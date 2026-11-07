import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderRoute,
  type OrchestrationV2ThreadProjection,
} from "@d4research/contracts";
import { DeepSeekSettings } from "@d4research/provider-deepseek/settings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { modelSelectionsEqual, getModelSelectionStringOptionValue } from "@d4research/shared/model";
import { resolveProviderInstanceEnabled } from "@d4research/contracts";
import { probeDeepSeek } from "@d4research/provider-deepseek/server";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { historicalMessage } from "@d4research/provider-core/server/handoffBudget";
import * as RouteTelemetry from "./RouteTelemetry.ts";
import { localRouteReason } from "./smartRoutingPolicy.ts";

export class SmartRoutingError extends Schema.TaggedError<SmartRoutingError>()(
  "SmartRoutingError",
  {
    reason: Schema.Literals(["configuration", "fallback_unavailable", "telemetry"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "Smart routing could not select an available provider. Check the local provider and fallback settings.";
  }
}

export class SmartRouting extends Context.Service<
  SmartRouting,
  {
    readonly select: (input: {
      readonly selection: ModelSelection;
      readonly projection: OrchestrationV2ThreadProjection;
      readonly text: string;
      readonly hasAttachments: boolean;
      readonly toolPolicy?: "d4-agent";
    }) => Effect.Effect<
      { readonly selection: ModelSelection; readonly route: ProviderRoute | null },
      SmartRoutingError
    >;
  }
>()("d4research/provider/SmartRouting") {}

const decodeSettings = Schema.decodeUnknownEffect(DeepSeekSettings);

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const telemetry = yield* RouteTelemetry.RouteTelemetry;
  const http = yield* HttpClient.HttpClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return SmartRouting.of({
    select: Effect.fn("SmartRouting.select")(function* (input) {
      // Nia must keep the provider whose restricted tool boundary was selected.
      if (input.toolPolicy === "d4-agent") return { selection: input.selection, route: null };
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError((cause) => new SmartRoutingError({ reason: "configuration", cause })),
      );
      const previous = input.projection.thread.providerRoute;
      const source =
        previous && modelSelectionsEqual(input.selection, previous.selected)
          ? previous.source
          : input.selection;
      const instance = settings.providerInstances[source.instanceId];
      if (instance?.driver !== "deepseek") return { selection: input.selection, route: null };
      const config = yield* decodeSettings(instance.config).pipe(
        Effect.mapError((cause) => new SmartRoutingError({ reason: "configuration", cause })),
      );
      if (!config.smartRouting) return { selection: input.selection, route: null };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const taskMode =
        getModelSelectionStringOptionValue(source, "taskMode") === "tools"
          ? "tools"
          : getModelSelectionStringOptionValue(source, "taskMode") === "text"
            ? "text"
            : config.taskMode;
      // Counts only. Neither text nor semantic errors cross into route telemetry.
      const history = yield* projections
        .getTurnStartHistory(input.projection.thread.id)
        .pipe(Effect.mapError(() => new SmartRoutingError({ reason: "configuration" })));
      const transcriptBytes = history.reduce(
        (sum, item) => sum + Buffer.byteLength(historicalMessage(item)?.text ?? "", "utf8") + 32,
        0,
      );
      const userBytes = input.projection.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.text, "utf8") + 32,
        0,
      );
      const measuredTokens = Math.max(
        0,
        ...input.projection.providerTurns.map((turn) => turn.tokenUsage?.usedTokens ?? 0),
      );
      const contextTokens =
        Math.max(transcriptBytes, userBytes, measuredTokens) +
        Buffer.byteLength(input.text, "utf8") +
        256;
      const available =
        resolveProviderInstanceEnabled(instance) &&
        (yield* adapters.list()).includes(source.instanceId);
      let health: ProviderRoute["health"] = "unknown";
      if (
        available &&
        taskMode === "text" &&
        !input.hasAttachments &&
        contextTokens + 4096 <= config.contextWindowTokens
      ) {
        health = (yield* probeDeepSeek(config).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ))
          ? "healthy"
          : "unhealthy";
      }
      const recent = yield* telemetry
        .recent(source.instanceId, config.model, now)
        .pipe(Effect.mapError((cause) => new SmartRoutingError({ reason: "telemetry", cause })));
      const reason = localRouteReason({
        taskMode,
        hasAttachments: input.hasAttachments,
        available,
        health,
        contextTokens,
        contextWindowTokens: config.contextWindowTokens,
        recent,
      });
      let selection = { ...source, model: config.model };
      let driver = instance.driver;
      if (reason !== "local_healthy") {
        if (!config.fallbackInstanceId.trim() || !config.fallbackModel.trim())
          return yield* new SmartRoutingError({ reason: "fallback_unavailable" });
        const fallbackId = ProviderInstanceId.make(config.fallbackInstanceId);
        const fallbackConfig = settings.providerInstances[fallbackId];
        const fallback = yield* Effect.option(adapters.get(fallbackId));
        const metadata = adapters.getMetadata
          ? yield* Effect.option(adapters.getMetadata(fallbackId))
          : undefined;
        if (
          fallbackId === source.instanceId ||
          Option.isNone(fallback) ||
          (fallbackConfig !== undefined && !resolveProviderInstanceEnabled(fallbackConfig)) ||
          (metadata !== undefined &&
            (Option.isNone(metadata) ||
              !metadata.value.enabled ||
              metadata.value.available === false ||
              (metadata.value.models !== undefined &&
                !metadata.value.models.includes(config.fallbackModel))))
        ) {
          return yield* new SmartRoutingError({ reason: "fallback_unavailable" });
        }
        const capabilities = yield* fallback.value
          .getCapabilities()
          .pipe(
            Effect.mapError(
              (cause) => new SmartRoutingError({ reason: "fallback_unavailable", cause }),
            ),
          );
        if ((taskMode === "tools" || input.hasAttachments) && !capabilities.tools.emitsToolStarted)
          return yield* new SmartRoutingError({ reason: "fallback_unavailable" });
        selection = { instanceId: fallbackId, model: config.fallbackModel };
        driver = fallback.value.driver;
      }
      return {
        selection,
        route: {
          source,
          selected: selection,
          driver,
          taskMode,
          reason,
          health,
          decidedAt: now,
          contextTokens,
          fallbackCount:
            (previous?.source.instanceId === source.instanceId ? previous.fallbackCount : 0) +
            (reason === "local_healthy" ? 0 : 1),
        },
      };
    }),
  });
});

export const layer = Layer.effect(SmartRouting, make).pipe(
  Layer.provide(Layer.orDie(RouteTelemetry.layer)),
);
