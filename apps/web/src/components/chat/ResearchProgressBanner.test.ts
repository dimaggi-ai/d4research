import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveResearchBannerSteps,
  deriveResearchDelegations,
  formatDelegationElapsed,
  ResearchProgressBanner,
  shortTargetLabel,
  summarizeResearchDelegations,
  summarizeResearchProgress,
} from "./ResearchProgressBanner";

describe("summarizeResearchProgress", () => {
  it("reports the in-progress stage", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Gather primary evidence", status: "inProgress" },
        { step: "Synthesize the answer", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 3, current: "Gather primary evidence" });
  });

  it("falls back to the next unfinished stage between stages", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Challenge findings", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 2, current: "Challenge findings" });
  });

  it("reports no current stage once everything is complete", () => {
    expect(
      summarizeResearchProgress([
        { step: "Scope the question", status: "completed" },
        { step: "Synthesize the answer", status: "completed" },
      ]),
    ).toEqual({ completed: 2, total: 2, current: null });
  });
});

describe("ResearchProgressBanner", () => {
  it("labels a dev pipeline separately from research", () => {
    const markup = renderToStaticMarkup(
      createElement(ResearchProgressBanner, {
        pipelineKind: "dev",
        isRunning: true,
        steps: [{ step: "Review blockers", status: "inProgress" }],
      }),
    );
    expect(markup).toContain('data-pipeline-progress="dev"');
    expect(markup).toContain('aria-label="Dev pipeline progress"');
    expect(markup).toContain("Building");
    expect(markup).not.toContain('data-research-progress="true"');
  });

  it("shows an identified running delegate before the orchestrator publishes its plan", () => {
    const nowMs = Date.now();
    const markup = renderToStaticMarkup(
      createElement(ResearchProgressBanner, {
        pipelineKind: "dev",
        isRunning: true,
        steps: [],
        delegations: [
          {
            callId: "call-1",
            step: "",
            visit: 1,
            target: "",
            settled: false,
            remainingBudget: null,
            failed: false,
            startedAtMs: nowMs,
            lastActivityAtMs: nowMs,
            durationMs: null,
          },
        ],
      }),
    );
    expect(markup).toContain("Delegate");
    expect(markup).toContain("running 0s");
    expect(markup).toContain("signal now");
  });
});

describe("deriveResearchBannerSteps", () => {
  const completedPlan = [
    { step: "Old task", status: "completed" },
    { step: "Older task", status: "completed" },
  ] as const;

  it("hides a completed plan inherited from a previous turn while a new turn runs", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual([]);
  });

  it("keeps a partially finished plan from a previous turn — stages carry across handoffs", () => {
    const steps = [
      { step: "Scope the question", status: "completed" },
      { step: "Gather primary evidence", status: "inProgress" },
    ] as const;
    expect(
      deriveResearchBannerSteps({
        steps,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual(steps);
  });

  it("keeps a completed plan from the current turn — the research genuinely finished", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-2",
        latestTurnId: "turn-2",
        isRunning: true,
      }),
    ).toEqual(completedPlan);
  });

  it("keeps a completed plan once nothing is running", () => {
    expect(
      deriveResearchBannerSteps({
        steps: completedPlan,
        planTurnId: "turn-1",
        latestTurnId: "turn-2",
        isRunning: false,
      }),
    ).toEqual(completedPlan);
  });
});

// Activity shapes below mirror rows read out of a real research run's event
// log: MCP delegate calls carry step/visit/target on the way in and
// remainingBudget on the way out.
const startedDelegate = (step: string, target: string, visit = 1) => ({
  kind: "tool.started",
  payload: {
    itemType: "mcp_tool_call",
    data: { toolName: "mcp__t3-code__research_delegate", input: { step, target, visit } },
  },
});

const completedDelegate = (
  step: string,
  target: string,
  visit = 1,
  extra?: { remainingBudget?: number; isError?: boolean },
) => ({
  kind: "tool.completed",
  payload: {
    itemType: "mcp_tool_call",
    data: {
      toolName: "mcp__t3-code__research_delegate",
      input: { step, target, visit },
      ...(extra?.remainingBudget === undefined
        ? {}
        : { output: { remainingBudget: extra.remainingBudget } }),
      ...(extra?.isError ? { result: { is_error: true } } : {}),
    },
  },
});

