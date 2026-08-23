import { EnvironmentId } from "@d4research/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("reuses a validated bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const responses = [
        Response.json(DESCRIPTOR),
        Response.json({ ticket: "first-ticket", expiresAt: "2026-06-06T01:00:00.000Z" }),
        Response.json({ ticket: "second-ticket", expiresAt: "2026-06-06T01:00:00.000Z" }),
      ];
      const fetchFn = ((input: RequestInfo | URL) => {
        calls.push(String(input));
        const response = responses.shift();
        return response === undefined
          ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
          : Promise.resolve(response);
      }) satisfies typeof fetch;
      const layer = RemoteEnvironmentAuthorization.layer.pipe(
        Layer.provide(remoteHttpClientLayer(fetchFn)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: "https://environment.example.test",
            wsBaseUrl: "wss://environment.example.test",
            bearerToken: "bearer-token",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(calls.filter((url) => url.endsWith("/.well-known/t3/environment"))).toHaveLength(1);
      expect(calls.filter((url) => url.endsWith("/api/auth/websocket-ticket"))).toHaveLength(2);
    }),
  );
});
