import { assert, it } from "@effect/vitest";
import {
  RunId,
  ThreadId,
  TurnItemId,
  MessageId,
  type OrchestrationV2TurnItem,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { selectAppProviderHistory } from "./appProviderHistory.ts";
const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const completed = RunId.make("completed");
const failed = RunId.make("failed");
const current = RunId.make("current");
function item(
  id: string,
  runId: RunId,
  type: "assistant_message" | "user_message",
  status: "completed" | "running" = "completed",
): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    updatedAt: now,
    text: id,
    messageId: MessageId.make(id),
  };
  return type === "assistant_message"
    ? { ...base, type, streaming: status === "running" }
    : {
        ...base,
        type,
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments: [],
      };
}
it("restores completed history without duplicating the current prompt or accepting failed output", () => {
  const history = selectAppProviderHistory(
    [
      item("question", completed, "user_message"),
      item("answer", completed, "assistant_message"),
      item("failed question", failed, "user_message"),
      item("failed output", failed, "assistant_message"),
      item("partial", completed, "assistant_message", "running"),
      item("current prompt", current, "user_message"),
    ],
    [
      { id: completed, status: "completed" },
      { id: failed, status: "failed" },
      { id: current, status: "running" },
    ],
    current,
  );
  assert.deepStrictEqual(
    history.map((message) => [message.role, message.text]),
    [
      ["user", "question"],
      ["assistant", "answer"],
      ["user", "failed question"],
    ],
  );
});
