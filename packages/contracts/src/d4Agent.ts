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
export const D4_BRAIN_CONTEXTS = ["Global", "Personal", "YB", "Dimaggi"] as const;
export const D4BrainContext = Schema.Literals(D4_BRAIN_CONTEXTS);
export type D4BrainContext = typeof D4BrainContext.Type;
export const D4AgentSwitchContextInput = Schema.Struct({ context: D4BrainContext });
export type D4AgentSwitchContextInput = typeof D4AgentSwitchContextInput.Type;
export const D4BrainIndexStatus = Schema.Struct({
  context: D4BrainContext,
  status: Schema.Literals(["ready", "not-available", "disabled", "refused"]),
  files: NonNegativeInt,
  lastRebuild: Schema.NullOr(IsoDateTime),
});
export const D4AgentQuietHours = Schema.Struct({
  startMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  endMinute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  utcOffsetMinutes: Schema.Int.check(Schema.isBetween({ minimum: -840, maximum: 840 })),
});
export const D4AgentSettings = Schema.Struct({
  brainVaultPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(Effect.succeed("/home/dmitriis/Documents/Shared26/Second Brain")),
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
  ctoEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ctoBaseUrl: Schema.String.check(Schema.isMaxLength(2048)).pipe(
    Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:9093")),
  ),
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
  brainVaultPath: "/home/dmitriis/Documents/Shared26/Second Brain",
  memoryEnabled: false,
  embeddingsEnabled: false,
  embeddingBaseUrl: null,
  embeddingModel: null,
  projectContexts: {},
  ctoEnabled: false,
  ctoBaseUrl: "http://127.0.0.1:9093",
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
  context: D4BrainContext.pipe(Schema.withDecodingDefault(Effect.succeed("Global"))),
  sessionId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  result: Schema.optionalKey(Schema.Unknown),
  id: Schema.String,
  action: D4AgentAction,
  status: Schema.Literals(["pending", "approved", "denied", "executed", "failed"]),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type D4AgentActionRecord = typeof D4AgentActionRecord.Type;
export const D4AgentActionSummary = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["send", "interrupt", "answer", "start", "memory-propose", "cto-ask"]),
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
    "context",
    "memory-unavailable",
    "cto-unreachable",
    "cto-response",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.reason === "context")
      return "Context operation refused; inspect the selected scope configuration.";
    if (this.reason === "cto-unreachable") return "CTO server unreachable";
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
