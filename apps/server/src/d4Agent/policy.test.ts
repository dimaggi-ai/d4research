import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_D4_AGENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentMonitorUpdate,
  type D4AgentSettings,
  type ServerProvider,
} from "@d4research/contracts";
import {
  contentFreeDigest,
  compactDigest,
  heartbeatDue,
  isAllowedAgentMcpRequest,
  isQuietHour,
  modelAvailability,
  usageAttributes,
} from "./policy.ts";
import { diskCheck } from "./SystemProbe.ts";
import { requiresActionApproval } from "./D4Agent.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-24T12:00:00Z",
  models: [
    {
      slug: "chosen",
      name: "Chosen",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }] },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};
const settings: D4AgentSettings = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  enabled: true,
  modelSelection: {
    instanceId: provider.instanceId,
    model: "chosen",
    options: [{ id: "effort", value: "low" }],
  },
};

describe("d4 Agent policies", () => {
  it("requires the exact live provider, model, and effort without fallback", () => {
    assert.equal(modelAvailability(settings, [provider]), null);
    assert.equal(modelAvailability(settings, []), "provider-unavailable");
    assert.equal(
      modelAvailability(
        { ...settings, modelSelection: { instanceId: provider.instanceId, model: "absent" } },
        [provider],
      ),
      "model-unavailable",
    );
    assert.equal(
      modelAvailability(
        {
          ...settings,
          modelSelection: {
            instanceId: provider.instanceId,
            model: "chosen",
            options: [{ id: "effort", value: "high" }],
          },
        },
        [provider],
      ),
      "option-unavailable",
    );
    assert.equal(
      modelAvailability(settings, [{ ...provider, auth: { status: "unauthenticated" } }]),
      "provider-unavailable",
    );
  });
  it("refuses providers whose native tool isolation is unsupported", () => {
    for (const driver of ["cursor", "grok", "opencode", "antigravity", "agy"])
      assert.equal(
        modelAvailability(settings, [{ ...provider, driver: ProviderDriverKind.make(driver) }]),
        "sandbox-unavailable",
      );
    assert.equal(
      modelAvailability(settings, [
        { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
      ]),
      null,
    );
  });
  it("digest excludes titles, content, and its own conversation", () => {
    const report = {
      schemaVersion: 1 as const,
      runId: null,
      attemptId: null,
      classification: "needs_user" as const,
      reason: "pending_request" as const,
      attentionRequired: true,
      notificationEligible: true,
      reportKey: "opaque",
      observedAt: "2026-10-24T12:00:00Z",
      runStatus: null,
      pendingRequestId: null,
    };
    const input: ReadonlyArray<AgentMonitorUpdate & { title: string; text: string }> = [
      {
        threadId: ThreadId.make("other"),
        report,
        revision: 1,
        title: "SECRET TITLE",
        text: "SECRET CONTENT",
      },
      { threadId: ThreadId.make("own"), report, revision: 1, title: "OWN", text: "SECRET" },
    ];
    const digest = contentFreeDigest(input, Date.parse("2026-10-24T12:01:00Z"), "own");
    const many = Array.from({ length: 200 }, (_, index) => ({
      ...input[0]!,
      threadId: ThreadId.make(`thread:${index}`),
    }));
    const compact = compactDigest(many, Date.parse("2026-10-24T12:01:00Z"), "own");
    assert.equal(compact.reports.length, 20);
    assert.equal(compact.omitted, 180);
    assert.deepEqual(compact.counts, { needs_user: 200 });
    assert.deepEqual(digest.counts, { needs_user: 1 });
    assert.equal(digest.reports[0]?.ageSeconds, 60);
    assert.isFalse(JSON.stringify(digest).includes("SECRET"));
    assert.isFalse(JSON.stringify(digest).includes("own"));
  });
  it("telemetry retains zero and positive cache counters without content attributes", () => {
    const attributes = usageAttributes({
      provider: "codex",
      model: "chosen",
      conversationId: "opaque",
      durationMs: 45,
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
    });
    assert.equal(attributes["gen_ai.usage.cache_read.input_tokens"], 20);
    assert.equal(attributes["gen_ai.usage.cache_creation.input_tokens"], 0);
    assert.isFalse(
      Object.keys(attributes).some((key) => /messages|instructions|arguments|results/.test(key)),
    );
    assert.isUndefined(
      usageAttributes({
        provider: "p",
        model: "m",
        conversationId: "c",
        durationMs: 0,
        cachedInputTokens: -1,
      })["gen_ai.usage.cache_read.input_tokens"],
    );
  });
  it("heartbeat defaults off and runs only for new attention outside quiet hours", () => {
    const input = {
      settings,
      now: Date.parse("2026-10-24T12:00:00Z"),
      lastAt: 0,
      previousKeys: [],
      attentionKeys: ["a"],
      busy: false,
    };
    assert.isFalse(heartbeatDue(input));
    const enabled = { ...input, settings: { ...settings, heartbeatMinutes: 15 as const } };
    assert.isTrue(heartbeatDue(enabled));
    assert.isFalse(heartbeatDue({ ...enabled, previousKeys: ["a"] }));
    assert.isFalse(heartbeatDue({ ...enabled, attentionKeys: [] }));
    assert.isFalse(heartbeatDue({ ...enabled, busy: true }));
    assert.isTrue(
      isQuietHour(Date.parse("2026-10-24T23:00:00Z"), {
        startMinute: 22 * 60,
        endMinute: 7 * 60,
        utcOffsetMinutes: 0,
      }),
    );
    assert.isFalse(
      heartbeatDue({
        ...enabled,
        settings: {
          ...enabled.settings,
          quietHours: { startMinute: 11 * 60, endMinute: 13 * 60, utcOffsetMinutes: 0 },
        },
      }),
    );
  });
  it("never auto-relays arbitrary instructions and denies MCP bypass routes", () => {
    assert.isTrue(
      requiresActionApproval("act", {
        type: "send",
        threadId: ThreadId.make("target"),
        text: "push",
      }),
    );
    assert.isFalse(
      requiresActionApproval("act", { type: "interrupt", threadId: ThreadId.make("target") }),
    );
    assert.isTrue(
      requiresActionApproval("ask", { type: "interrupt", threadId: ThreadId.make("target") }),
    );
    for (const name of [
      "pipeline_upsert",
      "delegate_task",
      "t3_pending_request_respond",
      "t3_thread_send",
    ])
      assert.isFalse(isAllowedAgentMcpRequest({ method: "tools/call", params: { name } }));
    assert.isFalse(
      isAllowedAgentMcpRequest([{ method: "tools/call", params: { name: "d4_agent_action" } }]),
    );
    assert.isTrue(
      isAllowedAgentMcpRequest({ method: "tools/call", params: { name: "d4_agent_list" } }),
    );
  });
  it("disk checks use available blocks and explicit unavailable states", () => {
    assert.equal(diskCheck("root-disk", 100, 10, 90).status, "attention");
    assert.equal(diskCheck("data-disk", 100, 11, 90).status, "ok");
    assert.equal(diskCheck("data-disk", 0, 0, 90).status, "unavailable");
  });
});
