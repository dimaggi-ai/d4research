// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real HTTP fixtures exercise redirects, streamed byte limits, and transport cancellation.
import * as NodeHttp from "node:http";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import * as Cto from "./CtoClient.ts";

const servers: Array<NodeHttp.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function fake(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
) {
  const server = NodeHttp.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fake server address");
  return { context: "Dimaggi", enabled: true, baseUrl: `http://127.0.0.1:${address.port}` };
}

const client = Cto.createCtoClient();
const result = <A>(effect: Effect.Effect<A, Cto.CtoClientError>) => Effect.result(effect);

it.live(
  "uses only fixed GET endpoints and joins brief with tasks",
  Effect.fnUntraced(function* () {
    const requests: Array<string> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.end(JSON.stringify({ path: req.url }));
      }),
    );
    expect(yield* client.status(input)).toEqual({ path: "/api/status" });
    expect(yield* client.brief(input)).toEqual({
      brief: { path: "/api/brief" },
      tasks: { path: "/api/tasks" },
    });
    expect(requests).toEqual(["GET /api/status", "GET /api/brief", "GET /api/tasks"]);
  }),
);

it.live.each(["Global", "Personal", "YB", "dimaggi", "", "Dimaggi/../YB"])(
  "refuses %j without any HTTP call",
  Effect.fnUntraced(function* (context) {
    const requests: Array<string | undefined> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(req.url);
        res.end("{}");
      }),
    );
    for (const operation of [
      client.status({ ...input, context }),
      client.brief({ ...input, context }),
      client.ask({ ...input, context, text: "hello", permissionMode: "act" }),
    ]) {
      expect(yield* result(operation)).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: "scope",
          message: "Context operation refused; inspect the selected scope configuration.",
        },
      });
    }
    expect(requests).toEqual([]);
  }),
);

it.live(
  "refuses disabled integration and chat permissions without requests",
  Effect.fnUntraced(function* () {
    const requests: Array<string | undefined> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(req.url);
        res.end("{}");
      }),
    );
    expect(yield* result(client.status({ ...input, enabled: false }))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "disabled" },
    });
    for (const permission of [
      { permissionMode: "read-only" as const, approved: true },
      { permissionMode: "ask" as const },
      { permissionMode: "ask" as const, approved: false },
    ]) {
      expect(yield* result(client.ask({ ...input, ...permission, text: "hello" }))).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission" },
      });
    }
    expect(requests).toEqual([]);
  }),
);

it.live.each([
  { permissionMode: "act" as const },
  { permissionMode: "ask" as const, approved: true },
])(
  "posts the verified chat payload for $permissionMode",
  Effect.fnUntraced(function* (permission) {
    const requests: Array<unknown> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push({
            method: req.method,
            path: req.url,
            body: JSON.parse(body),
            contentType: req.headers["content-type"],
          });
          res.end(JSON.stringify({ reply: "Grounded answer" }));
        });
      }),
    );
    expect(yield* client.ask({ ...input, ...permission, text: "Explain the brief" })).toEqual({
      reply: "Grounded answer",
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/chat",
        body: { message: "Explain the brief" },
        contentType: "application/json",
      },
    ]);
  }),
);

it("does not expose execution, direction, restart or arbitrary operation methods", () => {
  expect(Object.keys(client).sort()).toEqual(["ask", "brief", "status"]);
});

it.live.each([
  "/run",
  "/api/tasks/execute",
  "/api/direction/save",
  "/restart",
  "/?op=run",
  "/#run",
])(
  "rejects endpoint injection through the base URL %s",
  Effect.fnUntraced(function* (path) {
    const requests: Array<string | undefined> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(req.url);
        res.end("{}");
      }),
    );
    expect(yield* result(client.status({ ...input, baseUrl: input.baseUrl + path }))).toMatchObject(
      {
        _tag: "Failure",
        failure: { reason: "configuration" },
      },
    );
    expect(requests).toEqual([]);
  }),
);

it.live(
  "does not follow a redirect to a forbidden endpoint",
  Effect.fnUntraced(function* () {
    const requests: Array<string | undefined> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(req.url);
        res.writeHead(307, { location: "/run" });
        res.end();
      }),
    );
    expect(yield* result(client.status(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unreachable", message: "CTO server unreachable" },
    });
    expect(requests).toEqual(["/api/status"]);
  }),
);

it.live(
  "caps streamed response bytes without relying on Content-Length",
  Effect.fnUntraced(function* () {
    const input = yield* Effect.promise(() =>
      fake((_req, res) => {
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.write('"');
        for (let i = 0; i < 17; i++) res.write("x".repeat(16 * 1024));
        res.end('"');
      }),
    );
    expect(yield* result(client.status(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "response-size" },
    });
  }),
);

it.live(
  "counts UTF-8 bytes and shares the size budget across brief and tasks",
  Effect.fnUntraced(function* () {
    const input = yield* Effect.promise(() =>
      fake((_req, res) => {
        res.end(JSON.stringify("é".repeat(70_000)));
      }),
    );
    expect(yield* result(client.brief(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "response-size" },
    });
  }),
);

