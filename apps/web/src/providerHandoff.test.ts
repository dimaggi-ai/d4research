import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildProviderHandoffMemory,
  buildProviderHandoffPrompt,
  buildProviderHandoffTitle,
  buildProviderHandoffTranscript,
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
    expect(prompt).toContain("Shared context was saved to local Memo");
    expect(prompt).toContain('memory_search with connector="local"');
    expect(prompt).toContain('project="t3code"');
    expect(prompt).toContain("thread-source");
    expect(prompt).toContain("source thread remains unchanged");
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

  it("labels the new chat as a handoff", () => {
    expect(buildProviderHandoffTitle("Main chat")).toBe("Handoff: Main chat");
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
