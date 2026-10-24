import { describe, expect, it } from "vite-plus/test";
import type { AgentMonitorReport } from "@d4research/contracts";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  monitorActivityThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "./agentMonitor.ts";

const report = {
  schemaVersion: 1,
  classification: "wedged",
  reason: "provider_absent",
  attentionRequired: true,
  notificationEligible: true,
  reportKey: "run:wedged",
  observedAt: "2026-10-24T00:00:00.000Z",
  runId: null,
  attemptId: null,
  runStatus: "running",
  pendingRequestId: null,
} satisfies AgentMonitorReport;

const thread = (id: string, monitor: AgentMonitorReport | null | undefined = report) => ({
  id,
  archivedAt: null as string | null,
  deletedAt: null as string | null,
  source: { agentMonitor: monitor },
});

describe("monitor attention", () => {
  it("uses the server attention decision and excludes archived, deleted and old-server threads", () => {
    const actionable = thread("actionable");
    expect(
      monitorAttentionThreads([
        actionable,
        { ...thread("old-server"), source: {} },
        thread("disabled", null),
        thread("suspected", {
          ...report,
          classification: "suspected_stuck",
          attentionRequired: false,
        }),
        { ...thread("archived"), archivedAt: report.observedAt },
        { ...thread("deleted"), deletedAt: report.observedAt },
      ]),
    ).toEqual([actionable]);
  });

  it("lists only non-idle activity outside the attention list", () => {
    const working = thread("working", {
      ...report,
      classification: "working",
      attentionRequired: false,
    });
    expect(
      monitorActivityThreads([
        thread("attention"),
        thread("idle", { ...report, classification: "idle", attentionRequired: false }),
        thread("old", null),
        working,
      ]),
    ).toEqual([working]);
    expect(AGENT_MONITOR_LIST_LIMIT).toBe(50);
  });

  it("shows completed runs separately from idle threads", () => {
    expect(agentMonitorLabel({ ...report, classification: "idle", runStatus: "completed" })).toBe(
      "Completed",
    );
    expect(agentMonitorLabel({ ...report, classification: "idle", runStatus: null })).toBe("Idle");
  });
});
