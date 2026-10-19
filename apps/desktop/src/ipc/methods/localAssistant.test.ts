import { describe, it, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import { localAssistantGenerate, localAssistantCancel } from "./localAssistant.ts";

describe("local assistant IPC", () => {
  it.effect("allows only the requesting window to cancel and closes its native process scope", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      const layer = Layer.mergeAll(
        Path.layer,
        Layer.mock(ElectronApp.ElectronApp, {
          metadata: Effect.succeed({
            appVersion: "0.2.0",
            appPath: "/app",
            isPackaged: true,
            resourcesPath: "/app/resources",
            runningUnderArm64Translation: false,
          }),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed = true;
                }),
              );
              yield* Deferred.succeed(started, undefined);
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.never,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
            }),
          ),
        ),
      );
      const pending = yield* localAssistantGenerate
        .handler(
          { requestId: "one", instructions: "Summarize", input: "A note" },
          { sender: { id: 10 } },
        )
        .pipe(Effect.provide(layer), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* localAssistantCancel.handler("one", { sender: { id: 20 } });
      expect(closed).toBe(false);
      yield* localAssistantCancel.handler("one", { sender: { id: 10 } });
      expect(yield* Fiber.join(pending)).toEqual({
        available: false,
        error: "Generation cancelled.",
      });
      expect(closed).toBe(true);
    }),
  );
});
