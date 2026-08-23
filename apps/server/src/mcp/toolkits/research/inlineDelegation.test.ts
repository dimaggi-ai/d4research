import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RESEARCH_STEP_VISIT_LIMIT,
  type ServerProvider,
} from "@d4research/contracts";
import { parseInlineDelegateTrigger } from "@d4research/shared/researchPipeline";

import { INLINE_DELEGATION_STEP, resolveInlineDelegateTarget } from "./inlineDelegation.ts";

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly models: ReadonlyArray<string>;
  readonly status?: ServerProvider["status"];
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  displayName: input.displayName,
  enabled: true,
  installed: true,
  version: "test",
  status: input.status ?? "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-08T00:00:00.000Z",
  availability: "available",
  models: input.models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  provider({
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    models: ["gpt-5.6-sol", "gpt-5.6-terra"],
  }),
  provider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    models: ["claude-fable-5", "claude-opus-5"],
  }),
];

const resolve = (prompt: string, providers: ReadonlyArray<ServerProvider> = PROVIDERS) => {
  const trigger = parseInlineDelegateTrigger(prompt);
  expect(trigger).not.toBeNull();
  return resolveInlineDelegateTarget(trigger!.directive, providers);
};

describe("resolveInlineDelegateTarget", () => {
  it("resolves a directive to an exact, ready instance and canonical model slug", () => {
    expect(resolve("!codex:sol explain this stack trace")).toEqual({
      ok: true,
      target: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        resolvedTarget: "codex:gpt-5.6-sol",
        providerName: "Codex",
      },
    });
  });

  it("refuses an unknown provider rather than guessing one", () => {
    const result = resolve("!nope:whatever do the thing");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toContain('No ready provider matches "nope"');
  });

  it("refuses an ambiguous model rather than picking the first", () => {
    const result = resolve("!codex:gpt-5.6 do the thing");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toContain("ambiguous");
  });

  it("refuses a provider that is not ready", () => {
    const result = resolve("!codex:gpt-5.6-sol do the thing", [
      provider({
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: ["gpt-5.6-sol"],
        status: "error",
      }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toContain('No ready provider matches "codex"');
  });

  it("never substitutes: exact policy leaves no room for an unauthored fallback", () => {
    const result = resolve("!claude:claude-fable-5 review", [PROVIDERS[0]!]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).not.toContain("gpt-5.6");
  });
});

describe("inline delegation budget key", () => {
  it("uses a step name no pipeline step can collide with", () => {
    // The budget's visit key is `${step}→${target}`; a pipeline names its steps
    // by number or title, so an inline turn can never eat a pipeline's visits.
    expect(INLINE_DELEGATION_STEP).toBe("inline");
    expect(RESEARCH_STEP_VISIT_LIMIT).toBeGreaterThan(0);
  });
});
