import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  RuntimeRequestId,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { MIN_SCHEDULED_TASK_INTERVAL_MS, ScheduledTaskFixedTimeSchedule } from "./scheduledTask.ts";

export const D4AgentPermissionMode = Schema.Literals(["read-only", "ask", "act"]);
export const D4_BRAIN_CONTEXTS = ["Global", "Personal", "YB", "Dimaggi"] as const;
export const D4BrainContext = Schema.Literals(D4_BRAIN_CONTEXTS);
export type D4BrainContext = typeof D4BrainContext.Type;
// Only these adapters enforce the d4 Agent's MCP tool allowlist and read-only sandbox.
export const D4_AGENT_PROVIDER_DRIVERS: ReadonlyArray<string> = ["codex", "claudeAgent"];
// A fresh install has no local model, so Nia starts on the bundled Claude instance.
export const DEFAULT_D4_AGENT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
} satisfies ModelSelection;
export const supportsD4AgentDriver = (driver: string): boolean =>
  D4_AGENT_PROVIDER_DRIVERS.includes(driver);
export const D4AgentSwitchContextInput = Schema.Struct({ context: D4BrainContext });
export type D4AgentSwitchContextInput = typeof D4AgentSwitchContextInput.Type;
export const D4BrainIndexStatus = Schema.Struct({
  context: D4BrainContext,
  status: Schema.Literals(["ready", "not-indexed", "not-available", "disabled", "refused"]),
  files: NonNegativeInt,
  lastRebuild: Schema.NullOr(IsoDateTime),
});
export const D4AgentResolveMemoryProposalInput = Schema.Struct({
  proposalId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  approve: Schema.Boolean,
});
export type D4AgentResolveMemoryProposalInput = typeof D4AgentResolveMemoryProposalInput.Type;
export const D4MemoryProposal = Schema.Struct({
  id: Schema.String,
  context: D4BrainContext,
  text: Schema.String,
  status: Schema.Literals(["pending", "approved", "rejected"]),
  createdAt: Schema.NullOr(IsoDateTime),
});
export const D4AgentQuietHours = Schema.Struct({
  startMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  endMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  utcOffsetMinutes: Schema.Int.check(Schema.isBetween({ minimum: -840, maximum: 840 })),
  // IANA zone; when present it wins over the fixed offset so quiet hours follow DST.
  timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
export const D4AgentSettings = Schema.Struct({
  sessionIdleMinutes: Schema.NullOr(Schema.Literals([30, 120, 480])).pipe(
    Schema.withDecodingDefault(Effect.succeed(120)),
  ),
  sessionBudgetPercent: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 90 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(60)),
  ),
  // 0 archives a completed task as soon as it is reported.
  agentThreadArchiveHours: Schema.NullOr(Schema.Literals([0, 24])).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  // Base ref for a fresh worktree per Nia task, for projects whose root checkout lacks the code.
  projectWorktreeBaseRefs: Schema.Record(
    ProjectId,
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  pipelineProjects: Schema.Record(Schema.String, ProjectId).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  brainVaultPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  memoryEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  embeddingsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  embeddingBaseUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  embeddingModel: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  projectContexts: Schema.Record(ProjectId, D4BrainContext).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  overviewSources: Schema.Record(Schema.String, D4BrainContext).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  ctoEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ctoBaseUrl: Schema.String.check(Schema.isMaxLength(2048)).pipe(
    Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:9093")),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_D4_AGENT_MODEL_SELECTION)),
  ),
  // The exact provider instance and model used for new Nia-created work.
  // Null is intentional: the manager model must never become an implicit worker fallback.
  taskModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  permissionMode: D4AgentPermissionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("read-only")),
  ),
  heartbeatMinutes: Schema.NullOr(Schema.Literals([15, 30, 60])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  quietHours: Schema.NullOr(D4AgentQuietHours).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  systemProbeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diskWarningPercent: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 99 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(90)),
  ),
  // A local tg-proxy that judges each Nia action; null keeps the built-in approval rules.
  toolGuardUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type D4AgentSettings = typeof D4AgentSettings.Type;
