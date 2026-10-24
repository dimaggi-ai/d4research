import { D4AgentError, type ModelSelection, type ThreadId } from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as D4AgentStore from "./D4AgentStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentMonitor from "../orchestration-v2/AgentMonitorReactor.ts";
import {
  contentFreeDigest,
  D4_AGENT_PREFIX,
  modelAvailability,
  selectionsEqual,
} from "./policy.ts";

const encodeDigest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class D4AgentContext extends Context.Service<
  D4AgentContext,
  {
    readonly prepare: (
      threadId: ThreadId,
      selection: ModelSelection,
    ) => Effect.Effect<string | null, D4AgentError>;
    readonly owns: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("d4research/d4Agent/D4AgentContext") {}
export const layer = Layer.effect(
  D4AgentContext,
  Effect.gen(function* () {
    const store = yield* D4AgentStore.D4AgentStore;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const monitor = yield* AgentMonitor.AgentMonitorReactor;
    return D4AgentContext.of({
      owns: (threadId) => store.get.pipe(Effect.map((state) => state.threadId === threadId)),
      prepare: Effect.fn("D4AgentContext.prepare")(function* (threadId, selection) {
        const state = yield* store.get;
        if (state.threadId !== threadId) return null;
        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError((cause) => new D4AgentError({ reason: "storage", cause })),
        );
        const available = modelAvailability(settings.d4Agent, yield* providers.getProviders);
        if (available !== null) return yield* new D4AgentError({ reason: available });
        if (
          settings.d4Agent.modelSelection === null ||
          !selectionsEqual(selection, settings.d4Agent.modelSelection)
        )
          return yield* new D4AgentError({ reason: "model-unavailable" });
        const updates = yield* monitor.snapshot.pipe(
          Effect.mapError((cause) => new D4AgentError({ reason: "thread", cause })),
        );
        const digest = contentFreeDigest(updates, yield* Clock.currentTimeMillis, threadId);
        return `${D4_AGENT_PREFIX}\n\nCurrent monitor digest:\n${yield* encodeDigest({ ...digest, monitorEnabled: settings.agentMonitor.enabled }).pipe(Effect.mapError((cause) => new D4AgentError({ reason: "storage", cause })))}\nPermission mode: ${settings.d4Agent.permissionMode}`;
      }),
    });
  }),
);
