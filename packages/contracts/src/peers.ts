import * as Schema from "effect/Schema";
import { McpUsageLimitsSnapshot } from "./usageMcp.ts";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  RunId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
} from "./orchestratorMcp.ts";

export const PeerThreadSender = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String.check(Schema.isMaxLength(256)),
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(256)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type PeerThreadSender = typeof PeerThreadSender.Type;
export const PeerThreadsListInput = OrchestratorMcpThreadListInput;
export type PeerThreadsListInput = typeof PeerThreadsListInput.Type;
export const PeerThreadsListResult = OrchestratorMcpThreadListResult;
export type PeerThreadsListResult = typeof PeerThreadsListResult.Type;
export const PeerThreadReadInput = OrchestratorMcpThreadReadInput;
export type PeerThreadReadInput = typeof PeerThreadReadInput.Type;
export const PeerThreadReadResult = Schema.Struct({
  ...OrchestratorMcpThreadReadResult.fields,
  sequence: NonNegativeInt,
});
export type PeerThreadReadResult = typeof PeerThreadReadResult.Type;
export const PeerThreadSendInput = Schema.Struct({
  ...OrchestratorMcpThreadSendInput.fields,
  sender: PeerThreadSender,
});
export type PeerThreadSendInput = typeof PeerThreadSendInput.Type;
export const PeerThreadSendResult = Schema.Struct({
  ...OrchestratorMcpThreadSendResult.fields,
  afterSequence: NonNegativeInt,
});
export type PeerThreadSendResult = typeof PeerThreadSendResult.Type;
export const PeerThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optionalKey(RunId),
  afterSequence: NonNegativeInt,
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(30_000)),
});
export type PeerThreadWaitInput = typeof PeerThreadWaitInput.Type;
export const PeerThreadReply = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  sequence: NonNegativeInt,
  status: Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type PeerThreadReply = typeof PeerThreadReply.Type;
export const PeerThreadWaitResult = Schema.Struct({ reply: Schema.NullOr(PeerThreadReply) });
export type PeerThreadWaitResult = typeof PeerThreadWaitResult.Type;

export const PeerThreadWatchMode = Schema.Literals(["once", "continuous"]);
export const PeerThreadWatchInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  mode: Schema.optionalKey(PeerThreadWatchMode),
  afterSequence: Schema.optionalKey(NonNegativeInt),
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PeerThreadWatchInput = typeof PeerThreadWatchInput.Type;
export const PeerThreadMessageInput = Schema.Struct({
  ...OrchestratorMcpThreadSendInput.fields,
  environmentId: EnvironmentId,
  clientRequestId: PeerThreadWatchInput.fields.clientRequestId,
  watch: Schema.optionalKey(Schema.Literals(["none", "once", "continuous"])),
});
export type PeerThreadMessageInput = typeof PeerThreadMessageInput.Type;
export const PeerThreadMessageResult = Schema.Struct({
  ...PeerThreadSendResult.fields,
  watchId: Schema.NullOr(TrimmedNonEmptyString),
});
export type PeerThreadMessageResult = typeof PeerThreadMessageResult.Type;

/**
 * Files moved between environments for agents. Servers never reach each other: a client connected
 * to both relays each request, so the calling server asks its relay and the relay calls the
 * `peerFiles.*` RPCs of the other one.
 */

/** Raw bytes per transfer chunk; base64 adds a third on the wire. */
export const PEER_FILE_CHUNK_BYTES = 512 * 1024;
export const PEER_FILES_LIST_MAX_ENTRIES = 2000;

const PeerPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const PeerFileEntry = Schema.Struct({
  /** Relative to the listed directory with `/` separators, or the file's name when a file was listed. */
  path: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
  size: NonNegativeInt,
  modifiedAt: Schema.String,
  sha256: Schema.optionalKey(Schema.String),
});
export type PeerFileEntry = typeof PeerFileEntry.Type;

export const PeerFilesListInput = Schema.Struct({
  path: PeerPath,
  recursive: Schema.Boolean,
  /** Only what Git does not carry: untracked and ignored paths, with whole folders collapsed. */
  untrackedOnly: Schema.Boolean,
  hash: Schema.Boolean,
});
export type PeerFilesListInput = typeof PeerFilesListInput.Type;

export const PeerFilesListResult = Schema.Struct({
  path: Schema.String,
  /** A listed file answers with that one file as its only entry. */
  kind: Schema.Literals(["file", "directory"]),
  entries: Schema.Array(PeerFileEntry),
  truncated: Schema.Boolean,
});
export type PeerFilesListResult = typeof PeerFilesListResult.Type;

export const PeerFilesReadInput = Schema.Struct({
  path: PeerPath,
  offset: NonNegativeInt,
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(PEER_FILE_CHUNK_BYTES)),
});
export type PeerFilesReadInput = typeof PeerFilesReadInput.Type;

