import {
  CommandId,
  D4AgentError,
  type D4BrainContext,
  type ProjectId,
  type ThreadId,
} from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export interface AgentStartedThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly context: D4BrainContext;
  readonly actionId: string;
  readonly pipelineId?: string;
  readonly pipelineHash?: string;
  readonly scopeHash?: string;
  readonly reportedAt: string | null;
  readonly archivedAt: string | null;
  readonly undoDisabled: boolean;
}

export class D4AgentThreadLifecycle extends Context.Service<
  D4AgentThreadLifecycle,
  {
    readonly archive: (
      record: AgentStartedThread,
      delayHours: number | null,
    ) => Effect.Effect<boolean, D4AgentError>;
    readonly undo: (record: AgentStartedThread) => Effect.Effect<void, D4AgentError>;
  }
>()("d4research/d4Agent/D4AgentThreadLifecycle") {}

const threadError = (cause: unknown) => new D4AgentError({ reason: "thread", cause });
const unsettled = new Set(["preparing", "queued", "starting", "pending", "running", "waiting"]);

const make = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const threads = yield* Threads.ThreadManagementService;
  const archive = Effect.fn("D4AgentThreadLifecycle.archive")(function* (
    record: AgentStartedThread,
    delayHours: number | null,
  ) {
    if (
      delayHours === null ||
      !Number.isFinite(delayHours) ||
      delayHours < 0 ||
      record.reportedAt === null ||
      record.archivedAt !== null ||
      record.undoDisabled
    )
      return false;
    const now = yield* Clock.currentTimeMillis;
    const reportedAt = Date.parse(record.reportedAt);
    if (!Number.isFinite(reportedAt) || now < reportedAt + delayHours * 3_600_000) return false;
    const shell = yield* threads.getThreadShell(record.threadId).pipe(Effect.mapError(threadError));
    if (
      shell === null ||
      shell.projectId !== record.projectId ||
      shell.createdBy !== "agent" ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.pinnedAt != null ||
      // A pull request is ongoing work the user reviews from the thread.
      shell.linkedPullRequest != null ||
      shell.branchPullRequest != null ||
      (shell.pullRequests?.length ?? 0) > 0 ||
      shell.activeRunId !== null ||
      shell.pendingRuntimeRequest !== null ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
      shell.latestUserAuthoredMessageAt != null ||
      shell.hasActionableProposedPlan ||
      shell.latestRunId === null
    )
      return false;
    const projection = yield* projections
      .getThreadProjection(record.threadId)
      .pipe(Effect.mapError(threadError));
    const latestRun = projection.runs.find((run) => run.id === shell.latestRunId);
    // The report must refer to the completed run, never an earlier turn.
    if (
      latestRun?.status !== "completed" ||
      latestRun.completedAt === null ||
      DateTime.toEpochMillis(latestRun.completedAt) > reportedAt ||
      projection.runs.some((run) => unsettled.has(run.status)) ||
      projection.runtimeRequests.some((request) => request.status === "pending") ||
      projection.messages.some(
        (message) => message.role === "user" && message.createdBy !== "agent",
      ) ||
      projection.subagents.some((agent) => unsettled.has(agent.status))
    )
      return false;
    yield* threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(
          `d4-auto-archive:${record.actionId}:${DateTime.toEpochMillis(shell.updatedAt)}`,
        ),
        threadId: record.threadId,
        onlyIfUpdatedAt: DateTime.formatIso(shell.updatedAt),
      })
      .pipe(Effect.mapError(threadError));
    return true;
  });
  const undo = Effect.fn("D4AgentThreadLifecycle.undo")(function* (record: AgentStartedThread) {
    if (record.archivedAt === null || record.undoDisabled)
      return yield* new D4AgentError({ reason: "action-unavailable" });
    const shell = yield* threads.getThreadShell(record.threadId).pipe(Effect.mapError(threadError));
    if (
      shell === null ||
      shell.projectId !== record.projectId ||
      shell.createdBy !== "agent" ||
      shell.deletedAt !== null
    )
      return yield* new D4AgentError({ reason: "action-unavailable" });
    if (shell.archivedAt !== null)
      yield* threads
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`d4-auto-archive-undo:${record.actionId}`),
          threadId: record.threadId,
        })
        .pipe(Effect.mapError(threadError));
  });
  return D4AgentThreadLifecycle.of({ archive, undo });
});

export const layer = Layer.effect(D4AgentThreadLifecycle, make);
