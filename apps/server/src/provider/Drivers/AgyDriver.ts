import { AgySettings, ProviderDriverKind, type ServerProvider } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ProviderHost from "@d4research/provider-core/server/ProviderHost";
import { makeAgyTextGeneration } from "../../textGeneration/AgyTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAgyAdapter } from "../Layers/AgyAdapter.ts";
import { checkAgyProviderStatus } from "../Layers/AgyProvider.ts";
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

const decodeSettings = Schema.decodeSync(AgySettings);
const DRIVER_KIND = ProviderDriverKind.make("agy");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);

export type AgyDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

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

export const AgyDriver: ProviderDriver<AgySettings, AgyDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Agy", supportsMultipleInstances: true },
  configSchema: AgySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
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
      const effectiveConfig = { ...config, enabled } satisfies AgySettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });
      const adapter = yield* makeAgyAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
      });
      const textGeneration = yield* makeAgyTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkAgyProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AgySettings>>({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          // Agy model discovery is short but essential: publishing the
          // optimistic "Checking" snapshot first lets the registry cache it
          // before the background refresh result arrives. Probe before this
          // instance enters the registry so Settings gets a real status.
          checkAgyProviderStatus(settings.provider, processEnv).pipe(
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot: current, publishSnapshot }) => publishSnapshot(current),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Agy snapshot: ${cause.message ?? String(cause)}`,
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
