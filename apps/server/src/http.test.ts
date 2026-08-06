import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  buildHandoffMemoryText,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  selectHandoffCompressionPlan,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("handoff prepare", () => {
  it("passes the transcript through when compression is disabled", () => {
    expect(
      selectHandoffCompressionPlan({
        enabled: false,
        backend: "provider",
        instanceId: "claude",
        model: "sonnet",
      }),
    ).toBe("passthrough");
  });

  it("uses the local model by default", () => {
    expect(selectHandoffCompressionPlan({ enabled: true, backend: "local" })).toBe("local");
  });

  it("uses a provider session only when fully configured", () => {
    expect(
      selectHandoffCompressionPlan({
        enabled: true,
        backend: "provider",
        instanceId: "claude",
        model: "sonnet",
      }),
    ).toBe("provider");
    expect(selectHandoffCompressionPlan({ enabled: true, backend: "provider" })).toBe("local");
    expect(
      selectHandoffCompressionPlan({ enabled: true, backend: "provider", instanceId: "claude" }),
    ).toBe("local");
  });

  it("stores the compressed summary with its source thread and target", () => {
    const text = buildHandoffMemoryText({
      summary: "Dense summary of the work.",
      sourceThreadId: "thread-source",
      sourceThreadTitle: "Voice integration",
      target: { instanceId: "claude", model: "claude-sonnet" },
    });
    expect(text).toContain("Voice integration");
    expect(text).toContain("thread-source");
    expect(text).toContain("claude / claude-sonnet");
    expect(text).toContain("Dense summary of the work.");
  });

  it("still builds a memory record without thread metadata", () => {
    const text = buildHandoffMemoryText({ summary: "Just the summary." });
    expect(text).toContain("d4research provider handoff.");
    expect(text).toContain("Just the summary.");
  });
});
