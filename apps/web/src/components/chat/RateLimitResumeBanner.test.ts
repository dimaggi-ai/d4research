import { EventId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRateLimitResumeState } from "./RateLimitResumeBanner";

describe("deriveRateLimitResumeState", () => {
  const rateLimitedActivity = {
    id: EventId.make("activity-rate-limited"),
    tone: "error" as const,
    kind: "turn.rate-limited",
    summary: "Usage limit reached",
    payload: {
      resumeAt: "2026-08-05T10:45:00.000Z",
      reason: "Rate limit reached",
      provider: "codex",
    },
    turnId: null,
    createdAt: "2026-08-05T10:00:00.000Z",
  };

  it("returns the schedule when the latest activity is rate-limited", () => {
    expect(deriveRateLimitResumeState([rateLimitedActivity])).toEqual({
      resumeAt: "2026-08-05T10:45:00.000Z",
      reason: "Rate limit reached",
      provider: "codex",
      createdAt: "2026-08-05T10:00:00.000Z",
    });
  });

  it("returns null when a newer activity supersedes the parked activity", () => {
    expect(
      deriveRateLimitResumeState([
        rateLimitedActivity,
        {
          ...rateLimitedActivity,
          id: EventId.make("activity-newer"),
          kind: "task.started",
        },
      ]),
    ).toBeNull();
  });

  it("rejects malformed schedule payloads", () => {
    expect(
      deriveRateLimitResumeState([
        {
          ...rateLimitedActivity,
          payload: { ...rateLimitedActivity.payload, resumeAt: "not-a-date" },
        },
      ]),
    ).toBeNull();
  });
});