export const PeerFilesReadResult = Schema.Struct({
  data: Schema.String,
  size: NonNegativeInt,
  mode: NonNegativeInt,
  modifiedAt: Schema.String,
  eof: Schema.Boolean,
});
export type PeerFilesReadResult = typeof PeerFilesReadResult.Type;

export const PeerFilesWriteInput = Schema.Struct({
  path: PeerPath,
  transferId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/)),
  offset: NonNegativeInt,
  data: Schema.String.check(Schema.isMaxLength(Math.ceil(PEER_FILE_CHUNK_BYTES / 3) * 4)),
  last: Schema.Boolean,
  overwrite: Schema.Boolean,
  mode: Schema.optionalKey(NonNegativeInt),
});
export type PeerFilesWriteInput = typeof PeerFilesWriteInput.Type;

export const PeerFilesWriteResult = Schema.Struct({
  size: NonNegativeInt,
  /** Of the finished file, present on the last chunk. */
  sha256: Schema.optionalKey(Schema.String),
});
export type PeerFilesWriteResult = typeof PeerFilesWriteResult.Type;

export const PeerFilesFailureCode = Schema.Literals([
  "outside_projects",
  "not_found",
  "not_a_file",
  "not_a_directory",
  "not_a_repository",
  "already_exists",
  "transfer_out_of_order",
  "io_failed",
]);
export type PeerFilesFailureCode = typeof PeerFilesFailureCode.Type;

export class PeerFilesError extends Schema.TaggedError<PeerFilesError>()("PeerFilesError", {
  code: PeerFilesFailureCode,
  message: Schema.String,
}) {}

export const PeerProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /** Whether the user's client groups it with the project the request came from. */
  sameProject: Schema.Boolean,
});
export type PeerProject = typeof PeerProject.Type;

export const PeerEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  connected: Schema.Boolean,
  projects: Schema.Array(PeerProject),
});
export type PeerEnvironment = typeof PeerEnvironment.Type;

export const PeerThreadOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("threads-list"),
    environmentId: EnvironmentId,
    input: PeerThreadsListInput,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-read"),
    environmentId: EnvironmentId,
    input: PeerThreadReadInput,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-send"),
    environmentId: EnvironmentId,
    input: PeerThreadSendInput,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-wait"),
    environmentId: EnvironmentId,
    input: PeerThreadWaitInput,
  }),
]);
export type PeerThreadOperation = typeof PeerThreadOperation.Type;

export const PeerRelayOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("usage-limits"),
    environmentId: EnvironmentId,
    refresh: Schema.Boolean,
  }),
  PeerThreadOperation,
  Schema.Struct({ type: Schema.Literal("describe"), projectId: Schema.NullOr(ProjectId) }),
  Schema.Struct({
    type: Schema.Literal("list"),
    environmentId: EnvironmentId,
    input: PeerFilesListInput,
  }),
  Schema.Struct({
    type: Schema.Literal("read"),
    environmentId: EnvironmentId,
    input: PeerFilesReadInput,
  }),
  Schema.Struct({
    type: Schema.Literal("write"),
    environmentId: EnvironmentId,
    input: PeerFilesWriteInput,
  }),
]);
export type PeerRelayOperation = typeof PeerRelayOperation.Type;

export const PeerRelayRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  operation: PeerRelayOperation,
});
export type PeerRelayRequest = typeof PeerRelayRequest.Type;

export const PeerRelayReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("usage-limits"),
    environmentId: EnvironmentId,
    snapshot: McpUsageLimitsSnapshot,
  }),
  Schema.Struct({ type: Schema.Literal("threads-listed"), result: PeerThreadsListResult }),
  Schema.Struct({ type: Schema.Literal("thread-read"), result: PeerThreadReadResult }),
  Schema.Struct({ type: Schema.Literal("thread-sent"), result: PeerThreadSendResult }),
  Schema.Struct({ type: Schema.Literal("thread-waited"), result: PeerThreadWaitResult }),
  Schema.Struct({ type: Schema.Literal("described"), peers: Schema.Array(PeerEnvironment) }),
  Schema.Struct({ type: Schema.Literal("listed"), result: PeerFilesListResult }),
  Schema.Struct({ type: Schema.Literal("read"), result: PeerFilesReadResult }),
  Schema.Struct({ type: Schema.Literal("written"), result: PeerFilesWriteResult }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    code: Schema.Union([
      PeerFilesFailureCode,
      OrchestratorMcpFailure.fields.code,
      Schema.Literal("peer_unreachable"),
    ]),
    message: Schema.String,
  }),
]);
export type PeerRelayReply = typeof PeerRelayReply.Type;

export const PeerRelayRespondInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  reply: PeerRelayReply,
});
export type PeerRelayRespondInput = typeof PeerRelayRespondInput.Type;
