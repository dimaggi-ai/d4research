import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeConfiguredMemoryConnector } from "../memory/localConnector.ts";
import { ResearchDelegationBudget } from "./budget.ts";
import { ResearchDelegateError, ResearchToolkit } from "./tools.ts";

/** Delegates run real research prompts; give them room but never forever. */
const DELEGATE_TURN_TIMEOUT_MILLIS = 240_000;
const DELEGATE_START_TIMEOUT_MILLIS = 120_000;
const SESSION_STOP_TIMEOUT_MILLIS = 10_000;
/**
 * A cold cloud model loads on its first inference and can blow the turn
 * ceiling on a fresh session; a throwaway warm-up turn absorbs that load so
 * the real turn runs hot. Best-effort, so this is its own (shorter) budget.
 */
const DELEGATE_WARMUP_TIMEOUT_MILLIS = 120_000;
/** Cap what flows back into the orchestrator context per delegation. */
export const DELEGATE_MAX_OUTPUT_CHARS = 24_000;

/**
 * Ollama cloud models (slug suffix ":cloud") execute remotely and cold-start
 * on the first call to a fresh session. Warming them first turns the repeated
 * 240s timeouts into one absorbed load. Local/hosted providers answer from a
 * warm endpoint and are left on the fast path.
 */
export function isColdStartProne(model: string): boolean {
  return model.endsWith(":cloud");
}

// Thread items are opaque (Array<unknown>) and their shape differs by adapter:
// agy stores plain strings or `{ text }`; claude / opencode store SDK messages
// shaped as `{ role, content: [{ type, text }, ...] }` and include the echoed
// user turn; codex app-server items carry a `type` discriminator
// (`userMessage`, `reasoning`, `agentMessage`, ...). These pull the assistant's
// answer only, across every shape.
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block !== null && typeof block === "object") {
    const t = (block as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function itemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item === null || typeof item !== "object") return "";
  const o = item as { role?: unknown; type?: unknown; text?: unknown; content?: unknown };
  // Codex surfaces the echoed prompt (`userMessage`) and intermediate
  // `reasoning` in the same turn as the answer. Neither is the reply, and both
  // would otherwise be mistaken for it via the fields below.
  if (o.type === "userMessage" || o.type === "reasoning") return "";
  if (o.role === "user") return "";
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) return o.content.map(blockText).join("");
  return "";
}

/** Assistant text of a thread's last turn, empty until that turn produced any. */
export function extractAssistantText(thread: {
  readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
}): string {
  const lastTurn = thread.turns[thread.turns.length - 1];
  if (!lastTurn) return "";
  return lastTurn.items.map(itemText).join("").trim();
}

/**
 * Splits "instanceId:model" on the FIRST colon only — model slugs carry
 * colons of their own (`glm-5.2:cloud`).
 */
export function parseDelegateTarget(
  target: string,
): { readonly instanceId: string; readonly model: string } | null {
  const separator = target.indexOf(":");
  if (separator <= 0 || separator === target.length - 1) return null;
  const instanceId = target.slice(0, separator).trim();
  const model = target.slice(separator + 1).trim();
  if (!instanceId || !model) return null;
  return { instanceId, model };
}

