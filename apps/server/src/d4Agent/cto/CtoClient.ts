import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class CtoClientError extends Schema.TaggedError<CtoClientError>()("CtoClientError", {
  reason: Schema.Literals([
    "scope",
    "disabled",
    "permission",
    "configuration",
    "unreachable",
    "response-size",
    "response-json",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "scope":
        return "Context operation refused; inspect the selected scope configuration.";
      case "disabled":
        return "CTO integration is disabled.";
      case "permission":
        return "CTO chat requires permission.";
      case "configuration":
        return "CTO server URL is invalid.";
      case "response-size":
        return "CTO response exceeds the size limit.";
      case "response-json":
        return "CTO response is invalid.";
      case "unreachable":
        return "CTO server unreachable";
    }
  }
}

export type CtoRequest = {
  readonly context: string;
  readonly enabled: boolean;
  readonly baseUrl?: string;
};

export type CtoAskRequest = CtoRequest & {
  readonly text: string;
  readonly permissionMode: "read-only" | "ask" | "act";
  readonly approved?: boolean;
};

export class CtoClient extends Context.Service<
  CtoClient,
  {
    readonly status: (input: CtoRequest) => Effect.Effect<unknown, CtoClientError>;
    readonly brief: (
      input: CtoRequest,
    ) => Effect.Effect<{ brief: unknown; tasks: unknown }, CtoClientError>;
    readonly ask: (input: CtoAskRequest) => Effect.Effect<unknown, CtoClientError>;
  }
>()("d4research/d4Agent/cto/CtoClient") {}

const MAX_RESPONSE_BYTES = 256 * 1024;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export function createCtoClient(): CtoClient["Service"] {
  const perform = <A>(
    input: CtoRequest,
    run: (
      request: (
        path: "/api/status" | "/api/brief" | "/api/tasks" | "/api/chat",
        text?: string,
      ) => Effect.Effect<unknown, CtoClientError, Scope.Scope>,
    ) => Effect.Effect<A, CtoClientError, Scope.Scope>,
  ): Effect.Effect<A, CtoClientError> =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.context !== "Dimaggi") return yield* new CtoClientError({ reason: "scope" });
        if (input.enabled !== true) return yield* new CtoClientError({ reason: "disabled" });
        const base = yield* Effect.try({
          try: () => new URL(input.baseUrl ?? "http://127.0.0.1:9093"),
          catch: (cause) => new CtoClientError({ reason: "configuration", cause }),
        });
        if (
          !["http:", "https:"].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.pathname !== "/" ||
          base.search ||
          base.hash
        )
          return yield* new CtoClientError({ reason: "configuration" });
        const client = HttpClient.withScope(yield* HttpClient.HttpClient);
        let received = 0;
        const request = Effect.fnUntraced(function* (
          path: "/api/status" | "/api/brief" | "/api/tasks" | "/api/chat",
          text?: string,
        ) {
          const req =
            path === "/api/chat"
              ? HttpClientRequest.post(new URL(path, base).href).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ message: text }),
                )
              : HttpClientRequest.get(new URL(path, base).href);
          const response = yield* client
            .execute(req)
            .pipe(Effect.mapError((cause) => new CtoClientError({ reason: "unreachable", cause })));
          if (response.status < 200 || response.status >= 300)
            return yield* new CtoClientError({ reason: "unreachable" });
          const declared = Number(response.headers["content-length"]);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES - received)
            return yield* new CtoClientError({ reason: "response-size" });
          const decoder = new TextDecoder();
          const body = yield* response.stream.pipe(
            Stream.mapError((cause) => new CtoClientError({ reason: "unreachable", cause })),
            Stream.runFoldEffect(
              () => "",
              (body, chunk) => {
                received += chunk.byteLength;
                return received > MAX_RESPONSE_BYTES
                  ? Effect.fail(new CtoClientError({ reason: "response-size" }))
                  : Effect.succeed(body + decoder.decode(chunk, { stream: true }));
              },
            ),
          );
          return yield* decodeJson(body + decoder.decode()).pipe(
            Effect.mapError((cause) => new CtoClientError({ reason: "response-json", cause })),
          );
        });
        return yield* run(request);
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new CtoClientError({ reason: "unreachable" })),
      }),
      // Fetch otherwise follows redirects before response status can be checked.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
    );

  return CtoClient.of({
    status: (input) => perform(input, (request) => request("/api/status")),
    brief: (input) =>
      perform(
        input,
        Effect.fnUntraced(function* (request) {
          const brief = yield* request("/api/brief");
          const tasks = yield* request("/api/tasks");
          return { brief, tasks };
        }),
      ),
    ask: (input) =>
      perform(input, (request) => {
        if (
          input.permissionMode !== "act" &&
          !(input.permissionMode === "ask" && input.approved === true)
        )
          return Effect.fail(new CtoClientError({ reason: "permission" }));
        return request("/api/chat", input.text);
      }),
  });
}

export const layer = Layer.sync(CtoClient, createCtoClient);
