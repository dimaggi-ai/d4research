import { describe, expect, it } from "vite-plus/test";

import {
  appendProviderHandoffContext,
  buildProviderHandoffPromptText,
  extractTrailingProviderHandoffContext,
  parseProviderHandoffPrompt,
} from "./providerHandoffPrompt.ts";

const baseInput = {
  sourceThreadId: "thread-42",
  sourceThreadTitle: "Fix the flaky login test",
  summary: "USER: fix login\n\nASSISTANT: done, tests green.",
  targetInstanceId: "claude",
  targetModel: "claude-sonnet-5",
} as const;

describe("provider handoff prompt format", () => {
  it("round-trips build → parse", () => {
    const text = buildProviderHandoffPromptText({
      ...baseInput,
      targetLabel: "Claude Code",
      project: "d4research",
      enabledSkills: ["review", "docs"],
    });
    const parsed = parseProviderHandoffPrompt(text);
    expect(parsed).toEqual({
      target: "Claude Code / claude-sonnet-5",
      sourceThread: "Fix the flaky login test (thread-42)",
      summary: baseInput.summary,
    });
  });

  it("round-trips without project, label, or skills", () => {
    const text = buildProviderHandoffPromptText(baseInput);
    const parsed = parseProviderHandoffPrompt(text);
    expect(parsed?.target).toBe("claude / claude-sonnet-5");
    expect(parsed?.summary).toBe(baseInput.summary);
  });

  it("keeps summary boundaries when the summary quotes the markers", () => {
    const trickySummary = [
      "The transcript quoted a prior handoff:",
      "Handoff context (reference only):",
      "This is context synchronization only, not a request to continue or resume any prior job or task.",
      "…and then continued normally.",
    ].join("\n");
    const parsed = parseProviderHandoffPrompt(
      buildProviderHandoffPromptText({ ...baseInput, summary: trickySummary }),
    );
    expect(parsed?.summary).toBe(trickySummary);
  });

  it("rejects ordinary user text that merely starts the same way", () => {
    expect(parseProviderHandoffPrompt("Handoff to the night shift.")).toBeNull();
    expect(
      parseProviderHandoffPrompt("Handoff to X / y.\nplease summarize the thread for me"),
    ).toBeNull();
  });

  it("rejects a prompt with a damaged trailer", () => {
    const text = buildProviderHandoffPromptText(baseInput).replace(
      "Acknowledge briefly that the context is loaded, then wait for the user's next instruction.",
      "Acknowledge loudly.",
    );
    expect(parseProviderHandoffPrompt(text)).toBeNull();
  });
});

