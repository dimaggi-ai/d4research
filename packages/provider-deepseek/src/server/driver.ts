import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as ProviderHost from "@d4research/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@d4research/provider-core/server/driver";
import { ProviderDriverError } from "@d4research/provider-core/server/errors";
import { buildServerProvider } from "@d4research/provider-core/server/snapshotProbe";
import { withInstanceIdentity } from "@d4research/provider-core/server/instanceIdentity";
import type { ProviderTextGeneration } from "@d4research/provider-core/server/textGeneration";
import { DeepSeekSettings, isLoopbackEndpoint } from "../settings.ts";
import { DeepSeekAdapterV2Driver } from "./adapter.ts";
import { probeDeepSeek } from "./health.ts";

const DRIVER = ProviderDriverKind.make("deepseek");
export type DeepSeekDriverEnv = HttpClient.HttpClient | ProviderHost.ProviderHost;

const unavailableText = () =>
  Effect.fail(
    new TextGenerationError({
      operation: "deepseek",
      detail: "Local DeepSeek supports conversation text only.",
    }),
  );
const textGeneration: ProviderTextGeneration = {
  generateCommitMessage: unavailableText,
  generatePrContent: unavailableText,
  generateBranchName: unavailableText,
  generateThreadTitle: unavailableText,
  generateReviewGuide: unavailableText,
};
export const DeepSeekDriver: ProviderDriver<DeepSeekSettings, DeepSeekDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "DeepSeek (local)",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: DeepSeekAdapterV2Driver.defaultConfig,
  create: (input) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId: input.instanceId,
        displayName: input.displayName,
        accentColor: input.accentColor,
        driverKind: DRIVER,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const build = (ready: boolean, checkedAt: string): ServerProvider =>
        stamp(
          buildServerProvider({
            driver: DRIVER,
            presentation: {
              displayName: "DeepSeek (local)",
              badgeLabel: "Text only",
              showInteractionModeToggle: false,
              reportsContextWindow: true,
              supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
              supportsConversationRollback: false,
            },
            enabled: input.enabled,
            checkedAt,
            models: [
              {
                slug: input.config.model,
                name: input.config.model,
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "taskMode",
                      label: "Task mode",
                      type: "select",
                      currentValue: input.config.taskMode,
                      options: [
                        { id: "text", label: "Text" },
                        { id: "tools", label: "Tools (fallback)" },
                      ],
                    },
                  ],
                },
              },
            ],
            probe: {
              installed: true,
              version: null,
              status: ready ? "ready" : "error",
              auth: { status: "authenticated" },
              ...(ready
                ? {}
                : {
                    message: "The configured model is unavailable at the local DeepSeek endpoint.",
                  }),
            },
          }),
        );
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const state = yield* Ref.make(build(false, checkedAt));
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );
      const refresh = Effect.gen(function* () {
        let ready = false;
        if (input.enabled && isLoopbackEndpoint(input.config.endpoint)) {
          ready = yield* probeDeepSeek(input.config).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          );
        }
        const snapshot = build(ready, DateTime.formatIso(yield* DateTime.now));
        yield* Ref.set(state, snapshot);
        yield* PubSub.publish(changes, snapshot);
        return snapshot;
      });
      yield* refresh;
      const orchestrationAdapter = yield* DeepSeekAdapterV2Driver.create(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to create the local DeepSeek adapter.",
              cause,
            }),
        ),
      );
      return {
        instanceId: input.instanceId,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        driverKind: DRIVER,
        continuationIdentity,
        orchestrationAdapter,
        textGeneration,
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
          getSnapshot: Ref.get(state),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
        },
      };
    }),
};
