import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  ProviderInstanceId,
  ThreadId,
  type ResearchPromptFile,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { resolveResearchDelegateTimeoutMillis } from "../../researchDelegateTiming.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { makeConfiguredMemoryConnector } from "../memory/localConnector.ts";
import { ResearchDelegationBudget } from "./budget.ts";
import { ResearchDelegateError, type ResearchDelegateInput, ResearchToolkit } from "./tools.ts";

/** Keeps a failure reason readable in a tool result without dumping a stack. */
const CAUSE_DETAIL_MAX_CHARS = 400;

function describeCause(cause: Cause.Cause<unknown>): string {
  // `squash` yields the typed failure when there is one and the defect
  // otherwise, so a spawn-level crash reports its real message.
  const squashed: unknown = Cause.squash(cause);
  const message =
    squashed instanceof Error
      ? squashed.message
      : typeof squashed === "string"
        ? squashed
        : Cause.pretty(cause);
  const trimmed = message.trim() || "unknown error";
  return trimmed.length > CAUSE_DETAIL_MAX_CHARS
    ? `${trimmed.slice(0, CAUSE_DETAIL_MAX_CHARS)}…`
    : trimmed;
}

/** Distinguishes a blown deadline from a crashed delegate for the run state. */
export function isTimeoutCause(cause: Cause.Cause<unknown>): boolean {
  const squashed: unknown = Cause.squash(cause);
  return (
    (typeof squashed === "object" &&
      squashed !== null &&
      (squashed as { _tag?: unknown })._tag === "TimeoutError") ||
    (squashed instanceof Error && /timeout|timed out/i.test(squashed.message))
  );
}

/**
 * Turn ceiling for one delegation. A web-search verification step runs many
 * lookups and legitimately takes many minutes, and an aggregator pressure-test
 * reasons over a 10k+ brief; both were being cut off mid-answer. This is
 * deliberately generous — a genuinely stuck delegate is still bounded, but real
 * search work is not. Override without a rebuild via the env var below.
 */
const DELEGATE_TURN_TIMEOUT_MILLIS = resolveResearchDelegateTimeoutMillis(); // 30 min by default
/** Starting a session can lag on a cold cloud endpoint; give it real room. */
const DELEGATE_START_TIMEOUT_MILLIS = 180_000;
const SESSION_STOP_TIMEOUT_MILLIS = 10_000;
/**
 * A cold cloud model loads on its first inference and can blow the turn
 * ceiling on a fresh session; a throwaway warm-up turn absorbs that load so
 * the real turn runs hot. This has its own ceiling: if it does not settle we
 * fail the delegation so the pipeline can use its fallback instead of sending
 * the real prompt into a session that may still be running the warm-up.
 */
const DELEGATE_WARMUP_TIMEOUT_MILLIS = 360_000;
/** Cap what flows back into the orchestrator context per delegation. */
export const DELEGATE_MAX_OUTPUT_CHARS = 24_000;
/** Delegates advise only; write operations must remain provider-gated. */
export const DELEGATE_RUNTIME_MODE: RuntimeMode = "approval-required";

/**
 * Headless delegates cannot surface an approval prompt to the orchestrating
 * user, and provider request events do not expose a path we can validate.
 * Decline every request until the adapter contract carries a normalized path;
 * session-wide approval of an unvalidated read would expose arbitrary files.
 */
export function delegateApprovalDecision(_requestType: CanonicalRequestType): "decline" {
  return "decline";
}

export function buildDelegateThreadId(nowMs: number, entropy: string): ThreadId {
  return ThreadId.make(`research-delegate-${nowMs}-${entropy}`);
}

/** Poll cadence for waiting on a delegate's answer. */
const DELEGATE_POLL_DELAY_MILLIS = 400;
const DELEGATE_POLL_DELAY = `${DELEGATE_POLL_DELAY_MILLIS} millis`;
/**
 * Poll iterations for the settle loop. Derived from the turn timeout with a
 * margin so the OUTER `Effect.timeout` is the single ceiling — otherwise a
 * fixed attempt cap silently ends the wait before the timeout (the old 1200
 * capped every delegate at ~8 min regardless of the timeout).
 */