describe("deriveResearchDelegations", () => {
  it("reads the bounded ledger emitted by server activity projection", () => {
    expect(
      deriveResearchDelegations([
        {
          kind: "tool.completed",
          payload: {
            itemType: "dynamic_tool_call",
            data: {
              researchDelegate: {
                step: "6",
                target: "junie:gemini-3.1-pro-preview",
                visit: 2,
                remainingBudget: 5,
                failed: false,
              },
            },
          },
        },
      ]),
    ).toEqual([
      {
        callId: null,
        step: "6",
        target: "junie:gemini-3.1-pro-preview",
        visit: 2,
        settled: true,
        remainingBudget: 5,
        failed: false,
        startedAtMs: null,
        lastActivityAtMs: null,
        durationMs: null,
      },
    ]);
  });

  it("ignores non-delegate tool activity", () => {
    expect(
      deriveResearchDelegations([
        { kind: "tool.completed", payload: { data: { toolName: "ToolSearch" } } },
        { kind: "turn.plan.updated", payload: {} },
      ]),
    ).toEqual([]);
  });

  it("collapses a started call into its completion", () => {
    const delegations = deriveResearchDelegations([
      startedDelegate("3", "codex:gpt-5.6-terra"),
      completedDelegate("3", "codex:gpt-5.6-terra", 1, { remainingBudget: 20 }),
    ]);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({ settled: true, remainingBudget: 20 });
  });

  it("tracks elapsed time and provider progress by tool-call identity", () => {
    const started = {
      kind: "tool.started",
      summary: "t3-code · research_delegate started",
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: { itemType: "mcp_tool_call", toolCallId: "mcp-live-1" },
    };
    const progress = {
      kind: "tool.progress",
      createdAt: "2026-08-09T00:01:05.000Z",
      payload: { toolCallId: "mcp-live-1", elapsedSeconds: 65 },
    };
    const inFlight = deriveResearchDelegations([started, progress]);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toMatchObject({
      callId: "mcp-live-1",
      settled: false,
      startedAtMs: Date.parse("2026-08-09T00:00:00.000Z"),
      lastActivityAtMs: Date.parse("2026-08-09T00:01:05.000Z"),
    });

    const completed = {
      kind: "tool.completed",
      createdAt: "2026-08-09T00:01:10.000Z",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          item: {
            id: "mcp-live-1",
            tool: "research_delegate",
            arguments: { step: "3", target: "codex:gpt-5.6-sol", visit: 1 },
            result: { structuredContent: { remainingBudget: 20, durationMs: 70_000 } },
          },
        },
      },
    };
    const settled = deriveResearchDelegations([started, progress, completed]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      callId: "mcp-live-1",
      step: "3",
      target: "codex:gpt-5.6-sol",
      settled: true,
      startedAtMs: Date.parse("2026-08-09T00:00:00.000Z"),
      lastActivityAtMs: Date.parse("2026-08-09T00:01:10.000Z"),
      durationMs: 70_000,
    });
  });

  it("keeps each visit of a rerun distinct", () => {
    const delegations = deriveResearchDelegations([
      completedDelegate("7", "codex:gpt-5.6-sol", 1, { remainingBudget: 8 }),
      completedDelegate("7", "codex:gpt-5.6-sol", 2, { remainingBudget: 7 }),
    ]);
    expect(delegations).toHaveLength(2);
    expect(delegations.map((entry) => entry.visit)).toEqual([1, 2]);
  });

  it("marks an errored delegate as failed", () => {
    const delegations = deriveResearchDelegations([
      completedDelegate("3", "agy:gemini-3.6-flash-high", 1, { isError: true }),
    ]);
    expect(delegations[0]?.failed).toBe(true);
  });

  it("reads the exact Codex MCP lifecycle shape instead of a test-only toolName shape", () => {
    const delegations = deriveResearchDelegations([
      {
        kind: "tool.completed",
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            completedAtMs: 1_778_000_000_000,
            item: {
              type: "mcpToolCall",
              id: "mcp_1",
              server: "t3-code",
              tool: "research_delegate",
              arguments: { step: "4", target: "junie:grok-4.5", visit: 2 },
              result: {
                structuredContent: { remainingBudget: 11, text: "reviewed" },
                isError: false,
              },
              status: "completed",
            },
          },
        },
      },
    ]);
    expect(delegations).toEqual([
      {
        callId: "mcp_1",
        step: "4",
        target: "junie:grok-4.5",
        visit: 2,
        settled: true,
        remainingBudget: 11,
        failed: false,
        startedAtMs: null,
        lastActivityAtMs: null,
        durationMs: null,
      },
    ]);
  });

  it.each([
    [
      "Claude",
      {
        status: "completed",
        data: {
          toolName: "mcp__t3-code__research_delegate",
          input: { step: "2", target: "codex:gpt-5.6-sol", visit: 1 },
          result: { content: '{"remainingBudget":19}' },
        },
      },
    ],
    [
      "OpenCode",
      {
        status: "completed",
        data: {
          tool: "mcp__t3-code__research_delegate",
          state: {
            status: "completed",
            input: { step: "2", target: "opencode:deepseek", visit: 1 },
            output: '{"remainingBudget":18}',
          },
        },
      },
    ],
    [
      "ACP",
      {
        status: "failed",
        data: {
          rawInput: {
            name: "research_delegate",
            arguments: { step: "2", target: "junie:gemini-3.1-pro-preview", visit: 1 },
          },
          rawOutput: { remainingBudget: 17, is_error: true },
        },
      },
    ],
  ])("normalizes the %s adapter payload", (_provider, payload) => {
    const [delegation] = deriveResearchDelegations([{ kind: "tool.completed", payload }]);
    expect(delegation).toMatchObject({ step: "2", visit: 1, settled: true });
    expect(delegation?.remainingBudget).not.toBeNull();
  });
});

