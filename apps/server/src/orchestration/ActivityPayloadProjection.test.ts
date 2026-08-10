import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("event-1"),
    tone: "tool",
    kind: "tool.completed",
    summary: "research_delegate completed",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("projectActivityPayload research ledger", () => {
  it("retains bounded ACP delegate metadata while dropping the full raw payload", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "research_delegate",
        status: "completed",
        data: {
          toolCallId: "call-1",
          rawInput: {
            name: "research_delegate",
            arguments: { step: "3", target: "junie:grok-4.5", visit: 2 },
          },
          rawOutput: {
            content: "x".repeat(100_000),
            structuredContent: { remainingBudget: 9, durationMs: 65_000 },
          },
        },
      }),
    );
    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      title: "research_delegate",
      status: "completed",
      data: {
        toolCallId: "call-1",
        researchDelegate: {
          callId: "call-1",
          step: "3",
          target: "junie:grok-4.5",
          visit: 2,
          remainingBudget: 9,
          durationMs: 65_000,
          failed: false,
        },
        rawOutput: { content: `${"x".repeat(83)}…` },
      },
    });
  });

  it("adds the same canonical ledger to Codex MCP rows without removing native data", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        status: "failed",
        data: {
          item: {
            id: "mcp-4",
            tool: "research_delegate",
            arguments: { step: "4", target: "codex:gpt-5.6-terra", visit: 1 },
            result: { isError: true, structuredContent: { remainingBudget: 7 } },
          },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        item: { tool: "research_delegate" },
        researchDelegate: {
          callId: "mcp-4",
          step: "4",
          target: "codex:gpt-5.6-terra",
          visit: 1,
          remainingBudget: 7,
          failed: true,
        },
      },
    });
  });
});
