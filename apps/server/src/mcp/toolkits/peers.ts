import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PeerEnvironment,
  PeerFilesListResult,
  PeerThreadsListInput,
  PeerThreadsListResult,
  PeerThreadReadInput,
  PeerThreadReadResult,
  PeerThreadMessageInput,
  PeerThreadMessageResult,
  PeerThreadWatchInput,
  PeerThreadWatch,
  TrimmedNonEmptyString,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Peers from "../../peers/Peers.ts";
import * as PeerThreadMessaging from "../../peers/PeerThreadMessaging.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { loadCaller, readCaller, unavailable } from "../threadAccess.ts";

const shared = {
  failure: Schema.Union([Peers.PeersError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService.ThreadManagementService],
};
const environment = EnvironmentId.annotate({
  description: "environmentId of the other machine, from t3_peers_list.",
});
const peerPath = (description: string) => Schema.String.annotate({ description });

const list = Tool.make("t3_peers_list", {
  ...shared,
  description:
    "List the user's other machines (environments) that T3 Code can reach right now, with each project's id and absolute folder. sameProject marks matching folders. self gives this environmentId and folders. Start here before cross-environment thread messaging or file transfer; pass the destination projectId to t3_peer_threads_list. For same-environment conversations use self.environmentId and the caller's projectId. Tracked work moves through Git; peer file tools transfer what Git does not carry. Needs the desktop/web app open and connected to both machines for cross-environment calls.",
  success: Schema.Struct({
    self: Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      projectFolder: Schema.NullOr(Schema.String),
      workingFolder: Schema.NullOr(Schema.String),
    }),
    peers: Schema.Array(PeerEnvironment),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const filesList = Tool.make("t3_peer_files_list", {
  ...shared,
  description:
    "List a folder on another machine: each entry's path relative to it, kind, size and modification time. path is absolute and must lie inside a project folder or thread worktree there. recursive walks subfolders but stops at .git and node_modules, and at 2,000 entries (truncated=true, then list subfolders). untrackedOnly lists only what Git does not carry there (untracked and ignored paths, whole folders collapsed), which is the quick way to find files a clone would miss. hash adds a sha256 per file so you can compare with `shasum -a 256` here. A path to a file answers with that one file.",
  parameters: Schema.Struct({
    environment,
    path: peerPath("Absolute folder or file on the other machine."),
    recursive: Schema.optionalKey(Schema.Boolean),
    untrackedOnly: Schema.optionalKey(Schema.Boolean),
    hash: Schema.optionalKey(Schema.Boolean),
  }),
  success: PeerFilesListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const fileRead = Tool.make("t3_peer_file_read", {
  ...shared,
  description:
    "Read a text file on another machine, up to 256 KB (truncated=true beyond that). For comparing or inspecting small files such as .env or configs. To bring a file here, use t3_peer_copy instead: it handles any size and binary content without passing through you.",
  parameters: Schema.Struct({
    environment,
    path: peerPath("Absolute file on the other machine."),
  }),
  success: Schema.Struct({
    text: Schema.String,
    size: Schema.Number,
    truncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const copy = Tool.make("t3_peer_copy", {
  ...shared,
  description:
    "Copy a file, or a whole folder, between this machine and another one. direction to_peer sends localPath to peerPath there; from_peer brings peerPath to localPath here. Both paths are absolute, name the destination itself (not its parent folder), and must lie inside a project folder or thread worktree on their machine. Missing parent folders are created, file permissions are kept, and every file is verified by checksum. An existing destination fails unless overwrite is true; in a folder copy, existing files are skipped and reported instead. Folder copies skip .git and node_modules. Nothing is ever deleted. Needs a full-access thread.",
  parameters: Schema.Struct({
    environment,
    direction: Schema.Literals(["to_peer", "from_peer"]),
    localPath: peerPath("Absolute path on this machine."),
    peerPath: peerPath("Absolute path on the other machine."),
    overwrite: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    files: Schema.Number,
    bytes: Schema.Number,
    skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const threadsList = Tool.make("t3_peer_threads_list", {
  ...shared,
  description:
    "Discover conversations and T3-managed child subagents in an environment from t3_peers_list (including self.environmentId). includeSubagents lists sibling/child backing threads. This can coordinate parent and sibling agents in the same thread family. Across machines the app must remain open and connected to both environments; direct SSH works. Use returned threadIds, never infer them from filenames.",
  parameters: Schema.Struct({ ...PeerThreadsListInput.fields, environmentId: EnvironmentId }),
  success: PeerThreadsListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const threadRead = Tool.make("t3_peer_thread_read", {
  ...shared,
  description:
    "Read another environment's conversation (or self), with bounded pagination like t3_thread_read. Includes sequence for starting a response watch. Works for child agents too, including readable provider-native child transcripts. Read what was actually sent/answered before claiming an exchange happened.",
  parameters: Schema.Struct({ ...PeerThreadReadInput.fields, environmentId: EnvironmentId }),
  success: PeerThreadReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const threadSend = Tool.make("t3_peer_thread_send", {
  ...shared,
  description:
    "Send an attributed user-side message to another T3 thread or T3-managed child/sibling agent, on this machine or another environment. Parent agents can send and follow the same exchanges. Stable clientRequestId prevents duplicate delivery on retry. mode auto steers active work or starts a turn; queue waits behind active work. Choose watch none (default), once for this reply, or continuous for subsequent replies until stopped. Retain watchId; do not poll when watching. This genuinely dispatches the message; writing a shared Git note does not. For provider-native subagents use the provider's send_message/SendMessage tool; their imported backing threads cannot accept ordinary turns. This does not start a new delegated review round: use delegate_task for that. Target modes may not exceed yours.",
  parameters: PeerThreadMessageInput,
  success: PeerThreadMessageResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const threadWatch = Tool.make("t3_peer_thread_watch", {
  ...shared,
  description:
    "Watch another thread's completed replies and wake THIS agent with their results. Choose once (default) or continuous; use t3_peer_thread_unwatch to stop. afterSequence resumes after a cursor from read/send; omitted begins at the current cursor. Watches survive app/server reconnects, count as background work, and Stop/archive/settlement clears them. Stable clientRequestId deduplicates registration. The target can be a T3-managed sibling or child; parent can follow it too. Cross-machine watches need an app connected to both machines.",
  parameters: PeerThreadWatchInput,
  success: PeerThreadWatch,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const threadUnwatch = Tool.make("t3_peer_thread_unwatch", {
  ...shared,
  description:
    "Stop one of this agent's response watches using its watchId. Leaves the other agent's work running.",
  parameters: Schema.Struct({
    watchId: TrimmedNonEmptyString,
    clientRequestId: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ stopped: Schema.Boolean }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const watches = Tool.make("t3_peer_thread_watches", {
  ...shared,
  description:
    "List this thread's active response watches, including mode and cursor. No agent work is started.",
  success: Schema.Struct({ watches: Schema.Array(PeerThreadWatch) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const PeersToolkit = Toolkit.make(
  list,
  filesList,
  fileRead,
  copy,
  threadsList,
  threadRead,
  threadSend,
  threadWatch,
  threadUnwatch,
  watches,
);

export const PeersHandlersLive = McpToolAccess.toLayer(
  PeersToolkit,
  Effect.gen(function* () {
    const peers = yield* Peers.Peers;
    const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
    const projects = yield* ProjectService.ProjectService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return {
      t3_peer_threads_list: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const { caller } = yield* readCaller();
          const descriptor = yield* serverEnvironment.getDescriptor;
          const projectId =
            input.projectId ??
            (input.environmentId === descriptor.environmentId ? caller?.projectId : undefined);
          const reply = yield* messaging.request({
            type: "threads-list",
            environmentId: input.environmentId,
            input: { ...input, ...(projectId === undefined ? {} : { projectId }) },
          });
          if (reply.type === "failed")
            return yield* new Peers.PeersError({ code: reply.code, message: reply.message });
          if (reply.type !== "threads-listed") return yield* unavailable();
          return reply.result;
        }),
      ),
      t3_peer_thread_read: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          const reply = yield* messaging.request({
            type: "thread-read",
            environmentId: input.environmentId,
            input,
          });
          if (reply.type === "failed")
            return yield* new Peers.PeersError({ code: reply.code, message: reply.message });
          if (reply.type !== "thread-read") return yield* unavailable();
          return reply.result;
        }),
      ),
      t3_peer_thread_send: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { caller } = yield* readCaller();
          if (caller === undefined) return yield* unavailable();
          return yield* messaging.send(caller.id, input);
        }),
      ),
      t3_peer_thread_watch: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { caller } = yield* readCaller();
          if (caller === undefined) return yield* unavailable();
          return yield* messaging.watch(caller.id, input);
        }),
      ),
      t3_peer_thread_unwatch: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const { caller } = yield* readCaller();
          if (caller === undefined) return yield* unavailable();
          yield* messaging.unwatch(caller.id, input.watchId, input.clientRequestId);
          return { stopped: true };
        }),
      ),
      t3_peer_thread_watches: McpToolAccess.readsAsCaller(() =>
        Effect.gen(function* () {
          const { caller } = yield* readCaller();
          return { watches: caller?.peerThreadWatches ?? [] };
        }),
      ),
      t3_peers_list: McpToolAccess.readsAsCaller(() =>
        Effect.gen(function* () {
          const { caller } = yield* loadCaller();
          const descriptor = yield* serverEnvironment.getDescriptor;
          const project =
            caller === undefined
              ? undefined
              : Option.getOrUndefined(
                  yield* projects
                    .getById(caller.projectId)
                    .pipe(Effect.orElseSucceed(() => Option.none())),
                );
          return {
            self: {
              environmentId: descriptor.environmentId,
              label: descriptor.label,
              projectFolder: project?.workspaceRoot ?? null,
              workingFolder: caller?.worktreePath ?? project?.workspaceRoot ?? null,
            },
            peers: yield* peers.describe(caller?.projectId ?? null),
          };
        }),
      ),
      t3_peer_files_list: McpToolAccess.readsAsCaller((input) =>
        peers.list(input.environment, {
          path: input.path,
          recursive: input.recursive ?? false,
          untrackedOnly: input.untrackedOnly ?? false,
          hash: input.hash ?? false,
        }),
      ),
      t3_peer_file_read: McpToolAccess.readsAsCaller((input) =>
        peers.readText(input.environment, input.path),
      ),
      t3_peer_copy: McpToolAccess.writesEnvironment((input) =>
        peers.copy({
          environmentId: input.environment,
          direction: input.direction,
          localPath: input.localPath,
          peerPath: input.peerPath,
          overwrite: input.overwrite ?? false,
        }),
      ),
    };
  }),
);
