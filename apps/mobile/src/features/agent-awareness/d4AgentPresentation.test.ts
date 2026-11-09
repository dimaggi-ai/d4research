import { D4AgentError, ProjectId, type D4AgentSystemCheck } from "@d4research/contracts";
import { expect, it } from "vite-plus/test";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentOpenFailureMessage,
  agentUnavailableMessage,
  projectBelongsToAgentContext,
  brainIndexStatus,
  actionHeading,
  niaFileLinkRoute,
} from "./d4AgentPresentation";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "../../lib/enrichedLinkPresentation";
import { markdownForNativeRendering } from "../../lib/markdownDocument";

it("opens an absolute inline-code path outside Nia's workspace in the file viewer", () => {
  const rendered = markdownForNativeRendering(
    "Report: `/var/www/intel/2026-11-09.md`",
    ENRICHED_INLINE_FILE_LINK_REGEX,
  );
  const href = /\]\(<?([^)>]+)>?\)/.exec(rendered)?.[1];
  expect(href).toBeDefined();
  expect(niaFileLinkRoute(href!, "/home/u/.t3/userdata/d4-agent/workspace")).toEqual({
    path: ["", "var", "www", "intel", "2026-11-09.md"],
  });
});

it("opens workspace files relative to Nia's workspace and keeps the line", () => {
  expect(
    niaFileLinkRoute(
      "/home/u/.t3/userdata/d4-agent/workspace/notes/a.md:12",
      "/home/u/.t3/userdata/d4-agent/workspace",
    ),
  ).toEqual({ path: ["notes", "a.md"], line: "12" });
  expect(niaFileLinkRoute("https://example.com/a.md", "/w")).toBeNull();
});
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

it("labels system services, OS updates, and doctor checks", () => {
  const labels = {
    "system-units": "System services",
    "os-updates": "OS updates",
    doctor: "Doctor",
  } as const;
  for (const id of ["system-units", "os-updates", "doctor"] as const) {
    expect(
      systemCheckLabel({
        id,
        status: "unavailable",
        value: null,
        reportKey: id,
        notificationEligible: false,
      }),
    ).toBe(labels[id]);
  }
  expect(
    systemCheckStatus({
      id: "system-units",
      status: "attention",
      value: 2,
      reportKey: "system",
      notificationEligible: false,
    }),
  ).toBe("Needs attention · 2 failed services");
});
it("keeps informational checks distinct from healthy, unavailable, and disabled checks", () => {
  for (const id of ["system-units", "os-updates", "doctor"] as const) {
    const check: D4AgentSystemCheck = {
      id,
      status: "info",
      title: "Current information",
      value: 2,
      reportKey: id,
      notificationEligible: false,
    };
    expect(systemCheckStatus(check)).toBe("Current information");
    expect(
      systemCheckStatus({
        id,
        status: "info",
        value: null,
        reportKey: id,
        notificationEligible: false,
      }),
    ).toBe("Information");
    expect(systemCheckStatus({ ...check, status: "unavailable" })).toBe("Not available");
    expect(systemCheckStatus({ ...check, status: "disabled" })).toBe("Off");
  }
});
it("preserves OS update and doctor details alongside attention and healthy status", () => {
  for (const id of ["os-updates", "doctor"] as const) {
    const check: D4AgentSystemCheck = {
      id,
      status: "attention",
      title: "Probe details",
      value: 1,
      reportKey: id,
      notificationEligible: false,
    };
    expect(systemCheckStatus(check)).toBe("Needs attention · Probe details");
    expect(systemCheckStatus({ ...check, status: "ok" })).toBe("Healthy · Probe details");
  }
});

it("shows why Nia could not open", () => {
  expect(agentOpenFailureMessage(new D4AgentError({ reason: "provider-unavailable" }))).toBe(
    agentUnavailableMessage("provider-unavailable"),
  );
  expect(agentOpenFailureMessage(new D4AgentError({ reason: "thread" }))).toBe(
    "Could not open Nia. Try again.",
  );
  expect(agentOpenFailureMessage(new Error("socket closed"))).toBe(
    "Could not open Nia. Try again.",
  );
});
