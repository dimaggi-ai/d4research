import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildProviderHandoffMemory,
  buildProviderHandoffPrompt,
  buildProviderHandoffTranscript,
  compressProviderHandoffContext,
  isProviderHandoffCandidate,
  shouldHandoffModelSelection,
} from "./providerHandoff";

describe("provider handoff", () => {
  it("keeps the newest bounded conversation context", () => {
    const transcript = buildProviderHandoffTranscript(
      [
        { role: "user", text: "old context" },
        { role: "assistant", text: "latest result" },
      ],
      25,
    );
    expect(transcript).toContain("latest result");
    expect(transcript).toContain("Earlier messages omitted");
  });

  it("tells the receiving provider that shared Memo context is ready", () => {
    const prompt = buildProviderHandoffPrompt({
      sourceThreadId: ThreadId.make("thread-source"),
      sourceThreadTitle: "Voice integration",
      summary: "Voice is deployed and tests pass.",
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
      project: "t3code",
    });
    expect(prompt).toContain("Context attached: local Memo");
    expect(prompt).toContain("continues in the same d2research chat");
    expect(prompt).toContain('memory_search with connector="local"');
    expect(prompt).toContain('project="t3code"');
    expect(prompt).toContain("thread-source");
    expect(prompt).toContain("authoritative conversation history");
  });

  it("builds a self-contained shared-memory handoff record", () => {
    const memory = buildProviderHandoffMemory({
      sourceThreadId: ThreadId.make("thread-source"),
      sourceThreadTitle: "Voice integration",
      summary: "Voice is deployed and tests pass.",
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
    });
    expect(memory).toContain("thread-source");
    expect(memory).toContain("claude / claude-sonnet");
    expect(memory).toContain("Voice is deployed and tests pass.");
  });

  it("hands cross-agent model selections off after a session starts", () => {
    expect(
      shouldHandoffModelSelection({
        hasStartedSession: true,
        currentInstanceId: ProviderInstanceId.make("codex"),
        nextInstanceId: ProviderInstanceId.make("claude"),
        modelChangeRequiresNewThread: false,
        providerChanged: true,
      }),
    ).toBe(true);
    expect(
      shouldHandoffModelSelection({
        hasStartedSession: false,
        currentInstanceId: ProviderInstanceId.make("codex"),
        nextInstanceId: ProviderInstanceId.make("claude"),
        modelChangeRequiresNewThread: false,
        providerChanged: true,
      }),
    ).toBe(false);
  });

  it("accepts a custom maxCharacters for transcript building", () => {
    const messages = [
      { role: "user", text: "A".repeat(500) },
      { role: "assistant", text: "B".repeat(500) },
    ];
    const small = buildProviderHandoffTranscript(messages, 200);
    expect(small).toContain("Earlier messages omitted");
    expect(small.length).toBeLessThanOrEqual(200 + "[Earlier messages omitted]\n\n".length);

    const large = buildProviderHandoffTranscript(messages, 50_000);
    expect(large).not.toContain("Earlier messages omitted");
  });

  it("compression client returns null on network failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    try {
      const result = await compressProviderHandoffContext("test transcript");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("compression client returns null on non-ok response", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 502 }));
    try {
      const result = await compressProviderHandoffContext("test transcript");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("compression client returns compressed text on success", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, compressed: "dense summary" }), { status: 200 }),
      );
    try {
      const result = await compressProviderHandoffContext("long transcript");
      expect(result).toBe("dense summary");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never offers the source provider as a handoff target", () => {
    const source = ProviderInstanceId.make("codex");
    expect(
      isProviderHandoffCandidate(
        { instanceId: source, enabled: true, isAvailable: true, status: "ready", models: [{}] },
        source,
      ),
    ).toBe(false);
    expect(
      isProviderHandoffCandidate(
        {
          instanceId: ProviderInstanceId.make("claude"),
          enabled: true,
          isAvailable: true,
          status: "ready",
          models: [{}],
        },
        source,
      ),
    ).toBe(true);
  });
});