describe("summarizeResearchDelegations", () => {
  it("surfaces the in-flight call, budget, reruns, and failures", () => {
    const summary = summarizeResearchDelegations(
      deriveResearchDelegations([
        completedDelegate("3", "agy:gemini-3.6-flash-high", 1, { isError: true }),
        completedDelegate("7", "codex:gpt-5.6-sol", 1, { remainingBudget: 9 }),
        completedDelegate("7", "codex:gpt-5.6-sol", 2, { remainingBudget: 8 }),
        startedDelegate("7", "ollama:nemotron-3-super:cloud", 3),
      ]),
    );
    expect(summary.used).toBe(4);
    expect(summary.failures).toBe(1);
    // Latest reported budget wins, not the first.
    expect(summary.remainingBudget).toBe(8);
    // A reran fact-check is visible as visit 3 on step 7.
    expect(summary.visitsByStep.get("7")).toBe(3);
    expect(summary.inFlight?.target).toBe("ollama:nemotron-3-super:cloud");
  });

  it("reports no in-flight call once everything settled", () => {
    const summary = summarizeResearchDelegations(
      deriveResearchDelegations([completedDelegate("1", "codex:gpt-5.6-sol")]),
    );
    expect(summary.inFlight).toBeNull();
  });
});

describe("shortTargetLabel", () => {
  it("drops the provider prefix but keeps colon-bearing model slugs", () => {
    expect(shortTargetLabel("claudeAgent:claude-fable-5")).toBe("claude-fable-5");
    expect(shortTargetLabel("ollama:kimi-k2.7-code:cloud")).toBe("kimi-k2.7-code:cloud");
    expect(shortTargetLabel("bare-model")).toBe("bare-model");
    expect(shortTargetLabel("")).toBe("Delegate");
  });
});

describe("formatDelegationElapsed", () => {
  it("keeps running time compact at minute and hour boundaries", () => {
    expect(formatDelegationElapsed(9_999)).toBe("9s");
    expect(formatDelegationElapsed(65_000)).toBe("1m 05s");
    expect(formatDelegationElapsed(3_720_000)).toBe("1h 02m");
  });
});
