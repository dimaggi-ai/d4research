import { sha256Hex } from "@d4research/shared/hash";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- execFile supplies a hard child-process timeout and bounded output without invoking a shell.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem does not expose filesystem capacity (statfs).
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { D4AgentSystemCheck } from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";

class DoctorReadError extends Schema.TaggedError<DoctorReadError>()("DoctorReadError", {
  cause: Schema.Defect(),
}) {}
const isDoctorReadError = Schema.is(DoctorReadError);
const DoctorRows = Schema.Array(
  Schema.Struct({ status: Schema.Literals(["OK", "WARN", "FAIL", "INFO"]) }),
);
const DoctorSnapshot = Schema.Union([
  DoctorRows,
  Schema.Struct({ generatedAt: Schema.String, results: DoctorRows }),
]);
const decodeDoctorSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DoctorSnapshot));
const updateCacheMs = 6 * 60 * 60 * 1000;
const doctorStaleMs = 26 * 60 * 60 * 1000;
const UnitRows = Schema.Array(Schema.Struct({ unit: Schema.String }));
export function diskCheck(
  id: "root-disk" | "data-disk",
  blocks: number,
  available: number,
  threshold: number,
): D4AgentSystemCheck {
  if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available) || available < 0)
    return {
      notificationEligible: false,
      id,
      status: "unavailable",
      reportKey: `${id}:unavailable`,
      value: null,
    };
  const percent = Math.min(100, Math.max(0, Math.ceil((1 - available / blocks) * 100)));
  const status = percent >= threshold ? "attention" : "ok";
  return { notificationEligible: false, id, status, reportKey: `${id}:${status}`, value: percent };
}
export const probeIds = [
  "user-units",
  "system-units",
  "root-disk",
  "data-disk",
  "server",
  "os-updates",
  "doctor",
] as const;
export const disabledChecks = (): ReadonlyArray<D4AgentSystemCheck> =>
  probeIds.map((id) => ({
    notificationEligible: false,
    id,
    status: "disabled",
    reportKey: `${id}:disabled`,
    value: null,
  }));

export class SystemProbe extends Context.Service<
  SystemProbe,
  {
    readonly check: (threshold: number) => Effect.Effect<ReadonlyArray<D4AgentSystemCheck>>;
  }
