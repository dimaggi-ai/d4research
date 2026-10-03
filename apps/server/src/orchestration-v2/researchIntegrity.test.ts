import { describe, expect, it } from "@effect/vitest";
import { RunId, type OrchestrationV2ThreadProjection } from "@d4research/contracts";

import {
  DEV_ORCHESTRATOR_SENTINEL,
  RESEARCH_INTEGRITY_WARNING_KIND,
  RESEARCH_ORCHESTRATOR_SENTINEL,
  countResearchDelegations,
  hasAdvancedPastBrief,
  shouldWarnFakedPipeline,
  type ResearchIntegrityProjection,
} from "./researchIntegrity.ts";

type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];

const firstRun = RunId.make("run-integrity-first");
const secondRun = RunId.make("run-integrity-second");

function userMessage(text: string, runId = firstRun): TurnItem {
  return { type: "user_message", text, runId } as TurnItem;
}

function assistantMessage(text: string, runId = firstRun): TurnItem {
  return { type: "assistant_message", text, runId } as TurnItem;
}

function dynamicTool(toolName: string, runId = firstRun, input: unknown = {}): TurnItem {
  return { type: "dynamic_tool", toolName, input, runId } as TurnItem;
}

function systemNotice(kind: string, runId = firstRun): TurnItem {
  return {
    type: "system_notice",
    message: kind,
    activity: { kind, payload: {} },
    runId,
  } as TurnItem;
}

function projection(...turnItems: ReadonlyArray<TurnItem>): ResearchIntegrityProjection {
  return { turnItems };
}

const researchPrompt = `!research:default\n\nYou are the research orchestrator.\n${RESEARCH_ORCHESTRATOR_SENTINEL}`;
const devPrompt = `!dev:default fix the mobile regression\n\n${DEV_ORCHESTRATOR_SENTINEL}`;

describe("researchIntegrity", () => {
  it("flags a research run that advances past the brief without delegating", () => {
    const faked = projection(
      userMessage(researchPrompt),
      assistantMessage("[step 1 | visit 1] brief...\n[step 8 | visit 1]\n## Conclusion\nDone."),
    );

    expect(shouldWarnFakedPipeline(faked, firstRun)).toBe(true);
  });

  it("recognizes a server-expanded dev run from its compact persisted directive", () => {
    const faked = projection(
      userMessage("!dev:default fix the mobile regression"),
      assistantMessage("[step 3 | visit 1] review complete"),
    );

    expect(shouldWarnFakedPipeline(faked, firstRun)).toBe(true);
  });

  it("recognizes compact research directives and the explicit research manifest", () => {
    const compact = projection(
      userMessage("!research:private audit the release"),
      assistantMessage("[step 2 | visit 1] invented audit"),
    );
    const manifest = projection(
      userMessage("Please investigate this issue."),
      systemNotice("research.run.started"),
      assistantMessage("[step 2 | visit 1] invented audit"),
    );

    expect(shouldWarnFakedPipeline(compact, firstRun)).toBe(true);
    expect(shouldWarnFakedPipeline(manifest, firstRun)).toBe(true);
  });

  it("flags markerless RUN STATE completion claims", () => {
    const faked = projection(
      userMessage(devPrompt),
      assistantMessage(
        "Implemented and verified.\n\nRUN STATE\nPlan PASS; build PASS; review PASS.",
      ),
    );

    expect(hasAdvancedPastBrief(faked, firstRun)).toBe(false);
    expect(shouldWarnFakedPipeline(faked, firstRun)).toBe(true);
  });

  it("does not flag a brief-only run or an ordinary thread with step-like prose", () => {
    const briefOnly = projection(
      userMessage(researchPrompt),
      assistantMessage("[step 1 | visit 1] writing the brief, will delegate next."),
    );
    const ordinary = projection(
      userMessage("Walk me through step 2 of setup."),
      assistantMessage("# Step 2: install dependencies"),
    );

    expect(hasAdvancedPastBrief(briefOnly, firstRun)).toBe(false);
    expect(shouldWarnFakedPipeline(briefOnly, firstRun)).toBe(false);
    expect(shouldWarnFakedPipeline(ordinary, firstRun)).toBe(false);
  });

  it("counts only a real dynamic_tool research_delegate, not narration or discovery", () => {
    const items = projection(
      userMessage(researchPrompt),
      assistantMessage("I called research_delegate and then completed the audit. [step 2]"),
      dynamicTool("ToolSearch", firstRun, { query: "select:research_delegate" }),
      dynamicTool("mcp__t3-code__research_delegate"),
    );

    expect(countResearchDelegations(items, firstRun)).toBe(1);
    expect(shouldWarnFakedPipeline(items, firstRun)).toBe(false);
  });

  it("recognizes the exact ACP tool name without an MCP prefix", () => {
    const items = projection(
      userMessage(researchPrompt),
      assistantMessage("[step 2] delegating"),
      dynamicTool("research_delegate"),
    );

    expect(countResearchDelegations(items, firstRun)).toBe(1);
    expect(shouldWarnFakedPipeline(items, firstRun)).toBe(false);
  });

  it("scopes delegated work and progress to the completed run", () => {
    const items = projection(
      userMessage(researchPrompt, firstRun),
      assistantMessage("[step 2] a real earlier delegation", firstRun),
      dynamicTool("research_delegate", firstRun),
      userMessage(devPrompt, secondRun),
      assistantMessage("[step 3] invented review", secondRun),
    );

    expect(shouldWarnFakedPipeline(items, firstRun)).toBe(false);
    expect(shouldWarnFakedPipeline(items, secondRun)).toBe(true);
    expect(hasAdvancedPastBrief(items, firstRun)).toBe(true);
    expect(countResearchDelegations(items, secondRun)).toBe(0);
  });

  it("suppresses one warning per run, not per thread", () => {
    const items = projection(
      userMessage(researchPrompt, firstRun),
      assistantMessage("[step 2] faking it", firstRun),
      systemNotice(RESEARCH_INTEGRITY_WARNING_KIND, firstRun),
      userMessage(devPrompt, secondRun),
      assistantMessage("[step 2] faking it again", secondRun),
    );

    expect(shouldWarnFakedPipeline(items, firstRun)).toBe(false);
    expect(shouldWarnFakedPipeline(items, secondRun)).toBe(true);
  });
});
