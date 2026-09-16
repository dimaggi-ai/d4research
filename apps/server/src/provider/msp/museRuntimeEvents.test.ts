import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ThreadId, ProviderRuntimeEvent } from "@d4research/contracts";
import { Schema } from "effect";
import { decodeMspNotification, type Item } from "./MspProtocol.ts";
import { mspNotificationToRuntimeEvents } from "./museRuntimeEvents.ts";
import { view } from "./mspTestUtils.ts";
const ctx = {
  threadId: ThreadId.make("thread"),
  instanceId: ProviderInstanceId.make("muse"),
  eventId: "event",
  createdAt: "2026-09-16T00:00:00Z",
  items: new Map<string, Item>(),
};
const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
function map(method: string, params: object) {
  const notification = decodeMspNotification(method, { ...view, ...params });
  if (!notification) throw new Error("Unknown fixture method");
  const events = mspNotificationToRuntimeEvents(ctx, notification);
  for (const event of events) decodeRuntimeEvent(event);
  return events;
}
describe("Muse events", () => {
  it("maps completion usage and cancellation", () => {
    expect(
      map("turn/completed", {
        turnId: "turn",
        terminal: "completed",
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3, reasoningTokens: 2 },
      })[0]?.payload,
    ).toMatchObject({ state: "completed", tokenUsage: { inputTokens: 10, cachedInputTokens: 3 } });
    expect(
      map("turn/completed", { turnId: "turn", terminal: "cancelled" })[0]?.payload,
    ).toMatchObject({ state: "cancelled", stopReason: "interrupted" });
  });
  it("reports auth failures and retryable errors", () => {
    const events = map("turn/completed", {
      turnId: "turn",
      terminal: "failed",
      error: { kind: "authRequired", message: "login", retryable: false },
    });
    expect(events.map((e) => e.type)).toEqual(["turn.completed", "runtime.error", "auth.status"]);
    expect(events[0]?.payload).toMatchObject({
      errorMessage: expect.stringContaining("muse login"),
    });
    expect(
      map("turn/completed", {
        turnId: "turn",
        terminal: "failed",
        error: { kind: "rateLimited", message: "slow down", retryable: true },
      })[0]?.payload,
    ).toMatchObject({ errorMessage: "rateLimited: slow down (retryable)" });
  });
  it("renders unknown items and retains future fields", () => {
    const events = map("item/completed", {
      item: {
        itemId: "i",
        kind: "reminderChild",
        status: "completed",
        revision: 1,
        fallbackText: "Done",
        futureField: 42,
      },
    });
    expect(events[0]?.payload).toMatchObject({
      itemType: "unknown",
      detail: "Done",
      data: { futureField: 42 },
    });
  });
  it("emits compaction receipts with measured token counts", () => {
    expect(
      map("item/completed", {
        item: {
          itemId: "i",
          kind: "compaction",
          status: "completed",
          revision: 1,
          tokensBefore: 100,
          tokensAfter: 20,
        },
      })[1],
    ).toMatchObject({
      type: "thread.state.changed",
      payload: { state: "compacted", beforeTokens: 100, afterTokens: 20 },
    });
  });
  for (const [kind, tool, expected] of [
    ["agentMessage", undefined, "assistant_message"],
    ["reasoning", undefined, "reasoning"],
    ["toolCall", "shell", "command_execution"],
    ["toolCall", "apply_patch", "file_change"],
    ["toolCall", "web_search", "web_search"],
    ["toolCall", "custom", "dynamic_tool_call"],
    ["userShell", undefined, "command_execution"],
  ]) {
    it(`maps ${kind}/${tool} lifecycle`, () => {
      expect(
        map("item/started", {
          item: { itemId: "i", kind, status: "inProgress", revision: 1, ...(tool ? { tool } : {}) },
        })[0]?.payload,
      ).toMatchObject({ itemType: expected, status: "inProgress" });
    });
  }
  it("routes deltas by item kind and field", () => {
    ctx.items.set("i", { itemId: "i", kind: "reasoning", status: "inProgress", revision: 1 });
    expect(
      map("item/delta", { itemId: "i", field: "summary.2", delta: "Think" })[0]?.payload,
    ).toEqual({ streamKind: "reasoning_summary_text", delta: "Think", summaryIndex: 2 });
    ctx.items.set("i", {
      itemId: "i",
      kind: "toolCall",
      tool: "shell",
      status: "inProgress",
      revision: 1,
    });
    expect(
      map("item/delta", { itemId: "i", field: "output", delta: "out" })[0]?.payload,
    ).toMatchObject({ streamKind: "command_output" });
  });
  it("maps waiting state, context pressure, gaps and ignores user echo", () => {
    expect(
      map("session/statusChanged", { status: "running", attention: ["approvalPending"] })[0]
        ?.payload,
    ).toEqual({ state: "waiting" });
    expect(
      map("session/contextUsage", { usedTokens: 10, windowTokens: 100, pressure: "normal" })[0]
        ?.payload,
    ).toEqual({ usage: { usedTokens: 10, maxTokens: 100 } });
    expect(map("view/gap", { after: "a", next: "b" })[0]?.type).toBe("runtime.warning");
    expect(
      map("item/started", {
        item: { itemId: "i", kind: "userMessage", revision: 1, status: "completed" },
      }),
    ).toEqual([]);
    expect(decodeMspNotification("skill/changed", {})).toBeUndefined();
  });
});
