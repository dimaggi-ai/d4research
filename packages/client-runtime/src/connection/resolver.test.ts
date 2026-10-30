import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopSshEnvironmentTarget,
} from "@d4research/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
  makePullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly fetch?: typeof fetch;
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly profileStore?: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly descriptorProtocolVersion?: number | null | undefined;
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized relay environment",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: "dpop-access-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        })),
    authorizeDpopHttp: () => Effect.die("unused"),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(
      options?.fetch ??
        ((() =>
          Promise.resolve(
            Response.json({
              environmentId: ENVIRONMENT_ID,
              label: "Compatible environment",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              ...(options?.descriptorProtocolVersion === undefined
                ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
                : options.descriptorProtocolVersion === null
                  ? {}
                  : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
              capabilities: { repositoryIdentity: true },
            }),
          )) satisfies typeof fetch),
    ),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      options?.profileStore ?? profileStore,
    ),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("connects a phone to a shared environment with its saved host credential", () =>
    Effect.gen(function* () {
      const gateway = "https://mac.test/api/shared-environments/proxy/mini";
      const target = Object.assign(
        new PrimaryConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "Mini",
          httpBaseUrl: gateway,
          wsBaseUrl: gateway.replace("https:", "wss:") + "/ws",
        }),
        { sharedHost: { environmentId: EnvironmentId.make("host"), connectionId: "phone-host" } },
      );
      const calls: Array<{ url: string; authorization: string | null }> = [];
      const layerBroker = yield* makeDependencies({
        profiles: [
          new BearerConnectionProfile({
            connectionId: "phone-host",
            environmentId: EnvironmentId.make("host"),
            label: "Mac",
            httpBaseUrl: "https://mac.test/",
            wsBaseUrl: "wss://mac.test/ws",
          }),
        ],
        credentials: [
          ["phone-host", new BearerConnectionCredential({ token: "phone-host-token" })],
        ],
        fetch: (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          calls.push({ url: request.url, authorization: request.headers.get("authorization") });
          if (request.url.includes("/api/shared-environments/")) {
            if (request.headers.get("authorization") !== "Bearer phone-host-token")
              return Promise.resolve(
                Response.json({ message: "host authentication required" }, { status: 401 }),
              );
            if (request.url.endsWith("/api/auth/websocket-ticket/rpc"))
              return Promise.resolve(
                Response.json({ ticket: "host-ticket", expiresAt: "2099-01-01T00:00:00Z" }),
              );
          }
          return Promise.resolve(
            Response.json({
              environmentId: request.url.includes("/proxy/") ? ENVIRONMENT_ID : "host",
              label: "Mac",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.1.2",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              capabilities: { repositoryIdentity: true },
            }),
          );
        },
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const prepared = yield* broker.prepare(catalogEntry(target));
      expect(prepared.httpAuthorization).toEqual({ _tag: "Bearer", token: "phone-host-token" });
      expect(prepared.socketUrl).toContain(
        "/api/shared-environments/proxy/mini/ws?wsTicket=host-ticket",
      );
      expect(
        calls
          .filter((call) => call.authorization !== null)
          .every((call) => call.url.startsWith(gateway + "/")),
      ).toBe(true);
    }),
  );
  it.effect("rejects a changed host identity or gateway origin before sending its credential", () =>
    Effect.gen(function* () {
      for (const origin of ["https://mac.test", "https://another.test"]) {
        const calls: Array<Request> = [];
        const target = new PrimaryConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "Mini",
          httpBaseUrl: origin + "/api/shared-environments/proxy/mini",
          wsBaseUrl: origin.replace("https:", "wss:") + "/api/shared-environments/proxy/mini/ws",
          sharedHost: { environmentId: EnvironmentId.make("host"), connectionId: "phone-host" },
        });
        const layerBroker = yield* makeDependencies({
          profiles: [
            new BearerConnectionProfile({
              connectionId: "phone-host",
              environmentId: EnvironmentId.make("host"),
              label: "Mac",
              httpBaseUrl: "https://mac.test/",
              wsBaseUrl: "wss://mac.test/ws",
            }),
          ],
          credentials: [
            ["phone-host", new BearerConnectionCredential({ token: "phone-host-token" })],
          ],
          fetch: (input, init) => {
            calls.push(new Request(input, init));
            return Promise.resolve(
              Response.json({
                environmentId: "different-machine",
                label: "Wrong host",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.1.2",
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                capabilities: { repositoryIdentity: true },
              }),
            );
          },
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        expect((yield* Effect.exit(broker.prepare(catalogEntry(target))))._tag).toBe("Failure");
        expect(calls.every((request) => !request.headers.has("authorization"))).toBe(true);
        expect(calls).toHaveLength(origin === "https://mac.test" ? 1 : 0);
      }
    }),
  );

  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update T3 Code on Compatible environment");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl:
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("offers the saved SSH token on each connect and saves the one it gets back", () =>
    Effect.gen(function* () {
      const offeredTokens = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["ssh-1", new BearerConnectionCredential({ token: "revoked-token" })]],
        // The host accepts only the token it paired last; anything else pairs again.
        prepareSsh: (input) =>
          Ref.update(offeredTokens, (tokens) => [...tokens, input.bearerToken]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "paired-token",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* broker.prepare(entry);
      const second = yield* broker.prepare(entry);

      expect(yield* Ref.get(offeredTokens)).toEqual(["revoked-token", "paired-token"]);
      expect(first.httpAuthorization).toMatchObject({ token: "paired-token" });
      expect(second.httpAuthorization).toMatchObject({ token: "paired-token" });
    }),
  );

  it.effect.each(["unchanged", "changed", "revocation-failed"] as const)(
    "handles %s SSH routing consent before saving or authorizing",
    (scenario) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const entry = catalogEntry(target, Option.some(profile));
        const preparedTarget =
          scenario === "unchanged"
            ? SSH_TARGET
            : { ...SSH_TARGET, hostname: "replacement.example.test" };
        const failure = new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not persist routing consent.",
        });
        const permissions = yield* makePullRequestRoutingPermissions({
          read: Effect.succeed([
            {
              environmentId: ENVIRONMENT_ID,
              connectionKey: pullRequestRoutingConnectionKey(entry)!,
              permission: "read-write",
            },
          ]),
          write: () =>
            Effect.sync(() => {
              calls.push("revoke");
            }).pipe(
              Effect.andThen(scenario === "revocation-failed" ? Effect.fail(failure) : Effect.void),
            ),
        });
        let savedProfile: ConnectionProfile = profile;
        const layerBroker = yield* makeDependencies({
          profileStore: {
            get: () => Effect.sync(() => Option.some(savedProfile)),
            put: (value) =>
              Effect.sync(() => {
                calls.push("profile");
                savedProfile = value;
              }),
            remove: () => Effect.die("unused"),
          },
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: preparedTarget,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          authorizeBearer: (input) =>
            Effect.sync(() => {
              calls.push("authorize");
              return {
                environmentId: input.expectedEnvironmentId,
                label: "SSH",
                httpBaseUrl: input.httpBaseUrl,
                socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=ssh",
                httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              };
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepare = broker
          .prepare(entry)
          .pipe(Effect.provideService(PullRequestRoutingPermissions, permissions));
        if (scenario === "revocation-failed") {
          expect(yield* Effect.flip(prepare)).toBe(failure);
          expect(savedProfile).toBe(profile);
          expect(calls).toEqual(["revoke"]);
        } else {
          expect((yield* prepare).socketUrl).toContain("wsTicket=ssh");
          expect(savedProfile).toMatchObject({ target: preparedTarget });
          expect(calls).toEqual(
            scenario === "unchanged"
              ? ["profile", "authorize"]
              : ["revoke", "profile", "authorize"],
          );
        }
        expect(yield* permissions.get(entry)).toBe(scenario === "changed" ? "off" : "read-write");
      }),
  );
});
