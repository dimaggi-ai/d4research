import { sha256Hex } from "@d4research/shared/hash";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- execFile supplies a hard child-process timeout and bounded output without invoking a shell.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem does not expose filesystem capacity (statfs).
import * as NodeFSP from "node:fs/promises";
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
export const probeIds = ["user-units", "root-disk", "data-disk", "server"] as const;
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
    const unavailable = (id: D4AgentSystemCheck["id"]): D4AgentSystemCheck => ({
      notificationEligible: false,
      id,
      status: "unavailable",
      reportKey: `${id}:unavailable`,
      value: null,
    });
    const units = Effect.tryPromise({
      try: (signal) =>
        new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            "systemctl",
            ["--user", "list-units", "--failed", "--output=json", "--no-pager"],
            { timeout: 3000, maxBuffer: 128 * 1024, signal },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        }),
      catch: () => undefined,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(UnitRows))),
      Effect.map((rows): D4AgentSystemCheck => ({
        notificationEligible: false,
        id: "user-units",
        status: rows.length > 0 ? "attention" : "ok",
        reportKey: `user-units:${sha256Hex(
          rows
            .map((row) => row.unit)
            .sort()
            .join("\n"),
        )}`,
        value: rows.length,
      })),
      Effect.catch(() => Effect.succeed(unavailable("user-units"))),
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
                units,
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
