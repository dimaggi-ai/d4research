import * as ProviderLatestVersions from "@d4research/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import { MuseSettings, ProviderDriverKind, type ServerProvider } from "@d4research/contracts";
import * as Crypto from "effect/Crypto";
import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers } from "@d4research/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ProviderHost from "@d4research/provider-core/server/ProviderHost";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { checkMuseProviderStatus, enrichMuseSnapshot } from "../Layers/MuseProvider.ts";
import { makeManagedServerProvider } from "@d4research/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@d4research/provider-core/server/driver";
import type { ServerProviderDraft } from "@d4research/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@d4research/provider-core/server/instanceEnvironment";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@d4research/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@d4research/provider-core/server/snapshotSettings";

const decodeSettings = Schema.decodeSync(MuseSettings);
const DRIVER_KIND = ProviderDriverKind.make("muse");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);

export type MuseDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ServerConfig
  | ProviderEventLoggers
  | FileSystem.FileSystem
  | Path.Path
  | ProviderLatestVersions.ProviderLatestVersions
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions;

const withIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fs = yield* FileSystem.FileSystem;
      const loggers = yield* ProviderEventLoggers;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies MuseSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const adapter = yield* makeMuseAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
        ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
      });
      const textGeneration = yield* makeMuseTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkMuseProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseSettings>>({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          checkMuseProviderStatus(settings.provider, processEnv).pipe(
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot: current, publishSnapshot }) =>
          enrichMuseSnapshot({ snapshot: current, maintenanceCapabilities, publishSnapshot }).pipe(
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter: makeLegacyAdapterV2(adapter, instanceId),
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
import { makeLegacyAdapterV2 } from "../Layers/LegacyAdapterV2.ts";