const DELEGATE_POLL_ATTEMPTS =
  Math.ceil(DELEGATE_TURN_TIMEOUT_MILLIS / DELEGATE_POLL_DELAY_MILLIS) + 150;
/** Warm-up only needs the model loaded; its own timeout bounds it. */
const DELEGATE_WARMUP_POLL_ATTEMPTS =
  Math.ceil(DELEGATE_WARMUP_TIMEOUT_MILLIS / DELEGATE_POLL_DELAY_MILLIS) + 60;
// Consecutive equal-length reads before the answer is accepted as settled.
// Streaming providers emit an intent preamble first, so returning on the first
// non-empty read hands that preamble back as the result.
const DELEGATE_SETTLE_READS = 3;

/** Minimal thread shape the settle loop needs; every adapter's snapshot fits. */
export interface DelegateThreadSnapshot {
  readonly turns: ReadonlyArray<{ readonly items: ReadonlyArray<unknown> }>;
}

/**
 * Waits for a delegate turn to produce a STABLE answer, not merely a first
 * token. It keeps reading while the assistant text grows and returns once the
 * text has been non-empty and unchanged for `stableReads` polls, or when
 * `maxAttempts` is spent. This is a strict superset of "return on first text":
 * it can only ever wait longer, never less, so it cannot hang beyond the
 * caller's outer timeout and cannot regress a provider that answers in one shot.
 *
 * Known limitation: a provider that emits a preamble and then goes silent for
 * longer than `stableReads` polls before answering (e.g. a long, output-free
 * tool call) can still settle on the preamble. That case needs a provider
 * completion signal, which the Codex adapter does not currently expose on a
 * per-delegate basis.
 */
export const settleDelegateThread = <E, R, E2 = never, R2 = never>(input: {
  readonly readThread: Effect.Effect<DelegateThreadSnapshot, E, R>;
  readonly turnsBefore: number;
  readonly maxAttempts: number;
  readonly stableReads: number;
  readonly pollDelay: Effect.Effect<void>;
  /**
   * True while the provider still reports the turn as running. Text stability
   * alone cannot distinguish "finished" from "posted an intent line, now
   * silently searching for minutes" — Codex does exactly that. While busy the
   * loop keeps waiting no matter how stable the text is; the outer timeout is
   * still the ceiling. Omitted (or erroring) it degrades to stability-only.
   */
  readonly isBusy?: Effect.Effect<boolean, E2, R2>;
}): Effect.Effect<DelegateThreadSnapshot, E | E2, R | R2> => {
  const loop = (
    attemptsLeft: number,
    lastLength: number,
    stableCount: number,
  ): Effect.Effect<DelegateThreadSnapshot, E | E2, R | R2> =>
    Effect.gen(function* () {
      const thread = yield* input.readThread;
      const busy = input.isBusy === undefined ? false : yield* input.isBusy;
      const hasNewTurn = thread.turns.length > input.turnsBefore;
      const length = extractAssistantText(thread).length;
      const answered = hasNewTurn && length > 0 && !busy;
      const stable = answered && length === lastLength ? stableCount + 1 : 0;
      if ((answered && stable >= input.stableReads) || attemptsLeft <= 0) {
        return thread;
      }
      yield* input.pollDelay;
      return yield* loop(attemptsLeft - 1, length, stable);
    });
  return loop(input.maxAttempts, -1, 0);
};

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

/**
 * Prompt files one named scenario may inline, and the only set a delegate of
 * that scenario can ever read. Scoping is a disclosure boundary, not a
 * convenience: a file attached to `security-audit` must stay unreadable from a
 * `blog` run, so an unknown scenario resolves to nothing rather than widening
 * to every scenario.
 */
export function listPipelinePromptFiles(
  settings: ServerSettings,
  pipelineKind: "research" | "dev",
  scenarioName: string,
): ReadonlyArray<ResearchPromptFile> {
  const scenarios = pipelineKind === "dev" ? settings.dev.scenarios : settings.research.scenarios;
  const scenario = scenarios.find((candidate) => candidate.name === scenarioName);
  if (scenario) return scenario.promptFiles;
  // Pre-scenario research settings kept their files in a top-level list. With
  // no scenarios configured there is exactly one (synthetic `default`)
  // scenario, so there is nothing to scope against and these are its files.
  // The settings panel folds them into a real `default` scenario on first
  // write, after which this branch is dead for that install.
  if (pipelineKind === "research" && scenarios.length === 0) return settings.research.promptFiles;
  return [];
}

