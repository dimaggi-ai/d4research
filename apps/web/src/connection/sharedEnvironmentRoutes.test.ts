import { describe, expect, it } from "vite-plus/test";
import {
  PrimaryConnectionTarget,
  sharedEnvironmentRegistrations,
  isHostPrimaryConnectionTarget,
  isSharedHostConnectionTarget,
  BearerConnectionTarget,
  type PreparedConnection,
} from "@d4research/client-runtime/connection";
import { EnvironmentId } from "@d4research/contracts";
import * as Option from "effect/Option";
import { sharedEnvironmentPublication, type SharedHostConnection } from "./sharedEnvironmentRoutes";

const primary = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("host"),
  label: "MacBook",
  httpBaseUrl: "https://mac.tail.test/",
  wsBaseUrl: "wss://mac.tail.test/ws",
});
const mini = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("mini"),
  label: "Mac Mini",
  connectionId: "ssh-mini",
});
const route = (
  target: typeof primary | typeof mini,
  authorization: PreparedConnection["httpAuthorization"],
  enabled = true,
): SharedHostConnection => ({
  entry: { target, enabled, profile: Option.none() },
  prepared: {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target === primary ? primary.httpBaseUrl : "http://127.0.0.1:12345/",
    socketUrl: "ws://127.0.0.1:12345/ws",
    target,
    httpAuthorization: authorization,
  },
});
const host = route(primary, { _tag: "Bearer", token: "host-secret" });

describe("host shared environment routes", () => {
  it("publishes only other enabled environments using their current route", () => {
    const remote = route(mini, { _tag: "Bearer", token: "mini-secret" });
    expect(sharedEnvironmentPublication([host, remote])).toEqual({
      httpBaseUrl: primary.httpBaseUrl,
      headers: { authorization: "Bearer host-secret" },
      payload: {
        environments: [
          {
            environmentId: mini.environmentId,
            label: "Mac Mini",
            httpBaseUrl: "http://127.0.0.1:12345/",
            bearerToken: "mini-secret",
          },
        ],
      },
    });
    expect(
      sharedEnvironmentPublication([host, route(mini, { _tag: "Bearer", token: "secret" }, false)])
        ?.payload.environments,
    ).toEqual([]);
  });
  it("retains disconnected environments without a credential and publishes refreshed credentials", () => {
    const remote = route(mini, { _tag: "Bearer", token: "rotated-secret" });
    expect(
      sharedEnvironmentPublication([host, { ...remote, prepared: null }])?.payload.environments[0],
    ).toMatchObject({ httpBaseUrl: null, bearerToken: null });
    expect(sharedEnvironmentPublication([host, remote])?.payload.environments[0]?.bearerToken).toBe(
      "rotated-secret",
    );
  });
  it("does not pretend unsupported proof-authenticated routes are bearer routes", () => {
    const remote = route(mini, {
      _tag: "Dpop",
      accessToken: "proof-secret",
      expiresAtEpochMs: 123,
    });
    expect(
      sharedEnvironmentPublication([host, remote])?.payload.environments[0]?.bearerToken,
    ).toBeNull();
    expect(sharedEnvironmentPublication([route(primary, null), remote])).toBeNull();
    expect(
      sharedEnvironmentPublication([{ ...host, entry: { ...host.entry, enabled: false } }, remote]),
    ).toBeNull();
  });
  it("discovers distinct same-origin routes without tunnel addresses, credentials, or pairing", () => {
    const registrations = sharedEnvironmentRegistrations(primary, {
      environments: [
        { environmentId: primary.environmentId, label: "Host", available: true, reason: null },
        { environmentId: mini.environmentId, label: "Mac Mini", available: true, reason: null },
      ],
    });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.target).toEqual(
      new PrimaryConnectionTarget({
        environmentId: mini.environmentId,
        label: "Mac Mini",
        httpBaseUrl: "https://mac.tail.test/api/shared-environments/proxy/mini",
        wsBaseUrl: "wss://mac.tail.test/api/shared-environments/proxy/mini/ws",
      }),
    );
    expect(JSON.stringify(registrations)).not.toContain("secret");
  });
});

describe("host identity", () => {
  it("distinguishes shared environments from the actual primary machine", () => {
    const target = sharedEnvironmentRegistrations(primary, {
      environments: [
        {
          environmentId: mini.environmentId,
          label: "Mini",
          available: false,
          reason: "Disconnected",
        },
      ],
    })[0]!.target;
    expect(isHostPrimaryConnectionTarget(primary)).toBe(true);
    expect(isHostPrimaryConnectionTarget(target)).toBe(false);
    expect(isSharedHostConnectionTarget(target)).toBe(true);
  });
});