>()("d4research/d4Agent/SystemProbe") {}
export const layer = Layer.effect(
  SystemProbe,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const cache = yield* Ref.make<{
      at: number;
      threshold: number;
      checks: ReadonlyArray<D4AgentSystemCheck>;
    } | null>(null);
    const updateCache = yield* Ref.make<{ at: number; check: D4AgentSystemCheck } | null>(null);
    const unavailable = (id: D4AgentSystemCheck["id"]): D4AgentSystemCheck => ({
      notificationEligible: false,
      id,
      status: "unavailable",
      reportKey: `${id}:unavailable`,
      value: null,
    });
    const command = (executable: string, args: ReadonlyArray<string>, emptyExitCode?: number) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<string>((resolve, reject) => {
            NodeChildProcess.execFile(
              executable,
              args,
              { timeout: 3000, maxBuffer: 128 * 1024, signal },
              (error, stdout) => {
                if (error && (emptyExitCode === undefined || error.code !== emptyExitCode))
                  reject(error);
                else resolve(error ? "" : stdout);
              },
            );
          }),
        catch: () => undefined,
      });
    const units = (id: "user-units" | "system-units") =>
      command("systemctl", [
        ...(id === "user-units" ? ["--user"] : []),
        "list-units",
        "--failed",
        "--output=json",
        "--no-pager",
      ]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(UnitRows))),
        Effect.map((rows): D4AgentSystemCheck => ({
          notificationEligible: false,
          id,
          status: rows.length > 0 ? "attention" : "ok",
          title: `${rows.length} failed ${id === "user-units" ? "user" : "system"} units`,
          reportKey: `${id}:${sha256Hex(
            rows
              .map((row) => row.unit)
              .sort()
              .join("\n"),
          )}`,
          value: rows.length,
        })),
        Effect.catch(() =>
          Effect.succeed({
            ...unavailable(id),
            title: `${id === "user-units" ? "User" : "System"} units unknown`,
          }),
        ),
      );
    const updates = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = yield* Ref.get(updateCache);
      if (previous !== null && now - previous.at < updateCacheMs) return previous.check;
      const check = yield* command("checkupdates", [], 2).pipe(
        Effect.map((output): D4AgentSystemCheck => {
          const lines = output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.some((line) => !/^\S+ \S+ -> \S+$/.test(line))) {
            return { ...unavailable("os-updates"), title: "OS updates unknown" };
          }
          const packages = lines.map((line) => line.split(" ")[0]!);
          const important = packages.some((name) => /^(linux|nvidia|systemd)(?:-|$)/.test(name));
          return {
            notificationEligible: false,
            id: "os-updates",
            status: important ? "attention" : packages.length > 0 ? "info" : "ok",
            title: `${packages.length} OS updates pending`,
            reportKey: `os-updates:${sha256Hex(lines.sort().join("\n"))}`,
            value: packages.length,
          };
        }),
        Effect.catch(() =>
          Effect.succeed({ ...unavailable("os-updates"), title: "OS updates unknown" }),
        ),
      );
      yield* Ref.set(updateCache, { at: now, check });
      return check;
    });
    const doctor = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const path = `${NodeOS.homedir()}/.local/state/system-doctor/latest.json`;
      const loaded = yield* Effect.tryPromise({
        try: async (signal) => {
          const stat = await NodeFSP.stat(path);
          if (stat.size > 256 * 1024) throw new Error("Snapshot exceeds size limit");
          const content = await NodeFSP.readFile(path, { encoding: "utf8", signal });
          if (Buffer.byteLength(content) > 256 * 1024)
            throw new Error("Snapshot exceeds size limit");
          return { content, modifiedAt: stat.mtimeMs };
        },
        catch: (cause) => new DoctorReadError({ cause }),
      });
      const snapshot = yield* decodeDoctorSnapshot(loaded.content);
      const rows = "results" in snapshot ? snapshot.results : snapshot;
      const generatedAt =
        "results" in snapshot ? Date.parse(snapshot.generatedAt) : loaded.modifiedAt;
      if (rows.length === 0 || !Number.isFinite(generatedAt) || generatedAt > now) {
        return { ...unavailable("doctor"), title: "doctor results unknown" };
      }
      if (now - generatedAt > doctorStaleMs)
        return {
          notificationEligible: false,
          id: "doctor",
          status: "info",
          reportKey: "doctor:stale",
          value: null,
          title: "doctor results stale",
        } satisfies D4AgentSystemCheck;
      const failures = rows.filter((row) => row.status === "FAIL").length;
      const warnings = rows.filter((row) => row.status === "WARN").length;
      return {
        notificationEligible: false,
        id: "doctor",
        status: failures > 0 ? "attention" : warnings > 0 ? "info" : "ok",
        title: `doctor: ${failures} failures, ${warnings} warnings`,
        reportKey: `doctor:${failures}:${warnings}`,
        value: failures + warnings,
      } satisfies D4AgentSystemCheck;
    }).pipe(
      Effect.timeout("3 seconds"),
      Effect.catch((error) =>
        Effect.succeed(
          isDoctorReadError(error) &&
            error.cause instanceof Error &&
            "code" in error.cause &&
            error.cause.code === "ENOENT"
            ? ({
                notificationEligible: false,
                id: "doctor",
                status: "info",
                reportKey: "doctor:stale",
                value: null,
                title: "doctor results stale",
              } satisfies D4AgentSystemCheck)
            : { ...unavailable("doctor"), title: "doctor results unknown" },
        ),
      ),
    );
    const disk = (id: "root-disk" | "data-disk", location: string, threshold: number) =>
      Effect.tryPromise(() => NodeFSP.statfs(location)).pipe(
        Effect.timeout("3 seconds"),
        Effect.map((stat) => diskCheck(id, stat.blocks, stat.bavail, threshold)),
        Effect.catch(() => Effect.succeed(unavailable(id))),
      );
    const server = sql`SELECT 1`.pipe(
      Effect.timeout("3 seconds"),
      Effect.as<D4AgentSystemCheck>({
        notificationEligible: false,
        id: "server",
        status: "ok",
        reportKey: "server:ok",
        value: null,
      }),
      Effect.catch(() =>
        Effect.succeed({
          notificationEligible: false,
          id: "server",
          status: "attention",
          reportKey: "server:attention",
          value: null,
        } satisfies D4AgentSystemCheck),
      ),
    );
    return SystemProbe.of({
      check: (threshold) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = yield* Ref.get(cache);
            if (previous !== null && previous.threshold === threshold && now - previous.at < 30_000)
              return previous.checks;
            const checks = yield* Effect.all(
              [
                units("user-units"),
                units("system-units"),
                updates,
                doctor,
                disk("root-disk", "/", threshold),
                disk("data-disk", config.stateDir, threshold),
                server,
              ],
              { concurrency: 4 },
            );
            yield* Ref.set(cache, { at: now, threshold, checks });
            return checks;
          }),
        ),
    });
  }),
);
