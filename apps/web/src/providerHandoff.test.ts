import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildProviderHandoffMemory,
  buildProviderHandoffPrompt,
  buildStructuredHandoffTranscript,
  isProviderHandoffCandidate,
  prepareProviderHandoff,
  shouldHandoffModelSelection,
} from "./providerHandoff";

describe("provider handoff", () => {
  it("passes a short thread through unchanged", () => {
    const transcript = buildStructuredHandoffTranscript(
      [
        { role: "user", text: "old context" },
        { role: "assistant", text: "latest result" },
      ],
      6_000,
    );
    expect(transcript).toBe("USER: old context\n\nASSISTANT: latest result");
    expect(transcript).not.toContain("omitted");
  });

  it("keeps the original task AND the newest messages on a long thread", () => {
    const messages = [
      { role: "user", text: "Original task: migrate the billing service to Effect v4." },
      ...Array.from({ length: 40 }, (_value, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `filler message ${index} ${"x".repeat(400)}`,
      })),
      { role: "assistant", text: "Final answer: the migration is complete." },
    ];
    const transcript = buildStructuredHandoffTranscript(messages, 3_000);
    expect(transcript).toContain("migrate the billing service to Effect v4");
    expect(transcript).toContain("USER (original task):");
    expect(transcript).toContain("earlier conversation");
    expect(transcript).toContain("Final answer: the migration is complete.");
    expect(transcript.length).toBeLessThanOrEqual(3_000);
  });

  it("respects the character budget even when the first message is huge", () => {
    const messages = [
      { role: "user", text: "T".repeat(10_000) },
      { role: "assistant", text: "R".repeat(10_000) },
    ];
    const transcript = buildStructuredHandoffTranscript(messages, 1_000);
    expect(transcript.length).toBeLessThanOrEqual(1_000);
    expect(transcript).toContain("R");
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
    const small = buildStructuredHandoffTranscript(messages, 400);
    expect(small).toContain("earlier conversation");
    expect(small.length).toBeLessThanOrEqual(400);

    const large = buildStructuredHandoffTranscript(messages, 50_000);
    expect(large).not.toContain("earlier conversation");
  });

  it("prepare client returns null on network failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    try {
      const result = await prepareProviderHandoff({ transcript: "test transcript" });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("prepare client returns null on non-ok response", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 502 }));
    try {
      const result = await prepareProviderHandoff({ transcript: "test transcript" });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("prepare client posts once to /api/handoff/prepare and returns the summary", async () => {
    const original = globalThis.fetch;
    const calls: Array<string> = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, compressed: "dense summary" }), { status: 200 }),
      );
    }) as typeof globalThis.fetch;
    try {
      const result = await prepareProviderHandoff({
        transcript: "long transcript",
        project: "t3code",
      });
      expect(result).toBe("dense summary");
      expect(calls).toEqual(["/api/handoff/prepare"]);
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
