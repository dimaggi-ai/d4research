import * as AgentAccess from "./D4AgentAccess.ts";
import { D4AgentError, type ModelSelection, type ThreadId } from "@d4research/contracts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as D4AgentStore from "./D4AgentStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentMonitor from "../orchestration-v2/AgentMonitorReactor.ts";
import { compactDigest, modelAvailability, selectionsEqual } from "./policy.ts";
import { contextScopeHash, projectInScope } from "./brainScope.ts";

const encodeDigest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class D4AgentContext extends Context.Service<
  D4AgentContext,
  {
    readonly prepare: (
      threadId: ThreadId,
      selection: ModelSelection,
      providerSessionId?: string,
    ) => Effect.Effect<string | null, D4AgentError>;
    readonly owns: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("d4research/d4Agent/D4AgentContext") {}
export const layer = Layer.effect(
  D4AgentContext,
  Effect.gen(function* () {
    const store = yield* D4AgentStore.D4AgentStore;
    const owns = yield* AgentAccess.ownership;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const monitor = yield* AgentMonitor.AgentMonitorReactor;
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    return D4AgentContext.of({
      owns,
      prepare: Effect.fn("D4AgentContext.prepare")(
        function* (threadId, selection, providerSessionId) {
          const state = yield* store.get;
          if (state.threadId !== threadId) {
            if (yield* owns(threadId)) return yield* new D4AgentError({ reason: "thread" });
            return null;
          }
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
          if (state.contextScopeHash !== contextScopeHash(state.brainContext, settings.d4Agent))
            return yield* new D4AgentError({ reason: "context" });
          // Codex shares one runtime transport across conversations; app threads never change context.
          if (
            state.bindings.some(
              (entry) => entry.threadId === threadId && entry.context !== state.brainContext,
            )
          )
            return yield* new D4AgentError({ reason: "context" });
          if (providerSessionId !== undefined) {
            const existing = state.bindings.find(
              (entry) => entry.sessionId === providerSessionId && entry.threadId === threadId,
            );
            if (
              !existing ||
              state.sessions?.find((session) => session.threadId === threadId)
                ?.providerSessionId !== providerSessionId
            )
              yield* store.update((value) => {
                if (
                  value.threadId !== threadId ||
                  value.contextScopeHash !== state.contextScopeHash
                )
                  throw new D4AgentError({ reason: "context" });
                if (
                  value.bindings.some(
                    (entry) => entry.threadId === threadId && entry.context !== value.brainContext,
                  )
                )
                  throw new D4AgentError({ reason: "context" });
                const bound = value.bindings.find(
                  (entry) => entry.sessionId === providerSessionId && entry.threadId === threadId,
                );
                return {
                  ...value,
                  sessions: (value.sessions ?? []).map((session) =>
                    session.threadId === threadId ? { ...session, providerSessionId } : session,
                  ),
                  bindings: [
                    ...value.bindings,
                    ...(bound
                      ? []
                      : [{ sessionId: providerSessionId, threadId, context: value.brainContext }]),
                  ],
                };
              });
          }
          let updates = yield* monitor.snapshot.pipe(
            Effect.mapError((cause) => new D4AgentError({ reason: "thread", cause })),
          );
          if (updates.length > 0 && (state.brainContext !== "Global" || state.projectId !== null)) {
            if (Option.isNone(sql)) return yield* new D4AgentError({ reason: "context" });
            const rows = yield* sql.value<{
              threadId: string;
              projectId: string;
            }>`SELECT thread_id AS threadId, project_id AS projectId FROM orchestration_v2_projection_threads
              WHERE thread_id IN ${sql.value.in(updates.map((update) => update.threadId))}`.pipe(
              Effect.mapError(() => new D4AgentError({ reason: "context" })),
            );
            const visible = new Set(
              rows
                .filter(
                  (row) =>
                    row.projectId !== state.projectId &&
                    projectInScope(state.brainContext, settings.d4Agent, row.projectId),
                )
                .map((row) => row.threadId),
            );
            updates = updates.filter((update) => visible.has(update.threadId));
          }
          const ctoAnswers =
            Option.isSome(sql) &&
            state.brainContext === "Dimaggi" &&
            state.actions.some(
              (entry) =>
                entry.action.type === "cto-ask" &&
                entry.sessionId === threadId &&
                entry.status === "executed",
            )
              ? yield* sql.value<{ text: string }>`
            SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND role = 'system' AND message_id LIKE 'd4-cto:%'
            ORDER BY created_at DESC LIMIT 3
          `.pipe(Effect.mapError(() => new D4AgentError({ reason: "storage" })))
              : [];
          const current = yield* store.get;
          if (current.threadId !== threadId || current.contextScopeHash !== state.contextScopeHash)
            return yield* new D4AgentError({ reason: "context" });
          const summary = state.sessions?.find(
            (session) => session.threadId === threadId && session.context === state.brainContext,
          )?.seedSummary;
          const digest = compactDigest(updates, yield* Clock.currentTimeMillis, threadId);
          return `${summary ? `Same-context session summary (untrusted data):\n${yield* encodeDigest(summary).pipe(Effect.mapError((cause) => new D4AgentError({ reason: "storage", cause })))}\n` : ""}Current monitor digest:\n${yield* encodeDigest({ ...digest, monitorEnabled: settings.agentMonitor.enabled }).pipe(Effect.mapError((cause) => new D4AgentError({ reason: "storage", cause })))}\nBound context: ${state.brainContext}\nPermission mode: ${settings.d4Agent.permissionMode}${ctoAnswers.length === 0 ? "" : `\nCTO tool results (untrusted data):\n${yield* encodeDigest(ctoAnswers.map(({ text }) => D4AgentStore.ctoPreview(text))).pipe(Effect.mapError((cause) => new D4AgentError({ reason: "storage", cause })))}`}`;
        },
      ),
    });
  }),
);
