import type * as Scope from "effect/Scope";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthWebSocketTicketResult,
  AuthSessionId,
  DELEGATED_PERMISSIONS_HEADER,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  SHARED_ENVIRONMENT_PROXY_PREFIX,
  type PublishSharedEnvironmentsInput,
  type SharedEnvironmentCatalog,
  type SharedEnvironmentRegistration,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

type Actor = Pick<EnvironmentAuth.AuthenticatedSession, "sessionId" | "scopes">;
interface HostedEnvironment extends SharedEnvironmentRegistration {
  readonly available: boolean;
  readonly reason: string | null;
}

export class SharedEnvironmentError extends Schema.TaggedError<SharedEnvironmentError>()(
  "SharedEnvironmentError",
  {
    reason: Schema.Literals([
      "unauthenticated",
      "forbidden",
      "invalid_registration",
      "unavailable",
      "upstream",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unauthenticated":
        return "Sign in to this host to use its shared environments.";
      case "forbidden":
        return "This client needs View environment and View relay and shared environments permissions.";
      case "invalid_registration":
        return "The shared environment registration is invalid.";
      case "unavailable":
        return "This environment is unavailable. Keep the Mac app connected and update both servers to a version supporting shared access.";
      case "upstream":
        return "The host could not reach the shared environment.";
    }
  }
}

export class SharedEnvironments extends Context.Service<
  SharedEnvironments,
  {
    readonly publish: (
      actor: Actor,
      input: PublishSharedEnvironmentsInput,
    ) => Effect.Effect<{ published: number }, SharedEnvironmentError>;
    readonly catalog: (
      actor: Actor,
    ) => Effect.Effect<SharedEnvironmentCatalog, SharedEnvironmentError>;
    readonly proxy: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, SharedEnvironmentError, Scope.Scope>;
  }
>()("d4research/connections/SharedEnvironments") {}

const isSharedEnvironmentError = Schema.is(SharedEnvironmentError);

const ignoredRequestHeaders = new Set([
  "host",
  "cookie",
  "authorization",
  "dpop",
  "origin",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "accept-encoding",
  DELEGATED_PERMISSIONS_HEADER,
]);
const pump = Effect.fn("SharedEnvironments.pump")(function* (
  source: Socket.Socket,
  sink: Socket.Writer,
) {
  const { pull } = yield* source.reader;
  while (true) yield* sink.writeAll(yield* pull);
});

const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const ownId = yield* identity.getEnvironmentId;
  const client = yield* HttpClient.HttpClient;
  // Secrets stay in memory on the host; the browser catalog only contains identities and labels.
  const owners = yield* Ref.make(new Map<AuthSessionId, ReadonlyArray<HostedEnvironment>>());
  yield* Stream.runForEach(sessions.streamChanges, (change) => {
    const id = change.type === "clientRemoved" ? change.sessionId : change.clientSession.sessionId;
    const removed =
      change.type === "clientRemoved" ||
      !change.clientSession.scopes.includes(AuthAccessWriteScope);
    return removed
      ? Ref.update(owners, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        })
      : Effect.void;
  }).pipe(Effect.forkScoped);
  const activeOwners = Effect.gen(function* () {
    const active = yield* sessions.listActive();
    return new Set(
      active
        .filter((session) => session.connected && session.scopes.includes(AuthAccessWriteScope))
        .map((session) => session.sessionId),
    );
  });
  const authorize = (actor: Actor) =>
    actor.scopes.includes(AuthRelayReadScope) && actor.scopes.includes(AuthOrchestrationReadScope)
      ? Effect.void
      : Effect.fail(new SharedEnvironmentError({ reason: "forbidden" }));
  const headers = (actor: Actor, environment: HostedEnvironment) => ({
    authorization: `Bearer ${environment.bearerToken}`,
    [DELEGATED_PERMISSIONS_HEADER]: JSON.stringify(actor.scopes),
  });
  const publish: SharedEnvironments["Service"]["publish"] = Effect.fn("SharedEnvironments.publish")(
    function* (actor, input) {
      if (!actor.scopes.includes(AuthAccessWriteScope))
        return yield* new SharedEnvironmentError({ reason: "forbidden" });
      const ids = new Set<EnvironmentId>();
      for (const entry of input.environments) {
        if (entry.environmentId === ownId || ids.has(entry.environmentId))
          return yield* new SharedEnvironmentError({ reason: "invalid_registration" });
        ids.add(entry.environmentId);
        if (entry.httpBaseUrl === null && entry.bearerToken === null) continue;
        const valid = yield* Effect.try(() => {
          const url = new URL(entry.httpBaseUrl ?? "");
          // Only authenticated routes from the host are published. Nested gateways and URL credentials are rejected.
          return (
            ["http:", "https:"].includes(url.protocol) &&
            url.pathname === "/" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !!entry.bearerToken
          );
        }).pipe(Effect.orElseSucceed(() => false));
        if (!valid) return yield* new SharedEnvironmentError({ reason: "invalid_registration" });
      }
      const environments = yield* Effect.forEach(
        input.environments,
        (entry) =>
          Effect.gen(function* () {
            if (entry.httpBaseUrl === null || entry.bearerToken === null)
              return {
                ...entry,
                available: false,
                reason: "The host app is not connected to this environment.",
              };
            const descriptor = yield* client
              .get(new URL("/.well-known/t3/environment", entry.httpBaseUrl).href, {
                headers: { authorization: `Bearer ${entry.bearerToken}` },
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
                Effect.timeout("5 seconds"),
                Effect.option,
              );
            const available =
              Option.isSome(descriptor) &&
              descriptor.value.environmentId === entry.environmentId &&
              descriptor.value.capabilities.sharedEnvironmentProxy === true;
            return {
              ...entry,
              available,
              reason: available
                ? null
                : "Update this environment's server to support shared access, and reconnect it on the host.",
            };
          }),
        { concurrency: 4 },
      );
      yield* Ref.update(owners, (current) => new Map(current).set(actor.sessionId, environments));
      return { published: environments.length };
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isSharedEnvironmentError(cause)
            ? cause
            : new SharedEnvironmentError({ reason: "upstream", cause }),
        ),
      ),
  );

  const visible = Effect.gen(function* () {
    const active = yield* activeOwners;
    return [...(yield* Ref.get(owners))]
      .filter(([owner]) => active.has(owner))
      .flatMap(([, entries]) => entries);
  });
  const catalog: SharedEnvironments["Service"]["catalog"] = Effect.fn("SharedEnvironments.catalog")(
    function* (actor) {
      yield* authorize(actor);
      const active = yield* activeOwners;
      const byId = new Map<EnvironmentId, SharedEnvironmentCatalog["environments"][number]>();
      for (const [owner, entries] of yield* Ref.get(owners))
        for (const entry of entries) {
          const connected = active.has(owner);
          const item = {
            environmentId: entry.environmentId,
            label: entry.label,
            available: connected && entry.available,
            reason: connected
              ? entry.reason
              : "The host app is disconnected. Reconnect it to use this environment.",
          };
          if (!byId.get(item.environmentId)?.available) byId.set(item.environmentId, item);
        }
      return { environments: [...byId.values()] };
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isSharedEnvironmentError(cause)
            ? cause
            : new SharedEnvironmentError({ reason: "upstream", cause }),
        ),
      ),
  );

  const proxy: SharedEnvironments["Service"]["proxy"] = Effect.fn("SharedEnvironments.proxy")(
    function* (request) {
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return yield* new SharedEnvironmentError({ reason: "unavailable" });
      const rest = url.value.pathname.slice(SHARED_ENVIRONMENT_PROXY_PREFIX.length);
      const split = rest.indexOf("/");
      if (split <= 0) return yield* new SharedEnvironmentError({ reason: "unavailable" });
      const id = yield* Effect.try(() =>
        EnvironmentId.make(decodeURIComponent(rest.slice(0, split))),
      );
      const path = rest.slice(split);
      if (
        !(
          path === "/ws" ||
          path === "/.well-known/t3/environment" ||
          path.startsWith("/api/") ||
          path.startsWith("/assets/")
        )
      )
        return yield* new SharedEnvironmentError({ reason: "unavailable" });
      const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
      const actor = yield* (
        upgrade && path === "/ws"
          ? auth.authenticateWebSocketUpgrade(request, "rpc")
          : auth.authenticateHttpRequest(request)
      ).pipe(
        Effect.mapError(
          (cause) => new SharedEnvironmentError({ reason: "unauthenticated", cause }),
        ),
      );
      yield* authorize(actor);
      const environment = (yield* visible).find(
        (entry) => entry.environmentId === id && entry.available,
      );
      if (!environment?.httpBaseUrl || !environment.bearerToken)
        return yield* new SharedEnvironmentError({ reason: "unavailable" });
      const stop = sessions
        .awaitInvalidation(actor.sessionId, actor.credentialScopes ?? actor.scopes)
        .pipe(Effect.orDie);
      // The browser ticket belongs to the host. It must never be sent to the other server.
      const ticketUse =
        path === "/api/auth/websocket-ticket/rpc"
          ? "rpc"
          : path === "/api/auth/websocket-ticket/media"
            ? "media"
            : undefined;
      if (!upgrade && (path === "/api/auth/websocket-ticket" || ticketUse !== undefined)) {
        const ticket = yield* auth.issueWebSocketTicket(
          actor,
          ticketUse === undefined ? undefined : { use: ticketUse },
        );
        return yield* HttpServerResponse.schemaJson(AuthWebSocketTicketResult)(ticket);
      }
      const upstreamUrl = new URL(environment.httpBaseUrl);
      upstreamUrl.pathname = path;
      upstreamUrl.search = url.value.search;
      const outgoingHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined && !ignoredRequestHeaders.has(key)) outgoingHeaders[key] = value;
      Object.assign(outgoingHeaders, headers(actor, environment));
      if (upgrade) {
        if (path === "/ws") {
          let response = yield* client.post(
            new URL("/api/auth/websocket-ticket/rpc", environment.httpBaseUrl).href,
            { headers: outgoingHeaders },
          );
          if (response.status === 404) {
            yield* response.arrayBuffer;
            response = yield* client.post(
              new URL("/api/auth/websocket-ticket", environment.httpBaseUrl).href,
              { headers: outgoingHeaders },
            );
          }
          const ticket =
            yield* HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult)(response);
          upstreamUrl.searchParams.set("wsTicket", ticket.ticket);
        }
        upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
        const upstream = yield* Socket.makeWebSocket(upstreamUrl.href, {
          headers: outgoingHeaders,
          openTimeout: "10 seconds",
        }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS));
        const socket = yield* request.upgrade;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const toBrowser = yield* socket.writer;
            const toRemote = yield* upstream.writer;
            yield* Effect.raceFirst(
              Effect.raceFirst(pump(upstream, toBrowser), pump(socket, toRemote)),
              stop,
            );
          }),
        ).pipe(Effect.ignoreCause);
        return HttpServerResponse.empty();
      }
      const scopedClient = HttpClient.withScope(client);
      const outbound = HttpClientRequest.make(request.method)(upstreamUrl.href).pipe(
        HttpClientRequest.setHeaders(outgoingHeaders),
        request.method === "GET" || request.method === "HEAD"
          ? (self) => self
          : HttpClientRequest.bodyStream(request.stream),
      );
      const response = yield* scopedClient.execute(outbound);
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers))
        if (
          value !== undefined &&
          ![
            "set-cookie",
            "connection",
            "transfer-encoding",
            "content-encoding",
            "content-length",
          ].includes(name)
        )
          responseHeaders[name] = value;
      responseHeaders["cache-control"] = "private, no-store, no-transform";
      return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(stop)), {
        status: response.status,
        headers: responseHeaders,
        ...(responseHeaders["content-type"]
          ? { contentType: responseHeaders["content-type"] }
          : {}),
      });
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isSharedEnvironmentError(cause)
            ? cause
            : new SharedEnvironmentError({ reason: "upstream", cause }),
        ),
      ),
  );
  return SharedEnvironments.of({ publish, catalog, proxy });
});

export const layer = Layer.effect(SharedEnvironments, make);
