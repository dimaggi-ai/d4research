import { it, assert } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { makeMspConnection } from "./MspConnection.ts";

const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.optionalKey(Schema.String),
      result: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const fixture = Effect.gen(function* () {
  const stdin = yield* Queue.unbounded<Uint8Array>();
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exits = yield* Deferred.make<ExitCode>();
  const notifications: string[] = [];
  const connection = yield* makeMspConnection(
    {
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
      exitCode: Deferred.await(exits),
      kill: () => Deferred.succeed(exits, ExitCode(0)).pipe(Effect.asVoid),
    },
    {
      stdin,
      onNotification: (method) =>
        Effect.sync(() => {
          notifications.push(method);
        }),
      onServerRequest: () => Effect.succeed({}),
    },
  );
  const send = (frame: unknown) =>
    encodeFrame(frame).pipe(
      Effect.flatMap((line) => Queue.offer(stdout, new TextEncoder().encode(`${line}\n`))),
    );
  const read = Queue.take(stdin).pipe(
    Effect.flatMap((bytes) => decodeFrame(new TextDecoder().decode(bytes))),
  );
  return { connection, notifications, stdout, exits, send, read };
});
it.effect("MSP correlates responses and returns RPC errors", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fiber = yield* f.connection.request("model/list", {}).pipe(Effect.forkChild);
    const request = yield* f.read;
    yield* f.send({ jsonrpc: "2.0", id: request.id, result: { models: [] } });
    assert.deepStrictEqual(yield* Fiber.join(fiber), { models: [] });
    const failed = yield* f.connection
      .request("model/list", {})
      .pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
        Effect.forkChild,
      );
    const next = yield* f.read;
    yield* f.send({
      jsonrpc: "2.0",
      id: next.id,
      error: { code: -1, message: "no", data: { kind: "notInitialized" } },
    });
    assert.equal((yield* Fiber.join(failed))?._tag, "MspRpcError");
  }).pipe(Effect.scoped),
);
it.effect("MSP preserves notification order and acknowledges server requests", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.send({ jsonrpc: "2.0", method: "first", params: {} });
    yield* f.send({ jsonrpc: "2.0", method: "second", params: {} });
    yield* f.send({ jsonrpc: "2.0", id: "host", method: "approval/request", params: {} });
    assert.deepStrictEqual(yield* f.read, { id: "host", result: {} });
    assert.deepStrictEqual(f.notifications, ["first", "second"]);
  }).pipe(Effect.scoped),
);
it.effect("MSP fails pending calls when stdout ends", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pending = yield* f.connection
      .request("model/list", {})
      .pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
        Effect.forkChild,
      );
    yield* f.read;
    yield* Queue.end(f.stdout);
    assert.equal((yield* Fiber.join(pending))?._tag, "MspTransportError");
    assert.equal(
      (yield* f.connection
        .request("model/list", {})
        .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error })))?._tag,
      "MspTransportError",
    );
  }).pipe(Effect.scoped),
);

it.effect("MSP fails pending calls on exit even if stdout remains open", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pending = yield* f.connection
      .request("model/list", {})
      .pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
        Effect.forkChild,
      );
    yield* f.read;
    yield* Deferred.succeed(f.exits, ExitCode(2));
    assert.equal((yield* Fiber.join(pending))?._tag, "MspTransportError");
  }).pipe(Effect.scoped),
);
