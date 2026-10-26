import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Probe from "./SystemProbe.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
const host = vi.hoisted(() => ({
  calls: 0,
  missing: false,
  updateCalls: 0,
  updateExit: 2,
  updateOutput: "",
  doctor: null as string | null,
  doctorMtime: 0,
  doctorFailure: false,
}));
vi.mock("node:child_process", () => ({
  execFile: (
    command: string,
    args: ReadonlyArray<string>,
    _options: unknown,
    callback: (error: (Error & { code?: number }) | null, output: string) => void,
  ) => {
    if (command === "checkupdates") {
      host.updateCalls++;
      callback(
        host.updateExit
          ? Object.assign(new Error("checkupdates failed"), { code: host.updateExit })
          : null,
        host.updateOutput,
      );
      return;
    }
    assert.equal(command, "systemctl");
    assert.include(args, "--failed");
    host.calls++;
    callback(host.missing ? new Error("unavailable") : null, '[{"unit":"private-unit.service"}]');
  },
}));
vi.mock("node:fs/promises", () => ({
  statfs: async () => ({ blocks: 1000, bavail: 50 }),
  stat: async () => {
    if (host.doctorFailure) throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (host.doctor === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { size: host.doctor.length, mtimeMs: host.doctorMtime };
  },
  readFile: async () => host.doctor,
}));
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
      assert.equal(host.calls, 2);
      assert.equal(checks[0]?.find((entry) => entry.id === "user-units")?.status, "attention");
      assert.isFalse(checks[0]!.some((entry) => entry.reportKey.includes("private-unit")));
      assert.equal(checks[0]?.find((entry) => entry.id === "data-disk")?.value, 95);
      yield* TestClock.adjust("31 seconds");
      yield* service.check(90);
      assert.equal(host.calls, 4);
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

it.effect("failed system units are checked independently of user units", () =>
  Effect.gen(function* () {
    host.missing = false;
    const checks = yield* (yield* Probe.SystemProbe).check(90);
    const check = checks.find((entry) => entry.id === "system-units");
    assert.equal(check?.status, "attention");
    assert.equal(check?.value, 1);
    assert.equal(check?.title, "1 failed system units");
  }).pipe(Effect.provide(layer)),
);
it.effect("checkupdates exit 2 means no updates and results cache for six hours", () =>
  Effect.gen(function* () {
    host.updateCalls = 0;
    host.updateExit = 2;
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.status, "ok");
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.value, 0);
    yield* TestClock.adjust("5 hours");
    yield* service.check(90);
    assert.equal(host.updateCalls, 1);
    yield* TestClock.adjust("1 hour");
    checks = yield* service.check(90);
    assert.equal(host.updateCalls, 2);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.value, 0);
  }).pipe(Effect.provide(layer)),
);
it.effect("OS update severity distinguishes normal and critical packages", () =>
  Effect.gen(function* () {
    host.updateExit = 0;
    host.updateOutput = "curl 1 -> 2\n";
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.status, "info");
    host.updateOutput = "linux 1 -> 2\nnvidia-utils 1 -> 2\n";
    yield* TestClock.adjust("6 hours");
    checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.status, "attention");
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.title, "2 OS updates pending");
  }).pipe(Effect.provide(layer)),
);
it.effect("failed or malformed OS update probes remain unknown", () =>
  Effect.gen(function* () {
    host.updateExit = 1;
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.status, "unavailable");
    host.updateExit = 0;
    host.updateOutput = "unexpected output";
    yield* TestClock.adjust("6 hours");
    checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "os-updates")?.status, "unavailable");
  }).pipe(Effect.provide(layer)),
);
it.effect("missing and stale doctor snapshots are informative, never healthy", () =>
  Effect.gen(function* () {
    host.doctorFailure = false;
    host.doctor = null;
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.title, "doctor results stale");
    assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "info");
    host.doctor = JSON.stringify([{ status: "OK" }]);
    host.doctorMtime = 0;
    yield* TestClock.adjust("27 hours");
    checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.title, "doctor results stale");
    assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "info");
  }).pipe(Effect.provide(layer)),
);
it.effect("doctor failures require attention while warnings are informational", () =>
  Effect.gen(function* () {
    host.doctorFailure = false;
    host.doctor = JSON.stringify({
      generatedAt: "1970-01-01T00:00:00.000Z",
      results: [{ status: "WARN" }],
    });
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "info");
    host.doctor = JSON.stringify([{ status: "FAIL" }, { status: "WARN" }]);
    host.doctorMtime = 0;
    yield* TestClock.adjust("31 seconds");
    checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "attention");
    assert.equal(
      checks.find((entry) => entry.id === "doctor")?.title,
      "doctor: 1 failures, 1 warnings",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("invalid and unreadable doctor snapshots remain unknown", () =>
  Effect.gen(function* () {
    host.doctorFailure = false;
    host.doctor = "invalid json";
    const service = yield* Probe.SystemProbe;
    let checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "unavailable");
    host.doctorFailure = true;
    yield* TestClock.adjust("31 seconds");
    checks = yield* service.check(90);
    assert.equal(checks.find((entry) => entry.id === "doctor")?.title, "doctor results unknown");
    host.doctorFailure = false;
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "fresh successful doctor results are healthy, empty or future snapshots are unknown",
  () =>
    Effect.gen(function* () {
      host.doctorFailure = false;
      host.doctorMtime = 0;
      host.doctor = JSON.stringify([{ status: "OK" }]);
      const service = yield* Probe.SystemProbe;
      let checks = yield* service.check(90);
      assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "ok");
      host.doctor = "[]";
      yield* TestClock.adjust("31 seconds");
      checks = yield* service.check(90);
      assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "unavailable");
      host.doctor = JSON.stringify({
        generatedAt: "2999-01-01T00:00:00.000Z",
        results: [{ status: "OK" }],
      });
      yield* TestClock.adjust("31 seconds");
      checks = yield* service.check(90);
      assert.equal(checks.find((entry) => entry.id === "doctor")?.status, "unavailable");
    }).pipe(Effect.provide(layer)),
);