const handlers = {
  research_delegate: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const parsedTarget = parseDelegateTarget(input.target);
      if (!parsedTarget) {
        return yield* new ResearchDelegateError({
          detail: `Target "${input.target}" is not "instanceId:model". Use the exact target strings from the research briefing.`,
        });
      }

      // The delegate must never be this thread's own session — that is the
      // recursive-delegation door the product contract keeps shut.
      const nowMs = yield* Clock.currentTimeMillis;
      const budget = yield* ResearchDelegationBudget;
      const charge = yield* budget.charge({
        threadId: String(invocation.threadId),
        step: input.step,
        target: input.target,
        nowMs,
      });
      if (!charge.ok) {
        return yield* new ResearchDelegateError({
          detail: charge.reason ?? "Delegation budget exhausted.",
          budgetExhausted: true,
        });
      }

      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({ detail: `Could not read settings: ${String(cause)}` }),
        ),
      );
      let promptFileContent: string | null = null;
      if (input.promptFileName !== undefined) {
        // Prefer the named scenario's files; fall back to every scenario plus
        // the legacy single-pipeline list so older briefings keep working.
        const scenario = settings.research.scenarios.find(
          (candidate) => candidate.name === input.scenario,
        );
        const searchable = [
          ...(scenario?.promptFiles ?? []),
          ...settings.research.scenarios.flatMap((candidate) => candidate.promptFiles),
          ...settings.research.promptFiles,
        ];
        const file = searchable.find((candidate) => candidate.name === input.promptFileName);
        if (!file) {
          const attached = [...new Set(searchable.map((candidate) => candidate.name))];
          return yield* new ResearchDelegateError({
            detail: `Prompt file "${input.promptFileName}" is not attached in Settings → Research. Attached: ${
              attached.join(", ") || "none"
            }.`,
          });
        }
        promptFileContent = file.content;
      }

      const registry = yield* ProviderAdapterRegistry;
      const instanceId = ProviderInstanceId.make(parsedTarget.instanceId);
      const adapter = yield* registry.getByInstance(instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({
              detail: `Provider "${parsedTarget.instanceId}" unavailable: ${cause.message}`,
            }),
        ),
      );

      // Shared context rides along as-is — no summarization between what one
      // model learned and what the next one reads. Best-effort: a memory
      // outage degrades to a delegate without context, never a failed step.
      let sharedContext: string | null = null;
      if (settings.research.shareMemoContext) {
        sharedContext = yield* Effect.gen(function* () {
          const connector = yield* makeConfiguredMemoryConnector();
          const found = yield* connector.search(input.prompt, 5);
          if (found.results.length === 0) return null;
          return found.results.map((entry) => entry.text).join("\n---\n");
        }).pipe(Effect.orElseSucceed(() => null));
      }

      // Run the delegate in the orchestrator thread's workspace, not the
      // server process dir. Without this the CLI inherits the server's cwd
      // (e.g. the user's home), loads whatever agent memory/scope lives there,
      // and can refuse or misjudge work that is in-scope for the actual
      // project. Falls back to the default cwd when the thread has no
      // resolvable workspace yet.
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestratorContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(invocation.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<never>()));
      const delegateCwd = Option.match(orchestratorContext, {
        onNone: () => undefined,
        onSome: (context) => context.worktreePath ?? context.workspaceRoot,
      });

      const turnInput = [
        ...(sharedContext !== null
          ? ["--- SHARED CONTEXT (local memory, verbatim) ---", sharedContext, ""]
          : []),
        ...(promptFileContent !== null
          ? [`--- PROMPT FILE: ${input.promptFileName} ---`, promptFileContent, ""]
          : []),
        input.prompt,
      ].join("\n");

      const modelSelection = { instanceId, model: parsedTarget.model };
      const threadId = ThreadId.make(`research-delegate-${nowMs}`);

      yield* adapter
        .startSession({
          threadId,
          provider: adapter.provider,
          // Delegates are unattended: no human is present to answer an
          // approval prompt. Every session driver maps "full-access" to an
          // autonomous, no-reviewer policy (claude: bypassPermissions;
          // codex: approvalPolicy "never"; opencode: permissive rules),
          // matching what the one-shot agy delegate already does. Any
          // approval-gated mode strands the first turn ("Session stopped").
          runtimeMode: "full-access",
          modelSelection,
          ...(delegateCwd ? { cwd: delegateCwd } : {}),
        })
        .pipe(
          Effect.timeout(DELEGATE_START_TIMEOUT_MILLIS),
          Effect.mapError(
            (cause) =>
              new ResearchDelegateError({
                detail: `Failed to start ${input.target}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );

      // A streaming session driver enqueues the prompt on sendTurn; the turn
      // finishes asynchronously in the agent loop. Reading and stopping the
      // session before it settles interrupts the live turn ("Session stopped"),
      // so we poll (trampolined by Effect, so stack-safe) until a caller-chosen
      // `done` predicate holds. The outer Effect.timeout is the real ceiling;
      // attemptsLeft is a backstop.
      //
      // "A new turn appeared" is NOT the same as "the turn finished." Codex's
      // live thread/read surfaces a turn the instant it starts (first with the
      // echoed prompt, then reasoning), and the assistant `agentMessage` lands
      // only at completion, ~3s later. Waiting on turn count alone reads that
      // empty in-progress turn and reports an empty response. The real turn
      // therefore waits for extractable assistant text, not just a new turn.
      const pollThread = (
        done: (thread: {
          readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
        }) => boolean,
        attemptsLeft: number,
      ): ReturnType<typeof adapter.readThread> =>
        Effect.gen(function* () {
          const thread = yield* adapter.readThread(threadId);
          if (done(thread) || attemptsLeft <= 0) {
            return thread;
          }
          yield* Effect.sleep("400 millis");
          return yield* pollThread(done, attemptsLeft - 1);
        });

      // Warm a cold cloud model with a throwaway turn in THIS session, so the
      // model is loaded before the real turn's clock starts. Best-effort: a
      // failed or slow warm-up is swallowed and the real turn still runs.
      if (isColdStartProne(parsedTarget.model)) {
        yield* Effect.gen(function* () {
          const warmBefore = yield* adapter.readThread(threadId).pipe(
            Effect.map((thread) => thread.turns.length),
            Effect.orElseSucceed(() => 0),
          );
          yield* adapter.sendTurn({
            threadId,
            input: "Reply with the single word: OK",
            attachments: [],
            modelSelection,
          });
          // Warm-up only needs the model loaded, so a completed turn is enough.
          yield* pollThread((thread) => thread.turns.length > warmBefore, 1200);
        }).pipe(Effect.timeout(DELEGATE_WARMUP_TIMEOUT_MILLIS), Effect.ignore);
      }

      const turnsBefore = yield* adapter.readThread(threadId).pipe(
        Effect.map((thread) => thread.turns.length),
        Effect.orElseSucceed(() => 0),
      );

      const finalThread = yield* Effect.gen(function* () {
        yield* adapter.sendTurn({ threadId, input: turnInput, attachments: [], modelSelection });
        return yield* pollThread(
          (thread) => thread.turns.length > turnsBefore && extractAssistantText(thread).length > 0,
          1200,
        );
      }).pipe(
        Effect.timeout(DELEGATE_TURN_TIMEOUT_MILLIS),
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({
              detail: `Delegate turn on ${input.target} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
        Effect.ensuring(
          adapter
            .stopSession(threadId)
            .pipe(Effect.timeout(SESSION_STOP_TIMEOUT_MILLIS), Effect.ignore),
        ),
      );

      const text = extractAssistantText(finalThread);

      if (!text) {
        return yield* new ResearchDelegateError({
          detail: `Empty response from ${input.target}. Report the step as failed rather than inventing its answer.`,
        });
      }

      const truncated = text.length > DELEGATE_MAX_OUTPUT_CHARS;
      return {
        target: input.target,
        step: input.step,
        visit: input.visit,
        remainingBudget: charge.remaining,
        truncated,
        text: truncated ? text.slice(0, DELEGATE_MAX_OUTPUT_CHARS) : text,
      };
    }),
} satisfies Parameters<typeof ResearchToolkit.toLayer>[0];

export const ResearchToolkitHandlersLive = ResearchToolkit.toLayer(handlers);
