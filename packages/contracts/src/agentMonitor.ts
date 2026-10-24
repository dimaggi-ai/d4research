import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TrimmedNonEmptyString,
  ThreadId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const AgentMonitorClassification = Schema.Literals([
  "needs_user",
  "waiting_background",
  "working",
  "slow",
  "suspected_stuck",
  "wedged",
  "limited",
  "failed",
  "idle",
]);
export type AgentMonitorClassification = typeof AgentMonitorClassification.Type;

export const AgentMonitorReason = Schema.Literals([
  "pending_request",
  "background_work",
  "recent_progress",
  "progress_delayed",
  "progress_stale",
  "provider_error",
  "provider_absent",
  "usage_limit",
  "run_failed",
  "run_terminal",
  "no_active_run",
  "observation_unavailable",
]);
export type AgentMonitorReason = typeof AgentMonitorReason.Type;

export const AgentMonitorRunStatus = Schema.Literals([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type AgentMonitorRunStatus = typeof AgentMonitorRunStatus.Type;

export const AgentMonitorPendingRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
  "dynamic_tool_call",
  "user_input",
  "auth_refresh",
]);
export type AgentMonitorPendingRequestKind = typeof AgentMonitorPendingRequestKind.Type;

export const AgentMonitorReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.NullOr(RunId),
  attemptId: Schema.NullOr(RunAttemptId),
  classification: AgentMonitorClassification,
  reason: AgentMonitorReason,
  attentionRequired: Schema.Boolean,
  notificationEligible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reportKey: TrimmedNonEmptyString,
  observedAt: IsoDateTime.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
    Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
  ),
  runStatus: Schema.NullOr(AgentMonitorRunStatus),
  pendingRequestId: Schema.NullOr(RuntimeRequestId),
});
export type AgentMonitorReport = typeof AgentMonitorReport.Type;

export const AgentMonitorUpdate = Schema.Struct({
  threadId: ThreadId,
  report: Schema.NullOr(AgentMonitorReport),
  revision: NonNegativeInt,
});
export type AgentMonitorUpdate = typeof AgentMonitorUpdate.Type;

export const AgentMonitorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Reserved for a user-selected monitor model; classification does not invoke a provider.
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  notificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AgentMonitorSettings = typeof AgentMonitorSettings.Type;

export const AgentMonitorTokenCounters = Schema.Struct({
  input: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  output: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  cacheRead: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  cacheWrite: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
});
export type AgentMonitorTokenCounters = typeof AgentMonitorTokenCounters.Type;

export class AgentMonitorError extends Schema.TaggedError<AgentMonitorError>()(
  "AgentMonitorError",
  {},
) {
  override get message(): string {
    return "Agent monitor is unavailable.";
  }
}
