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
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "default", name: "Default", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];

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
    const available = started.sessionSetupResult.models?.availableModels ?? [];
    const seen = new Set<string>();
    return available.flatMap((model): Array<ServerProviderModel> => {
      const slug = model.modelId.trim();
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          name: model.name.trim() || slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        },
      ];
    });
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
