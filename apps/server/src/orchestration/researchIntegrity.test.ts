import { describe, expect, it } from "@effect/vitest";
import { TurnId, type OrchestrationThread } from "@t3tools/contracts";

import {
  DEV_ORCHESTRATOR_SENTINEL,
  RESEARCH_INTEGRITY_WARNING_KIND,
  RESEARCH_ORCHESTRATOR_SENTINEL,
  countResearchDelegations,
  hasAdvancedPastBrief,
  shouldWarnFakedPipeline,
} from "./researchIntegrity.ts";

type Message = { role: "user" | "assistant"; text: string; turnId?: TurnId };
type Activity = { kind: string; payload: unknown; turnId?: TurnId };

// The predicates only read `messages` and `activities`; build the narrow shape
// they touch and cast, rather than decoding a full thread snapshot.
function thread(input: {
  messages?: ReadonlyArray<Message>;
  activities?: ReadonlyArray<Activity>;
}): OrchestrationThread {
  return {
    messages: input.messages ?? [],
    activities: input.activities ?? [],
  } as unknown as OrchestrationThread;
}

const orchestratorPrompt = `!research:default\n\nYou are the research orchestrator.\n${RESEARCH_ORCHESTRATOR_SENTINEL}\n1. TRACE ...`;
const devPrompt = `!dev:default\n\n${DEV_ORCHESTRATOR_SENTINEL}\n1. TRACE ...`;

const realDelegateActivity: Activity = {
  kind: "tool.completed",
  payload: {
    itemType: "mcp_tool_call",
    detail: 'mcp__t3-code__research_delegate: {"target":"claudeAgent:claude-fable-5"}',
    data: { toolName: "mcp__t3-code__research_delegate" },
  },
};

// The discovery step names the tool but is not a real invocation.
const toolSearchActivity: Activity = {
  kind: "tool.completed",
  payload: {
    itemType: "dynamic_tool_call",
    detail: 'ToolSearch: {"query":"select:research_delegate"}',
    data: { toolName: "ToolSearch" },
  },
};

describe("researchIntegrity", () => {
  it("flags a research thread that advanced past the brief with zero delegations", () => {
    const faked = thread({
      messages: [
        { role: "user", text: orchestratorPrompt },
        {
          role: "assistant",
          text: "[step 1 | visit 1] brief...\n[step 8 | visit 1]\n## Conclusion\nDone.",
        },
      ],
      activities: [],
    });
    expect(shouldWarnFakedPipeline(faked)).toBe(true);
  });

  it("flags a dev pipeline that narrates later steps without delegating", () => {
    expect(
      shouldWarnFakedPipeline(
        thread({
          messages: [
            { role: "user", text: devPrompt },
            { role: "assistant", text: "[step 3 | visit 1] review complete" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("flags a markerless RUN STATE completion claim with zero delegations", () => {
    const faked = thread({
      messages: [
        { role: "user", text: devPrompt },
        {
          role: "assistant",
          text: "Implemented and verified.\n\nRUN STATE\nPlan PASS; build PASS; review PASS.",
        },
      ],
    });
    expect(hasAdvancedPastBrief(faked)).toBe(false);
    expect(shouldWarnFakedPipeline(faked)).toBe(true);
  });

  it("flags a server-expanded dev run whose persisted message remains the raw trigger", () => {
    expect(
      shouldWarnFakedPipeline(
        thread({
          messages: [
            { role: "user", text: "!dev:default fix the mobile regression" },
            { role: "assistant", text: "[step 2 | visit 1] invented build" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a thread that actually delegated", () => {
    const real = thread({
      messages: [
        { role: "user", text: orchestratorPrompt },
        { role: "assistant", text: "[step 2 | visit 1] delegating..." },
      ],
      activities: [toolSearchActivity, realDelegateActivity],
    });
    expect(countResearchDelegations(real)).toBe(1);
    expect(shouldWarnFakedPipeline(real)).toBe(false);
  });

  it("does not let an older successful run immunize a later fake dev run", () => {
    const oldTurn = TurnId.make("turn-old");
    const currentTurn = TurnId.make("turn-current");
    const repeated = thread({
      messages: [
        { role: "user", text: orchestratorPrompt, turnId: oldTurn },
        { role: "assistant", text: "[step 2 | visit 1] delegated", turnId: oldTurn },
        { role: "user", text: devPrompt, turnId: currentTurn },
        { role: "assistant", text: "[step 3 | visit 1] invented review", turnId: currentTurn },
      ],
      activities: [{ ...realDelegateActivity, turnId: oldTurn }],
    });

    expect(shouldWarnFakedPipeline(repeated, oldTurn)).toBe(false);
    expect(shouldWarnFakedPipeline(repeated, currentTurn)).toBe(true);
  });

  it("scopes warning suppression to the completed turn", () => {
    const oldTurn = TurnId.make("turn-warned");
    const currentTurn = TurnId.make("turn-new");
    const repeated = thread({
      messages: [
        { role: "user", text: orchestratorPrompt, turnId: oldTurn },
        { role: "assistant", text: "[step 2] fake", turnId: oldTurn },
        { role: "user", text: devPrompt, turnId: currentTurn },
        { role: "assistant", text: "[step 2] fake again", turnId: currentTurn },
      ],
      activities: [{ kind: RESEARCH_INTEGRITY_WARNING_KIND, payload: {}, turnId: oldTurn }],
    });

    expect(shouldWarnFakedPipeline(repeated, currentTurn)).toBe(true);
  });

  it("counts only real delegations, never the ToolSearch discovery step", () => {
    const t = thread({ activities: [toolSearchActivity, toolSearchActivity] });
    expect(countResearchDelegations(t)).toBe(0);
  });

  it("recognizes ACP adapters that report the exact tool name without an MCP prefix", () => {
    const activity: Activity = {
      kind: "tool.completed",
      payload: { data: { toolName: "research_delegate" } },
    };
    expect(countResearchDelegations(thread({ activities: [activity] }))).toBe(1);
  });

  it("recognizes the exact Codex item.tool lifecycle payload", () => {
    const activity: Activity = {
      kind: "tool.completed",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            server: "t3-code",
            tool: "research_delegate",
            arguments: { step: "2", target: "junie:grok-4.5", visit: 1 },
            result: { structuredContent: { remainingBudget: 20 } },
          },
        },
      },
    };
    expect(countResearchDelegations(thread({ activities: [activity] }))).toBe(1);
  });

  it("does not flag a brief-only turn (step 1, no advancement)", () => {
    const briefOnly = thread({
      messages: [
        { role: "user", text: orchestratorPrompt },
        { role: "assistant", text: "[step 1 | visit 1] writing the brief, will delegate next." },
      ],
    });
    expect(hasAdvancedPastBrief(briefOnly)).toBe(false);
    expect(shouldWarnFakedPipeline(briefOnly)).toBe(false);
  });

  it("ignores non-research threads even with step-like prose", () => {
    const notResearch = thread({
      messages: [
        { role: "user", text: "walk me through step 2 of the setup" },
        { role: "assistant", text: "# Step 2: install deps" },
      ],
    });
    expect(shouldWarnFakedPipeline(notResearch)).toBe(false);
  });

  it("warns at most once per thread", () => {
    const alreadyWarnedThread = thread({
      messages: [
        { role: "user", text: orchestratorPrompt },
        { role: "assistant", text: "[step 5 | visit 1] faking it" },
      ],
      activities: [{ kind: RESEARCH_INTEGRITY_WARNING_KIND, payload: {} }],
    });
    expect(shouldWarnFakedPipeline(alreadyWarnedThread)).toBe(false);
  });
});
