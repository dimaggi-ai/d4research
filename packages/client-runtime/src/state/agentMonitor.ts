import type { AgentMonitorReport, OrchestrationV2ThreadShell } from "@d4research/contracts";

export const AGENT_MONITOR_LABELS: Record<AgentMonitorReport["classification"], string> = {
  needs_user: "Needs you",
  waiting_background: "Waiting for background work",
  working: "Working",
  slow: "Slow",
  suspected_stuck: "Possibly stuck",
  wedged: "Stuck",
  limited: "Usage limited",
  failed: "Failed",
  idle: "Idle",
};

export function monitorAttentionThreads<
  T extends {
    readonly archivedAt: unknown;
    readonly deletedAt: unknown;
    readonly source: Pick<OrchestrationV2ThreadShell, "agentMonitor">;
  },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return threads.filter(
    (thread) =>
      thread.archivedAt == null &&
      thread.deletedAt == null &&
      thread.source.agentMonitor?.attentionRequired === true,
  );
}

export function agentMonitorLabel(report: AgentMonitorReport): string {
  return report.classification === "idle" && report.runStatus === "completed"
    ? "Completed"
    : AGENT_MONITOR_LABELS[report.classification];
}

export function monitorActivityThreads<
  T extends {
    readonly source: Pick<OrchestrationV2ThreadShell, "agentMonitor">;
  },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  return threads.filter((thread) => {
    const report = thread.source.agentMonitor;
    return report != null && !report.attentionRequired && report.classification !== "idle";
  });
}

export const AGENT_MONITOR_LIST_LIMIT = 50;
