import {
  canStartProviderTurn,
  type ChatAttachment,
  CommandId,
  type DevSettings,
  type ResearchSettings,
  CheckpointRef,
  EventId,
  MessageId,
  type ModelSelection,
  type PipelineTargetPolicy,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  type ServerProvider,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@d4research/contracts";
import { extractTrailingEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@d4research/shared/git";
import {
  deriveDevProviderCandidates,
  expandDevPipelinePrompt,
  parseDevTrigger,
  providerDriverSupportsPipelineOrchestration,
  type DevProviderCandidate,
} from "@d4research/shared/devPipeline";
import {
  buildResearchRunManifest,
  deriveResearchProviderCandidatesFromProviders,
  expandResearchPipelinePrompt,
  parseInlineDelegateTrigger,
  parseResearchTrigger,
  type InlineDelegateTrigger,
  type ResearchProviderCandidate,
} from "@d4research/shared/researchPipeline";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@d4research/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import {
  INLINE_DELEGATE_TURN_PREFIX,
  INLINE_DELEGATION_STEP,
  InlineDelegationRunner,
  isInlineDelegateTurnId,
  resolveInlineDelegateTarget,
  type InlineDelegationResult,
} from "../../mcp/toolkits/research/inlineDelegation.ts";
import type { ResearchDelegateError } from "../../mcp/toolkits/research/tools.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";
export const PROVIDER_SESSION_START_TIMEOUT_MILLIS = 180_000;
export const PROVIDER_TURN_SEND_TIMEOUT_MILLIS = 180_000;

export function withProviderSessionStartDeadline<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly provider: string;
    readonly threadId: ThreadId;
    readonly timeoutMillis?: number;
  },
): Effect.Effect<A, E | ProviderAdapterRequestError, R> {
  const timeoutMillis = input.timeoutMillis ?? PROVIDER_SESSION_START_TIMEOUT_MILLIS;
  return effect.pipe(
    Effect.timeout(timeoutMillis),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: input.provider,
          method: "thread.turn.start",
          detail: `Provider session startup timed out after ${timeoutMillis}ms. Check the provider process and retry the turn.`,
        }),
      ),
    ),
  );
}

export function withProviderTurnSendDeadline<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly provider: string;
    readonly timeoutMillis?: number;
  },
): Effect.Effect<A, E | ProviderAdapterRequestError, R> {
  const timeoutMillis = input.timeoutMillis ?? PROVIDER_TURN_SEND_TIMEOUT_MILLIS;
  return effect.pipe(
    Effect.timeout(timeoutMillis),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: input.provider,
          method: "thread.turn.start",
          detail: `Provider did not accept the turn within ${timeoutMillis}ms. The session was stopped; retry when the provider is responsive.`,
        }),
      ),
    ),
  );
}

/**
 * Expand only the provider-bound copy of a dev trigger. The persisted message
 * remains the compact user-authored text, including when Claude prompt effort
 * prepends its transport-only `Ultrathink:` marker.
 */
export function expandProviderDevMessage(
  messageText: string,
  settings: Pick<DevSettings, "scenarios" | "activeScenario"> | undefined,
  candidates: ReadonlyArray<DevProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  const hasEffortPrefix = messageText.startsWith(CLAUDE_ULTRATHINK_PREFIX);
  const prompt = hasEffortPrefix ? messageText.slice(CLAUDE_ULTRATHINK_PREFIX.length) : messageText;
  if (parseDevTrigger(prompt) === null) return messageText;
  const expanded = expandDevPipelinePrompt(prompt, settings, candidates, targetPolicy);
  return hasEffortPrefix ? `${CLAUDE_ULTRATHINK_PREFIX}${expanded}` : expanded;
}

/**
 * Expand only the provider-bound copy of a research trigger. The compact
 * trigger remains in event history, transcripts, handoffs, and remote sync.
 */
