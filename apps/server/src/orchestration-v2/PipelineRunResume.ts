import {
  CommandId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  PipelineRunResumeError,
  type PipelineRunResumeResult,
  type ThreadId,
} from "@d4research/contracts";
import { pendingPipelineResume } from "@d4research/shared/pipelineRunResume";
import * as Effect from "effect/Effect";

import * as D4AgentStore from "../d4Agent/D4AgentStore.ts";
import {
  describeTaskScopeRefusal,
  evaluateTaskScope,
  repinTaskPipeline,
} from "../d4Agent/D4AgentTaskScope.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

/**
 * The turn text of an explicit resume. The server prepends the RESUME note
 * with the ledger, so this only has to say what the user asked for.
 */
export const PIPELINE_RESUME_PROMPT =
  "Resume the interrupted pipeline run from the next incomplete step.";

/**
 * Continues a pipeline run that a restart, a stop, or a failure cut short.
 * One path for the web Resume button and Nia's `resume` action.
 *
 * A d4-action task stays pinned to the pipeline it was approved under, so a
 * plain message after a pipeline edit is refused. This explicit resume is
 * the re-approval: it re-pins the task to the pipeline as it is now, and only
 * when every other scope check still holds.
 */
export const resumePipelineRun = Effect.fn("PipelineRunResume.resume")(function* (input: {
  readonly threadId: ThreadId;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly store: D4AgentStore.D4AgentStore["Service"] | undefined;
}) {
  const threads = yield* ThreadManagementService;
  const projections = yield* ProjectionStoreV2;
  const unavailable = (detail: string) =>
    new PipelineRunResumeError({ reason: "unavailable", detail });
  const shell = yield* threads
    .getThreadShell(input.threadId)
    .pipe(Effect.mapError(() => unavailable("The thread could not be read.")));
  if (shell === null) return yield* unavailable("The thread does not exist.");
  const records = yield* projections
    .getThreadRecords(input.threadId, ["runs", "messages"])
    .pipe(Effect.mapError(() => unavailable("The thread's runs could not be read.")));
  const pending = pendingPipelineResume({ runs: records.runs, messages: records.messages });
  if (pending === null) {
    const busy = records.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    );
    return yield* new PipelineRunResumeError(
      busy
        ? { reason: "busy", detail: "A run is still active in this thread." }
        : {
            reason: "not-resumable",
            detail: "This thread has no interrupted pipeline run to resume.",
          },
    );
  }

  let repinnedPipeline = false;
  if (String(input.threadId).startsWith("d4-action:")) {
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      Effect.mapError(() => unavailable("Settings could not be read.")),
    );
    const state = input.store === undefined ? undefined : yield* input.store.get;
    const scope = evaluateTaskScope(state, input.threadId, settings.d4Agent, undefined, settings);
    if (scope.status === "pipeline-changed" && input.store !== undefined) {
      yield* input.store
        .update((current) => repinTaskPipeline(current, input.threadId, scope.currentPipelineHash))
        .pipe(Effect.mapError(() => unavailable("The task's approval could not be updated.")));
      repinnedPipeline = true;
    } else if (scope.status !== "ok") {
      return yield* new PipelineRunResumeError({
        reason: "scope-refused",
        detail: describeTaskScopeRefusal(scope),
      });
    }
  }

  // Keyed by the run being resumed, so a double click or a retried request
  // dispatches one resume, and resuming a later interruption gets a new key.
  const resumedRunId = String(pending.chain[0]!.id);
  // Resuming an archived thread means the user wants that thread back.
  if (shell.archivedAt !== null)
    yield* threads
      .dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make(`pipeline-resume-unarchive:${resumedRunId}`),
        threadId: input.threadId,
      })
      .pipe(Effect.mapError(() => unavailable("The archived thread could not be restored.")));
  const sent = yield* threads
    .sendToThread({
      projectId: shell.projectId,
      threadId: input.threadId,
      commandId: CommandId.make(`pipeline-resume:${resumedRunId}`),
      messageId: MessageId.make(`pipeline-resume:${resumedRunId}`),
      text: PIPELINE_RESUME_PROMPT,
      attachments: [],
      mode: "queue",
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    })
    .pipe(
      Effect.mapError((cause) =>
        unavailable(`The resume message could not be sent: ${String(cause.message ?? cause)}`),
      ),
    );
  return {
    threadId: input.threadId,
    runId: sent.run.id,
    repinnedPipeline,
  } satisfies PipelineRunResumeResult;
});
