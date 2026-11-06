import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostResources } from "./HostResources.ts";
import { SystemMonitor, layer } from "./SystemMonitor.ts";

it.effect(
  "uses measured utilization and available memory without inventing unsupported metrics",
  () =>
    Effect.gen(function* () {
      const monitor = yield* SystemMonitor;
      const snapshot = yield* monitor.read;
      assert.equal(snapshot.cpu.overall, 25);
      assert.equal(snapshot.mem.pct, 60);
      assert.equal(snapshot.mem.available, 400);
      assert.equal(snapshot.mem.swap_pct, null);
      assert.equal(snapshot.procsum, null);
      assert.deepEqual(snapshot.procs, []);
      assert.isAbove(snapshot.uptime, 0);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.succeed(HostResources, {
              read: Effect.succeed({
                sampledAt: 0,
                cpuUtilization: 0.25,
                cpuCount: 8,
                totalMemoryBytes: 1000 * 1024,
                availableMemoryBytes: 400 * 1024,
              }),
            }),
          ),
        ),
      ),
    ),
);