export function expandProviderResearchMessage(
  messageText: string,
  settings:
    | Pick<ResearchSettings, "scenarios" | "activeScenario" | "pipelinePrompt" | "promptFiles">
    | undefined,
  candidates: ReadonlyArray<ResearchProviderCandidate>,
  targetPolicy: PipelineTargetPolicy = "labeled-fallback",
): string {
  const hasEffortPrefix = messageText.startsWith(CLAUDE_ULTRATHINK_PREFIX);
  const prompt = hasEffortPrefix ? messageText.slice(CLAUDE_ULTRATHINK_PREFIX.length) : messageText;
  if (parseResearchTrigger(prompt) === null) return messageText;
  const expanded = expandResearchPipelinePrompt(prompt, settings, candidates, targetPolicy);
  return hasEffortPrefix ? `${CLAUDE_ULTRATHINK_PREFIX}${expanded}` : expanded;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const inlineDelegationRunner = yield* InlineDelegationRunner;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const pendingSessionStarts = new Map<ThreadId, Fiber.Fiber<ProviderSession, unknown>>();
  const cancelledTurnStarts = new Set<ThreadId>();
  const activeTurnStartFibers = new Set<Fiber.Fiber<void, unknown>>();
  /**
   * Inline `!provider:model` turns run without a thread provider session, so
   * `providerService.interruptTurn` has nothing to interrupt. Stopping one
   * means interrupting its fiber; the delegation's own cleanup then stops the
   * adapter-local delegate session. A `null` value reserves the thread while
   * the turn is opening, which keeps a second concurrent delegation from
   * replacing (and orphaning) the first.
   */
  const activeInlineDelegations = new Map<ThreadId, Fiber.Fiber<void, unknown> | null>();
  /** Stops that arrived while a delegation was still opening. */
  const cancelledInlineDelegations = new Set<ThreadId>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.delegate.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendResearchRunStartedActivity = (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly manifest: NonNullable<ReturnType<typeof buildResearchRunManifest>>;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("research-run-started"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "info",
            kind: "research.run.started",
            summary: `Research scenario ${input.manifest.scenario} started`,
            payload: { messageId: input.messageId, ...input.manifest },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendProviderTargetActivity = (input: {
    readonly threadId: ThreadId;
    readonly requested: ModelSelection;
    readonly resolved: ModelSelection;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-target-selected"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "info",
            kind: "provider.target.selected",
            summary: "Provider target selected",
            payload: {
              requestedInstanceId: input.requested.instanceId,
              requestedModel: input.requested.model,
              resolvedInstanceId: input.resolved.instanceId,
              resolvedModel: input.resolved.model,
              resolutionSource: "d4research-adapter-target",
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Tool-lifecycle rows for an inline delegation, shaped exactly like the MCP
   * `research_delegate` calls a pipeline emits. The activity projection then
   * derives the same compact `data.researchDelegate` ledger, so the delegation
   * banner on web and the work log on mobile need no new payload shape.
   */
  const appendInlineDelegateActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly callId: string;
    readonly target: string;
    readonly settled: boolean;
    readonly failed: boolean;
    readonly detail: string | null;
    readonly output: { readonly remainingBudget: number; readonly durationMs: number } | null;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("inline-delegate-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: input.failed ? "error" : "tool",
            kind: input.settled ? "tool.completed" : "tool.started",
            summary: `Delegated to ${input.target}`,
            payload: {
              itemType: "mcp_tool_call",
              title: "research_delegate",
              status: input.failed ? "failed" : input.settled ? "completed" : "in_progress",
              ...(input.detail === null ? {} : { detail: input.detail }),
              data: {
                toolName: "research_delegate",
                toolCallId: input.callId,
                input: { target: input.target, step: INLINE_DELEGATION_STEP, visit: 1 },
                ...(input.output === null ? {} : { output: input.output }),
              },
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  /**
   * Session identity for an inline delegate turn. The thread's own provider is
   * never started, so the record keeps whatever provider the thread already
   * names — it exists to say "this thread is busy", not to claim a session. A
   * thread that never had one keeps `providerName: null`, which is the
   * existing "no native session was ever established" marker.
   */
  const inlineDelegateSessionBase = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession | null;
    readonly runtimeMode: RuntimeMode;
  }) => ({
    threadId: input.threadId,
    providerName: input.session?.providerName ?? null,
    ...(input.session?.providerInstanceId !== undefined
      ? { providerInstanceId: input.session.providerInstanceId }
      : {}),
    runtimeMode: input.session?.runtimeMode ?? input.runtimeMode,
  });

  /**
   * A settle dispatch must land: leaving it undone strands the turn "running"
   * forever. Transient engine failures get a bounded retry before the caller's
   * force-settle fallback takes over.
   */
  const withSettleRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, { times: 2, schedule: Schedule.exponential(50) });

  /**
   * Records a delegation as a checkpointed turn boundary. Inline delegates run
   * headless with every approval declined, so the capture finds no file
   * changes — the point is the turn ROW: revert retention keeps only turns that
   * carry a checkpoint, so a turn without one has its messages deleted by any
   * later revert. CheckpointReactor replaces this placeholder with a real git
   * ref, exactly as it does for provider-reported diffs.
   */
  const appendInlineDelegateCheckpoint = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly assistantMessageId: MessageId;
    readonly completedAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) return;
    const nextTurnCount =
      thread.checkpoints.reduce(
        (highest, checkpoint) => Math.max(highest, checkpoint.checkpointTurnCount),
        0,
      ) + 1;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("inline-delegate-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.completedAt,
      checkpointRef: CheckpointRef.make(`inline-delegate:${String(input.turnId)}`),
      status: "missing",
      files: [],
      assistantMessageId: input.assistantMessageId,
      checkpointTurnCount: nextTurnCount,
      createdAt: input.completedAt,
    });
  });

  const settleInlineDelegateTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly callId: string;
    readonly target: string;
    readonly sessionBase: ReturnType<typeof inlineDelegateSessionBase>;
    /** A thread with no session before the turn must not keep a synthetic one. */
    readonly hadSession: boolean;
    readonly exit: Exit.Exit<InlineDelegationResult, ResearchDelegateError>;
  }) {
    const settledAt = DateTime.formatIso(yield* DateTime.now);
    if (Exit.isSuccess(input.exit)) {
      const result = input.exit.value;
      // The delegate's answer is authored through the same assistant
      // delta/complete commands every adapter uses, so it lands in the visible
      // thread as an ordinary assistant message. Attribution stays in the
      // ledger below; the body is the delegate's own words, unprefixed.
      const messageId = MessageId.make(`assistant:inline-delegate:${String(input.turnId)}`);
      yield* withSettleRetry(
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* serverCommandId("inline-delegate-assistant-delta"),
            threadId: input.threadId,
            messageId,
            delta: result.text,
            turnId: input.turnId,
            createdAt: settledAt,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: yield* serverCommandId("inline-delegate-assistant-complete"),
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: settledAt,
          });
        }),
      );
      yield* withSettleRetry(
        appendInlineDelegateActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          callId: input.callId,
          target: input.target,
          settled: true,
          failed: false,
          detail: null,
          output: { remainingBudget: result.remainingBudget, durationMs: result.durationMs },
          createdAt: settledAt,
        }),
      );
      yield* withSettleRetry(
        setThreadSession({
          threadId: input.threadId,
          session: {
            ...input.sessionBase,
            // A thread that had no provider session keeps none: "stopped" is
            // the sessionless resting state, and it settles the turn just as
            // "ready" does.
            status: input.hadSession ? "ready" : "stopped",
            activeTurnId: null,
            lastError: null,
            updatedAt: settledAt,
          },
          createdAt: settledAt,
        }),
      );
      // Best effort and last: a missing checkpoint costs revert fidelity, but
      // failing here must not undo an answer the user can already read.
      yield* appendInlineDelegateCheckpoint({
        threadId: input.threadId,
        turnId: input.turnId,
        assistantMessageId: messageId,
        completedAt: settledAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor could not checkpoint an inline delegation", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      return;
    }

    const interrupted = Cause.hasInterruptsOnly(input.exit.cause);
    const failure = input.exit.cause.reasons.find(Cause.isFailReason)?.error;
    const detail = interrupted
      ? "You stopped this delegation."
      : (failure?.detail ?? Cause.pretty(input.exit.cause));
    yield* withSettleRetry(
      appendInlineDelegateActivity({
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.callId,
        target: input.target,
        settled: true,
        failed: true,
        detail,
        output: null,
        createdAt: settledAt,
      }),
    );
    if (!interrupted) {
      yield* withSettleRetry(
        appendProviderFailureActivity({
          threadId: input.threadId,
          kind: "provider.turn.delegate.failed",
          summary: `Delegation to ${input.target} failed`,
          // The typed failureKind keeps "timed out" distinguishable from
          // "refused" in the thread, exactly as a pipeline run reports it.
          detail: failure?.failureKind ? `${failure.failureKind}: ${detail}` : detail,
          turnId: input.turnId,
          createdAt: settledAt,
        }),
      );
    }
    yield* withSettleRetry(
      setThreadSession({
        threadId: input.threadId,
        session: {
          ...input.sessionBase,
          status: interrupted ? "stopped" : "error",
          activeTurnId: null,
          lastError: interrupted ? null : detail,
          updatedAt: settledAt,
        },
        createdAt: settledAt,
      }),
    );
  });

  /**
   * Last resort when the settle sequence itself could not be written. Nothing
   * may stay "running": this clears the turn even if the richer rows are lost.
   */
  const forceSettleInlineDelegateTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly sessionBase: ReturnType<typeof inlineDelegateSessionBase>;
    readonly detail: string;
  }) {
    const settledAt = DateTime.formatIso(yield* DateTime.now);
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...input.sessionBase,
        status: "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: settledAt,
      },
      createdAt: settledAt,
    });
  });

  /**
   * Answers one `!provider:model <task>` message with a bounded delegation to
   * the mentioned target. The thread's model selection, provider session, and
   * history are untouched: no session is started, nothing is expanded, and the
   * persisted user message stays the compact trigger the user typed.
   *
   * The delegate runs headless with approval-required runtime mode and every
   * request auto-declined, so it cannot edit the worktree.
   */
  const startInlineDelegateTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly createdAt: string;
    readonly trigger: InlineDelegateTrigger;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly session: OrchestrationSession | null;
    readonly runtimeMode: RuntimeMode;
    readonly shareMemoContext: boolean;
  }) {
    const refuse = (detail: string) => ({
      refused: new ProviderAdapterRequestError({
        provider: input.trigger.directive.provider,
        method: "thread.turn.start",
        detail,
      }),
    });

    // Reserved synchronously, before the first yield: two turn-start fibers for
    // one thread run concurrently, and a second delegation would otherwise
    // replace the first in the registry — orphaning it, uninterruptible.
    if (activeInlineDelegations.has(input.threadId)) {
      return refuse(
        "A delegation is already running in this thread. Wait for it to finish or stop it first.",
      );
    }
    // A correct client never sends both, because a delegate turn skips the
    // staged handoff. If the combination arrives anyway, the carried context is
    // labeled for a provider that is not the one about to answer.
    if (input.messageText.includes("<handoff_context>")) {
      return refuse(
        "A delegation cannot carry a provider handoff. Send the handoff as a normal message first.",
      );
    }
    const resolved = resolveInlineDelegateTarget(input.trigger.directive, input.providers);
    if (!resolved.ok) {
      // Nothing may stay "running" on an unresolvable directive: the caller
      // ends the turn visibly, naming the directive that could not resolve.
      return refuse(
        `\`${input.trigger.directive.raw}\` could not be delegated. ${resolved.detail}`,
      );
    }
    activeInlineDelegations.set(input.threadId, null);

    const turnId = TurnId.make(`${INLINE_DELEGATE_TURN_PREFIX}${input.messageId}`);
    // The clients fold a tool lifecycle's rows together by call id; one
    // delegation per turn means the turn id is already that identity.
    const callId = String(turnId);
    const hadSession = input.session !== null;
    const sessionBase = inlineDelegateSessionBase({
      threadId: input.threadId,
      session: input.session,
      runtimeMode: input.runtimeMode,
    });
    const releaseSlot = Effect.sync(() => {
      activeInlineDelegations.delete(input.threadId);
      cancelledInlineDelegations.delete(input.threadId);
    });
    const opened = yield* Effect.gen(function* () {
      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          ...sessionBase,
          status: "running",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      yield* appendInlineDelegateActivity({
        threadId: input.threadId,
        turnId,
        callId,
        target: resolved.target.resolvedTarget,
        settled: false,
        failed: false,
        detail: null,
        output: null,
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        releaseSlot.pipe(
          Effect.andThen(
            Effect.logWarning("provider command reactor could not open an inline delegate turn", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.as(false),
        ),
      ),
    );
    if (!opened) {
      return refuse("The delegation could not be started. Try again.");
    }

    const fiber = yield* inlineDelegationRunner
      .run({
        orchestratorThreadId: input.threadId,
        // One user turn is one run, so an inline delegation draws on the same
        // per-run ceiling a pipeline turn would.
        runId: `${String(input.threadId)}:${String(turnId)}`,
        requestedTarget: resolved.target.resolvedTarget,
        resolvedTarget: resolved.target.resolvedTarget,
        substituted: false,
        parsedTarget: { instanceId: resolved.target.instanceId, model: resolved.target.model },
        prompt: input.trigger.task,
        attachments: input.attachments,
        // Inline delegation authors no scenario, so it has no prompt files.
        resolvePromptFile: Effect.succeed(null),
        shareMemoContext: input.shareMemoContext,
        step: INLINE_DELEGATION_STEP,
        visit: 1,
      })
      .pipe(
        // A finalizer, so a cancelled delegation still records its outcome
        // instead of leaving the thread stuck on a running turn.
        Effect.onExit((exit) =>
          settleInlineDelegateTurn({
            threadId: input.threadId,
            turnId,
            callId,
            target: resolved.target.resolvedTarget,
            sessionBase,
            hadSession,
            exit,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider command reactor failed to settle inline delegation", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }).pipe(
                Effect.andThen(
                  forceSettleInlineDelegateTurn({
                    threadId: input.threadId,
                    sessionBase,
                    detail: `The delegation to ${resolved.target.resolvedTarget} ended, but its result could not be recorded. Send the message again.`,
                  }).pipe(Effect.catchCause(() => Effect.void)),
                ),
              ),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("provider command reactor inline delegation failed", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.asVoid,
        Effect.forkScoped,
      );
    activeInlineDelegations.set(input.threadId, fiber);
    yield* Fiber.await(fiber).pipe(Effect.ensuring(releaseSlot), Effect.forkScoped);
    // A stop that landed while this turn was opening still applies.
    if (cancelledInlineDelegations.delete(input.threadId)) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
    return { refused: null };
  });

  /** Stops a running inline delegation; true when one was actually stopped. */
  const interruptInlineDelegation = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (!activeInlineDelegations.has(threadId)) return false;
    const fiber = activeInlineDelegations.get(threadId) ?? null;
    if (fiber === null) {
      // Still opening: the starter honors this the moment its fiber exists.
      cancelledInlineDelegations.add(threadId);
      return true;
    }
    activeInlineDelegations.delete(threadId);
    yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    return true;
  });

  /**
   * A delegation cannot survive a restart: its fiber and the delegate process
   * are both gone. Any thread still projected as running one is settled here
   * with a visible failure, because nothing may stay "running" across a
   * restart.
   */
  const reconcileInterruptedInlineDelegation = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly reconciledAt: string;
  }) {
    const turnId = input.session.activeTurnId;
    if (turnId !== null) {
      yield* appendInlineDelegateActivity({
        threadId: input.threadId,
        turnId,
        callId: String(turnId),
        target: "delegate",
        settled: true,
        failed: true,
        detail: "The delegation did not survive a d4research restart.",
        output: null,
        createdAt: input.reconciledAt,
      }).pipe(Effect.catchCause(() => Effect.void));
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...input.session,
        status: "error",
        activeTurnId: null,
        lastError: "The delegation did not survive a d4research restart. Send the message again.",
        updatedAt: input.reconciledAt,
      },
      createdAt: input.reconciledAt,
    });
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (
      activeThreadSession !== null &&
      (requestedModelSelection === undefined ||
        requestedModelSelection.instanceId === currentInstanceId)
    ) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) => {
      const start = withProviderSessionStartDeadline(
        providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        }),
        {
          provider: providerErrorLabel(String(desiredInstanceId)),
          threadId,
        },
      );
      if (options?.pendingTurnStart !== true) {
        return start;
      }
      return Effect.gen(function* () {
        const fiber = yield* start.pipe(Effect.forkScoped);
        pendingSessionStarts.set(threadId, fiber);
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (pendingSessionStarts.get(threadId) === fiber) {
                pendingSessionStarts.delete(threadId);
              }
            }),
          ),
        );
      });
    };

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const continuationChanged =
        instanceChanged &&
        (currentInfo.driverKind !== desiredInfo.driverKind ||
          currentInfo.continuationIdentity.continuationKey !==
            desiredInfo.continuationIdentity.continuationKey);
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        shouldRestartForModelChange || continuationChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const settings = yield* serverSettingsService.getSettings;
    const providers = yield* providerRegistry.getProviders;
    const promptWithoutEffort = message.text.startsWith(CLAUDE_ULTRATHINK_PREFIX)
      ? message.text.slice(CLAUDE_ULTRATHINK_PREFIX.length)
      : message.text;
    const pipelineKind =
      parseDevTrigger(promptWithoutEffort) !== null
        ? "dev"
        : parseResearchTrigger(promptWithoutEffort) !== null
          ? "research"
          : null;
    // A leading `!provider:model` answers this one message from that target
    // instead of the thread's provider. Diverted before any pipeline expansion
    // and before the thread's provider is even consulted: nothing about the
    // thread's session or model selection takes part in this turn.
    // The normalizer appends the thread's enabled-skills block to every user
    // turn. That is wiring for the thread's own agent, not part of the single
    // question a delegate is being asked, so it is peeled off first. The
    // effort marker is NOT peeled here — `parseInlineDelegateTrigger` owns
    // that, so clients and server can never disagree about what parses.
    const inlineDelegateTrigger =
      pipelineKind === null
        ? parseInlineDelegateTrigger(
            message.text.includes("<enabled_skills")
              ? extractTrailingEnabledSkillsContext(message.text).promptText
              : message.text,
          )
        : null;
    if (inlineDelegateTrigger !== null) {
      const inlineDelegate = yield* startInlineDelegateTurn({
        threadId: event.payload.threadId,
        messageId: String(event.payload.messageId),
        messageText: message.text,
        attachments: message.attachments ?? [],
        createdAt: event.payload.createdAt,
        trigger: inlineDelegateTrigger,
        providers,
        session: thread.session ?? null,
        runtimeMode: thread.runtimeMode,
        shareMemoContext: settings.research.shareMemoContext,
      });
      if (inlineDelegate.refused !== null) {
        yield* handleTurnStartFailure(Cause.fail(inlineDelegate.refused));
      }
      return;
    }
    const desiredInstanceId =
      event.payload.modelSelection?.instanceId ?? thread.modelSelection.instanceId;
    const desiredProvider = providers.find((provider) => provider.instanceId === desiredInstanceId);
    if (desiredProvider === undefined || !canStartProviderTurn(desiredProvider)) {
      const providerName =
        desiredProvider?.displayName ?? String(desiredProvider?.instanceId ?? desiredInstanceId);
      const remediation =
        desiredProvider?.readiness?.remediation ??
        desiredProvider?.message ??
        "Open Settings → Providers, refresh this provider, and resolve its setup status.";
      yield* handleTurnStartFailure(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: String(desiredInstanceId),
            method: "thread.turn.start",
            detail: `${providerName} is not ready to start a turn. ${remediation}`,
          }),
        ),
      );
      return;
    }
    if (
      pipelineKind !== null &&
      !providerDriverSupportsPipelineOrchestration(String(desiredProvider.driver))
    ) {
      yield* handleTurnStartFailure(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: String(desiredProvider.instanceId),
            method: "thread.turn.start",
            detail: `${desiredProvider.displayName ?? desiredProvider.instanceId} cannot orchestrate ${pipelineKind} pipelines because its adapter does not expose MCP tools. Select Claude, Codex, Cursor, Grok, or OpenCode for the orchestrator; the pipeline may still delegate work to ${desiredProvider.displayName ?? desiredProvider.instanceId}.`,
          }),
        ),
      );
      return;
    }
    const researchCandidates = deriveResearchProviderCandidatesFromProviders(providers);
    const researchRunManifest = buildResearchRunManifest(
      promptWithoutEffort,
      settings.research,
      researchCandidates,
      settings.pipelineTargetPolicy,
    );
    if (researchRunManifest !== null) {
      yield* appendResearchRunStartedActivity({
        threadId: event.payload.threadId,
        messageId: String(event.payload.messageId),
        manifest: researchRunManifest,
        createdAt: event.payload.createdAt,
      });
    }
    const devExpandedMessageText = expandProviderDevMessage(
      message.text,
      settings.dev,
      deriveDevProviderCandidates(providers),
      settings.pipelineTargetPolicy,
    );
    const providerMessageText = expandProviderResearchMessage(
      devExpandedMessageText,
      settings.research,
      researchCandidates,
      settings.pipelineTargetPolicy,
    );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: providerMessageText,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      cancelledTurnStarts.delete(event.payload.threadId);
      return;
    }

    if (cancelledTurnStarts.delete(event.payload.threadId)) {
      yield* providerService
        .stopSession({ threadId: event.payload.threadId })
        .pipe(Effect.catchCause(() => Effect.void));
      const cancelledThread = yield* resolveThread(event.payload.threadId);
      if (cancelledThread !== undefined) {
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...(cancelledThread.session ?? {
              threadId: event.payload.threadId,
              providerName: desiredProvider.driver,
              providerInstanceId: desiredProvider.instanceId,
              runtimeMode: cancelledThread.runtimeMode,
            }),
            status: "stopped",
            activeTurnId: null,
            lastError: null,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
      }
      return;
    }

    const requestedModelSelection = event.payload.modelSelection ?? thread.modelSelection;
    const resolvedModelSelection = sendTurnRequest.value.modelSelection ?? requestedModelSelection;
    yield* appendProviderTargetActivity({
      threadId: event.payload.threadId,
      requested: requestedModelSelection,
      resolved: resolvedModelSelection,
      createdAt: event.payload.createdAt,
    });

    yield* withProviderTurnSendDeadline(providerService.sendTurn(sendTurnRequest.value), {
      provider: String(desiredProvider.instanceId),
    }).pipe(
      Effect.catchCause((cause) =>
        providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.andThen(recoverTurnStartFailure(cause)),
        ),
      ),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    // An inline delegate turn owns no thread provider session, so it is
    // stopped by interrupting its fiber; its finalizer settles the turn.
    if (yield* interruptInlineDelegation(event.payload.threadId)) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    if (thread.session?.status === "starting") {
      cancelledTurnStarts.add(event.payload.threadId);
      const pendingStart = pendingSessionStarts.get(event.payload.threadId);
      if (pendingStart !== undefined) {
        yield* Fiber.interrupt(pendingStart).pipe(Effect.ignore);
      }
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...thread.session,
          status: "stopped",
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) => {
        const detail = formatFailureDetail(cause);
        return setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...thread.session!,
            status: "error",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.andThen(
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail,
              turnId: event.payload.turnId ?? null,
              createdAt: event.payload.createdAt,
            }),
          ),
          Effect.asVoid,
        );
      }),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    // Stopping the thread stops an inline delegation too; its finalizer marks
    // the turn stopped, so this handler must not also rewrite that state.
    if (yield* interruptInlineDelegation(event.payload.threadId)) {
      return;
    }
    if (thread.session?.status === "starting") {
      cancelledTurnStarts.add(event.payload.threadId);
      const pendingStart = pendingSessionStarts.get(event.payload.threadId);
      if (pendingStart !== undefined) {
        yield* Fiber.interrupt(pendingStart).pipe(Effect.ignore);
      }
    }
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService
        .stopSession({ threadId: thread.id })
        .pipe(Effect.catchCause(() => Effect.void));
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        {
          const fiber = yield* processTurnStartRequested(event).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
              return Effect.logWarning("provider turn-start fiber failed", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              });
            }),
            Effect.forkScoped,
          );
          activeTurnStartFibers.add(fiber);
          yield* Fiber.await(fiber).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeTurnStartFibers.delete(fiber);
              }),
            ),
            Effect.forkScoped,
          );
        }
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.gen(function* () {
      const [readModel, liveSessions] = yield* Effect.all([
        projectionSnapshotQuery.getCommandReadModel(),
        providerService.listSessions(),
      ]);
      const liveThreadIds = new Set(liveSessions.map((session) => session.threadId));
      const staleThreads = Object.values(readModel.threads).filter(
        (thread) =>
          thread.session !== null &&
          thread.session.status !== "stopped" &&
          !liveThreadIds.has(thread.id),
      );
      const reconciledAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.forEach(
        staleThreads,
        (thread) =>
          // An inline delegation owns no provider session, so the generic
          // "the provider session ended" message would be a lie. Settle it as
          // the interrupted delegation it is.
          isInlineDelegateTurnId(thread.session!.activeTurnId)
            ? reconcileInterruptedInlineDelegation({
                threadId: thread.id,
                session: thread.session!,
                reconciledAt,
              })
            : setThreadSession({
                threadId: thread.id,
                session: {
                  ...thread.session!,
                  status: "error",
                  activeTurnId: null,
                  lastError:
                    "The provider session ended while d4research was offline. Retry the turn to continue.",
                  updatedAt: reconciledAt,
                },
                createdAt: reconciledAt,
              }),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor could not reconcile stale sessions", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* Effect.forEach([...activeTurnStartFibers], Fiber.await, { discard: true });
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
