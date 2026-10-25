import { ProjectId } from "@d4research/contracts";
import { expect, it } from "vite-plus/test";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  projectBelongsToAgentContext,
  brainIndexStatus,
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
