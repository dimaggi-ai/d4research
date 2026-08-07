// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { compressHandoffContextLocal } from "./handoffCompression.ts";
import { buildHandoffMemoryText, resolveHandoffPreparePlan } from "./http.ts";
import { makeBuiltinMemoryConnector } from "./mcp/toolkits/memory/builtinStore.ts";

/**
 * QA for the research handoff path: the bypass plan, the local small-model
 * compression it replaces, and the memory round-trip a handoff performs. The
 * live half runs against a local gemma4 tag via Ollama and skips cleanly when
 * the daemon is absent, so CI stays hermetic.
 */
const OLLAMA_URL = "http://127.0.0.1:11434";
const GENERATION_TIMEOUT_MS = 120_000;

async function pickGemmaModel(): Promise<string | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (payload.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string");
    return (
      names.find((name) => name === "gemma4:e4b-it-qat") ??
      names.find((name) => name.startsWith("gemma4:")) ??
      null
    );
  } catch {
    return null;
  }
}

const SAMPLE_TRANSCRIPT = [
  "user: Compare FTS5 and embedding search for agent memory.",
  "assistant: FTS5 gives exact keyword recall with BM25 ranking and zero dependencies;",
  "embeddings capture paraphrase but need a model and an index.",
  "user: Which should our research pipeline use for handoff context?",
  "assistant: FTS5 — handoff context quotes commands, file paths, and slugs, which keyword search retrieves verbatim.",
].join("\n");

describe("handoff compression bypass", () => {
  const enabledLocal = { enabled: true, backend: "local" as const };

  it("bypass forces passthrough even when compression is fully configured", () => {
    expect(resolveHandoffPreparePlan(enabledLocal, true)).toBe("passthrough");
    expect(
      resolveHandoffPreparePlan(
        { enabled: true, backend: "provider", instanceId: "claudeAgent", model: "claude-fable-5" },
        true,
      ),
    ).toBe("passthrough");
  });

  it("without bypass the configured plan still applies", () => {
    expect(resolveHandoffPreparePlan(enabledLocal, false)).toBe("local");
    expect(resolveHandoffPreparePlan({ enabled: false, backend: "local" }, false)).toBe(
      "passthrough",
    );
  });
});

describe("handoff memory round-trip (builtin store)", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-qa-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it.effect("a stored handoff is findable by the terms a later agent would search", () =>
    Effect.gen(function* () {
      const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const text = buildHandoffMemoryText({
        summary: SAMPLE_TRANSCRIPT,
        sourceThreadId: "qa-thread-1",
        sourceThreadTitle: "Memory backend research",
        target: { instanceId: "claudeAgent", model: "claude-fable-5" },
      });
      const stored = yield* connector.add(text, "t3research-provider-handoff", "t3code");
      expect(stored.ok).toBe(true);
      const found = yield* connector.search("FTS5 handoff context", 3, "t3code");
      expect(found.results.length).toBeGreaterThan(0);
      expect(found.results[0]?.text).toContain("Memory backend research");
      // The transcript itself crossed as-is — evidence must survive verbatim.
      expect(found.results[0]?.text).toContain("BM25 ranking");
    }),
  );
});

describe("handoff compression QA (live gemma4)", () => {
  it.effect(
    "the local small model produces a bounded, on-topic summary",
    () =>
      Effect.gen(function* () {
        const model = yield* Effect.promise(pickGemmaModel);
        if (!model) {
          yield* Effect.log("SKIP handoff compression QA — no local Ollama daemon or gemma4 tag");
          return;
        }
        const compressed = yield* compressHandoffContextLocal({
          transcript: SAMPLE_TRANSCRIPT,
          model,
          baseUrl: OLLAMA_URL,
          maxInputCharacters: 6_000,
          maxOutputCharacters: 1_200,
          customPrompt: "",
          timeoutMillis: GENERATION_TIMEOUT_MS,
        });
        expect(compressed.trim().length).toBeGreaterThan(0);
        expect(compressed.length).toBeLessThanOrEqual(1_200);
        // On-topic: the summary must retain the load-bearing subject.
        expect(compressed.toLowerCase()).toMatch(/fts5|keyword|memory/);
      }),
    GENERATION_TIMEOUT_MS + 10_000,
  );
});
