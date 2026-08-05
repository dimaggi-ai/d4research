import {
  type AgySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Agy",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const PROBE_TIMEOUT_MS = 8_000;

function modelsFromSlugs(
  slugs: ReadonlyArray<string>,
  settings: AgySettings,
): ReadonlyArray<ServerProviderModel> {
  const discovered = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
    ...(slug === settings.defaultModel ? { isDefault: true } : {}),
  }));
  return providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES);
}

const runAgy = (
  settings: AgySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  });

export const buildInitialAgyProviderSnapshot = Effect.fn("buildInitialAgyProviderSnapshot")(
  function* (settings: AgySettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsFromSlugs([settings.defaultModel], settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Agy CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Agy is disabled in d2research settings.",
          },
    });
  },
);

export const checkAgyProviderStatus = Effect.fn("checkAgyProviderStatus")(function* (
  settings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSlugs([settings.defaultModel], settings);
  if (!settings.enabled) return yield* buildInitialAgyProviderSnapshot(settings);

  const probe = yield* runAgy(settings, ["models"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(probe)) {
    const missing = isCommandMissingCause(probe.failure);
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
          ? "Agy CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute the Agy CLI health check.",
      },
    });
  }
  if (Option.isNone(probe.success)) {
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
        message: "Agy CLI health check timed out.",
      },
    });
  }

  const models = probe.success.value;
  const discovered = models.code === 0 ? models.stdout.split(/\r?\n/u) : [];
  const healthy = models.code === 0 && discovered.some((slug) => slug.trim().length > 0);
  const versionProbe = healthy
    ? yield* runAgy(settings, ["--version"], environment).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT_MS),
        Effect.result,
      )
    : null;
  const version =
    versionProbe && Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)
      ? parseGenericCliVersion(
          `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
        )
      : null;
  const failureDetail = models.stderr.trim().slice(0, 500);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: healthy ? modelsFromSlugs(discovered, settings) : fallbackModels,
    probe: {
      installed: true,
      version,
      status: healthy ? "ready" : "error",
      auth: healthy ? { status: "authenticated", type: "Agy account" } : { status: "unknown" },
      ...(!healthy
        ? {
            message: failureDetail
              ? `Agy model discovery failed: ${failureDetail}`
              : `Agy model discovery exited with code ${models.code}. Run \`agy models\` to diagnose authentication or connector settings.`,
          }
        : {}),
    },
  });
});
