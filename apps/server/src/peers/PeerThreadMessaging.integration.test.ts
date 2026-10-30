import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ExecutionEnvironmentDescriptor,
  type PeerRelayReply,
  type RunId,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as PeerFiles from "./PeerFiles.ts";
import * as Peers from "./Peers.ts";
import * as PeerThreads from "./PeerThreads.ts";
import * as PeerThreadMessaging from "./PeerThreadMessaging.ts";

const source = EnvironmentId.make("test-macbook");
const destination = EnvironmentId.make("test-mini");
const caller = ThreadId.make("thread:peer:caller");
const target = ThreadId.make("thread:peer:target");
const projectId = ProjectId.make("project:peer");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const descriptor = (environmentId: EnvironmentId): ExecutionEnvironmentDescriptor => ({
  environmentId,
  label: environmentId === source ? "MacBook" : "Mac Mini",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
});
const environmentLayer = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor(environmentId)),
  });
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No real provider may be launched by this test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
  get: () => Effect.succeed(adapter),
  list: () => Effect.succeed([instanceId]),
});
const backend = ProviderReplayHarness.layerWithRegistry(
  { name: "peer-thread-messaging" },
  registry,
  { runEffectWorker: false },
);
const threads = ThreadManagement.layer.pipe(
  Layer.provideMerge(backend),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(CommandReceipts.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
);
const api = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(RemoteDelegation)({})),
  Layer.provideMerge(threads),
  Layer.provide(registry),
  Layer.provide(ProviderRegistryMock.layer()),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({ id: projectId, defaultModelSelection: modelSelection } as never),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
// Both machines use an isolated in-memory event store. Only the transport is simulated;
// sends, receipts, projections, watches and wakes use the production implementations.
const recipient = PeerThreads.layer.pipe(
  Layer.provideMerge(api),
  Layer.provide(environmentLayer(destination)),
);
const messagingLayer = (environmentId: EnvironmentId) =>
  PeerThreadMessaging.layer.pipe(
    Layer.provideMerge(recipient),
    Layer.provideMerge(Peers.layer.pipe(Layer.provide(Layer.mock(PeerFiles.PeerFiles)({})))),
    Layer.provide(environmentLayer(environmentId)),
  );
const layerTest = messagingLayer(source);