export function findPipelinePromptFile(
  settings: ServerSettings,
  input: {
    readonly pipelineKind: "research" | "dev";
    readonly scenario: string;
    readonly promptFileName: string;
  },
): { readonly content: string; readonly attachedNames: ReadonlyArray<string> } | null {
  const searchable = listPipelinePromptFiles(settings, input.pipelineKind, input.scenario);
  const file = searchable.find((candidate) => candidate.name === input.promptFileName);
  if (!file) return null;
  return {
    content: file.content,
    attachedNames: [...new Set(searchable.map((candidate) => candidate.name))],
  };
}

export const makeResearchDelegateHandler =
  (options?: { readonly pollDelay?: Effect.Effect<void> }) => (input: ResearchDelegateInput) =>
    Effect.gen(function* () {
      const delegatePollDelay = options?.pollDelay ?? Effect.sleep(DELEGATE_POLL_DELAY);
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (!invocation.capabilities.has("research")) {
        return yield* new ResearchDelegateError({
          detail: "This provider session is not allowed to delegate research.",
          failureKind: "authorization",
        });
      }
      const crypto = yield* Crypto.Crypto;
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
        runId: `${String(invocation.threadId)}:${String(
          invocation.turnId ?? `${invocation.providerSessionId}:${invocation.issuedAt}`,
        )}`,
        step: input.step,
        target: input.target,
      });
      if (!charge.ok) {
        return yield* new ResearchDelegateError({
          detail: charge.reason ?? "Delegation budget exhausted.",
          budgetExhausted: true,
          failureKind: "budget",
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
        const pipelineKind = input.pipelineKind ?? "research";
        // `scenario` is what scopes the lookup, so a missing one cannot fall
        // back to searching every scenario — that would hand this run the
        // prompt files of pipelines it is not part of. Refuse and say why.
        if (input.scenario === undefined) {
          return yield* new ResearchDelegateError({
            detail: `Prompt file "${input.promptFileName}" needs the scenario it is attached to. Pass "scenario" exactly as the briefing states it.`,
          });
        }
        const file = findPipelinePromptFile(settings, {
          pipelineKind,
          scenario: input.scenario,
          promptFileName: input.promptFileName,
        });
        if (file === null) {
          const attached = listPipelinePromptFiles(settings, pipelineKind, input.scenario).map(
            (entry) => entry.name,
          );
          return yield* new ResearchDelegateError({
            detail: `Prompt file "${input.promptFileName}" is not attached to the "${input.scenario}" ${pipelineKind} pipeline. Attached: ${
              [...new Set(attached)].join(", ") || "none"
            }.`,
          });
        }
        promptFileContent = file.content;
      }

      const registry = yield* ProviderAdapterRegistry;
      const providerService = yield* ProviderService;
      const instanceId = ProviderInstanceId.make(parsedTarget.instanceId);
      const adapter = yield* registry.getByInstance(instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new ResearchDelegateError({
              detail: `Provider "${parsedTarget.instanceId}" unavailable: ${cause.message}`,
            }),
        ),
      );

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

      // Memo records written by provider handoff are scoped by the project
      // title. Resolve that title through the server-owned thread→project
      // relationship; never accept a scope from the MCP caller and never fall
      // back to an unscoped search when the authoritative project is missing.
      const memoProject = Option.isNone(orchestratorContext)
        ? null
        : yield* projectionSnapshotQuery
            .getProjectShellById(orchestratorContext.value.projectId)
            .pipe(
              Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.title })),
              Effect.orElseSucceed(() => null),
            );

      // Shared context rides along as-is — no summarization between what one
      // model learned and what the next one reads. Best-effort: a memory
      // outage degrades to a delegate without context, never a failed step.
      let sharedContext: string | null = null;
      if (settings.research.shareMemoContext && memoProject !== null) {
        sharedContext = yield* Effect.gen(function* () {
          const connector = yield* makeConfiguredMemoryConnector();
          const found = yield* connector.search(input.prompt, 5, memoProject);
          if (found.results.length === 0) return null;
          return found.results.map((entry) => entry.text).join("\n---\n");
        }).pipe(Effect.orElseSucceed(() => null));
      }

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
      const entropy = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () =>
            new ResearchDelegateError({
              detail: "Could not allocate a unique delegate session id.",
              failureKind: "start",
            }),
        ),
      );
      const threadId = buildDelegateThreadId(nowMs, entropy);

      const interactionScope = yield* Scope.make();
      const providerEvents = yield* providerService.subscribeEvents.pipe(
        Effect.provideService(Scope.Scope, interactionScope),
      );
      const delegateInteractionFiber = yield* Effect.gen(function* () {
        yield* Stream.runForEach(providerEvents, (event) => {
          if (String(event.threadId) !== String(threadId)) return Effect.void;
          if (event.type === "request.opened") {
            if (event.requestId === undefined) return Effect.void;
            return adapter
              .respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                delegateApprovalDecision(event.payload.requestType),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause as Cause.Cause<never>)
                    : Effect.fail(
                        new ResearchDelegateError({
                          detail: `Failed to answer an approval request from ${input.target}: ${describeCause(cause)}`,
                          failureKind: "error",
                        }),
                      ),
                ),
              );
          }
          if (event.type === "user-input.requested") {
            if (event.requestId === undefined) return Effect.void;
            return adapter
              .respondToUserInput(threadId, ApprovalRequestId.make(String(event.requestId)), {})
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause as Cause.Cause<never>)
                    : Effect.fail(
                        new ResearchDelegateError({
                          detail: `Failed to answer a user-input request from ${input.target}: ${describeCause(cause)}`,
                          failureKind: "error",
                        }),
                      ),
                ),
              );
          }
          return Effect.void;
        });
        return yield* new ResearchDelegateError({
          detail: `The interaction event stream for ${input.target} ended before the delegate completed.`,
          failureKind: "error",
        });
      }).pipe(Effect.forkChild);

      const finalThread = yield* Effect.gen(function* () {
        // Delegate sessions are intentionally adapter-local. ProviderService is
        // the durable user-session facade: starting through it mints an MCP
        // credential, persists a routing binding, and can make an advisory
        // child recursively callable. A delegate needs none of those things.
        yield* adapter
          .startSession({
            threadId,
            provider: adapter.provider,
            // Delegates are advisers. Read-only tools can run, while any attempt
            // to mutate the shared worktree remains provider-gated instead of
            // silently bypassing the user's permission mode.
            runtimeMode: DELEGATE_RUNTIME_MODE,
            modelSelection,
            ...(delegateCwd ? { cwd: delegateCwd } : {}),
          })
          .pipe(
            Effect.timeout(DELEGATE_START_TIMEOUT_MILLIS),
            Effect.mapError(
              (cause) =>
                new ResearchDelegateError({
                  detail: `Failed to start ${input.target}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  failureKind: "start",
                }),
            ),
          );

        const delegateIsBusy = adapter
          .listSessions()
          .pipe(
            Effect.map((sessions) =>
              sessions.some(
                (session) =>
                  String(session.threadId) === String(threadId) && session.status === "running",
              ),
            ),
          );

        // Warm a cold cloud model with a throwaway turn in THIS session, so the
        // model is loaded before the real turn's clock starts. A failed warm-up
        // must fail this delegation: continuing could overlap two turns in the
        // same provider session and attribute the wrong answer to the real step.
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
            // A turn row appears at turn start, not completion. Wait for the
            // provider's running signal to clear so the real prompt cannot
            // collide with a warm-up that is still loading the model.
            yield* settleDelegateThread({
              readThread: adapter.readThread(threadId),
              turnsBefore: warmBefore,
              maxAttempts: DELEGATE_WARMUP_POLL_ATTEMPTS,
              stableReads: 1,
              pollDelay: delegatePollDelay,
              isBusy: delegateIsBusy,
            });
          }).pipe(
            Effect.timeout(DELEGATE_WARMUP_TIMEOUT_MILLIS),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(
                    new ResearchDelegateError({
                      detail: isTimeoutCause(cause)
                        ? `Warm-up for ${input.target} did not settle within ${Math.round(DELEGATE_WARMUP_TIMEOUT_MILLIS / 60_000)} minutes. Switch to the fallback target; do not send the real prompt into this session.`
                        : `Warm-up for ${input.target} failed: ${describeCause(cause)}. Switch to the fallback target.`,
                      failureKind: isTimeoutCause(cause) ? "timeout" : "error",
                    }),
                  ),
            ),
          );
        }

        const turnsBefore = yield* adapter.readThread(threadId).pipe(
          Effect.map((thread) => thread.turns.length),
          Effect.orElseSucceed(() => 0),
        );

        return yield* Effect.gen(function* () {
          yield* adapter.sendTurn({
            threadId,
            input: turnInput,
            attachments: [],
            modelSelection,
          });
          // Wait for the answer to SETTLE, not merely to appear. A reasoning model
          // (Codex gpt-5.6-sol) streams a short intent preamble ("I'll verify…")
          // before the real answer; returning on first text hands the preamble
          // back as the result. This keeps reading while the text grows and only
          // accepts it once it has been stable, bounded by DELEGATE_POLL_ATTEMPTS.
          return yield* settleDelegateThread({
            readThread: adapter.readThread(threadId),
            turnsBefore,
            maxAttempts: DELEGATE_POLL_ATTEMPTS,
            stableReads: DELEGATE_SETTLE_READS,
            pollDelay: delegatePollDelay,
            // "Session still running" is the provider's own completion signal —
            // every adapter flips status running→ready at turn end.
            isBusy: delegateIsBusy,
          });
        }).pipe(
          Effect.timeout(DELEGATE_TURN_TIMEOUT_MILLIS),
          // Catch the whole cause, not just typed failures. A spawn-level defect
          // (E2BIG on an oversized prompt, a missing binary) would otherwise die
          // outside the declared failure channel and reach the orchestrator as an
          // opaque "internal server error" — which is exactly how every agy
          // delegation failed silently instead of naming its reason.
          Effect.catchCause((cause) =>
            // An interrupt carries no typed failure, so re-raising it keeps
            // cancellation semantics without widening the error channel.
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(
                  new ResearchDelegateError({
                    detail: isTimeoutCause(cause)
                      ? `Delegate ${input.target} did not answer within ${Math.round(
                          DELEGATE_TURN_TIMEOUT_MILLIS / 60_000,
                        )} minutes. Report the step as timed out; do not write its answer yourself. Retry once, then switch targets.`
                      : `Delegate turn on ${input.target} failed: ${describeCause(cause)}`,
                    failureKind: isTimeoutCause(cause) ? "timeout" : "error",
                  }),
                ),
          ),
        );
      }).pipe(
        // A failed headless approval/user-input response can leave sendTurn
        // blocked forever. Observe the interaction fiber as part of the same
        // lifecycle so its typed failure interrupts the turn immediately.
        Effect.raceFirst(Fiber.join(delegateInteractionFiber)),
        // Cleanup wraps the race rather than either competitor. Interrupting
        // the interaction fiber from inside the delegate competitor would make
        // that competitor wait on the very fiber raceFirst is also stopping.
        Effect.ensuring(
          Effect.all(
            [
              adapter
                .stopSession(threadId)
                .pipe(Effect.timeout(SESSION_STOP_TIMEOUT_MILLIS), Effect.ignore),
              Fiber.interrupt(delegateInteractionFiber).pipe(
                Effect.andThen(Scope.close(interactionScope, Exit.void)),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        ),
      );

      const text = extractAssistantText(finalThread);

      if (!text) {
        return yield* new ResearchDelegateError({
          detail: `Empty response from ${input.target}. Report the step as failed rather than inventing its answer.`,
          failureKind: "empty",
        });
      }

      const truncated = text.length > DELEGATE_MAX_OUTPUT_CHARS;
      const completedMs = yield* Clock.currentTimeMillis;
      return {
        target: input.target,
        step: input.step,
        visit: input.visit,
        remainingBudget: charge.remaining,
        durationMs: Math.max(0, completedMs - nowMs),
        truncated,
        text: truncated ? text.slice(0, DELEGATE_MAX_OUTPUT_CHARS) : text,
      };
    });

const handlers = {
  research_delegate: makeResearchDelegateHandler(),
} satisfies Parameters<typeof ResearchToolkit.toLayer>[0];

export const ResearchToolkitHandlersLive = ResearchToolkit.toLayer(handlers);
