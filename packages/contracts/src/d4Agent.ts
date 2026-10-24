import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  RuntimeRequestId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const D4AgentPermissionMode = Schema.Literals(["read-only", "ask", "act"]);
export const D4AgentQuietHours = Schema.Struct({
  startMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  endMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  utcOffsetMinutes: Schema.Int.check(Schema.isBetween({ minimum: -840, maximum: 840 })),
});
export const D4AgentSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  modelSelection: Schema.NullOr(ModelSelection).pipe(
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
});
export type D4AgentSettings = typeof D4AgentSettings.Type;
export const DEFAULT_D4_AGENT_SETTINGS: D4AgentSettings = {
  enabled: false,
  modelSelection: null,
  permissionMode: "read-only",
  heartbeatMinutes: null,
  quietHours: null,
  systemProbeEnabled: false,
  diskWarningPercent: 90,
};

export const D4AgentAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("send"),
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  }),
  Schema.Struct({ type: Schema.Literal("interrupt"), threadId: ThreadId }),
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
]);
export type D4AgentAction = typeof D4AgentAction.Type;
export const D4AgentActionRecord = Schema.Struct({
  id: Schema.String,
  action: D4AgentAction,
  status: Schema.Literals(["pending", "approved", "denied", "executed", "failed"]),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type D4AgentActionRecord = typeof D4AgentActionRecord.Type;
export const D4AgentActionSummary = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["send", "interrupt", "answer", "start"]),
  targetId: Schema.String,
  preview: Schema.String.check(Schema.isMaxLength(256)),
  status: D4AgentActionRecord.fields.status,
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
  id: Schema.Literals(["user-units", "root-disk", "data-disk", "server"]),
  status: Schema.Literals(["ok", "attention", "unavailable", "disabled"]),
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
export const D4AgentState = Schema.Struct({
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
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
});
export const D4AgentResolveActionInput = Schema.Struct({
  actionId: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
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
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `d4 Agent: ${this.reason}.`;
  }
}

export type D4AgentSendInput = typeof D4AgentSendInput.Type;
export type D4AgentResolveActionInput = typeof D4AgentResolveActionInput.Type;

export const D4AgentClaimSystemAttentionInput = Schema.Struct({
  reportKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type D4AgentClaimSystemAttentionInput = typeof D4AgentClaimSystemAttentionInput.Type;
