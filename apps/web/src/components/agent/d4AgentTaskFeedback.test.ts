import {
  D4AgentError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import { d4AgentTaskFailureMessage } from "./d4AgentTaskFeedback";

const selection = {
  instanceId: ProviderInstanceId.make("worker"),
  model: "worker-model",
};

function provider(usedPercent: number): ServerProvider {
  return {
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-28T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt: "2026-10-28T00:00:00.000Z",
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

describe("d4AgentTaskFailureMessage", () => {
  it("distinguishes quota exhaustion from provider availability or authentication", () => {
    const failure = new D4AgentError({ reason: "provider-unavailable" });
    expect(
      d4AgentTaskFailureMessage({
        failure,
        preserved: "Your draft is preserved.",
        providers: [provider(100)],
        selection,
      }),
    ).toContain("out of quota");
    expect(
      d4AgentTaskFailureMessage({
        failure,
        preserved: "Your draft is preserved.",
        providers: [provider(50)],
        selection,
      }),
    ).toContain("unavailable or not authenticated");
  });

  it("uses the preserved artifact name for a stale routine preparation", () => {
    expect(
      d4AgentTaskFailureMessage({
        failure: new D4AgentError({ reason: "stale" }),
        preserved: "Your brief is preserved.",
        providers: [],
        selection,
      }),
    ).toBe(
      "Not sent: Nia's context or session changed after you wrote this. Your brief is preserved. Check it, then try again.",
    );
  });
});