describe("combined provider handoff context block", () => {
  const instruction = "Rerun the failing suite and report what broke.";

  it("round-trips append → extract", () => {
    const text = appendProviderHandoffContext(instruction, {
      ...baseInput,
      targetLabel: "Claude Code",
      project: "d4research",
      enabledSkills: ["review", "docs"],
    });
    expect(text).toContain("Configured global and chat skills: review, docs.");
    expect(text).toContain("Project: d4research");
    expect(extractTrailingProviderHandoffContext(text)).toEqual({
      promptText: instruction,
      handoff: {
        target: "Claude Code / claude-sonnet-5",
        summary: baseInput.summary,
      },
    });
  });

  it("round-trips without project, label, or skills", () => {
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(instruction, baseInput),
    );
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
  });

  it("keeps summary boundaries when the summary quotes the markers", () => {
    const trickySummary = [
      "The transcript quoted a prior handoff:",
      "Context summary (reference only):",
      "</handoff_context>",
      "…and then continued normally.",
    ].join("\n");
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(instruction, { ...baseInput, summary: trickySummary }),
    );
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.summary).toBe(trickySummary);
  });

  it("keeps a bare instruction that only mentions the tag intact", () => {
    const mentions = "Explain what a <handoff_context> block is used for.";
    expect(extractTrailingProviderHandoffContext(mentions)).toEqual({
      promptText: mentions,
      handoff: null,
    });
  });

  it("strips only the trailing block, never a mid-text mention", () => {
    const mentions = "Explain what a <handoff_context> block is used for.";
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(mentions, baseInput),
    );
    expect(extracted.promptText).toBe(mentions);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
  });

  it("returns the text unchanged when the inner structure is damaged", () => {
    const text = appendProviderHandoffContext(instruction, baseInput);
    for (const damaged of [
      text.replace("Source thread: ", "Origin thread: "),
      text.replace("Context summary (reference only):", "Context summary:"),
      text.replace(
        "Do not resume other prior work beyond the user's instruction.",
        "Resume whatever you like.",
      ),
    ]) {
      expect(extractTrailingProviderHandoffContext(damaged)).toEqual({
        promptText: damaged,
        handoff: null,
      });
    }
  });

  it("skips a stray opener line in the user's own text", () => {
    const mentions = ["A block looks like this:", "<handoff_context>", "…and so on."].join("\n");
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(mentions, baseInput),
    );
    expect(extracted.promptText).toBe(mentions);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
  });

  it("resolves to the outer block when the summary quotes a whole earlier handoff", () => {
    const nested = appendProviderHandoffContext("Earlier instruction.", {
      ...baseInput,
      targetInstanceId: "codex",
      targetModel: "gpt-5",
    });
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(instruction, { ...baseInput, summary: nested }),
    );
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
    expect(extracted.handoff?.summary).toBe(nested);
  });

  it("peels only the final block when the user pasted a complete one of their own", () => {
    const pasted = appendProviderHandoffContext("", {
      ...baseInput,
      targetInstanceId: "codex",
      targetModel: "gpt-5",
      summary: "Someone else's transcript.",
    });
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(pasted, baseInput),
    );
    // The pasted block is ordinary user content and must survive verbatim.
    expect(extracted.promptText).toBe(pasted);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
    expect(extracted.handoff?.summary).toBe(baseInput.summary);
  });

  it("prefers the outer block when an unbalanced decoy hides in the summary", () => {
    // Both candidates are unbalanced (one opener, two closers), so the balanced
    // pass finds nothing. The decoy would otherwise borrow the outer trailer.
    const decoySummary = [
      "Transcript fragment:",
      "<handoff_context>",
      "Handoff to Decoy / decoy-model.",
      "Source thread: Other (thread-9)",
      "Target model: decoy / decoy-model",
      "",
      "Context summary (reference only):",
      "noise",
      "</handoff_context>",
      "</handoff_context>",
    ].join("\n");
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(instruction, { ...baseInput, summary: decoySummary }),
    );
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
    expect(extracted.handoff?.summary).toBe(decoySummary);
  });

  it("recognizes a block whose newlines were normalized to CRLF", () => {
    const text = appendProviderHandoffContext(instruction, baseInput).replace(/\n/gu, "\r\n");
    const extracted = extractTrailingProviderHandoffContext(text);
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
    expect(extracted.handoff?.summary).toBe(baseInput.summary);
  });

  it("scans a long message full of stray openers without blowing up", () => {
    const noise = `${"filler line\n".repeat(4_000)}<handoff_context>\n`.repeat(10);
    const text = appendProviderHandoffContext(noise, baseInput);
    expect(text.length).toBeGreaterThan(100_000);
    const started = performance.now();
    const extracted = extractTrailingProviderHandoffContext(text);
    expect(performance.now() - started).toBeLessThan(25);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
  });

  it("stays fast when thousands of openers all look structurally valid", () => {
    const decoy = [
      "<handoff_context>",
      "Handoff to Decoy / m.",
      "Source thread: t (1)",
      "Target model: d / m",
      "",
      "Context summary (reference only):",
      "noise",
      "",
      "not the trailer",
    ].join("\n");
    const text = appendProviderHandoffContext(`${decoy}\n`.repeat(3_000), baseInput);
    expect(text.length).toBeGreaterThan(100_000);
    const started = performance.now();
    const extracted = extractTrailingProviderHandoffContext(text);
    expect(performance.now() - started).toBeLessThan(25);
    expect(extracted.handoff?.target).toBe("claude / claude-sonnet-5");
  });

  it("keeps the block parseable when the thread title spans lines", () => {
    const extracted = extractTrailingProviderHandoffContext(
      appendProviderHandoffContext(instruction, {
        ...baseInput,
        sourceThreadTitle: "Fix the login test\nand the flaky signup one",
        project: "d4\nresearch",
        targetLabel: "Claude\nCode",
      }),
    );
    expect(extracted.promptText).toBe(instruction);
    expect(extracted.handoff?.target).toBe("Claude Code / claude-sonnet-5");
    expect(extracted.handoff?.summary).toBe(baseInput.summary);
  });

  it("does not recognize a legacy full-turn prompt as a combined block", () => {
    const legacy = buildProviderHandoffPromptText(baseInput);
    expect(extractTrailingProviderHandoffContext(legacy).handoff).toBeNull();
    expect(parseProviderHandoffPrompt(legacy)).not.toBeNull();
  });
});
