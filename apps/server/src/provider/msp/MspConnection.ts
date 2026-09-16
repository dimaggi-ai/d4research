import { Deferred, Effect, Queue, Schema, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ErrorData, type MspMethod } from "./MspProtocol.ts";

export class MspRpcError extends Schema.TaggedError<MspRpcError>()("MspRpcError", {
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(ErrorData),
}) {}
export class MspTransportError extends Schema.TaggedError<MspTransportError>()(
  "MspTransportError",
  {
    message: Schema.String,
  },
) {}
const Frame = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optionalKey(ErrorData),
    }),
  ),
});
const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(Frame));
export type MspError = MspRpcError | MspTransportError;
export interface MspConnectionOptions {
  readonly stdin: Queue.Queue<Uint8Array>;
  readonly onNotification: (method: string, params: unknown) => Effect.Effect<void>;
  readonly onServerRequest: (method: string, params: unknown) => Effect.Effect<unknown, MspError>;
  readonly onStderr?: (text: string) => Effect.Effect<void>;
  readonly logger?: (event: unknown) => Effect.Effect<void>;
}

export const makeMspConnection = Effect.fn("makeMspConnection")(function* (
  handle: Pick<ChildProcessSpawner.ChildProcessHandle, "stdout" | "stderr" | "exitCode" | "kill">,
  options: MspConnectionOptions,
) {
  const scope = yield* Effect.scope;
  const pending = new Map<number, Deferred.Deferred<unknown, MspError>>();
  const ended = yield* Deferred.make<void, MspTransportError>();
  let sequence = 0;
  let closed: MspTransportError | undefined;
  const failPending = Effect.fn("MspConnection.failPending")(function* (error: MspTransportError) {
    if (closed) return;
    closed = error;
    for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
    pending.clear();
    yield* Deferred.fail(ended, error);
  });
  const write = Effect.fn("MspConnection.write")(function* (frame: unknown) {
    if (closed) return yield* closed;
    yield* options.logger?.({ direction: "outgoing", frame }) ?? Effect.void;
    const encoded = yield* encodeFrame(frame).pipe(
      Effect.mapError((error) => new MspTransportError({ message: String(error) })),
    );
    yield* Queue.offer(options.stdin, new TextEncoder().encode(`${encoded}\n`));
  });
  const respond = (
    id: string | number | null,
    result: unknown,
    error?: { code: number; message: string },
  ) => write({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
  const processLine = Effect.fn("MspConnection.processLine")(function* (line: string) {
    if (!line.trim()) return;
    const frame = yield* decodeFrame(line).pipe(
      Effect.mapError(() => new MspTransportError({ message: "Invalid MSP JSON-RPC frame." })),
    );
    yield* options.logger?.({ direction: "incoming", frame }) ?? Effect.void;
    if (frame.method) {
      if (frame.id !== undefined) {
        // Requests may issue commands of their own. Keep the response reader free.
        yield* options.onServerRequest(frame.method, frame.params).pipe(
          Effect.flatMap((result) => respond(frame.id!, result)),
          Effect.catch((error) =>
            respond(frame.id!, undefined, {
              code: error._tag === "MspRpcError" ? error.code : -32603,
              message: error.message,
            }),
          ),
          Effect.catch((error) => failPending(new MspTransportError({ message: error.message }))),
          Effect.forkIn(scope),
        );
      } else yield* options.onNotification(frame.method, frame.params);
    } else if (typeof frame.id === "number") {
      const deferred = pending.get(frame.id);
      if (!deferred) return;
      pending.delete(frame.id);
      if (frame.error) yield* Deferred.fail(deferred, new MspRpcError(frame.error));
      else yield* Deferred.succeed(deferred, frame.result);
    }
  });
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(processLine),
    Effect.catch((error) => failPending(new MspTransportError({ message: String(error) }))),
    Effect.ensuring(failPending(new MspTransportError({ message: "Muse stdout closed." }))),
    Effect.forkIn(scope),
  );
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => options.onStderr?.(text) ?? Effect.void),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* handle.exitCode.pipe(
    Effect.flatMap((code) =>
      failPending(new MspTransportError({ message: `Muse exited with code ${code}.` })),
    ),
    Effect.catch((error) => failPending(new MspTransportError({ message: String(error) }))),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    failPending(new MspTransportError({ message: "Muse connection closed." })),
  );
  const request = Effect.fn("MspConnection.request")(function* (
    method: MspMethod,
    params: unknown,
  ) {
    const id = ++sequence;
    const deferred = yield* Deferred.make<unknown, MspError>();
    pending.set(id, deferred);
    return yield* write({ jsonrpc: "2.0", id, method, params }).pipe(
      Effect.andThen(Deferred.await(deferred)),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.fail(new MspTransportError({ message: `Muse ${method} request timed out.` })),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
  });
  return {
    request,
    respond,
    notify: (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params }),
    exitCode: handle.exitCode,
    ended: Deferred.await(ended),
    close: failPending(new MspTransportError({ message: "Muse connection closed." })).pipe(
      Effect.andThen(handle.kill()),
      Effect.ignore,
    ),
  };
});
