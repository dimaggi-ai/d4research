import type {
  AgentMonitorClassification,
  AgentMonitorPendingRequestKind,
  AgentMonitorReason,
  AgentMonitorRunStatus,
} from "@d4research/contracts";

export interface ThreadLivenessEvidence {
  readonly runId?: string | null;
  readonly attemptId?: string | null;
  readonly runStatus: AgentMonitorRunStatus | null;
  readonly pendingRequestId?: string | null;
  readonly pendingRequestKind?: AgentMonitorPendingRequestKind | null;
  readonly waitingBackground: boolean;
  readonly providerState: "running" | "error" | "absent" | "unknown";
  readonly lastProgressAt?: string | number | null;
  readonly now: number;
  readonly leaseExpired: boolean;
  readonly leaseRenewalSupported: boolean;
  readonly failureClass?: string | null;
  readonly completed?: boolean;
}

export interface ThreadLivenessResult {
  readonly classification: AgentMonitorClassification;
  readonly attentionRequired: boolean;
  readonly reason: AgentMonitorReason;
  readonly reportKey: string;
}

export const THREAD_LIVENESS_SLOW_AFTER_MS = 120_000;
export const THREAD_LIVENESS_STALE_AFTER_MS = 600_000;

export function classifyThreadLiveness(input: ThreadLivenessEvidence): ThreadLivenessResult {
  const result = (
    classification: AgentMonitorClassification,
    reason: AgentMonitorReason,
    attentionRequired = false,
  ): ThreadLivenessResult => ({
    classification,
    reason,
    attentionRequired,
    reportKey: JSON.stringify([
      input.runId ?? null,
      input.attemptId ?? null,
      input.pendingRequestId ?? null,
      classification,
    ]),
  });

  if (input.pendingRequestId != null) {
    if (input.pendingRequestKind === "dynamic_tool_call") {
      return result("waiting_background", "background_work");
    }
    return result("needs_user", "pending_request", true);
  }
  if (input.completed || input.runStatus === "completed") {
    return input.waitingBackground
      ? result("waiting_background", "background_work")
      : result("idle", "run_terminal");
  }
  if (
    input.runStatus === "cancelled" ||
    input.runStatus === "interrupted" ||
    input.runStatus === "rolled_back"
  ) {
    return result("idle", "run_terminal");
  }
  if (input.failureClass === "usage_limit") return result("limited", "usage_limit", true);
  if (input.runStatus === "failed") return result("failed", "run_failed", true);
  if (input.runStatus === null) return result("idle", "no_active_run");
  if (input.waitingBackground) return result("waiting_background", "background_work");

  const live = input.runStatus === "running" || input.runStatus === "starting";
  if (live && input.providerState === "error") return result("wedged", "provider_error", true);
  if (live && input.providerState === "absent") return result("wedged", "provider_absent", true);

  // Lease expiry is not a heartbeat failure until the provider supports renewal.
  // Time alone also cannot prove a failed provider, including after host sleep.
  const progressAt =
    typeof input.lastProgressAt === "string"
      ? Date.parse(input.lastProgressAt)
      : input.lastProgressAt;
  if (
    !live ||
    input.providerState !== "running" ||
    progressAt == null ||
    !Number.isFinite(progressAt) ||
    !Number.isFinite(input.now) ||
    progressAt > input.now
  ) {
    return result("working", "observation_unavailable");
  }
  const elapsed = input.now - progressAt;
  if (elapsed >= THREAD_LIVENESS_STALE_AFTER_MS) {
    return result("suspected_stuck", "progress_stale", true);
  }
  if (elapsed >= THREAD_LIVENESS_SLOW_AFTER_MS) return result("slow", "progress_delayed");
  return result("working", "recent_progress");
}
