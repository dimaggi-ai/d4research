// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import {
  MUSE_REASONING_EFFORTS,
  type MuseSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@d4research/contracts";
import { createModelCapabilities } from "@d4research/shared/model";
import { resolveSpawnCommand } from "@d4research/shared/shell";
import { DateTime, Effect, FileSystem, Option, Result } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeMuseMspRuntime } from "../msp/MspSessionRuntime.ts";

export const MUSE_PRESENTATION = {
  displayName: "Muse",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  supportsConversationRollback: false,
} as const;
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select",
      options: MUSE_REASONING_EFFORTS.map((id) => ({ id, label: id })),
    },
  ],
});
const modelsFromSettings = (
  settings: MuseSettings,
  models: ReadonlyArray<ServerProviderModel> = [
    { slug: "default", name: "Host default", isCustom: false, capabilities: CAPABILITIES },
  ],
) => providerModelsFromSettings(models, settings.customModels, CAPABILITIES);
export const buildInitialMuseProviderSnapshot = Effect.fn("buildInitialMuseProviderSnapshot")(
  function* (settings: MuseSettings) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: modelsFromSettings(settings),
      slashCommands: [],
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Muse CLI availability..."
          : "Muse is disabled in T3 Code settings.",
      },
    });
  },
);
export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (!settings.enabled) return yield* buildInitialMuseProviderSnapshot(settings);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const versionResult = yield* Effect.gen(function* () {
    const command = settings.binaryPath || "muse";
    const resolved = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: NodeOS.tmpdir(),
        env: environment,
        shell: resolved.shell,
      }),
    );
  }).pipe(Effect.timeout(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult) || versionResult.success.code !== 0)
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings),
      probe: {
        installed: Result.isSuccess(versionResult) || !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse CLI is unavailable. Check the binary path and run `muse --version`.",
      },
    });
  const version = parseGenericCliVersion(
    `${versionResult.success.stdout}\n${versionResult.success.stderr}`,
  );
  const catalog = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-muse-probe-" });
    const runtime = yield* makeMuseMspRuntime({
      settings,
      environment,
      spawner,
      cwd,
      clientInfo: { name: "t3_code", version: "0.0.1" },
    });
    return yield* runtime.listModels();
  }).pipe(Effect.timeout("8 seconds"), Effect.scoped, Effect.result);
  if (Result.isFailure(catalog))
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse model discovery failed. Run `muse login` and retry.",
      },
    });
  const models = catalog.success.models.map((model) => ({
    slug: model.modelId,
    name: model.displayLabel,
    isCustom: false,
    isDefault: model.isDefault,
    capabilities: CAPABILITIES,
  }));
  const authenticated = models.length > 0;
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: modelsFromSettings(settings, models),
    slashCommands: [],
    probe: {
      installed: true,
      version,
      status: authenticated ? "ready" : "error",
      auth: { status: authenticated ? "authenticated" : "unauthenticated" },
      ...(!authenticated
        ? { message: "Muse is installed but not signed in. Run `muse login`." }
        : {}),
    },
  });
});
export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  snapshot: ServerProvider;
  maintenanceCapabilities: ProviderMaintenanceCapabilities;
  enableProviderUpdateChecks?: boolean;
  publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}) {
  const http = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(http)) return yield* input.publishSnapshot(input.snapshot);
  const snapshot = yield* enrichProviderSnapshotWithVersionAdvisory(
    input.snapshot,
    input.maintenanceCapabilities,
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, http.value),
    Effect.orElseSucceed(() => input.snapshot),
  );
  yield* input.publishSnapshot(snapshot);
});
