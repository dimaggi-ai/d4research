import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionTarget,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  type PlatformConnectionRegistration,
  type PreparedConnection,
} from "@d4research/client-runtime/connection";
import { EnvironmentId } from "@d4research/contracts";
import { layerRemoteHttpClient } from "@d4research/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";
import { discoverSharedHostEnvironments, layer } from "./shared-environments";

const host: PreparedConnection = {
  environmentId: EnvironmentId.make("host"),
  label: "My Mac",
  httpBaseUrl: "https://mac.test/",
  socketUrl: "wss://mac.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "phone-host-token" },
  target: new BearerConnectionTarget({
    environmentId: EnvironmentId.make("host"),
    label: "My Mac",
    connectionId: "phone-mac",
  }),
};

describe("native shared environment discovery", () => {
  it.effect(
    "installs discovered environments, retains them during an outage, and withdraws denied or disabled hosts",
    () =>
      Effect.gen(function* () {
        const hostEntry: ConnectionCatalogEntry = {
          target: host.target,
          profile: Option.none(),
          enabled: true,
        };
        const entries = yield* SubscriptionRef.make<
          ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
        >(new Map([[host.environmentId, hostEntry]]));
        const prepared = yield* SubscriptionRef.make(Option.some(host));
        const state = yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        });
        const reconciled = yield* Queue.unbounded<ReadonlyArray<PlatformConnectionRegistration>>();
        const supervisor = {
          state,
          prepared,
        } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        const registry = {
          entries,
          followStream: (_id, stream) =>
            stream.pipe(
              Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            ),
          reconcilePlatform: (registrations) =>
            Effect.gen(function* () {
              yield* SubscriptionRef.update(
                entries,
                (current) =>
                  new Map([
                    ...[...current].filter(
                      ([, entry]) => entry.target._tag !== "PrimaryConnectionTarget",
                    ),
                    ...registrations.map(
                      (registration) =>
                        [
                          registration.target.environmentId,
                          { target: registration.target, profile: Option.none(), enabled: true },
                        ] as const,
                    ),
                  ]),
              );
              yield* Queue.offer(reconciled, registrations);
            }),
        } satisfies Pick<
          EnvironmentRegistry.EnvironmentRegistry["Service"],
          "entries" | "followStream" | "reconcilePlatform"
        >;
        let status = 200;
        const http = layerRemoteHttpClient(() =>
          Promise.resolve(
            Response.json(
              {
                environments: [
                  { environmentId: "mini", label: "Mini", available: true, reason: null },
                ],
              },
              { status },
            ),
          ),
        );
        yield* Layer.build(
          layer.pipe(
            Layer.provide(
              Layer.succeed(
                EnvironmentRegistry.EnvironmentRegistry,
                registry as EnvironmentRegistry.EnvironmentRegistry["Service"],
              ),
            ),
            Layer.provide(http),
          ),
        );
        expect(
          (yield* Queue.take(reconciled)).map((registration) => registration.target.environmentId),
        ).toEqual(["mini"]);
        status = 503;
        yield* TestClock.adjust("10 seconds");
        expect(
          (yield* Queue.take(reconciled)).map((registration) => registration.target.environmentId),
        ).toEqual(["mini"]);
        status = 403;
        yield* TestClock.adjust("10 seconds");
        expect(yield* Queue.take(reconciled)).toEqual([]);
        status = 200;
        yield* TestClock.adjust("10 seconds");
        expect(
          (yield* Queue.take(reconciled)).map((registration) => registration.target.environmentId),
        ).toEqual(["mini"]);
        yield* SubscriptionRef.update(entries, (current) =>
          new Map(current).set(host.environmentId, { ...hostEntry, enabled: false }),
        );
        expect(yield* Queue.take(reconciled)).toEqual([]);
      }),
  );
  it.effect("discovers the Mini through the paired Mac without copying remote credentials", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const result = yield* discoverSharedHostEnvironments(host).pipe(
        Effect.provide(
          layerRemoteHttpClient((input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(
              Response.json({
                environments: [
                  { environmentId: "host", label: "My Mac", available: true, reason: null },
                  { environmentId: "mini", label: "Mini", available: true, reason: null },
                ],
              }),
            );
          }),
        ),
      );
      expect(requests.map((r) => [r.url, r.headers.get("authorization")])).toEqual([
        ["https://mac.test/api/shared-environments", "Bearer phone-host-token"],
      ]);
      const registrations = Option.getOrThrow(result);
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.target).toMatchObject({
        environmentId: "mini",
        httpBaseUrl: "https://mac.test/api/shared-environments/proxy/mini",
        sharedHost: { environmentId: "host", connectionId: "phone-mac" },
      });
      expect(JSON.stringify(registrations)).not.toContain("phone-host-token");
    }),
  );
  it.effect(
    "removes discovery after permission denial but retains it through a temporary outage",
    () =>
      Effect.gen(function* () {
        for (const status of [401, 403, 404, 503]) {
          const result = yield* discoverSharedHostEnvironments(host).pipe(
            Effect.provide(
              layerRemoteHttpClient(() => Promise.resolve(Response.json({}, { status }))),
            ),
          );
          expect(Option.getOrNull(result)).toEqual(status === 503 ? null : []);
        }
      }),
  );
  it.effect(
    "does not recursively discover through a gateway or attempt proof-only credentials",
    () =>
      Effect.gen(function* () {
        for (const current of [
          { ...host, httpBaseUrl: "https://mac.test/api/shared-environments/proxy/mini" },
          {
            ...host,
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "proof",
              expiresAtEpochMs: 123,
            },
          },
        ]) {
          const result = yield* discoverSharedHostEnvironments(current).pipe(
            Effect.provide(
              layerRemoteHttpClient(() => {
                throw new Error("Discovery should not make a request");
              }),
            ),
          );
          expect(Option.getOrThrow(result)).toEqual([]);
        }
      }),
  );
});
