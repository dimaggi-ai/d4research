import { expect, it } from "vite-plus/test";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
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
