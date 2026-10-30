import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  UsageLimitSourceId,
  type ServerProvider,
  type UsageSummaryInput,
  type UsageLimitSourceSnapshot,
  type PeerEnvironment,
  type PeerRelayReply,
  type PeerRelayOperation,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Peers from "../../../peers/Peers.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("usage-environment");
const checkedAt = "2026-10-18T00:00:00.000Z";
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "usage-test",
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("usage-thread"),
    providerInstanceId: ProviderInstanceId.make("claude-work"),
    providerSessionId: "claude-test",
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};
const provider = (id: string, usedPercent: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated", email: `${id}@example.com`, label: "Max" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  runtimePaths: { homePath: "/private/provider-home", shadowHomePath: null },
  message: "sensitive-probe-output",
  usageLimits: {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5h",
        usedPercent,
        resetsAt: "2026-10-18T05:00:00.000Z",
      },
    ],
  },
});

function harness(
  providers: readonly ServerProvider[] = [
    provider("claude-work", 75),
    provider("claude-personal", 10),
  ],
  peerOptions: {
    peers?: ReadonlyArray<PeerEnvironment>;
    reply?: PeerRelayReply;
    discoveryFails?: boolean;
  } = {},
) {
  let currentProviders = providers;
  const state = {
    errors: [] as string[],
    providerReads: 0,
    refreshes: 0,
    sourceRefreshes: 0,
    usageInputs: [] as UsageSummaryInput[],
    peerRequests: [] as PeerRelayOperation[],
    discoveries: 0,
  };
  const hub: UsageLimitSourceSnapshot = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Proxy accounts",
    checkedAt,
    accounts: [
      {
        id: "codex-account",
        driver: ProviderDriverKind.make("codex"),
        email: "codex@example.com",
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 90 }],
        },
      },
    ],
  };
  const layer = McpHttpServer.layerUsageToolkit.pipe(
    Layer.provide(
      Layer.mock(Peers.Peers)({
        describe: () =>
          Effect.sync(() => {
            state.discoveries++;
            return peerOptions.peers ?? [];
          }).pipe(
            Effect.filterOrFail(
              () => !peerOptions.discoveryFails,
              () => new Peers.PeersError({ code: "no_relay", message: "No relay" }),
            ),
          ),
        request: (operation) =>
          Effect.sync(() => {
            state.peerRequests.push(operation);
            return (
              peerOptions.reply ?? {
                type: "failed" as const,
                code: "peer_unreachable" as const,
                message: "Unavailable",
              }
            );
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ErrorReporter.CurrentErrorReporters,
        new Set([
          ErrorReporter.make(({ error }) => {
            state.errors.push(String(error));
          }),
        ]),
      ),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Usage test",
          serverVersion: "0.1.0",
          platform: { os: "darwin", arch: "arm64" },
          capabilities: { repositoryIdentity: false },
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => {
          state.providerReads++;
          return currentProviders;
        }),
        refresh: () =>
          Effect.sync(() => {
            state.refreshes++;
            currentProviders = providers.map((provider) => ({
              ...provider,
              usageLimits: provider.usageLimits
                ? { ...provider.usageLimits, checkedAt: "2026-10-18T01:00:00.000Z" }
                : undefined,
            }));
            return currentProviders;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(UsageLimitSources.UsageLimitSources)({
        current: Effect.succeed([hub]),
        refresh: Effect.sync(() => {
          state.sourceRefreshes++;
        }),
      }),
    ),
    Layer.provide(
      Layer.mock(UsageService.UsageService)({
        readSummary: (input) =>
          Effect.sync(() => {
            state.usageInputs.push(input);
            return {
              contractVersion: 6,
              readAt: checkedAt,
              sinceDay: input.sinceDay,
              untilDay: input.untilDay,
              timeZone: input.timeZone,
              buckets: [
                {
                  day: input.sinceDay,
                  provider: "claude" as const,
                  sourceId: "work",
                  sourcePath: undefined,
                  model: "claude-opus-4-6",
                  costUsd: 3,
                  cacheSavingsUsd: 1,
                  totals: {
                    uncachedInputTokens: 100,
                    cachedInputTokens: 50,
                    cacheCreationTokens: 0,
                    outputTokens: 20,
                    reasoningTokens: 10,
                  },
                  costSource: "modelPriced" as const,
                  records: 1,
                  sessions: 1,
                  unpricedRecords: 0,
                },
              ],
              sources: [
                {
                  sourceId: "work",
                  sourceLabel: "Work",
                  instanceId: "claude-work",
                  fingerprint: {
                    hostId: "test-host",
                    provider: "claude" as const,
                    resolvedHomePath: "/transcript-work",
                    volumeId: "1:2",
                  },
                  status: "ok" as const,
                  scannedFiles: 1,
                  skippedFiles: 0,
                  malformedRecords: 0,
                  distinctSessions: 1,
                  message: null,
                },
              ],
              pricing: {
                status: "cached" as const,
                source: "rates",
                fetchedAt: checkedAt,
                knownModels: 1,
              },
              scanDurationMs: 0,
            };
          }),
      }),
    ),
  );
  return { state, layer };
}

const call = (name: string, args: Record<string, unknown>, caller = scope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "usage-test", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "usage-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
    );
  });

it.effect(
  "lets a Claude caller read separate native accounts and the page's hub limits through MCP",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const result = yield* call("t3_usage_limits_read", {});
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(result.structuredContent).toMatchObject({
        environmentId,
        currentProviderInstanceId: "claude-work",
        providers: [
          {
            instanceId: "claude-work",
            limits: {
              checkedAt,
              windows: [{ usedPercent: 75, resetsAt: "2026-10-18T05:00:00.000Z" }],
            },
          },
          { instanceId: "claude-personal", limits: { windows: [{ usedPercent: 10 }] } },
        ],
        sources: [
          {
            label: "Proxy accounts",
            accounts: [{ driver: "codex", usageLimits: { windows: [{ usedPercent: 90 }] } }],
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("sensitive-probe-output");
      expect(JSON.stringify(result)).not.toContain("/private/provider-home");
      expect(h.state.refreshes).toBe(0);
      expect(h.state.sourceRefreshes).toBe(0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("refreshes the page's provider and hub probes only on request", () => {
  const h = harness();
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", { refresh: true });
    expect(result.isError).toBe(false);
    expect(h.state.refreshes).toBe(1);
    expect(h.state.sourceRefreshes).toBe(1);
    expect(result.structuredContent).toMatchObject({
      providers: [
        { limits: { checkedAt: "2026-10-18T01:00:00.000Z" } },
        { limits: { checkedAt: "2026-10-18T01:00:00.000Z" } },
      ],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "reads laptop Claude quotas when the calling mini's token-only Claude reports unsupported",
  () => {
    const laptopId = EnvironmentId.make("laptop");
    const work = provider("claude-work", 97);
    const personal = provider("claude-personal", 88);
    const h = harness(
      [
        {
          ...provider("claude-work", 0),
          usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
        },
      ],
      {
        peers: [{ environmentId: laptopId, label: "Laptop", connected: true, projects: [] }],
        reply: {
          type: "usage-limits",
          environmentId: laptopId,
          snapshot: {
            readAt: checkedAt,
            providers: [work, personal].map((p) => ({
              instanceId: p.instanceId,
              driver: p.driver,
              displayName: p.displayName,
              enabled: true,
              installed: true,
              available: true,
              auth: p.auth,
              limits: p.usageLimits!,
            })),
            sources: [],
          },
        },
      },
    );
    return Effect.gen(function* () {
      const result = yield* call("t3_usage_limits_read", { refresh: true });
      expect(result.isError, JSON.stringify(h.state.errors)).toBe(false);
      expect(result.structuredContent).toMatchObject({
        coverageComplete: true,
        environments: [
          { environmentId, available: true },
          { environmentId: laptopId, label: "Laptop", available: true },
        ],
        providers: [
          { environmentId, limits: { unavailable: { reason: "unsupported" } } },
          {
            environmentId: laptopId,
            environmentLabel: "Laptop",
            instanceId: "claude-work",
            limits: { windows: [{ usedPercent: 97 }] },
          },
          {
            environmentId: laptopId,
            instanceId: "claude-personal",
            limits: { windows: [{ usedPercent: 88 }] },
          },
        ],
      });
      expect(h.state.peerRequests).toEqual([
        { type: "usage-limits", environmentId: laptopId, refresh: true },
      ]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("reports incomplete coverage when connected quotas cannot be read", () => {
  const h = harness([], {
    peers: [
      {
        environmentId: EnvironmentId.make("laptop"),
        label: "Laptop",
        connected: true,
        projects: [],
      },
    ],
  });
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", {});
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      coverageComplete: false,
      environments: [
        { available: true },
        { available: false, error: expect.stringContaining("unknown") },
      ],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("does not claim full page coverage without a relaying app", () => {
  const h = harness([], { discoveryFails: true });
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", {});
    expect(result.structuredContent).toMatchObject({
      coverageComplete: false,
      notices: [expect.stringContaining("incomplete")],
    });
    const local = yield* call("t3_usage_limits_read", { includeConnected: false });
    expect(local.structuredContent).toMatchObject({ coverageComplete: true, notices: [] });
    expect(h.state.discoveries).toBe(1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("does not attribute another environment's reply to the requested laptop", () => {
  const h = harness([], {
    peers: [
      {
        environmentId: EnvironmentId.make("laptop"),
        label: "Laptop",
        connected: true,
        projects: [],
      },
    ],
    reply: {
      type: "usage-limits",
      environmentId: EnvironmentId.make("wrong-machine"),
      snapshot: { readAt: checkedAt, providers: [], sources: [] },
    },
  });
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", {});
    expect(result.structuredContent).toMatchObject({
      coverageComplete: false,
      providers: [],
      environments: [{ available: true }, { environmentId: "laptop", available: false }],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("serializes optional fields from published provider snapshots", () => {
  const original = provider("claude-work", 75);
  const h = harness([
    {
      ...original,
      displayName: undefined,
      auth: { status: "unknown" },
      usageLimits: {
        checkedAt,
        resetCredits: undefined,
        unavailable: undefined,
        windows: [
          {
            ...original.usageLimits!.windows[0]!,
            resetsAt: undefined,
            windowDurationMins: undefined,
          },
        ],
      },
    },
  ]);
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", {});
    expect(result.isError, JSON.stringify(h.state.errors)).toBe(false);
    expect(result.structuredContent).toMatchObject({
      providers: [{ limits: { windows: [{ usedPercent: 75 }] } }],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("distinguishes missing limits and a failed probe from zero usage", () => {
  const h = harness([
    { ...provider("claude-work", 75), usageLimits: undefined },
    {
      ...provider("claude-personal", 10),
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Probe unavailable" },
      },
    },
  ]);
  return Effect.gen(function* () {
    const result = yield* call("t3_usage_limits_read", {});
    expect(result.structuredContent).toMatchObject({
      providers: [
        { instanceId: "claude-work", limits: null },
        {
          instanceId: "claude-personal",
          limits: { checkedAt, unavailable: { reason: "probeFailed" } },
        },
      ],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("exposes the same usage buckets and defaults to today in the requested timezone", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-18T01:00:00Z"));
    const result = yield* call("t3_usage_read", {
      timeZone: "America/Vancouver",
      awaitRefresh: true,
    });
    expect(result.isError).toBe(false);
    expect(h.state.usageInputs).toEqual([
      {
        sinceDay: "2026-10-17",
        untilDay: "2026-10-17",
        timeZone: "America/Vancouver",
        awaitRefresh: true,
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      buckets: [
        {
          sourceId: "work",
          costUsd: 3,
          costSource: "modelPriced",
          totals: { outputTokens: 20, reasoningTokens: 10 },
        },
      ],
      sources: [{ sourceLabel: "Work", instanceId: "claude-work" }],
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "accepts read-only client credentials and rejects credentials for another environment",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const clientScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "reader", label: "Read-only", access: "read-only" as const },
      };
      const result = yield* call("t3_usage_limits_read", {}, clientScope);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ currentProviderInstanceId: null });
      const rejected = yield* call(
        "t3_usage_limits_read",
        {},
        { ...scope, environmentId: EnvironmentId.make("another-environment") },
      );
      expect(rejected.isError).toBe(true);
      expect(h.state.providerReads).toBe(1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "rejects an invalid timezone before scanning and requires the normal orchestration capability",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      expect((yield* call("t3_usage_read", { timeZone: "Invalid/Zone" })).isError).toBe(true);
      expect(
        (yield* call("t3_usage_read", {}, { ...scope, capabilities: new Set() })).isError,
      ).toBe(true);
      expect(h.state.usageInputs).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  },
);