export const DEFAULT_D4_AGENT_SETTINGS: D4AgentSettings = {
  sessionIdleMinutes: 120,
  sessionBudgetPercent: 60,
  agentThreadArchiveHours: 0,
  projectWorktreeBaseRefs: {},
  pipelineProjects: {},
  brainVaultPath: "",
  memoryEnabled: false,
  embeddingsEnabled: false,
  embeddingBaseUrl: null,
  embeddingModel: null,
  projectContexts: {},
  overviewSources: {},
  ctoEnabled: false,
  ctoBaseUrl: "http://127.0.0.1:9093",
  enabled: false,
  modelSelection: DEFAULT_D4_AGENT_MODEL_SELECTION,
  taskModelSelection: null,
  permissionMode: "read-only",
  heartbeatMinutes: null,
  quietHours: null,
  systemProbeEnabled: false,
  diskWarningPercent: 90,
  toolGuardUrl: null,
};

export const D4RoutineDraft = Schema.Struct({
  pipelineId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  modelSelection: ModelSelection,
  schedule: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("interval"),
      everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS)),
    }),
    ScheduledTaskFixedTimeSchedule,
  ]),
});
export const D4RoutineReadiness = Schema.Struct({
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  checks: Schema.Array(
    Schema.Struct({
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      passed: Schema.Boolean,
      evidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  limitations: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
    Schema.isMaxLength(20),
  ),
});
export const D4AgentRoutine = Schema.Struct({
  id: Schema.String,
  context: D4BrainContext,
  projectId: ProjectId,
  threadId: ThreadId,
  taskId: Schema.NullOr(ScheduledTaskId),
  status: Schema.Literals(["preparing", "ready", "activated", "failed"]),
  failure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  draft: D4RoutineDraft,
  readiness: Schema.NullOr(D4RoutineReadiness),
  createdAt: IsoDateTime,
});
export type D4AgentRoutine = typeof D4AgentRoutine.Type;

export const D4AgentAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("prepare-routine"), ...D4RoutineDraft.fields }),
  Schema.Struct({
    type: Schema.Literal("activate-routine"),
    routineId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    readiness: D4RoutineReadiness,
  }),
  Schema.Struct({
    type: Schema.Literal("set-schedule-enabled"),
    taskId: ScheduledTaskId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("auto-archive"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("pipeline"),
    projectId: ProjectId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    modelSelection: ModelSelection,
    pipelineId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    type: Schema.Literal("research"),
    projectId: ProjectId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    modelSelection: ModelSelection,
    pipelineId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    type: Schema.Literal("memory-propose"),
    context: D4BrainContext,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  }),
  Schema.Struct({
    type: Schema.Literal("cto-ask"),
    context: D4BrainContext,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  }),
  Schema.Struct({
    type: Schema.Literal("send"),
    originalText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  }),
  Schema.Struct({ type: Schema.Literal("interrupt"), threadId: ThreadId }),
  // Continues a pipeline run that a restart, a stop or a failure cut short.
  Schema.Struct({ type: Schema.Literal("resume"), threadId: ThreadId }),
  // The user asked to archive this thread; auto-archive is only for threads Nia started.
  Schema.Struct({ type: Schema.Literal("archive"), threadId: ThreadId }),
  // Thread lifecycle changes on any thread in scope, including ones Nia did not start.
  Schema.Struct({ type: Schema.Literal("settle"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("unsettle"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("snooze"), threadId: ThreadId, until: IsoDateTime }),
  Schema.Struct({ type: Schema.Literal("unsnooze"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("answer"),
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    answers: Schema.Record(
      Schema.String.check(Schema.isMaxLength(256)),
      Schema.Array(Schema.String.check(Schema.isMaxLength(4000))).check(Schema.isMaxLength(16)),
    ).check(
      Schema.makeFilter(
        (answers) => Object.keys(answers).length <= 16 && JSON.stringify(answers).length <= 64000,
      ),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("start"),
    projectId: ProjectId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    modelSelection: ModelSelection,
  }),
  // One shell command on the host's desktop session; Tool Guard sees it as text.
  Schema.Struct({
    type: Schema.Literal("pc"),
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  // A one-time note posted into Nia's chat at the given time.
  Schema.Struct({
    type: Schema.Literal("remind"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
    at: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel-reminder"),
    reminderId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  // A recurring agent run in a project, stored as an ordinary scheduled task.
  Schema.Struct({
    type: Schema.Literal("schedule"),
    projectId: ProjectId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    modelSelection: ModelSelection,
    schedule: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("interval"),
        everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS)),
      }),
      ScheduledTaskFixedTimeSchedule,
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("unschedule"), taskId: ScheduledTaskId }),
  // The agent names a thread or project; the server fills targetContext, title and originalText.
  Schema.Struct({
    type: Schema.Literal("switch-context"),
    threadId: Schema.optionalKey(ThreadId),
    projectId: Schema.optionalKey(ProjectId),
    targetContext: Schema.optionalKey(D4BrainContext),
    title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    originalText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
  }),
]);
export type D4AgentAction = typeof D4AgentAction.Type;
export const D4AgentGuardVerdict = Schema.Struct({
  decision: Schema.Literals(["allowed", "flagged", "escalated", "denied", "unavailable"]),
  rule: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type D4AgentGuardVerdict = typeof D4AgentGuardVerdict.Type;
// Nia's one-line reason for an action and what it will change, shown on the approval card.
export const D4AgentActionNote = Schema.Struct({
  why: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  effect: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type D4AgentActionNote = typeof D4AgentActionNote.Type;
export const D4AgentActionRecord = Schema.Struct({
  context: D4BrainContext.pipe(Schema.withDecodingDefault(Effect.succeed("Global"))),
  sessionId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  result: Schema.optionalKey(Schema.Unknown),
  id: Schema.String,
  action: D4AgentAction,
  note: Schema.optionalKey(D4AgentActionNote),
  guard: Schema.optionalKey(D4AgentGuardVerdict),
  // Why an approved action failed, in words the user can act on.
  failure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  // Set when Nia replaced this pending card with a newer one for the same target.
  supersededBy: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "approved", "denied", "executed", "failed"]),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type D4AgentActionRecord = typeof D4AgentActionRecord.Type;
export const D4AgentActionSummary = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals([
    "send",
    "interrupt",
    "resume",
    "archive",
    "settle",
    "unsettle",
    "snooze",
    "unsnooze",
    "answer",
    "start",
    "memory-propose",
    "cto-ask",
    "pipeline",
    "research",
    "auto-archive",
    "switch-context",
    "pc",
    "remind",
    "cancel-reminder",
    "schedule",
    "unschedule",
    "prepare-routine",
    "activate-routine",
    "set-schedule-enabled",
  ]),
  targetId: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
  preview: Schema.String.check(Schema.isMaxLength(256)),
  note: Schema.optionalKey(D4AgentActionNote),
  status: D4AgentActionRecord.fields.status,
  failure: D4AgentActionRecord.fields.failure,
  guard: Schema.optionalKey(D4AgentGuardVerdict),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type D4AgentActionSummary = typeof D4AgentActionSummary.Type;
export const D4AgentGetActionInput = Schema.Struct({
  actionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type D4AgentGetActionInput = typeof D4AgentGetActionInput.Type;
export const D4AgentSystemCheck = Schema.Struct({
  notificationEligible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  id: Schema.Literals([
    "user-units",
    "system-units",
    "os-updates",
    "doctor",
    "root-disk",
    "data-disk",
    "server",
  ]),
  title: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["ok", "info", "attention", "unavailable", "disabled"]),
  reportKey: Schema.String,
  value: Schema.NullOr(Schema.Number),
});
export type D4AgentSystemCheck = typeof D4AgentSystemCheck.Type;
export const D4AgentSystemHealthState = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  systemHealth: Schema.Array(D4AgentSystemCheck),
});
export type D4AgentSystemHealthState = typeof D4AgentSystemHealthState.Type;
export const D4AgentTurnUsage = Schema.Struct({
  runId: Schema.String,
  recordedAt: IsoDateTime,
  attributes: Schema.Struct({
    "gen_ai.provider.name": Schema.String,
    "gen_ai.request.model": Schema.String,
    "gen_ai.operation.name": Schema.Literal("chat"),
    "gen_ai.conversation.id": Schema.String,
    "gen_ai.usage.input_tokens": Schema.optionalKey(NonNegativeInt),
    "gen_ai.usage.output_tokens": Schema.optionalKey(NonNegativeInt),
    "gen_ai.usage.cache_read.input_tokens": Schema.optionalKey(NonNegativeInt),
    "gen_ai.usage.cache_creation.input_tokens": Schema.optionalKey(NonNegativeInt),
    "d4.agent.duration_ms": NonNegativeInt,
  }),
});
export type D4AgentTurnUsage = typeof D4AgentTurnUsage.Type;
export const D4AgentLink = Schema.Struct({
  label: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
});
export type D4AgentLink = typeof D4AgentLink.Type;
export const D4AgentTranscriptEntry = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  context: D4BrainContext,
  createdAt: IsoDateTime,
  links: Schema.Array(D4AgentLink),
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
});
export type D4AgentTranscriptEntry = typeof D4AgentTranscriptEntry.Type;
export const D4AgentOpenSession = Schema.Struct({
  context: D4BrainContext,
  threadId: ThreadId,
  providerSessionId: Schema.NullOr(Schema.String),
  lastActivityAt: IsoDateTime,
  inputTokens: NonNegativeInt,
  contextWindow: Schema.NullOr(NonNegativeInt),
});
export const D4AgentReminder = Schema.Struct({
  id: Schema.String,
  context: D4BrainContext,
  text: Schema.String,
  at: IsoDateTime,
});
export type D4AgentReminder = typeof D4AgentReminder.Type;
const HostRoutineTimestamp = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
  ),
);
export const D4HostRoutine = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  context: D4BrainContext,
  source: Schema.Literals(["systemd", "cron"]),
  schedule: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  enabled: Schema.NullOr(Schema.Boolean),
  nextRunAt: Schema.NullOr(HostRoutineTimestamp),
  lastRunAt: Schema.NullOr(HostRoutineTimestamp),
  lastRunStatus: Schema.String.check(Schema.isMaxLength(200)),
  observedAt: HostRoutineTimestamp,
  capability: Schema.Literal("read-only"),
});
export type D4HostRoutine = typeof D4HostRoutine.Type;
export const D4HostRoutinesState = Schema.Struct({
  status: Schema.Literals(["available", "not-configured", "unavailable"]),
  routines: Schema.Array(D4HostRoutine).check(Schema.isMaxLength(100)),
});
export type D4HostRoutinesState = typeof D4HostRoutinesState.Type;

export const D4AgentState = Schema.Struct({
  hostRoutines: Schema.optionalKey(D4HostRoutinesState),
  routines: Schema.optionalKey(Schema.Array(D4AgentRoutine)),
  transcript: Schema.optionalKey(Schema.Array(D4AgentTranscriptEntry)),
  chatThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  openSessions: Schema.optionalKey(Schema.Array(D4AgentOpenSession)),
  sessionChangeReason: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["context", "new-session", "resumed", "size"])),
  ),
  memoryProposals: Schema.optionalKey(Schema.Array(D4MemoryProposal)),
  /** All pending proposals in the bound context; `memoryProposals` holds only the first page. */
  memoryProposalCount: Schema.optionalKey(NonNegativeInt),
  otherContextProposalCounts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ context: D4BrainContext, count: NonNegativeInt })),
  ),
  ctoAskInFlight: Schema.optionalKey(Schema.Boolean),
  brainContext: D4BrainContext.pipe(Schema.withDecodingDefault(Effect.succeed("Global"))),
  contextChangedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  brainIndexes: Schema.Array(D4BrainIndexStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  modelAvailable: Schema.Boolean,
  unavailableReason: Schema.NullOr(
    Schema.Literals([
      "disabled",
      "model-not-selected",
      "provider-unavailable",
      "model-unavailable",
      "option-unavailable",
      "sandbox-unavailable",
    ]),
  ),
  actionLog: Schema.Array(D4AgentActionSummary),
  reminders: Schema.optionalKey(Schema.Array(D4AgentReminder)),
  systemHealth: Schema.Array(D4AgentSystemCheck),
  usage: Schema.Array(D4AgentTurnUsage),
});
export type D4AgentState = typeof D4AgentState.Type;
export const D4AgentEnsureThreadResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
});
export const D4AgentIdentity = Schema.NullOr(D4AgentEnsureThreadResult);
export type D4AgentIdentity = typeof D4AgentIdentity.Type;
export const D4AgentSendInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(16000)),
  attachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
  // Request-local worker intent. The server snapshots it with the user message so a later
  // settings change cannot rewrite the worker on a pending proposal.
  taskModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  // The context and session the user wrote the message for. The server rejects the send as
  // "stale" when either one changed in the meantime. Both are required; they decode as optional
  // only so a client that omits them gets "client-outdated" instead of a schema error.
  expectedContext: Schema.optionalKey(D4BrainContext),
  expectedThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
}).check(
  Schema.makeFilter(
    (input) => input.text.trim().length > 0 || (input.attachments?.length ?? 0) > 0,
  ),
);
export const D4AgentResolveActionInput = Schema.Struct({
  actionId: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
  editedText: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  ),
  sendOriginal: Schema.optionalKey(Schema.Boolean),
});
export class D4AgentError extends Schema.TaggedError<D4AgentError>()("D4AgentError", {
  reason: Schema.Literals([
    "disabled",
    "model-not-selected",
    "provider-unavailable",
    "model-unavailable",
    "option-unavailable",
    "sandbox-unavailable",
    "read-only",
    "action-unavailable",
    "request-not-answerable",
    "storage",
    "thread",
    "busy",
    "stale",
    "client-outdated",
    "context",
    "memory-unavailable",
    "cto-unreachable",
    "cto-response",
    "guard-denied",
  ]),
  cause: Schema.optional(Schema.Defect()),
  // One sentence the model can repeat: what was refused and what to do instead.
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const suffix = this.detail === undefined ? "" : ` ${this.detail}`;
    if (this.reason === "context")
      return `Context operation refused; inspect the selected scope configuration.${suffix}`;
    if (this.reason === "cto-unreachable") return "CTO server unreachable";
    if (this.reason === "stale")
      return "Nia's context or session changed after you wrote this message. Check it, then send again.";
    if (this.reason === "client-outdated") return "Update this app to send messages to Nia.";
    if (this.reason === "guard-denied")
      return "Tool Guard blocked this action and the user can see it. Do not retry it in other words.";
    return `Nia: ${this.reason}.${suffix}`;
  }
}

export type D4AgentSendInput = typeof D4AgentSendInput.Type;
export type D4AgentResolveActionInput = typeof D4AgentResolveActionInput.Type;

export const D4AgentClaimSystemAttentionInput = Schema.Struct({
  reportKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type D4AgentClaimSystemAttentionInput = typeof D4AgentClaimSystemAttentionInput.Type;
