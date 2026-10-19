import { it, expect } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as CaptureReactor from "./SecondBrainCaptureReactor.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Service from "./SecondBrainService.ts";
import * as Maintenance from "./SecondBrainMaintenance.ts";
import { withBrain } from "./testkit.ts";

it.effect("registers due work that reconciles the configured vault", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${root}/a.md`, "# A");
      const names: string[] = [];
      const scheduler = Layer.mock(Scheduler.Scheduler)({
        register: (name, run) => {
          names.push(name);
          return run.pipe(Effect.orDie);
        },
      });
      yield* Layer.build(
        Maintenance.layer.pipe(
          Layer.provide(
            Layer.merge(
              scheduler,
              Layer.mock(CaptureReactor.SecondBrainCaptureReactor)({ retry: () => Effect.void }),
            ),
          ),
        ),
      );
      expect(names).toEqual(["second-brain"]);
      const service = yield* Service.SecondBrainService;
      expect((yield* service.status()).notes).toBe(1);
    }),
  ),
);

it.effect("scheduler ticks skip service work before the configured interval", () =>
  withBrain(
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* Service.SecondBrainService;
        const original = service.reconcile;
        const mocked = {
          ...service,
          reconcile: () =>
            Effect.suspend(() => {
              calls++;
              return original();
            }),
        };
        yield* Layer.build(
          Maintenance.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Service.SecondBrainService, mocked),
                Layer.mock(CaptureReactor.SecondBrainCaptureReactor)({ retry: () => Effect.void }),
                Layer.mock(Scheduler.Scheduler)({
                  register: (_name, run) =>
                    Effect.gen(function* () {
                      yield* run.pipe(Effect.orDie);
                      yield* run.pipe(Effect.orDie);
                      expect(calls).toBe(1);
                      yield* TestClock.adjust("61 seconds");
                      yield* run.pipe(Effect.orDie);
                      expect(calls).toBe(2);
                    }),
                }),
              ),
            ),
          ),
        );
      }),
    { reconcileIntervalSeconds: 60 },
  ),
);
