import * as NodeSqliteClient from "@d4research/shared/nodeSqliteClient";
import { CommandId, IDLE_COMPACTION_TEXT, MessageId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as IdleCompaction from "./IdleCompaction.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const policy = yield* IdleCompaction.IdleCompaction;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "idle-compaction",
      Effect.gen(function* () {
        for (const candidate of yield* policy.due().pipe(NodeSqliteClient.readOnly)) {
          // Receipts deduplicate concurrent sweeps/restarts. The compact turn then
          // becomes the latest run, so it cannot trigger another compact by itself.
          const identity = `idle-compact:${candidate.threadId}:${candidate.runId}`;
          yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(identity),
              messageId: MessageId.make(identity),
              threadId: candidate.threadId,
              idleCompactionOfRunId: candidate.runId,
              idleCompaction: "idleTimeout",
              text: IDLE_COMPACTION_TEXT,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Idle compaction dispatch failed", {
                  threadId: candidate.threadId,
                  cause,
                }),
              ),
            );
        }
      }),
    );
  }),
);
