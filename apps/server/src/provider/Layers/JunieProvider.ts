import {
  type JunieSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { findSessionConfigOption } from "../acp/AcpRuntimeModel.ts";
import { makeJunieAcpRuntime } from "../acp/JunieAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Junie",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
// Last-resort catalog, used only when the ACP handshake itself fails. Junie
// advertises its real list per session (see `junieModelsFromSessionSetup`), and
// that list moves faster than this file — never treat these ids as current.
const HOSTED_MODELS: ReadonlyArray<readonly [string, string]> = [
  ["gpt-5.6-terra", "GPT-5.6-Terra"],
  ["gpt-5.6-sol", "GPT-5.6-Sol"],
  ["gpt-5.6-luna", "GPT-5.6-Luna"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
];

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = HOSTED_MODELS.map(([slug, name]) => ({
  slug,
  name,
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
}));

/**
 * Junie's catalog arrives as the session's model-category config option, not as
 * `models.availableModels` — it never sends that field, so reading it left
 * discovery empty and silently fell back to the hardcoded list above. Models
 * defined under `~/.junie/models/*.json` come back through here too, as
 * `custom:<file stem>`, which is the id the CLI actually accepts.
 */
export function junieModelsFromSessionSetup(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelConfigId: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelConfigId) return [];
  const option = findSessionConfigOption(configOptions, modelConfigId);
  if (!option || option.type !== "select") return [];
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  // Options are either flat entries or grouped ones; both carry `value`/`name`.
  for (const entry of option.options.flatMap((candidate) =>
    "value" in candidate ? [candidate] : candidate.options,
  )) {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: entry.name.trim() || slug,
      isCustom: slug.startsWith("custom:"),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

const modelsFromSettings = (
  customModels: ReadonlyArray<string>,
  builtInModels: ReadonlyArray<ServerProviderModel> = BUILT_IN_MODELS,
) => providerModelsFromSettings(builtInModels, customModels, EMPTY_CAPABILITIES);

export const buildInitialJunieProviderSnapshot = Effect.fn("buildInitialJunieProviderSnapshot")(
  function* (settings: JunieSettings) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSettings(settings.customModels),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Junie CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Junie is disabled in T3 Code settings.",
          },
    });
  },
);

const runVersion = (settings: JunieSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "junie";
    const resolved = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  });

const discoverModels = (settings: JunieSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeJunieAcpRuntime({
      junieSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return junieModelsFromSessionSetup(
      started.sessionSetupResult.configOptions,
      started.modelConfigId,
    );
  }).pipe(Effect.scoped);

export const checkJunieProviderStatus = Effect.fn("checkJunieProviderStatus")(function* (
  settings: JunieSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  if (!settings.enabled) return yield* buildInitialJunieProviderSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings.customModels);
  const versionResult = yield* runVersion(settings, environment).pipe(
    Effect.timeoutOption(4_000),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Junie CLI (`junie`) is not installed or not on PATH."
          : "Failed to execute the Junie CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Junie CLI timed out while running `junie --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Junie CLI is installed but failed to run.",
      },
    });
  }
  const discovery = yield* discoverModels(settings, environment).pipe(
    Effect.timeoutOption(15_000),
    Effect.exit,
  );
  if (Exit.isFailure(discovery) || Option.isNone(discovery.value)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Junie CLI is installed but ACP startup failed. Authenticate Junie and retry.",
      },
    });
  }
  const discovered = discovery.value.value;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: modelsFromSettings(
      settings.customModels,
      discovered.length ? discovered : BUILT_IN_MODELS,
    ),
    probe: { installed: true, version, status: "ready", auth: { status: "unknown" } },
  });
});
