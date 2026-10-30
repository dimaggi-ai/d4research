import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import {
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
} from "@d4research/client-runtime/connection";
import type { RpcSession } from "@d4research/client-runtime/rpc";
import { EnvironmentId, WS_METHODS } from "@d4research/contracts";

const { call, watch } = vi.hoisted(() => ({ call: vi.fn(), watch: vi.fn() }));
vi.mock("@d4research/client-runtime/rpc", () => ({
  request: (...args: unknown[]) => call(...args),
  subscribe: (...args: unknown[]) => watch(...args),
}));
import { readPeerUsageLimits } from "./peerUsageLimits";

const layerSupervisor = Layer.effect(
  EnvironmentSupervisor.EnvironmentSupervisor,
  Effect.gen(function* () {
    return EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("laptop"),
        label: "Laptop",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
      }),
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none()),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  }),
);

const config = {
  environment: { environmentId: "laptop", capabilities: { usageLimitSources: true } },
  providers: [
    {
      instanceId: "claude-work",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      runtimePaths: { homePath: "/private/config" },
      usageLimits: {
        checkedAt: "2026-10-19T05:49:00Z",
        windows: [{ id: "seven_day", usedPercent: 97 }],
      },
    },
  ],
};
const hub = {
  id: "hub",
  label: "Usage hub",
  kind: "cliproxy",
  checkedAt: "2026-10-19T05:49:00Z",
  accounts: [],
};

describe("peer usage page reads", () => {
  it.effect("reads the destination page snapshot and omits provider runtime details", () =>
    Effect.gen(function* () {
      call.mockReset().mockReturnValue(Effect.succeed(config));
      watch
        .mockReset()
        .mockReturnValue(
          Stream.make({ type: "usageLimitSourcesUpdated", payload: { sources: [hub] } }),
        );
      const result = yield* readPeerUsageLimits(false);
      expect(result).toMatchObject({
        environmentId: "laptop",
        snapshot: {
          providers: [{ instanceId: "claude-work", limits: config.providers[0]!.usageLimits }],
        },
      });
      expect(call).toHaveBeenCalledExactlyOnceWith(WS_METHODS.serverGetConfig, {});
      expect(JSON.stringify(result)).not.toContain("/private/config");
      expect(result.snapshot.sources).toEqual([hub]);
      expect(watch).toHaveBeenCalledExactlyOnceWith(WS_METHODS.subscribeServerConfig, {
        usageLimitSources: true,
      });
    }).pipe(Effect.provide(layerSupervisor)),
  );

  it.effect("awaits the normal refresh before reading the page configuration", () =>
    Effect.gen(function* () {
      const performed: string[] = [];
      watch
        .mockReset()
        .mockReturnValue(
          Stream.make({ type: "usageLimitSourcesUpdated", payload: { sources: [] } }),
        );
      call.mockReset().mockImplementation((method: string) =>
        Effect.sync(() => {
          performed.push(method);
          return method === WS_METHODS.serverGetConfig ? config : {};
        }),
      );
      yield* readPeerUsageLimits(true);
      expect(performed).toEqual([WS_METHODS.serverRefreshProviders, WS_METHODS.serverGetConfig]);
      expect(call).toHaveBeenNthCalledWith(1, WS_METHODS.serverRefreshProviders, { fresh: true });
    }).pipe(Effect.provide(layerSupervisor)),
  );
});
