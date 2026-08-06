import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { Button } from "../ui/button";

export interface RateLimitResumeState {
  readonly resumeAt: string;
  readonly reason: string;
  readonly provider: string;
  readonly createdAt: string;
}

export const RATE_LIMIT_CONTINUATION_PROMPT =
  "Continue the previous task from where it stopped. The provider usage limit that interrupted it has reset.";

export function deriveRateLimitResumeState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): RateLimitResumeState | null {
  const activity = activities.at(-1);
  if (!activity || activity.kind !== "turn.rate-limited") {
    return null;
  }
  if (activity.payload === null || typeof activity.payload !== "object") {
    return null;
  }
  const payload = activity.payload as Record<string, unknown>;
  if (
    typeof payload.resumeAt !== "string" ||
    !Number.isFinite(Date.parse(payload.resumeAt)) ||
    typeof payload.reason !== "string" ||
    typeof payload.provider !== "string"
  ) {
    return null;
  }
  return {
    resumeAt: payload.resumeAt,
    reason: payload.reason,
    provider: payload.provider,
    createdAt: activity.createdAt,
  };
}

export function RateLimitResumeBanner(props: {
  readonly state: RateLimitResumeState | null;
  readonly disabled: boolean;
  readonly onResumeNow: () => void;
}) {
  if (!props.state) return null;

  const localTime = new Date(props.state.resumeAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2 text-xs"
      data-rate-limit-resume="true"
    >
      <span className="text-muted-foreground">
        Usage limit reached — resuming automatically at {localTime}
      </span>
      <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onResumeNow}>
        Resume now
      </Button>
    </div>
  );
}
