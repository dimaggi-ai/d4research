import { describe, expect, it } from "vite-plus/test";

import { buildDefaultDevPipelinePrompt } from "./devPipeline";
import { resolveResearchDirectives, type ResearchProviderCandidate } from "./researchPipeline";

// Ollama shares the Claude driver/CLI namespace and appends custom models after built-ins.
// Put it before the real Claude instance to catch resolution that depends on stream order.
const CLAUDE_BUILT_INS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const OLLAMA_CUSTOM = [
  "kimi-k3:cloud",
  "qwen3.5:cloud",
  "nemotron-3-super:cloud",
  "minimax-m2.7:cloud",
  "glm-5.2:cloud",
  "kimi-k2.7-code:cloud",
];

const ENVIRONMENT: ReadonlyArray<ResearchProviderCandidate> = [
  {
    instanceId: "ollama",
    name: "Ollama",
    cli: "claude",
    models: [...CLAUDE_BUILT_INS, ...OLLAMA_CUSTOM],
  },
  { instanceId: "claudeAgent", name: "Claude", cli: "claude", models: CLAUDE_BUILT_INS },
  {
    instanceId: "codex",
    name: "Codex",
    cli: "codex",
    models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.3-codex"],
  },
  {
    instanceId: "junie",
    name: "Junie",
    cli: "junie",
    models: [
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "gemini-3.1-pro-preview",
      "gemini-3.6-flash",
      "gpt-5.3-codex",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "grok-4.5",
      "custom:t3-local-ollama",
    ],
  },
];

const defaultPrompt = buildDefaultDevPipelinePrompt(ENVIRONMENT);
const resolveAll = () => resolveResearchDirectives(defaultPrompt, ENVIRONMENT, []);

const targetOf = (raw: string) => {
  const resolution = resolveResearchDirectives(raw, ENVIRONMENT, [])[0];
  if (!resolution) throw new Error(`the default pipeline no longer names ${raw}`);
  return resolution.ok
    ? `${resolution.instanceId}:${resolution.model}`
    : `UNRESOLVED: ${resolution.error}`;
};

describe("default dev pipeline against an overlapping provider snapshot", () => {
  it("keeps the default planner and explicit Claude target unambiguous when Ollama is listed first", () => {
    const planner = /STEP 1: PLAN[\s\S]*?Directive: (\S+)/.exec(defaultPrompt)?.[1];
    expect(planner).toBe("!codex:gpt-5.6-sol");
    expect(defaultPrompt).not.toMatch(/Directive: ![^\s]+:claude-/u);
    expect(targetOf("!claudeAgent:claude-opus-5")).toBe("claudeAgent:claude-opus-5");
  });

  it("resolves every directive it names", () => {
    const failed = resolveAll()
      .filter((resolution) => !resolution.ok)
      .map(
        (resolution) => resolution.directive.raw + " -> " + (resolution.ok ? "" : resolution.error),
      );
    expect(failed).toEqual([]);
  });

  it("resolves Ollama models that sit past the built-in Claude ones", () => {
    // The regression this pins: a per-provider model cap of 6 truncated this
    // instance to Claude's built-ins, so the BUILD step could never resolve.
    expect(targetOf("!ollama:kimi-k2.7-code:cloud")).toBe("ollama:kimi-k2.7-code:cloud");
    expect(targetOf("!ollama:glm-5.2:cloud")).toBe("ollama:glm-5.2:cloud");
    expect(targetOf("!ollama:nemotron-3-super:cloud")).toBe("ollama:nemotron-3-super:cloud");
  });

  it("sends !claude to the Claude instance, not to an Ollama alias sharing its cli", () => {
    // Both candidates answer to `claude`; picking by array order would route
    // the planner to whichever instance the server streamed first.
    expect(targetOf("!claude:claude-opus-5")).toBe("claudeAgent:claude-opus-5");
  });

  it("keeps each role on a distinct target when enough targets exist", () => {
    const primaryTargets = [...defaultPrompt.matchAll(/^Directive: (\S+)/gm)].map(
      (match) => match[1],
    );
    expect(primaryTargets).toHaveLength(4);
    expect(new Set(primaryTargets).size).toBe(4);
  });

  it("puts every fallback on a different provider instance from its primary", () => {
    for (const step of defaultPrompt.split(/^STEP /m).slice(1)) {
      const primary = /^.*?Directive: !(\w[\w-]*):/ms.exec(step)?.[1];
      const fallback = /FALLBACK directive: !(\w[\w-]*):/.exec(step)?.[1];
      expect(primary).toBeDefined();
      expect(fallback).toBeDefined();
      expect(fallback).not.toBe(primary);
    }
  });
});
