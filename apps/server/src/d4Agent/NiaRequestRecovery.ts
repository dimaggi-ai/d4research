import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Access from "./D4AgentAccess.ts";

const MAX_RETRIES = 3;

export function recoveryCommand(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems" | "runtimeRequests" | "providerTurns"
  >,
  messageId: string,
  now: number,
) {
  const { thread, runs, turnItems, runtimeRequests } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > now) ||
    runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) ||
    runtimeRequests.some((request) => request.status === "pending")
  )
    return;
  let run = runs.find((entry) => entry.userMessageId === messageId);
  if (!run) return;
  let retries = 0;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const continuation = runs.find((entry) => entry.restartContinuationOfRunId === run!.id);
    if (!continuation) break;
    run = continuation;
    retries += 1;
  }
  if (retries >= MAX_RETRIES || run.providerInstanceId !== thread.providerInstanceId) return;
  if (
    turnItems.some(
      (item) =>
        seen.has(item.runId ?? "") &&
        (item.type === "run_interrupt_request" || item.type === "secret_request"),
    )
  )
    return;
  if (run.status !== "cancelled" && run.status !== "failed") return;
  // Deleting a queued request also cancels it, but it has no provider work to resume.
  if (
    run.status === "cancelled" &&
    run.startedAt === null &&
    run.restartContinuationOfRunId === undefined
  )
    return;
  if (
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === run!.activeAttemptId && turn.status === "completed",
    )
  )
    return;
  if (run.status === "failed") {
    const error = turnItems.findLast((item) => item.runId === run!.id && item.type === "error");
    if (
      error?.type !== "error" ||
      error.failure.retryable === false ||
      !["transport_error", "provider_error"].includes(error.failure.class)
    )
      return;
  }
  if (
    run.completedAt === null ||
    now - DateTime.toEpochMillis(run.completedAt) < 15_000 * 2 ** retries
  )
    return;
  const retryMessageId = MessageId.make(`message:nia-recovery:${run.id}`);
  if (projection.messages.some((message) => message.id === retryMessageId)) return;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`command:nia-recovery:${run.id}`),
    threadId: thread.id,
    messageId: retryMessageId,
    text: "Continue where you left off.",
    attachments: [],
    modelSelection: run.modelSelection,
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
    restartContinuationOfRunId: run.id,
  };
}

// The caller supplies only a currently bound Nia session and its latest human request.
// Durable continuation links and command receipts make retries survive process loss.
export const recover = Effect.fn("NiaRequestRecovery.recover")(function* (
  threadId: ThreadId,
  messageId: string,
) {
  const threads = yield* Threads.ThreadManagementService;
  const projection = yield* threads.getThreadRecords(
    threadId,
    ["runs", "messages", "runtimeRequests", "turnItems", "providerTurns"],
    { turnItemTypes: ["run_interrupt_request", "secret_request", "error"] },
  );
  const command = recoveryCommand(
    projection,
    messageId,
    DateTime.toEpochMillis(yield* DateTime.now),
  );
  if (command)
    yield* threads
      .dispatch(command)
      .pipe(Effect.provideService(Access.DispatchOrigin, "internal-server"));
});