const seed = Effect.fn("test.seedPeers")(function* (relay = true) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (const threadId of [caller, target])
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId,
      title: threadId === caller ? "Lead" : "Recorder",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  if (!relay) return;
  const peers = yield* Peers.Peers;
  const recipient = yield* PeerThreads.PeerThreads;
  yield* peers.connect.pipe(
    Stream.runForEach(({ requestId, operation }) => {
      const reply =
        operation.type === "describe"
          ? Effect.succeed<PeerRelayReply>({
              type: "described",
              peers: [
                { environmentId: destination, label: "Mac Mini", connected: true, projects: [] },
              ],
            })
          : operation.type === "threads-list" ||
              operation.type === "thread-read" ||
              operation.type === "thread-send" ||
              operation.type === "thread-wait"
            ? recipient.perform(operation).pipe(
                Effect.catch((error) =>
                  Effect.succeed<PeerRelayReply>({
                    type: "failed",
                    code: error.code,
                    message: error.message,
                  }),
                ),
              )
            : Effect.succeed<PeerRelayReply>({
                type: "failed",
                code: "peer_unreachable",
                message: "File request not part of this test",
              });
      return reply.pipe(
        Effect.flatMap((reply) => peers.respond({ requestId, reply })),
        Effect.forkScoped,
        Effect.asVoid,
      );
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
});

const complete = Effect.fn("test.completePeerReply")(function* (runId: RunId, text: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;
  const projection = yield* threads.getThreadRecords(target, ["runs"]);
  const run = projection.runs.find((run) => run.id === runId)!;
  const now = yield* DateTime.now;
  const messageId = MessageId.make(`reply:${runId}`);
  yield* events.write({
    commandId: CommandId.make(`complete:${runId}`),
    events: [
      {
        id: EventId.make(`reply:${runId}`),
        type: "message.updated",
        threadId: target,
        runId,
        occurredAt: now,
        providerInstanceId: instanceId,
        payload: {
          id: messageId,
          threadId: target,
          runId,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`item:${runId}`),
        type: "turn-item.updated",
        threadId: target,
        runId,
        occurredAt: now,
        providerInstanceId: instanceId,
        payload: {
          id: TurnItemId.make(`item:${runId}`),
          threadId: target,
          runId,
          nodeId: null,
          type: "assistant_message",
          messageId,
          text,
          status: "completed",
          title: null,
          ordinal: 1,
          parentItemId: null,
          providerThreadId: null,
          providerTurnId: null,
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          streaming: false,
          nativeItemRef: null,
        },
      },
      {
        id: EventId.make(`complete:${runId}`),
        type: "run.updated",
        threadId: target,
        runId,
        occurredAt: now,
        providerInstanceId: instanceId,
        payload: { ...run, status: "completed", completedAt: now },
      },
    ],
  });
});

const awaitWake = (watchId: string, text?: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads
      .streamStoredEventsFrom({ threadId: caller, eventType: "message.updated" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "message.updated" &&
            event.payload.id.startsWith(watchId) &&
            (text === undefined || event.payload.text.includes(text)),
        ),
        Stream.runHead,
      );
  });

it.effect(
  "relays list/read/send with source attribution and preserves delivery/cursor on retries",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
      const listed = yield* messaging.request({
        type: "threads-list",
        environmentId: destination,
        input: { projectId, includeSubagents: true },
      });
      expect(listed.type).toBe("threads-listed");
      const input = {
        environmentId: destination,
        threadId: target,
        message: "Align the recording clocks.",
        clientRequestId: "clocks",
        watch: "none" as const,
      };
      const sent = yield* messaging.send(caller, input);
      yield* complete(sent.runId, "Aligned. Both timestamps are retained.");
      const retried = yield* messaging.send(caller, input);
      expect(retried.messageId).toBe(sent.messageId);
      expect(retried.runId).toBe(sent.runId);
      expect(retried.afterSequence).toBe(sent.afterSequence);
      const read = yield* messaging.request({
        type: "thread-read",
        environmentId: destination,
        input: { threadId: target, view: "messages" },
      });
      expect(read.type).toBe("thread-read");
      if (read.type !== "thread-read") return;
      expect(read.result.items.filter((item) => item.type === "user_message")).toHaveLength(1);
      expect(read.result.items.map((item) => item.text).join("\n")).toContain(
        "Agent message from MacBook / Lead",
      );
      expect(read.result.items.map((item) => item.text).join("\n")).toContain("Aligned.");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "thread.archive", "thread.settle"] as const)(
  "%s clears response watches",
  (type) =>
    Effect.gen(function* () {
      yield* seed();
      const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* messaging.watch(caller, {
        environmentId: destination,
        threadId: target,
        clientRequestId: "cleanup",
      });
      expect((yield* threads.getThreadShell(caller))?.pendingBackgroundTasks?.[0]?.kind).toBe(
        "monitor",
      );
      yield* threads.dispatch({
        type,
        threadId: caller,
        commandId: CommandId.make(`cleanup:${type}`),
      });
      expect((yield* threads.getThreadShell(caller))?.peerThreadWatches).toEqual([]);
      expect((yield* threads.getThreadShell(caller))?.pendingBackgroundTasks ?? []).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("destination deletion ends a continuous watch with an explanatory wake", () =>
  Effect.gen(function* () {
    yield* seed();
    const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const watch = yield* messaging.watch(caller, {
      environmentId: destination,
      threadId: target,
      mode: "continuous",
      clientRequestId: "deleted",
    });
    yield* threads.dispatch({
      type: "thread.delete",
      threadId: target,
      commandId: CommandId.make("delete-target"),
    });
    yield* messaging.start();
    yield* awaitWake(watch.id, "removed");
    expect((yield* threads.getThreadShell(caller))?.peerThreadWatches).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("incoming sends enforce the sender's permission ceiling", () =>
  Effect.gen(function* () {
    yield* seed();
    const recipient = yield* PeerThreads.PeerThreads;
    const error = yield* recipient
      .perform({
        type: "thread-send",
        environmentId: destination,
        input: {
          threadId: target,
          message: "Please act.",
          clientRequestId: "restricted",
          sender: {
            environmentId: source,
            environmentLabel: "MacBook",
            threadId: caller,
            threadTitle: "Lead",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        },
      })
      .pipe(Effect.flip);
    expect(error.code).toBe("runtime_mode_escalation_denied");
    const threads = yield* ThreadManagement.ThreadManagementService;
    expect((yield* threads.getThreadRecords(target, ["messages"])).messages).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "T3-managed siblings and their parent send and read exchanges locally without a relay",
  () =>
    Effect.gen(function* () {
      yield* seed(false);
      const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* messaging.watch(caller, {
        environmentId: destination,
        threadId: target,
        clientRequestId: "parent-only",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId: caller,
        commandId: CommandId.make("parent-start"),
        messageId: MessageId.make("parent-start"),
        text: "Coordinate two workers.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const parent = yield* threads.getThreadRecords(caller, ["runs"]);
      const run = parent.runs[0]!;
      for (const title of ["Recorder", "Feed specialist"])
        yield* threads.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`delegate:${title}`),
          parentThreadId: caller,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: `Work as ${title}`,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
      const tasks = (yield* threads.getThreadRecords(caller, ["subagents"])).subagents;
      const recorder = tasks[0]!.childThreadId!;
      const feeds = tasks[1]!.childThreadId!;
      expect((yield* threads.getThreadShell(recorder))?.peerThreadWatches).toEqual([]);
      expect((yield* threads.getThreadShell(feeds))?.peerThreadWatches).toEqual([]);
      const listed = yield* messaging.request({
        type: "threads-list",
        environmentId: destination,
        input: { projectId, includeSubagents: true },
      });
      expect(listed.type).toBe("threads-listed");
      if (listed.type === "threads-listed")
        expect(
          listed.result.threads.filter((thread) => thread.relationshipToParent === "subagent"),
        ).toHaveLength(2);
      const sent = yield* messaging.send(recorder, {
        environmentId: destination,
        threadId: feeds,
        message: "Are the timestamps aligned?",
        mode: "queue",
        clientRequestId: "sibling",
      });
      expect(sent.delivery).toBe("queued");
      yield* messaging.send(caller, {
        environmentId: destination,
        threadId: feeds,
        message: "Keep both timestamps.",
        mode: "queue",
        clientRequestId: "parent-joins",
      });
      const messages = (yield* threads.getThreadRecords(feeds, ["messages"])).messages;
      expect(messages.find((message) => message.id === sent.messageId)?.text).toContain(
        "Are the timestamps aligned?",
      );
      expect(messages.some((message) => message.text.includes("Keep both timestamps."))).toBe(true);
      const read = yield* messaging.request({
        type: "thread-read",
        environmentId: destination,
        input: { threadId: feeds },
      });
      expect(read.type).toBe("thread-read");
    }).pipe(Effect.provide(messagingLayer(destination))),
);

it.effect("a once watch resumes a reply completed before registration and wakes exactly once", () =>
  Effect.gen(function* () {
    yield* seed();
    const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sent = yield* messaging.send(caller, {
      environmentId: destination,
      threadId: target,
      message: "Record.",
      clientRequestId: "record",
    });
    yield* complete(sent.runId, "Recording complete.");
    const watch = yield* messaging.watch(caller, {
      environmentId: destination,
      threadId: target,
      afterSequence: sent.afterSequence,
      clientRequestId: "once",
    });
    yield* messaging.start();
    expect(Option.isSome(yield* awaitWake(watch.id))).toBe(true);
    expect((yield* threads.getThreadShell(caller))?.peerThreadWatches).toEqual([]);
    yield* messaging.watch(caller, {
      environmentId: destination,
      threadId: target,
      afterSequence: sent.afterSequence,
      clientRequestId: "once",
    });
    expect((yield* threads.getThreadShell(caller))?.peerThreadWatches).toEqual([]);
    expect(
      (yield* threads.getThreadRecords(caller, ["messages"])).messages.filter((message) =>
        message.id.startsWith(watch.id),
      ),
    ).toHaveLength(1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "continuous watches advance their cursor and unwatch preserves the recipient's work",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sent = yield* messaging.send(caller, {
        environmentId: destination,
        threadId: target,
        message: "Record.",
        clientRequestId: "continuous",
        watch: "continuous",
      });
      expect(sent.watchId).not.toBeNull();
      yield* messaging.start();
      yield* complete(sent.runId, "First result.");
      yield* awaitWake(sent.watchId!);
      const watch = (yield* threads.getThreadShell(caller))?.peerThreadWatches?.[0];
      expect(watch?.afterSequence).toBeGreaterThan(sent.afterSequence);
      expect(watch?.runId).toBeUndefined();
      const events = yield* EventSink.EventSinkV2;
      const completed = (yield* threads.getThreadRecords(target, ["runs"])).runs[0]!;
      const sourceCursor = yield* threads.getThreadEventSequence(caller);
      yield* events.write({
        commandId: CommandId.make("repeat-completed"),
        events: [
          {
            id: EventId.make("repeat-completed"),
            type: "run.updated",
            threadId: target,
            runId: completed.id,
            providerInstanceId: instanceId,
            occurredAt: yield* DateTime.now,
            payload: completed,
          },
        ],
      });
      const repeatedCursor = yield* threads.getThreadEventSequence(target);
      yield* threads
        .streamStoredEventsFrom({
          threadId: caller,
          eventType: "thread.metadata-updated",
          afterSequence: sourceCursor,
        })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.metadata-updated" &&
              event.payload.peerThreadWatches?.some(
                (watch) => watch.id === sent.watchId && watch.afterSequence >= repeatedCursor,
              ) === true,
          ),
          Stream.runHead,
        );
      expect(
        (yield* threads.getThreadRecords(caller, ["messages"])).messages.filter((message) =>
          message.id.startsWith(sent.watchId!),
        ),
      ).toHaveLength(1);
      const second = yield* messaging.send(caller, {
        environmentId: destination,
        threadId: target,
        message: "Record again.",
        clientRequestId: "continuous-second",
      });
      yield* complete(second.runId, "Second result.");
      yield* awaitWake(sent.watchId!, "Second result.");
      expect(
        (yield* threads.getThreadRecords(caller, ["messages"])).messages.filter((message) =>
          message.id.startsWith(sent.watchId!),
        ),
      ).toHaveLength(2);
      yield* messaging.unwatch(caller, sent.watchId!, "stop-continuous");
      expect((yield* threads.getThreadShell(caller))?.peerThreadWatches).toEqual([]);
      expect((yield* threads.getThreadRecords(target, ["runs"])).runs[0]?.status).toBe("completed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("provider-native transcripts stay readable without claiming ordinary turn delivery", () =>
  Effect.gen(function* () {
    yield* seed();
    const threads = yield* ThreadManagement.ThreadManagementService;
    const events = yield* EventSink.EventSinkV2;
    const projection = yield* threads.getThreadRecords(target, []);
    const now = yield* DateTime.now;
    yield* events.write({
      commandId: CommandId.make("import-native"),
      events: [
        {
          id: EventId.make("import-native"),
          type: "thread.metadata-updated",
          threadId: target,
          occurredAt: now,
          providerInstanceId: instanceId,
          payload: {
            ...projection.thread,
            creationSource: "provider",
            lineage: {
              parentThreadId: caller,
              rootThreadId: caller,
              relationshipToParent: "subagent",
            },
          },
        },
      ],
    });
    const messaging = yield* PeerThreadMessaging.PeerThreadMessaging;
    const read = yield* messaging.request({
      type: "thread-read",
      environmentId: destination,
      input: { threadId: target },
    });
    expect(read.type).toBe("thread-read");
    const denied = yield* messaging
      .send(caller, {
        environmentId: destination,
        threadId: target,
        message: "Coordinate.",
        clientRequestId: "native-send",
      })
      .pipe(Effect.flip);
    expect(denied.code).toBe("thread_not_sendable");
    const unwatchable = yield* messaging
      .watch(caller, {
        environmentId: destination,
        threadId: target,
        clientRequestId: "native-watch",
      })
      .pipe(Effect.flip);
    expect(unwatchable.code).toBe("invalid_request");
    expect((yield* threads.getThreadRecords(target, ["messages"])).messages).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);
