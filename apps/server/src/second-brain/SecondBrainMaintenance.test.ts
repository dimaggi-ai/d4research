import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
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
      yield* Layer.build(Maintenance.layer.pipe(Layer.provide(scheduler)));
      expect(names).toEqual(["second-brain"]);
      const service = yield* Service.SecondBrainService;
      expect((yield* service.status()).notes).toBe(1);
    }),
  ),
);
