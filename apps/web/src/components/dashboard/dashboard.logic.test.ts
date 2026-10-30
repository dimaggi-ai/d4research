import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@d4research/client-runtime/environment";
import { ThreadId } from "@d4research/contracts";
import { collectDashboardItems, filterDashboardItems } from "./dashboard.logic";
import {
  dashboardProjects,
  dashboardThread,
  DASHBOARD_NOW,
  REMOTE,
} from "./dashboard.test-fixtures";

const collect = (
  threads: Parameters<typeof collectDashboardItems>[0]["threads"],
  localVisits = {},
) =>
  collectDashboardItems({
    threads,
    projects: dashboardProjects(),
    now: Date.parse(DASHBOARD_NOW),
    localVisits,
  });

describe("thread dashboard", () => {
  it("scopes colliding project and thread ids to their own environments", () => {
    const items = collect([dashboardThread(), dashboardThread({ environmentId: REMOTE })]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
    expect(
      items.map((item) =>
        item.project.memberProjects.some(
          (project) => project.environmentId === item.thread.environmentId,
        ),
      ),
    ).toEqual([true, true]);
    expect(
      filterDashboardItems(items, { environment: REMOTE, project: "all", query: "" }, new Map()),
    ).toHaveLength(1);
  });
  it("distinguishes a foreground turn, background monitoring, and an unread completion", () => {
    const ready = dashboardThread();
    const runtime = {
      status: "running" as const,
      activeRunId: ready.latestRun!.runId,
      providerInstanceId: ready.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DASHBOARD_NOW,
    };
    const items = collect([
      ready,
      dashboardThread({ id: ThreadId.make("running"), runtime }),
      dashboardThread({
        id: ThreadId.make("background"),
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", description: "Watch CI" }],
      }),
    ]);
    expect(items.map((item) => item.status).sort()).toEqual(["monitoring", "ready", "working"]);
    expect(items.find((item) => item.status === "monitoring")?.description).toContain("Watch CI");
  });
  it("uses authoritative visits including mark-unread and only falls back for older servers", () => {
    const thread = dashboardThread();
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const local = { [key]: DASHBOARD_NOW };
    expect(collect([thread], local)[0]?.status).toBe("ready");
    expect(collect([dashboardThread({ lastVisitedAt: DASHBOARD_NOW })])[0]?.status).toBe(
      "reviewed",
    );
    const { lastVisitedAt: _legacyVisit, ...legacyThread } = dashboardThread();
    expect(collect([legacyThread], local)[0]?.status).toBe("reviewed");
  });
  it("keeps old unread results but retires old reviewed results", () => {
    const thread = dashboardThread();
    const latestRun = { ...thread.latestRun!, completedAt: "2026-10-20T20:00:00.000Z" };
    expect(collect([dashboardThread({ latestRun })])[0]?.status).toBe("ready");
    expect(collect([dashboardThread({ latestRun, lastVisitedAt: DASHBOARD_NOW })])).toEqual([]);
  });
  it("omits deleted, archived, child and routine compaction completions without hiding a settled unread thread", () => {
    const thread = dashboardThread();
    expect(
      collect([
        dashboardThread({ archivedAt: DASHBOARD_NOW }),
        dashboardThread({ deletedAt: DASHBOARD_NOW }),
        dashboardThread({
          lineage: {
            ...thread.lineage,
            relationshipToParent: "subagent",
            parentThreadId: ThreadId.make("parent"),
          },
        }),
        dashboardThread({ latestRun: null }),
      ]),
    ).toEqual([]);
    expect(
      collect([dashboardThread({ settledAt: DASHBOARD_NOW, settledOverride: "settled" })])[0]
        ?.status,
    ).toBe("ready");
  });
  it("keeps approvals and failed outcomes visible and distinguishes them from successful results", () => {
    const thread = dashboardThread();
    const failed = dashboardThread({
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: thread.providerInstanceId,
        providerName: null,
        lastError: "Provider disconnected",
        updatedAt: DASHBOARD_NOW,
      },
    });
    expect(collect([failed])[0]).toMatchObject({
      status: "ready",
      attention: "Turn failed",
      description: "Provider disconnected",
    });
    expect(collect([dashboardThread({ hasPendingApprovals: true })])[0]).toMatchObject({
      status: "working",
      attention: "Approval needed",
    });
  });
  it("combines project, environment and search filters without fetching transcripts", () => {
    const items = collect([
      dashboardThread({ branch: "fix/files" }),
      dashboardThread({ environmentId: REMOTE, title: "Check CDC" }),
    ]);
    expect(
      filterDashboardItems(
        items,
        { environment: "all", project: "all", query: "fix/files" },
        new Map(),
      ),
    ).toHaveLength(1);
    expect(
      filterDashboardItems(
        items,
        { environment: REMOTE, project: items[1]!.project.projectKey, query: "mini" },
        new Map([[REMOTE, "Mac mini"]]),
      ),
    ).toHaveLength(1);
  });
});
