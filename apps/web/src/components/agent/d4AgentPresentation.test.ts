import { ProjectId } from "@d4research/contracts";
import { expect, it } from "vite-plus/test";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  projectBelongsToAgentContext,
  brainIndexStatus,
  actionHeading,
  guardNotice,
  agentActivityLabel,
  agentWatchLabel,
} from "./d4AgentPresentation";
it("labels disk values as percent used and failed services as counts", () => {
  expect(
    systemCheckLabel({
      id: "root-disk",
      status: "attention",
      value: 91,
      reportKey: "disk",
      notificationEligible: true,
    }),
  ).toBe("Root disk");
  expect(
    systemCheckStatus({
      id: "root-disk",
      status: "attention",
      value: 91,
      reportKey: "disk",
      notificationEligible: true,
    }),
  ).toBe("Needs attention · 91% used");
  expect(
    systemCheckStatus({
      id: "user-units",
      status: "attention",
      value: 2,
      reportKey: "units",
      notificationEligible: true,
    }),
  ).toBe("Needs attention · 2 failed services");
});
it("shows an unavailable host capability without inventing a healthy value", () => {
  expect(
    systemCheckStatus({
      id: "user-units",
      status: "unavailable",
      value: null,
      reportKey: "units",
      notificationEligible: false,
    }),
  ).toBe("Not available");
  expect(agentUnavailableMessage("sandbox-unavailable")).toContain(
    "cannot enforce the agent permissions",
  );
});

it("shows all projects in Global and only explicit mappings in work contexts", () => {
  const globalProject = ProjectId.make("unmapped");
  const workProject = ProjectId.make("yb");
  const personalProject = ProjectId.make("personal");
  const mappings = { [workProject]: "YB", [personalProject]: "Personal" } as const;
  expect(projectBelongsToAgentContext(globalProject, "Global", mappings)).toBe(true);
  expect(projectBelongsToAgentContext(globalProject, "YB", mappings)).toBe(false);
  expect(projectBelongsToAgentContext(workProject, "YB", mappings)).toBe(true);
  expect(projectBelongsToAgentContext(workProject, "Global", mappings)).toBe(true);
  expect(projectBelongsToAgentContext(workProject, "Dimaggi", mappings)).toBe(false);
  expect(projectBelongsToAgentContext(personalProject, "Personal", mappings)).toBe(true);
});
it("reports unavailable indexes and rebuild information without inventing readiness", () => {
  expect(
    brainIndexStatus({ context: "YB", status: "not-indexed", files: 2, lastRebuild: null }),
  ).toBe("Not indexed · 2 files · Last rebuild: Not available");
  expect(
    brainIndexStatus({ context: "YB", status: "not-available", files: 0, lastRebuild: null }),
  ).toBe("Not available · 0 files · Last rebuild: Not available");
  expect(
    brainIndexStatus({ context: "Personal", status: "refused", files: 0, lastRebuild: null }),
  ).toBe("Context operation refused; inspect the selected scope configuration.");
  expect(
    brainIndexStatus({
      context: "Global",
      status: "ready",
      files: 12,
      lastRebuild: "2026-10-24T00:00:00.000Z",
    }),
  ).toBe("Ready · 12 files · Last rebuild: 2026-10-24T00:00:00.000Z");
});

it("headlines a context switch with its target instead of the raw id", () => {
  expect(
    actionHeading({
      type: "switch-context",
      targetId: "thread-1",
      preview: "Switch to Dimaggi: Provider setup",
    }),
  ).toEqual({ title: "Switch to Dimaggi: Provider setup", detail: "" });
  expect(actionHeading({ type: "send", targetId: "thread-1", preview: "Draft" })).toEqual({
    title: "send · thread-1",
    detail: "Draft",
  });
});

it("says when Nia is working, failed, or idle", () => {
  const formatTime = () => "14:05";
  const runtime = (status: "running" | "waiting" | "failed" | "idle", lastError: string | null) =>
    ({ status, lastError }) as Parameters<typeof agentActivityLabel>[0]["runtime"];
  expect(
    agentActivityLabel({ runtime: runtime("running", null), latestRun: null, formatTime }),
  ).toEqual({ text: "Nia is working on a reply…", tone: "working" });
  expect(
    agentActivityLabel({ runtime: runtime("idle", "quota hit"), latestRun: null, formatTime }),
  ).toEqual({ text: "Last reply failed: quota hit", tone: "error" });
  expect(
    agentActivityLabel({
      runtime: runtime("idle", null),
      latestRun: { completedAt: "2026-10-25T21:05:00Z" } as Parameters<
        typeof agentActivityLabel
      >[0]["latestRun"],
      formatTime,
    }),
  ).toEqual({ text: "Last reply at 14:05.", tone: "idle" });
});

it("says whether Nia checks threads on its own", () => {
  expect(agentWatchLabel({ heartbeatMinutes: null, monitorEnabled: true }).off).toBe(true);
  expect(agentWatchLabel({ heartbeatMinutes: 15, monitorEnabled: true })).toEqual({
    text: "Checks threads every 15 min.",
    off: false,
  });
  expect(agentWatchLabel({ heartbeatMinutes: 15, monitorEnabled: false }).off).toBe(true);
});

it("names Tool Guard verdicts that need the user's attention", () => {
  expect(guardNotice(undefined)).toBeNull();
  expect(guardNotice({ decision: "allowed", rule: null, reason: null })).toBeNull();
  expect(guardNotice({ decision: "denied", rule: "nia-deny-send", reason: null })).toEqual({
    title: "Tool Guard blocked this action (nia-deny-send).",
    tone: "warning",
  });
  expect(guardNotice({ decision: "unavailable", rule: null, reason: null })?.tone).toBe("warning");
  expect(guardNotice({ decision: "flagged", rule: null, reason: null })?.tone).toBe("info");
});
