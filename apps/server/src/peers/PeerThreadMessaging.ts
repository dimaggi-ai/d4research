import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type EnvironmentId,
  type ThreadId,
  type PeerThreadOperation,
  type PeerRelayReply,
  type PeerThreadWatch,
  type PeerThreadWatchInput,
  type PeerThreadMessageInput,
  type PeerThreadMessageResult,
  type PeerThreadReply,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { dispatchFailure, unavailable } from "../mcp/threadAccess.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerThreads from "./PeerThreads.ts";
import * as Peers from "./Peers.ts";

type Failure = OrchestratorMcpFailure | Peers.PeersError;
export class PeerThreadMessaging extends Context.Service<
  PeerThreadMessaging,
  {
    readonly request: (operation: PeerThreadOperation) => Effect.Effect<PeerRelayReply, Failure>;
    readonly send: (
      caller: ThreadId,
      input: PeerThreadMessageInput,
    ) => Effect.Effect<PeerThreadMessageResult, Failure>;
    readonly watch: (
      caller: ThreadId,
      input: PeerThreadWatchInput,
    ) => Effect.Effect<PeerThreadWatch, Failure>;
    readonly unwatch: (
      caller: ThreadId,
      watchId: string,
      clientRequestId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("d4research/peers/PeerThreadMessaging") {}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const keyOf = (caller: ThreadId, request: string) =>
  `peer-watch:${encodeURIComponent(caller)}:${encodeURIComponent(request)}`;

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const peers = yield* Peers.Peers;
  const local = yield* PeerThreads.PeerThreads;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  // Leave relay capacity for sends, reads and file copies while watches long-poll.
  const waitSlots = yield* Semaphore.make(16);
  const request: PeerThreadMessaging["Service"]["request"] = Effect.fn(
    "PeerThreadMessaging.request",
  )(function* (operation) {
    const self = yield* environment.getDescriptor;
    if (operation.environmentId === self.environmentId) return yield* local.perform(operation);
    return yield* peers.request(operation);
  });

  const readTarget = Effect.fn("PeerThreadMessaging.readTarget")(function* (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    const reply = yield* request({
      type: "thread-read",
      environmentId,
      input: { threadId, limit: 1 },
    });
    if (reply.type === "failed")
      return yield* new Peers.PeersError({ code: reply.code, message: reply.message });
    if (reply.type !== "thread-read") return yield* unavailable();
    return reply.result;
  });

  const configure = (
    caller: ThreadId,
    watchId: string,
    watch: PeerThreadWatch | null,
    requestId: string,
  ) =>
    threads
      .dispatch({
        type: "thread.peer-watch.configure",
        threadId: caller,
        watchId,
        watch,
        commandId: CommandId.make(
          `peer-watch-configure:${encodeURIComponent(caller)}:${encodeURIComponent(requestId)}`,
        ),
      })
      .pipe(Effect.mapError(dispatchFailure), Effect.asVoid, Effect.uninterruptible);

  const register = Effect.fn("PeerThreadMessaging.register")(function* (
    caller: ThreadId,
    input: PeerThreadWatchInput,
    afterSequence: number,
    runId?: PeerThreadReply["runId"],
  ) {
    if (
      input.environmentId === (yield* environment.getDescriptor).environmentId &&
      input.threadId === caller
    )
      return yield* invalid("A thread cannot watch its own replies.");
    const target = yield* readTarget(input.environmentId, input.threadId);
    if (
      target.thread.creationSource === "provider" &&
      target.thread.relationshipToParent === "subagent"
    )
      return yield* invalid(
        "Use the provider's native messaging/wait tools for this subagent; T3 response watches follow app-owned runs.",
      );
    const descriptor = yield* environment.getDescriptor;
    const others =
      input.environmentId === descriptor.environmentId ? [] : yield* peers.describe(null);
    const watch: PeerThreadWatch = {
      id: keyOf(caller, input.clientRequestId),
      environmentId: input.environmentId,
      environmentLabel:
        others.find((peer) => peer.environmentId === input.environmentId)?.label ??
        (input.environmentId === descriptor.environmentId ? descriptor.label : input.environmentId),
      threadId: input.threadId,
      threadTitle: target.thread.title,
      afterSequence,
      mode: input.mode ?? "once",
      ...(runId === undefined ? {} : { runId }),
    };
    yield* configure(caller, watch.id, watch, input.clientRequestId);
    return watch;
  });

  const send: PeerThreadMessaging["Service"]["send"] = Effect.fn("PeerThreadMessaging.send")(
    function* (callerId, input) {
      const caller = yield* threads.getThreadShell(callerId).pipe(Effect.mapError(unavailable));
      if (caller === null || caller.deletedAt !== null)
        return yield* invalid("The sending thread no longer exists.");
      const descriptor = yield* environment.getDescriptor;
      if (descriptor.environmentId === input.environmentId && callerId === input.threadId)
        return yield* invalid("Use the current conversation to address this agent.");
      const reply = yield* request({
        type: "thread-send",
        environmentId: input.environmentId,
        input: {
          threadId: input.threadId,
          message: input.message,
          mode: input.mode ?? "auto",
          clientRequestId: input.clientRequestId,
          sender: {
            environmentId: descriptor.environmentId,
            environmentLabel: descriptor.label.slice(0, 256),
            threadId: callerId,
            threadTitle: caller.title.slice(0, 256),
            runtimeMode: caller.runtimeMode,
            interactionMode: caller.interactionMode,
          },
        },
      });
      if (reply.type === "failed")
        return yield* new Peers.PeersError({ code: reply.code, message: reply.message });
      if (reply.type !== "thread-sent") return yield* unavailable();
      const watch =
        input.watch === undefined || input.watch === "none"
          ? null
          : yield* register(
              callerId,
              {
                environmentId: input.environmentId,
                threadId: input.threadId,
                mode: input.watch,
                clientRequestId: `send:${input.clientRequestId}`,
              },
              reply.result.afterSequence,
              reply.result.runId,
            );
      return { ...reply.result, watchId: watch?.id ?? null };
    },
  );

  const watch: PeerThreadMessaging["Service"]["watch"] = Effect.fn("PeerThreadMessaging.watch")(
    function* (caller, input) {
      const cursor =
        input.afterSequence ?? (yield* readTarget(input.environmentId, input.threadId)).sequence;
      return yield* register(caller, input, cursor);
    },
  );

  // Watches are durable metadata; each cursor advance and agent notification commits together.
  // Replaying a terminal event after a crash therefore cannot send a second notification.
  // Finishing a once watch removes its own worker. Let dispatch finish publishing every
  // committed event before that interruption, or live clients can miss the wake message.
  const wake = (caller: ThreadId, watch: PeerThreadWatch, reply: PeerThreadReply | null) => {
    const sequence = reply?.sequence ?? watch.afterSequence + 1;
    const text =
      reply === null
        ? `Stopped watching ${watch.environmentLabel} / ${watch.threadTitle}: the destination thread was removed.`
        : `Reply from ${watch.environmentLabel} / ${watch.threadTitle}\nSource environment: ${watch.environmentId}\nSource thread: ${watch.threadId}\nRun: ${reply.runId} (${reply.status})\n\n${reply.text || "No assistant text was returned."}${reply.truncated ? "\n[Truncated; use t3_peer_thread_read for more.]" : ""}`;
    const identity = `${watch.id}:${sequence}`;
    return threads
      .dispatch({
        type: "thread.peer-watch.sync",
        commandId: CommandId.make(identity),
        threadId: caller,
        watchId: watch.id,
        expectedSequence: watch.afterSequence,
        afterSequence: sequence,
        end: reply === null,
        wake: {
          messageId: MessageId.make(reply === null ? identity : `${watch.id}:run:${reply.runId}`),
          text,
          notification: {
            source: { kind: "monitor" },
            outcome: reply === null || reply.status === "failed" ? "failed" : "updated",
            summary:
              reply === null ? `Watch ended: ${watch.threadTitle}` : `Reply: ${watch.threadTitle}`,
          },
        },
      })
      .pipe(Effect.mapError(dispatchFailure), Effect.asVoid, Effect.uninterruptible);
  };

  const worker = Effect.fn("PeerThreadMessaging.worker")(
    function* (caller: ThreadId, id: string) {
      while (true) {
        const shell = yield* threads.getThreadShell(caller).pipe(Effect.mapError(unavailable));
        const watch = shell?.peerThreadWatches?.find((watch) => watch.id === id);
        if (
          watch === undefined ||
          shell?.archivedAt !== null ||
          shell.deletedAt !== null ||
          shell.settledAt !== null
        )
          return;
        const reply = yield* waitSlots.withPermits(1)(
          request({
            type: "thread-wait",
            environmentId: watch.environmentId,
            input: {
              threadId: watch.threadId,
              afterSequence: watch.afterSequence,
              timeoutMs: 25_000,
              ...(watch.runId === undefined ? {} : { runId: watch.runId }),
            },
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed<PeerRelayReply>({
                type: "failed",
                code:
                  error.code === "no_relay" || error.code === "checksum_mismatch"
                    ? "peer_unreachable"
                    : error.code,
                message: error.message,
              }),
            ),
          ),
        );
        if (reply?.type === "thread-waited") {
          if (reply.result.reply !== null) yield* wake(caller, watch, reply.result.reply);
        } else if (reply?.type === "failed" && reply.code === "thread_not_found") {
          yield* wake(caller, watch, null);
          return;
        } else yield* Effect.sleep("30 seconds");
      }
    },
    Effect.tapError((error) =>
      Effect.logWarning("Peer response watch could not progress", { tag: error._tag }),
    ),
    Effect.retry(Schedule.spaced("30 seconds")),
  );

  const started = yield* Ref.make(false);
  const start: PeerThreadMessaging["Service"]["start"] = Effect.fn("PeerThreadMessaging.start")(
    function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* forkParked(
        Effect.scoped(
          Effect.gen(function* () {
            const workers = yield* FiberMap.make<string>();
            const known = new Map<ThreadId, Set<string>>();
            const reconcile = Effect.fn("PeerThreadMessaging.reconcile")(function* (
              threadId: ThreadId,
            ) {
              const shell = yield* threads
                .getThreadShell(threadId)
                .pipe(Effect.mapError(unavailable));
              const watches =
                shell === null ||
                shell.deletedAt !== null ||
                shell.archivedAt !== null ||
                shell.settledAt !== null
                  ? []
                  : (shell.peerThreadWatches ?? []);
              const previous = known.get(threadId) ?? new Set<string>();
              const next = new Set(watches.map((watch) => watch.id));
              for (const id of previous) if (!next.has(id)) yield* FiberMap.remove(workers, id);
              if (next.size === 0) known.delete(threadId);
              else known.set(threadId, next);
              for (const watch of watches)
                yield* FiberMap.run(workers, watch.id, worker(threadId, watch.id), {
                  onlyIfMissing: true,
                });
            });
            // Subscribe before loading the snapshot; reconciliation always re-reads current metadata.
            const changes = yield* threads.streamDomainEvents.pipe(
              Stream.filter((event) =>
                [
                  "thread.metadata-updated",
                  "thread.pull-request-synced",
                  "thread.archived",
                  "thread.settled",
                  "thread.deleted",
                ].includes(event.type),
              ),
              Stream.runForEach((event) =>
                event.threadId === null ? Effect.void : reconcile(event.threadId),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            const snapshot = yield* threads.getShellSnapshot({ location: "active" });
            yield* Effect.forEach(snapshot.threads, (thread) => reconcile(thread.id), {
              discard: true,
            });
            return yield* Fiber.join(changes);
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Peer response watches could not start", { tag: error._tag }),
          ),
          Effect.retry(Schedule.spaced("30 seconds")),
        ),
      );
    },
  );

  return PeerThreadMessaging.of({
    request,
    send,
    watch,
    start,
    unwatch: Effect.fn("PeerThreadMessaging.unwatch")((caller, watchId, requestId) =>
      configure(caller, watchId, null, `stop:${requestId}`),
    ),
  });
});
export const layer = Layer.effect(PeerThreadMessaging, make);
