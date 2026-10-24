import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentMonitorReport,
  AgentMonitorSettings,
  AgentMonitorTokenCounters,
} from "./agentMonitor.ts";

import {
  ServerSettings,
  WS_METHODS,
  clientRpcRequiredScopes,
  AuthOrchestrationReadScope,
  requiredScopesForServerSettingsPatch,
  AuthSettingsWriteScope,
} from "./index.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const encodeReport = Schema.encodeSync(AgentMonitorReport);

describe("AgentMonitorSettings", () => {
  const decode = Schema.decodeUnknownSync(AgentMonitorSettings);

  it("defaults to disabled without selecting a model or notifications", () => {
    expect(decode({})).toEqual({
      enabled: false,
      modelSelection: null,
      notificationsEnabled: false,
    });
  });

  it("preserves explicit model selection", () => {
    expect(
      decode({
        enabled: true,
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        notificationsEnabled: true,
      }),
    ).toMatchObject({
      enabled: true,
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      notificationsEnabled: true,
    });
  });
});

describe("AgentMonitorReport", () => {
  const decode = Schema.decodeUnknownSync(AgentMonitorReport);
  const report = {
    schemaVersion: 1,
    runId: "run-1",
    attemptId: "attempt-1",
    classification: "needs_user",
    reason: "pending_request",
    attentionRequired: true,
    reportKey: "report-1",
    observedAt: "2026-10-24T12:00:00.000Z",
    runStatus: "running",
    pendingRequestId: "request-1",
  };

  it("round trips scalar evidence and nullable identities", () => {
    const decoded = decode(report);
    expect(encodeReport(decoded)).toEqual(report);
    expect(
      decode({ ...report, runId: null, attemptId: null, pendingRequestId: null, runStatus: null }),
    ).toMatchObject({ runId: null, attemptId: null, pendingRequestId: null, runStatus: null });
  });

  it.each([
    { schemaVersion: 2 },
    { reportKey: "" },
    { observedAt: "yesterday" },
    { classification: "thinking" },
    { reason: "unknown_reason" },
    { runStatus: "unknown" },
  ])("rejects invalid report fields %s", (invalid) => {
    expect(() => decode({ ...report, ...invalid })).toThrow();
  });
});

describe("AgentMonitorTokenCounters", () => {
  const decode = Schema.decodeUnknownSync(AgentMonitorTokenCounters);

  it("preserves unavailable and zero counters separately", () => {
    expect(decode({})).toEqual({});
    expect(decode({ input: 0, output: 10, cacheRead: null, cacheWrite: 4 })).toEqual({
      input: 0,
      output: 10,
      cacheRead: null,
      cacheWrite: 4,
    });
  });

  it.each([-1, 0.5, Infinity, "1"])("rejects invalid counters %s", (input) => {
    expect(() => decode({ input })).toThrow();
  });
});

it("defaults older server settings to an opt-out monitor and guards its delivery claim", () => {
  expect(decodeServerSettings({}).agentMonitor).toEqual({
    enabled: false,
    notificationsEnabled: false,
    modelSelection: null,
  });
  expect(clientRpcRequiredScopes(WS_METHODS.agentMonitorClaimAttention, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
  expect(
    requiredScopesForServerSettingsPatch({
      agentMonitor: { enabled: true, notificationsEnabled: false, modelSelection: null },
    }),
  ).toEqual([AuthSettingsWriteScope]);
});
