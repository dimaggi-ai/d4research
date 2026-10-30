import { buildServerProvider } from "@d4research/provider-core/server/snapshotProbe";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@d4research/contracts";
import { providerDecisionContext } from "./providerContext.ts";

const now = Date.parse("2026-10-28T12:00:00Z");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("new-local-instance"),
  driver: ProviderDriverKind.make("cursor"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown", email: "private-email", profileId: "private-profile" },
  checkedAt: "2026-10-28T11:59:00Z",
  models: [{ slug: "custom-model", name: "Custom model", isCustom: true, capabilities: null }],
  skills: [],
  slashCommands: [],
};
const window = {
  id: "session",
  kind: "session" as const,
  label: "Session",
  usedPercent: 25,
  resetsAt: "2026-10-28T13:00:00Z",
};
const limits = { checkedAt: provider.checkedAt, windows: [window] };

describe("Nia provider decision context", () => {
  it("uses arbitrary configured instances and custom models without inventing subscriptions", () => {
    const [result] = providerDecisionContext([provider], now);
    assert.equal(result?.instanceId, "new-local-instance");
    assert.equal(result?.configured, true);
    assert.equal(result?.authentication, "unknown");
    assert.equal(result?.available, true);
    assert.equal(result?.canRunD4Agent, false);
    assert.deepEqual(
      result?.models,
      provider.models.map(({ slug, name, isCustom, capabilities }) => ({
        slug,
        name,
        isCustom,
        capabilities,
      })),
    );
    assert.equal(result?.quota.state, "unknown");
    assert.notInclude(JSON.stringify(result), "private-");
    assert.deepEqual(providerDecisionContext([], now), []);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { status: "error" as const },
    { availability: "unavailable" as const },
    { auth: { status: "unauthenticated" as const } },
    {
      readiness: {
        installation: "ready" as const,
        authentication: "ready" as const,
        reachability: "failed" as const,
        modelCatalog: "ready" as const,
        canStart: false,
        checkedAt: provider.checkedAt,
      },
    },
  ])("exposes unavailable runtime facts: %j", (patch) => {
    const [result] = providerDecisionContext([{ ...provider, ...patch }], now);
    assert.equal(result?.available, false);
    assert.equal(result?.configured, true);
  });

  it("preserves suitability constraints and excludes update-required models", () => {
    const capabilities = {
      optionDescriptors: [
        {
          id: "reasoning",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "high", label: "High" }],
        },
      ],
    };
    const [result] = providerDecisionContext(
      [
        {
          ...provider,
          supportedRuntimeModes: ["approval-required"],
          requiresNewThreadForModelChange: true,
          models: [
            { ...provider.models[0]!, capabilities },
            { slug: "blocked", name: "Blocked", isCustom: false, capabilities: null },
          ],
          updateRequiredModels: [{ slug: "blocked", name: "Blocked", minVersion: "2.0.0" }],
        },
      ],
      now,
    );
    assert.deepEqual(
      result?.models.map((model) => model.slug),
      ["custom-model"],
    );
    assert.deepEqual(result?.models[0]?.capabilities, capabilities);
    assert.deepEqual(result?.supportedRuntimeModes, ["approval-required"]);
    assert.equal(result?.requiresNewThreadForModelChange, true);
  });

  it("preserves reported quota, timestamp and reset without exposing credential fingerprints", () => {
    const [result] = providerDecisionContext(
      [{ ...provider, usageLimits: { ...limits, credentialFingerprint: "private-fingerprint" } }],
      now,
    );
    assert.equal(result?.quota.state, "reported-remaining");
    assert.equal(result?.quota.checkedAt, limits.checkedAt);
    assert.deepEqual(result?.quota.windows, [window]);
    assert.notInclude(JSON.stringify(result), "private-");
  });

  it.each([
    undefined,
    { ...limits, windows: [] },
    { ...limits, unavailable: { reason: "unsupported" as const } },
    { ...limits, unavailable: { reason: "probeFailed" as const } },
    { ...limits, windows: [{ ...window, resetsAt: "2026-10-28T11:00:00Z", usedPercent: 100 }] },
  ])("marks missing, failed, unsupported or expired quota evidence unknown: %j", (usageLimits) => {
    const [result] = providerDecisionContext(
      [{ ...provider, ...(usageLimits ? { usageLimits } : {}) }],
      now,
    );
    assert.equal(result?.quota.state, "unknown");
    assert.equal(result?.available, true);
  });

  it("reports exhausted alternatives without inventing a usable fallback or mapping windows to models", () => {
    const exhausted = { ...limits, windows: [{ ...window, usedPercent: 100 }] };
    const result = providerDecisionContext(
      [
        { ...provider, usageLimits: exhausted },
        { ...provider, instanceId: ProviderInstanceId.make("other"), usageLimits: exhausted },
      ],
      now,
    );
    assert.deepEqual(
      result.map((entry) => entry.quota.state),
      ["reported-exhausted", "reported-exhausted"],
    );
    assert.equal(result.filter((entry) => entry.quota.state === "reported-remaining").length, 0);
    assert.deepEqual(result[0]?.quota.windows, exhausted.windows);
  });
});

it("a passed reset cannot hide another window that still reports exhaustion", () => {
  const [result] = providerDecisionContext(
    [
      {
        ...provider,
        usageLimits: {
          ...limits,
          windows: [
            { ...window, resetsAt: "2026-10-28T11:00:00Z", usedPercent: 100 },
            { ...window, id: "weekly", kind: "weekly", usedPercent: 100 },
          ],
        },
      },
    ],
    now,
  );
  assert.equal(result?.quota.state, "reported-exhausted");
});

it("omits raw diagnostics while preserving readiness status and timestamps", () => {
  const diagnostic = "https://user:fake-secret@example.invalid/private-project";
  const snapshot: ServerProvider = {
    ...provider,
    ...buildServerProvider({
      presentation: { displayName: "OpenCode" },
      enabled: true,
      checkedAt: provider.checkedAt,
      models: provider.models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Could not reach ${diagnostic}`,
      },
    }),
    unavailableReason: `Connection failed: ${diagnostic}`,
  };
  assert.include(snapshot.readiness?.remediation ?? "", diagnostic);
  const [result] = providerDecisionContext([snapshot], now);
  const serialized = JSON.stringify(result);

  assert.notInclude(serialized, "fake-secret");
  assert.notInclude(serialized, "example.invalid");
  assert.notInclude(serialized, "/private-project");
  assert.notInclude(serialized, "remediation");
  assert.notProperty(result!, "unavailableReason");
  assert.equal(result?.available, false);
  assert.deepEqual(result?.readiness, {
    installation: "ready",
    authentication: "unknown",
    reachability: "failed",
    modelCatalog: "unknown",
    canStart: false,
    checkedAt: provider.checkedAt,
  });
});