it.live(
  "accepts a response exactly at the byte limit",
  Effect.fnUntraced(function* () {
    const input = yield* Effect.promise(() =>
      fake((_req, res) => {
        res.end(JSON.stringify("x".repeat(256 * 1024 - 2)));
      }),
    );
    const response = yield* client.status(input);
    expect(response).toHaveLength(256 * 1024 - 2);
  }),
);

it.live(
  "normalizes HTTP and JSON failures without exposing the response",
  Effect.fnUntraced(function* () {
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        if (req.url === "/api/status") res.writeHead(500);
        res.end("private invalid response");
      }),
    );
    expect(yield* result(client.status(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unreachable", message: "CTO server unreachable" },
    });
    expect(yield* result(client.brief(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "response-json", message: "CTO response is invalid." },
    });
  }),
);

it.live(
  "bounds a stalled response body to five seconds and closes the request",
  Effect.fnUntraced(function* () {
    let requestClosed: Promise<void> = Promise.resolve();
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requestClosed = new Promise<void>((resolve) => req.on("close", resolve));
        res.writeHead(200, { "transfer-encoding": "chunked" });
        res.write('{"unfinished":');
      }),
    );
    const started = performance.now();
    expect(yield* result(client.status(input))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unreachable", message: "CTO server unreachable" },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
    expect(performance.now() - started).toBeLessThan(6500);
    yield* Effect.promise(() => requestClosed);
  }),
  8000,
);

it.live(
  "treats a missing brief as no brief yet and still fetches tasks",
  Effect.fnUntraced(function* () {
    const requests: Array<string | undefined> = [];
    const input = yield* Effect.promise(() =>
      fake((req, res) => {
        requests.push(req.url);
        if (req.url === "/api/brief") {
          res.writeHead(404);
          res.end("private not-found body");
        } else res.end(JSON.stringify({ tasks: ["synthetic task"] }));
      }),
    );
    expect(yield* client.brief(input)).toEqual({
      brief: { status: "no brief yet" },
      tasks: { tasks: ["synthetic task"] },
    });
    expect(requests).toEqual(["/api/brief", "/api/tasks"]);
  }),
);

it.effect.each([
  { operation: "status", deadlineMs: 5000 },
  { operation: "brief", deadlineMs: 5000 },
  { operation: "ask", deadlineMs: 450000 },
] as const)(
  "cancels $operation at its $deadlineMs ms deadline without retrying",
  Effect.fnUntraced(function* ({ operation, deadlineMs }) {
    const started = yield* Deferred.make<void>();
    let calls = 0;
    const requestSignals: AbortSignal[] = [];
    const fetch: typeof globalThis.fetch = (_url, init) => {
      calls++;
      requestSignals.push(init!.signal!);
      Deferred.doneUnsafe(started, Effect.void);
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    };
    const input = { context: "Dimaggi", enabled: true, baseUrl: "http://127.0.0.1:9093" };
    const request =
      operation === "ask"
        ? client.ask({ ...input, text: "synthetic question", permissionMode: "act" })
        : client[operation](input);
    const fiber = yield* result(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(deadlineMs - 1);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(1);
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unreachable" },
    });
    expect(requestSignals[0]?.aborted).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect.each([
  { host: "127.0.0.1", allowed: true },
  { host: "127.255.255.255", allowed: true },
  { host: "localhost", allowed: true },
  { host: "[::1]", allowed: true },
  { host: "100.64.0.1", allowed: true },
  { host: "100.127.255.255", allowed: true },
  { host: "100.63.255.255", allowed: false },
  { host: "100.128.0.0", allowed: false },
  { host: "10.0.0.1", allowed: false },
  { host: "192.168.1.1", allowed: false },
  { host: "example.test", allowed: false },
])(
  "enforces CTO host policy for $host (allowed=$allowed)",
  Effect.fnUntraced(function* ({ host, allowed }) {
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      requests.push(String(url));
      return new Response('{"synthetic":true}');
    };
    const response = yield* result(
      client.status({ context: "Dimaggi", enabled: true, baseUrl: `http://${host}:9093` }),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    if (allowed) {
      expect(response).toMatchObject({ _tag: "Success", success: { synthetic: true } });
      expect(requests).toEqual([`http://${host}:9093/api/status`]);
    } else {
      expect(response).toMatchObject({ _tag: "Failure", failure: { reason: "configuration" } });
      expect(requests).toEqual([]);
    }
  }),
);

it.effect(
  "allows a remote CTO host only with an explicit override",
  Effect.fnUntraced(function* () {
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      requests.push(String(url));
      return new Response('{"synthetic":true}');
    };
    const input = {
      context: "Dimaggi",
      enabled: true,
      baseUrl: "https://example.test",
      allowRemoteHost: true,
    };
    expect(
      yield* client.status(input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).toEqual({ synthetic: true });
    expect(requests).toEqual(["https://example.test/api/status"]);
  }),
);
