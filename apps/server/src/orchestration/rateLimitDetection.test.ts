import type { ServerProviderUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isRateLimitFailure, resolveResumeAt } from "./rateLimitDetection.ts";

const NOW = DateTime.toDate(DateTime.makeUnsafe("2026-08-05T10:00:00.000Z"));

function usage(overrides: Partial<ServerProviderUsage> = {}): ServerProviderUsage {
  return {
    support: "supported",
    planType: "pro",
    windows: [],
    limitReached: null,
    checkedAt: NOW.toISOString(),
    message: null,
    ...overrides,
  };
}

describe("isRateLimitFailure", () => {
  it.each([
    "Rate limit exceeded",
    "rate_limit_error",
    "Usage Limit reached for this account",
    "quota exceeded",
    "HTTP 429",
    "Too Many Requests",
    "Limit reached. Try later.",
    "Your allowance resets at 11:00",
  ])("matches provider failure wording: %s", (message) => {
    expect(isRateLimitFailure(message)).toBe(true);
  });

  it.each([undefined, "authentication failed", "network connection closed", "model not found"])(
    "does not match unrelated failures: %s",
    (message) => {
      expect(isRateLimitFailure(message)).toBe(false);
    },
  );

  it("matches Codex rateLimitReachedType payloads", () => {
    expect(
      isRateLimitFailure(undefined, {
        rateLimits: { primary: { usedPercent: 100 } },
        rateLimitReachedType: "primary",
      }),
    ).toBe(true);
  });

  it("matches nested Claude rejected rate_limit_event payloads", () => {
    expect(
      isRateLimitFailure(undefined, {
        event: {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resets_at: 1_786_000_000 },
        },
      }),
    ).toBe(true);
  });

  it("does not treat an allowed Claude rate_limit_event as a failure", () => {
    expect(
      isRateLimitFailure(undefined, {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
    ).toBe(false);
  });

  it("handles cyclic raw payloads", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(isRateLimitFailure(undefined, payload)).toBe(false);
  });
});

describe("resolveResumeAt", () => {
  it("selects the earliest saturated Claude window reset", () => {
    expect(
      resolveResumeAt(
        usage({
          windows: [
            {
              id: "five_hour",
              label: "5-hour window",
              utilizationPercent: 100,
              resetsAt: "2026-08-05T10:45:00.000Z",
              windowMinutes: 300,
            },
            {
              id: "seven_day",
              label: "7-day window",
              utilizationPercent: 98,
              resetsAt: "2026-08-09T00:00:00.000Z",
              windowMinutes: 10_080,
            },
          ],
        }),
        NOW,
      ),
    ).toBe("2026-08-05T10:45:00.000Z");
  });

  it("selects the earliest future Codex primary/secondary ISO reset", () => {
    expect(
      resolveResumeAt(
        usage({
          windows: [
            {
              id: "primary",
              label: "Primary",
              utilizationPercent: 96,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_786_000_000 * 1_000)),
              windowMinutes: 300,
            },
            {
              id: "secondary",
              label: "Secondary",
              utilizationPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1_785_990_000 * 1_000)),
              windowMinutes: 10_080,
            },
          ],
        }),
        NOW,
      ),
    ).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_785_990_000 * 1_000)));
  });

  it("ignores windows below 95 percent when no limitReached marker exists", () => {
    expect(
      resolveResumeAt(
        usage({
          windows: [
            {
              id: "primary",
              label: "Primary",
              utilizationPercent: 94.9,
              resetsAt: "2026-08-05T10:05:00.000Z",
              windowMinutes: 300,
            },
            {
              id: "secondary",
              label: "Secondary",
              utilizationPercent: 95,
              resetsAt: "2026-08-05T11:00:00.000Z",
              windowMinutes: 10_080,
            },
          ],
        }),
        NOW,
      ),
    ).toBe("2026-08-05T11:00:00.000Z");
  });

  it("considers every window when limitReached is set", () => {
    expect(
      resolveResumeAt(
        usage({
          limitReached: "primary",
          windows: [
            {
              id: "primary",
              label: "Primary",
              utilizationPercent: null,
              resetsAt: "2026-08-05T10:20:00.000Z",
              windowMinutes: 300,
            },
            {
              id: "secondary",
              label: "Secondary",
              utilizationPercent: 20,
              resetsAt: "2026-08-05T10:10:00.000Z",
              windowMinutes: 10_080,
            },
          ],
        }),
        NOW,
      ),
    ).toBe("2026-08-05T10:10:00.000Z");
  });

  it("ignores expired, invalid, and missing reset timestamps", () => {
    expect(
      resolveResumeAt(
        usage({
          limitReached: "primary",
          windows: [
            {
              id: "past",
              label: "Past",
              utilizationPercent: 100,
              resetsAt: "2026-08-05T09:59:59.000Z",
              windowMinutes: 300,
            },
            {
              id: "invalid",
              label: "Invalid",
              utilizationPercent: 100,
              resetsAt: "not-a-date",
              windowMinutes: 300,
            },
            {
              id: "missing",
              label: "Missing",
              utilizationPercent: 100,
              resetsAt: null,
              windowMinutes: 300,
            },
          ],
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null without usage or eligible windows", () => {
    expect(resolveResumeAt(undefined, NOW)).toBeNull();
    expect(resolveResumeAt(usage(), NOW)).toBeNull();
  });
});
