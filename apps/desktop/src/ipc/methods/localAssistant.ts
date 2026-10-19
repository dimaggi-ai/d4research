import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const Reply = Schema.Struct({
  available: Schema.Boolean,
  text: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const Request = Schema.Struct({
  requestId: Schema.String.check(Schema.isMaxLength(100)),
  instructions: Schema.String.check(Schema.isMaxLength(2000)),
  input: Schema.String.check(Schema.isMaxLength(6000)),
});
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Request));
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply));
const gate = Semaphore.makeUnsafe(1);
const invoke = (request?: typeof Request.Type) =>
  gate
    .withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const metadata = yield* app.metadata;
          const executable = metadata.isPackaged
            ? path.join(metadata.resourcesPath, "apple-assistant", "d4-apple-assistant")
            : path.join(metadata.appPath, "resources", "apple-assistant", "d4-apple-assistant");
          const payload = request ? yield* encodeRequest(request) : "";
          const handle = yield* spawner.spawn(
            ChildProcess.make(executable, request ? ["--generate"] : [], {
              stdin: Stream.encodeText(Stream.make(payload)),
              stdout: "pipe",
              stderr: "ignore",
              forceKillAfter: "2 seconds",
            }),
          );
          const [stdout, code] = yield* Effect.all(
            [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
            { concurrency: "unbounded" },
          );
          if (code !== 0)
            return { available: false, error: "The on-device assistant could not start." };
          return yield* decodeReply(stdout);
        }),
      ),
    )
    .pipe(
      Effect.timeout("120 seconds"),
      Effect.orElseSucceed(() => ({
        available: false,
        error: "The on-device assistant is unavailable or timed out. Your source is unchanged.",
      })),
    );
export const localAssistantStatus = makeIpcMethod({
  channel: "local-assistant:status",
  payload: Schema.Void,
  result: Reply,
  handler: () => invoke(),
});
const cancellations = new Map<string, Deferred.Deferred<void>>();
export const localAssistantGenerate = makeIpcMethod({
  channel: "local-assistant:generate",
  payload: Request,
  result: Reply,
  handler: (request, event) =>
    Effect.gen(function* () {
      const key = `${event?.sender.id ?? 0}:${request.requestId}`;
      if (cancellations.has(key)) return { available: false, error: "Duplicate local request." };
      const cancelled = yield* Deferred.make<void>();
      cancellations.set(key, cancelled);
      return yield* Effect.raceFirst(
        invoke(request),
        Deferred.await(cancelled).pipe(
          Effect.as({ available: false, error: "Generation cancelled." }),
        ),
      ).pipe(Effect.ensuring(Effect.sync(() => cancellations.delete(key))));
    }),
});
export const localAssistantCancel = makeIpcMethod({
  channel: "local-assistant:cancel",
  payload: Schema.String.check(Schema.isMaxLength(100)),
  result: Schema.Void,
  handler: (id, event) =>
    Effect.gen(function* () {
      const pending = cancellations.get(`${event?.sender.id ?? 0}:${id}`);
      if (pending) yield* Deferred.succeed(pending, undefined);
    }),
});
