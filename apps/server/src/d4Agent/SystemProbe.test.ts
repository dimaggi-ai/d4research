import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Probe from "./SystemProbe.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
const host = vi.hoisted(() => ({ calls: 0, missing: false }));
vi.mock("node:child_process", () => ({
  execFile: (
    _command: string,
    _args: ReadonlyArray<string>,
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    host.calls++;
    callback(host.missing ? new Error("unavailable") : null, '[{"unit":"private-unit.service"}]');
  },
}));
vi.mock("node:fs/promises", () => ({ statfs: async () => ({ blocks: 1000, bavail: 50 }) }));
const layer = Probe.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Config.layerTest(process.cwd(), { prefix: "d4-probe-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Sqlite.layerMemory,
    ),
  ),
);
it.effect(
  "probe is single-flight cached across clients and keeps unit names out of report keys",
  () =>
    Effect.gen(function* () {
      host.calls = 0;
      host.missing = false;
      const service = yield* Probe.SystemProbe;
      const checks = yield* Effect.all(
        Array.from({ length: 10 }, () => service.check(90)),
        { concurrency: 10 },
      );
      assert.equal(host.calls, 1);
      assert.equal(checks[0]?.find((entry) => entry.id === "user-units")?.status, "attention");
      assert.isFalse(checks[0]!.some((entry) => entry.reportKey.includes("private-unit")));
      assert.equal(checks[0]?.find((entry) => entry.id === "data-disk")?.value, 95);
      yield* TestClock.adjust("31 seconds");
      yield* service.check(90);
      assert.equal(host.calls, 2);
    }).pipe(Effect.provide(layer)),
);
it.effect("missing systemctl reports unavailable while disk and server checks continue", () =>
  Effect.gen(function* () {
    host.missing = true;
    const service = yield* Probe.SystemProbe;
    const checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "user-units")?.status, "unavailable");
    assert.equal(checks.find((entry) => entry.id === "root-disk")?.status, "attention");
    assert.equal(checks.find((entry) => entry.id === "server")?.status, "ok");
  }).pipe(Effect.provide(layer)),
);
