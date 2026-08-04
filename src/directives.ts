import type { ResearchRun } from "./contracts";

export type ResearchDirective = {
  question: string;
  providerIds: string[];
  depth: ResearchRun["depth"];
  matched: boolean;
};

export function parseResearchDirective(
  question: string,
  fallbackProviderIds: string[],
  fallbackDepth: ResearchRun["depth"],
): ResearchDirective {
  const match = question.match(/^\s*#deep-research(?:\s*\[([^\]]*)\])?\s*([\s\S]*)$/i);
  if (!match) {
    return {
      question: question.trim(),
      providerIds: fallbackProviderIds,
      depth: fallbackDepth,
      matched: false,
    };
  }
  const providerIds = [...new Set(
    (match[1] || fallbackProviderIds.join(","))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
  const cleanQuestion = (match[2] || "").trim();
  if (!cleanQuestion) throw new Error("#deep-research requires a research question.");
  if (providerIds.length === 0) throw new Error("#deep-research requires at least one provider id.");
  return {
    question: cleanQuestion,
    providerIds,
    depth: fallbackDepth === "max" ? "max" : "deep",
    matched: true,
  };
}
