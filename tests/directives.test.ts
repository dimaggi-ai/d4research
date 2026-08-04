import { describe, expect, test } from "bun:test";

import { parseResearchDirective } from "../src/directives";

describe("parseResearchDirective", () => {
  test("parses and deduplicates an explicit deep-research provider chain", () => {
    expect(
      parseResearchDirective(
        "#deep-research [ollama-local, codex-local, ollama-local] Compare the evidence",
        ["local-mock"],
        "quick",
      ),
    ).toEqual({
      question: "Compare the evidence",
      providerIds: ["ollama-local", "codex-local"],
      depth: "deep",
      matched: true,
    });
  });

  test("uses an API provider list when the directive omits brackets", () => {
    expect(
      parseResearchDirective("#deep-research Preserve context", ["first", "second"], "max"),
    ).toMatchObject({
      question: "Preserve context",
      providerIds: ["first", "second"],
      depth: "max",
    });
  });

  test("leaves an ordinary question and depth unchanged", () => {
    expect(parseResearchDirective("  Ordinary question  ", ["first"], "quick")).toEqual({
      question: "Ordinary question",
      providerIds: ["first"],
      depth: "quick",
      matched: false,
    });
  });
});
