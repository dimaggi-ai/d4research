// @effect-diagnostics nodeBuiltinImport:off - Temporary Node HTTP servers exercise actual WebSocket upgrades.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_VERSION,
  SHARED_ENVIRONMENT_PROXY_PREFIX,
  type ExecutionEnvironmentDescriptor,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpClient,
  HttpClientRequest,
} from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Shared from "./SharedEnvironments.ts";
import * as SharedHttp from "./SharedEnvironmentHttp.ts";

const hostId = EnvironmentId.make("gateway-host");
const remoteId = EnvironmentId.make("gateway-mini");
const authLayer = (id: EnvironmentId) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(id),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "shared-env-test-" })),
  );
class RemoteApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
class HostApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.sharedEnvironments) {}

// Temporary loopback servers and memory databases; no provider turns or user data.
it.layer(NodeServices.layer)("shared environment browser gateway", (it) => {
  it.effect(
    "shares the host's environment, forwards HTTP and live frames, and enforces edited grants",
    () =>
      Effect.gen(function* () {
        const remoteContext = yield* Layer.build(authLayer(remoteId));
        const remoteAuth = Context.get(remoteContext, EnvironmentAuth.EnvironmentAuth);
        const remoteSessions = Context.get(remoteContext, SessionStore.SessionStore);
        const remoteOwner = yield* remoteAuth.issueSession({ scopes: AuthStandardClientScopes });
        let modern = true;
        let ticketAudiences = true;
        let calls = 0;
        const descriptor = (): ExecutionEnvironmentDescriptor => ({
          environmentId: remoteId,
          label: "Mac Mini",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.45",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true, sharedEnvironmentProxy: modern },
        });
        const remoteRoutes = Layer.mergeAll(
          HttpApiBuilder.layer(RemoteApi).pipe(
            Layer.provide(AuthHttp.layer),
            Layer.provide(AuthHttp.layerAuthenticatedAuth),
          ),
          HttpRouter.add(
            "GET",
            "/.well-known/t3/environment",
            Effect.sync(() => HttpServerResponse.jsonUnsafe(descriptor())),
          ),
          HttpRouter.add(
            "*",
            "/api/example",
            Effect.gen(function* () {
              calls++;
              const request = yield* HttpServerRequest.HttpServerRequest;
              const actor = yield* remoteAuth.authenticateHttpRequest(request);
              if (request.method === "POST" && !actor.scopes.includes("filesystem:write"))
                return HttpServerResponse.empty({ status: 403 });
              return HttpServerResponse.jsonUnsafe({
                machine: "Mac Mini",
                scopes: [...actor.scopes].sort(),
              });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/ws",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const actor = yield* remoteAuth.authenticateWebSocketUpgrade(request, "rpc");
              const ticket = new URL(request.url, "http://localhost").searchParams.get("wsTicket");
              expect((yield* remoteSessions.verifyWebSocketToken(ticket!)).audience).toBe(
                ticketAudiences ? "rpc" : undefined,
              );
              const socket = yield* request.upgrade;
              const { pull } = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* writer.writeAll([
                JSON.stringify({ machine: "Mac Mini", scopes: [...actor.scopes].sort() }),
              ]);
              while (true) yield* writer.writeAll(yield* pull);
            }),
          ),
        ).pipe(Layer.provide(Layer.succeedContext(remoteContext)));
        const remoteApp = yield* HttpRouter.toHttpEffect(remoteRoutes);
        const remoteNode = NodeHttp.createServer();
        const remoteServer = yield* NodeHttpServer.make(() => remoteNode, {
          host: "127.0.0.1",
          port: 0,
        });
        yield* remoteServer
          .serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (!ticketAudiences && request.url === "/api/auth/websocket-ticket/rpc")
                return HttpServerResponse.empty({ status: 404 });
              return yield* remoteApp;
            }),
          )
          .pipe(
            Effect.provideService(
              ServerSecretStore.ServerSecretStore,
              Context.get(remoteContext, ServerSecretStore.ServerSecretStore),
            ),
          );
        const remoteAddress = remoteNode.address();
        if (!remoteAddress || typeof remoteAddress === "string")
          throw new Error("Missing remote test listener");
        const remoteUrl = `http://127.0.0.1:${remoteAddress.port}`;

        const hostContext = yield* Layer.build(
          Shared.layer.pipe(
            Layer.provideMerge(authLayer(hostId)),
            Layer.provide(FetchHttpClient.layer),
          ),
        );
        const hostAuth = Context.get(hostContext, EnvironmentAuth.EnvironmentAuth);
        const sessions = Context.get(hostContext, SessionStore.SessionStore);
        const shared = Context.get(hostContext, Shared.SharedEnvironments);
        const owner = yield* hostAuth.issueSession({ scopes: AuthStandardClientScopes });
        yield* sessions.markConnected(owner.sessionId);
        const phoneScopes = ["orchestration:read", "relay:read", "filesystem:read"] as const;
        const pairing = yield* hostAuth.issuePairingCredential({ scopes: [...phoneScopes].sort() });
        const browser = yield* hostAuth.createBrowserSession(pairing.credential, {
          deviceType: "mobile",
          label: "Phone Safari",
        });
        const phoneSession = yield* hostAuth.authenticateHttpRequest({
          headers: {},
          cookies: { [browser.cookieName ?? sessions.cookieName]: browser.sessionToken },
        } as unknown as HttpServerRequest.HttpServerRequest);
        const phone = {
          cookie: `${browser.cookieName ?? sessions.cookieName}=${browser.sessionToken}`,
        };
        const registration = {
          environmentId: remoteId,
          label: "Mac Mini",
          httpBaseUrl: remoteUrl + "/",
          bearerToken: remoteOwner.token,
        };
        yield* shared.publish(owner, { environments: [registration] });
        const hostRoutes = Layer.mergeAll(
          HttpApiBuilder.layer(HostApi).pipe(
            Layer.provide(AuthHttp.layer),
            Layer.provide(SharedHttp.layerApi),
            Layer.provide(AuthHttp.layerAuthenticatedAuth),
          ),
          SharedHttp.layerProxy,
        ).pipe(Layer.provide(Layer.succeedContext(hostContext)));
        const hostApp = yield* HttpRouter.toHttpEffect(hostRoutes);
        const hostNode = NodeHttp.createServer();
        const hostServer = yield* NodeHttpServer.make(() => hostNode, {
          host: "127.0.0.1",
          port: 0,
        });
        yield* hostServer
          .serve(hostApp)
          .pipe(
            Effect.provideService(
              ServerSecretStore.ServerSecretStore,
              Context.get(hostContext, ServerSecretStore.ServerSecretStore),
            ),
          );
        const hostAddress = hostNode.address();
        if (!hostAddress || typeof hostAddress === "string")
          throw new Error("Missing host test listener");
        const hostUrl = `http://127.0.0.1:${hostAddress.port}`;
        const base = hostUrl + SHARED_ENVIRONMENT_PROXY_PREFIX + encodeURIComponent(remoteId);
        const http = yield* HttpClient.HttpClient;
        const fetchAsPhone = (path: string, method: "GET" | "POST" = "GET") =>
          http.execute(
            HttpClientRequest.make(method)(base + path).pipe(HttpClientRequest.setHeaders(phone)),
          );
        const catalog = yield* shared.catalog(phoneSession);
        expect(catalog.environments).toEqual([
          { environmentId: remoteId, label: "Mac Mini", available: true, reason: null },
        ]);
        expect(JSON.stringify(catalog)).not.toContain(remoteOwner.token);
        expect(JSON.stringify(catalog)).not.toContain(remoteUrl);
        const response = yield* fetchAsPhone("/api/example");
        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual({
          machine: "Mac Mini",
          scopes: [...phoneScopes].sort(),
        });
        expect((yield* fetchAsPhone("/api/example", "POST")).status).toBe(403);

        const ticketResponse = yield* fetchAsPhone("/api/auth/websocket-ticket/rpc", "POST");
        expect(ticketResponse.status).toBe(200);
        const { ticket } = (yield* ticketResponse.json) as { ticket: string };
        expect(yield* sessions.verifyWebSocketToken(ticket)).toMatchObject({
          sessionId: phoneSession.sessionId,
          audience: "rpc",
        });
        const legacyTicketResponse = yield* fetchAsPhone("/api/auth/websocket-ticket", "POST");
        const legacyTicket = (yield* legacyTicketResponse.json) as { ticket: string };
        expect((yield* sessions.verifyWebSocketToken(legacyTicket.ticket)).sessionId).toBe(
          phoneSession.sessionId,
        );
        const mediaTicketResponse = yield* fetchAsPhone("/api/auth/websocket-ticket/media", "POST");
        const mediaTicket = (yield* mediaTicketResponse.json) as { ticket: string };
        expect(yield* sessions.verifyWebSocketToken(mediaTicket.ticket)).toMatchObject({
          sessionId: phoneSession.sessionId,
          audience: "media",
        });
        const wsUrl = new URL(base + "/ws");
        wsUrl.protocol = "ws:";
        wsUrl.searchParams.set("wsTicket", ticket);
        const socket = yield* Socket.makeWebSocket(wsUrl.href).pipe(
          Effect.provide(NodeSocket.layerWebSocketConstructorWS),
        );
        const { pull } = yield* socket.reader;
        const frames = yield* pull;
        const message = JSON.parse(
          typeof frames[0] === "string" ? frames[0] : new TextDecoder().decode(frames[0]),
        );
        expect(message).toEqual({ machine: "Mac Mini", scopes: [...phoneScopes].sort() });
        ticketAudiences = false;
        const cookieUrl = new URL(base + "/ws");
        cookieUrl.protocol = "ws:";
        const cookieSocket = yield* Socket.makeWebSocket(cookieUrl.href, {
          headers: { ...phone, origin: hostUrl },
        }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS));
        const cookieReader = yield* cookieSocket.reader;
        const cookieFrames = yield* cookieReader.pull;
        expect(
          JSON.parse(
            typeof cookieFrames[0] === "string"
              ? cookieFrames[0]
              : new TextDecoder().decode(cookieFrames[0]),
          ).machine,
        ).toBe("Mac Mini");
        const cookieClosed = yield* cookieReader.pull.pipe(
          Effect.exit,
          Effect.forkScoped({ startImmediately: true }),
        );
        const closed = yield* pull.pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
        yield* hostAuth.updateClientScopes(owner, phoneSession.sessionId, ["orchestration:read"]);
        expect(Exit.isFailure(yield* Fiber.join(closed))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(cookieClosed))).toBe(true);
        expect((yield* fetchAsPhone("/api/example")).status).toBe(403);
        yield* hostAuth.updateClientScopes(owner, phoneSession.sessionId, phoneScopes);
        expect((yield* fetchAsPhone("/api/example")).status).toBe(200);

        yield* sessions.markDisconnected(owner.sessionId);
        expect((yield* shared.catalog(phoneSession)).environments[0]?.available).toBe(false);
        expect((yield* fetchAsPhone("/api/example")).status).toBe(503);
        yield* sessions.markConnected(owner.sessionId);
        modern = false;
        yield* shared.publish(owner, { environments: [registration] });
        expect((yield* shared.catalog(phoneSession)).environments[0]?.reason).toContain("Update");
        const before = calls;
        expect((yield* fetchAsPhone("/api/example")).status).toBe(503);
        expect(calls).toBe(before);
        expect(
          (yield* shared
            .publish(owner, {
              environments: [{ ...registration, httpBaseUrl: remoteUrl + "/other" }],
            })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_registration");
        expect(
          (yield* shared
            .publish(owner, { environments: [registration, registration] })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_registration");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(NodeHttpServer.layerHttpServices, FetchHttpClient.layer)),
      ),
  );
});
