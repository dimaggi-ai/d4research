import type { ServerProviderUsage } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";

export const RATE_LIMIT_CONTINUATION_PROMPT =
  "Continue the previous task from where it stopped. The provider usage limit that interrupted it has reset.";

const RATE_LIMIT_PHRASES = [
  "rate limit",
  "rate_limit",
  "usage limit",
  "quota exceeded",
  "429",
  "too many requests",
  "limit reached",
  "resets at",
] as const;

function containsRateLimitPhrase(value: string): boolean {
  const normalized = value.toLowerCase();
  return RATE_LIMIT_PHRASES.some((phrase) => normalized.includes(phrase));
}

function rawPayloadSignalsRateLimit(
  value: unknown,
  seen: WeakSet<object>,
  parentKey = "",
): boolean {
  if (typeof value === "string") {
    if (containsRateLimitPhrase(value)) {
      return true;
    }
    return parentKey.toLowerCase() === "ratelimitreachedtype" && value.trim().length > 0;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((entry) => rawPayloadSignalsRateLimit(entry, seen, parentKey));
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (type === "rate_limit_event") {
    const rateLimitInfo =
      record.rate_limit_info !== null && typeof record.rate_limit_info === "object"
        ? (record.rate_limit_info as Record<string, unknown>)
        : undefined;
    const nestedStatus =
      typeof rateLimitInfo?.status === "string" ? rateLimitInfo.status.toLowerCase() : "";
    return status === "rejected" || nestedStatus === "rejected";
  }

  return Object.entries(record).some(([key, entry]) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "ratelimitreachedtype" && entry != null && entry !== false) {
      return typeof entry !== "string" || entry.trim().length > 0;
    }
    return rawPayloadSignalsRateLimit(entry, seen, key);
  });
}

export function isRateLimitFailure(
  errorMessage: string | undefined,
  rawPayload?: unknown,
): boolean {
  return (
    (errorMessage !== undefined && containsRateLimitPhrase(errorMessage)) ||
    rawPayloadSignalsRateLimit(rawPayload, new WeakSet())
  );
}

export function resolveResumeAt(usage: ServerProviderUsage | undefined, now: Date): string | null {
  if (!usage) {
    return null;
  }

  const nowMs = now.getTime();
  const considerAllWindows = usage.limitReached !== null;
  let earliestResetMs = Number.POSITIVE_INFINITY;

  for (const window of usage.windows) {
    if (
      !considerAllWindows &&
      (window.utilizationPercent === null || window.utilizationPercent < 95)
    ) {
      continue;
    }
    if (window.resetsAt === null) {
      continue;
    }
    const resetMs = Date.parse(window.resetsAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs && resetMs < earliestResetMs) {
      earliestResetMs = resetMs;
    }
  }

  return Number.isFinite(earliestResetMs)
    ? DateTime.formatIso(DateTime.makeUnsafe(earliestResetMs))
    : null;
}
