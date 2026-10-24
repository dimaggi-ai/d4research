import { describe, expect, it } from "vite-plus/test";

import { classifyThreadLiveness, type ThreadLivenessEvidence } from "./threadLiveness.ts";

const baseline: ThreadLivenessEvidence = {
  runId: "run-1",
  attemptId: "attempt-1",
  runStatus: "running",
  waitingBackground: false,
  providerState: "running",
  lastProgressAt: 1_000_000,
  now: 1_000_001,
  leaseExpired: false,
  leaseRenewalSupported: false,
};
const classify = (overrides: Partial<ThreadLivenessEvidence> = {}) =>
  classifyThreadLiveness({ ...baseline, ...overrides });

describe("classifyThreadLiveness", () => {
  it("makes suspected stale progress actionable while slow work stays quiet", () => {
    expect(classify().classification).toBe("working");
    expect(classify({ now: 1_120_000 })).toMatchObject({
      classification: "slow",
      attentionRequired: false,
    });
    expect(classify({ now: 1_600_000 })).toMatchObject({
      classification: "suspected_stuck",
      attentionRequired: true,
    });
  });

  it("does not infer failure from host sleep or a forward wall clock jump", () => {
    expect(classify({ now: baseline.now + 86_400_000, leaseExpired: true })).toMatchObject({
      classification: "suspected_stuck",
      attentionRequired: true,
    });
  });

  it.each([null, "invalid", Infinity, NaN, 2_000_000])(
    "does not use invalid or future progress %s as failure evidence",
    (lastProgressAt) => {
      expect(classify({ lastProgressAt })).toMatchObject({
        classification: "working",
        reason: "observation_unavailable",
        attentionRequired: false,
      });
    },
  );

  it("accepts ISO progress and tolerates a backward clock jump", () => {
    expect(classify({ lastProgressAt: "1970-01-01T00:16:40.000Z" }).classification).toBe("working");
    expect(classify({ now: 999_999 }).attentionRequired).toBe(false);
  });

  it("does not require a progress timestamp", () => {
    expect(
      classifyThreadLiveness({
        runStatus: "running",
        waitingBackground: false,
        providerState: "running",
        now: 99_000_000,
        leaseExpired: true,
        leaseRenewalSupported: false,
      }),
    ).toMatchObject({ classification: "working", attentionRequired: false });
  });

  it("keeps unknown stale providers and nonrenewing leases out of attention", () => {
    expect(
      classify({ providerState: "unknown", now: 99_000_000, leaseExpired: true }),
    ).toMatchObject({ classification: "working", attentionRequired: false });
    expect(classify({ leaseExpired: true }).classification).toBe("working");
    expect(classify({ leaseExpired: true, leaseRenewalSupported: true }).classification).toBe(
      "working",
    );
  });

  it("keeps long tools and background work out of timers", () => {
    expect(classify({ waitingBackground: true, now: 99_000_000 })).toMatchObject({
      classification: "waiting_background",
      attentionRequired: false,
    });
    expect(
      classify({
        pendingRequestId: "tool-1",
        pendingRequestKind: "dynamic_tool_call",
        now: 99_000_000,
      }),
    ).toMatchObject({ classification: "waiting_background", attentionRequired: false });
  });

  it.each(["user_input", "permission", "auth_refresh", "command"] as const)(
    "lets a pending %s request win stale timers and provider errors",
    (pendingRequestKind) => {
      expect(
        classify({
          pendingRequestId: "request-1",
          pendingRequestKind,
          providerState: "error",
          now: 99_000_000,
        }),
      ).toMatchObject({ classification: "needs_user", attentionRequired: true });
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "keeps terminal %s runs idle despite stale evidence",
    (runStatus) => {
      expect(
        classify({ runStatus, providerState: "error", failureClass: "usage_limit" }),
      ).toMatchObject({ classification: "idle", attentionRequired: false });
    },
  );

  it("keeps background work visible after foreground completion", () => {
    expect(classify({ runStatus: "completed", waitingBackground: true })).toMatchObject({
      classification: "waiting_background",
      attentionRequired: false,
    });
  });

  it("keeps a current request actionable after foreground completion", () => {
    expect(
      classify({
        runStatus: "completed",
        pendingRequestId: "request-1",
        pendingRequestKind: "user_input",
      }),
    ).toMatchObject({ classification: "needs_user", attentionRequired: true });
  });

  it("classifies confirmed provider failures only on live runs", () => {
    for (const providerState of ["error", "absent"] as const) {
      expect(classify({ providerState })).toMatchObject({
        classification: "wedged",
        attentionRequired: true,
      });
      expect(classify({ providerState, runStatus: "queued" }).attentionRequired).toBe(false);
    }
  });

  it("distinguishes usage limits, failed runs and absent runs", () => {
    expect(classify({ runStatus: "failed", failureClass: "usage_limit" })).toMatchObject({
      classification: "limited",
      attentionRequired: true,
    });
    expect(classify({ runStatus: "failed" }).classification).toBe("failed");
    expect(classify({ runStatus: null }).classification).toBe("idle");
    expect(classify({ completed: true }).classification).toBe("idle");
  });

  it("deduplicates unchanged reports independently of observation time", () => {
    expect(classify().reportKey).toBe(classify({ now: baseline.now + 10_000 }).reportKey);
    expect(classify().reportKey).not.toBe(classify({ attemptId: "attempt-2" }).reportKey);
    expect(classify().reportKey).not.toBe(classify({ now: 1_120_000 }).reportKey);
    expect(classify({ pendingRequestId: "request-1" }).reportKey).not.toBe(
      classify({ pendingRequestId: "request-2" }).reportKey,
    );
    expect(classify({ runId: "a,b", attemptId: "c" }).reportKey).not.toBe(
      classify({ runId: "a", attemptId: "b,c" }).reportKey,
    );
  });

  it("classifies hundreds of threads without changing input or sharing state", () => {
    const inputs = Array.from({ length: 500 }, (_, index) =>
      Object.freeze({ ...baseline, runId: `run-${index}` }),
    );
    const results = inputs.map(classifyThreadLiveness);
    expect(new Set(results.map((result) => result.reportKey)).size).toBe(500);
    expect(results.every((result) => result.classification === "working")).toBe(true);
    expect(inputs.map(classifyThreadLiveness)).toEqual(results);
  });
});

it("separates provider reasons, changed progress, and explicit episodes without clock churn", () => {
  expect(classify({ providerState: "error" }).reportKey).not.toBe(
    classify({ providerState: "absent" }).reportKey,
  );
  expect(classify({ now: 2_000_000, lastProgressAt: 1_000_000 }).reportKey).not.toBe(
    classify({ now: 2_000_000, lastProgressAt: 1_100_000 }).reportKey,
  );
  expect(classify({ episodeId: 1 }).reportKey).not.toBe(classify({ episodeId: 2 }).reportKey);
  expect(classify({ episodeId: 1 }).reportKey).toBe(
    classify({ episodeId: 1, now: 1_010_000 }).reportKey,
  );
});

it("uses the configured stale threshold", () => {
  expect(classify({ now: 1_600_000, staleAfterMs: 900_000 }).classification).toBe("slow");
  expect(classify({ now: 1_900_000, staleAfterMs: 900_000 }).classification).toBe(
    "suspected_stuck",
  );
});
