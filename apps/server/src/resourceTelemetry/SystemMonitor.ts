// @effect-diagnostics nodeBuiltinImport:off -- Node supplies disk capacity and host uptime unavailable through Effect's filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@d4research/shared/HostProcess";
import { HostResources } from "./HostResources.ts";

const make = Effect.gen(function* () {
  const host = yield* HostResources;
  const platform = yield* HostProcess.Platform;
  const read = Effect.gen(function* () {
    const resources = yield* host.read;
    const mount = platform === "darwin" ? "/System/Volumes/Data" : "/";
    const disk = yield* Effect.tryPromise(() => NodeFSP.statfs(mount)).pipe(
      Effect.orElseSucceed(() => null),
    );
    const total = resources.totalMemoryBytes;
    const available = resources.availableMemoryBytes;
    return {
      cpu: {
        overall:
          resources.cpuUtilization === null ? null : Math.round(resources.cpuUtilization * 100),
        load: NodeOS.loadavg(),
        temp: null,
      },
      mem: {
        total: Math.round(total / 1024),
        used: Math.round((total - available) / 1024),
        available: Math.round(available / 1024),
        pct: total > 0 ? Math.round((1 - available / total) * 100) : 0,
        swap_pct: null,
      },
      disks:
        disk && disk.blocks > 0
          ? [
              {
                mount,
                total_gb: Math.round(((disk.blocks * disk.bsize) / 1024 ** 3) * 10) / 10,
                used_gb:
                  Math.round((((disk.blocks - disk.bfree) * disk.bsize) / 1024 ** 3) * 10) / 10,
                pct: Math.round((1 - disk.bfree / disk.blocks) * 100),
              },
            ]
          : [],
      gpu: null,
      services: [{ name: "d4research server", active: true, state: "running" }],
      procs: [],
      procsum: null,
      uptime: NodeOS.uptime(),
    };
  });
  return { read };
});

export class SystemMonitor extends Context.Service<SystemMonitor, Effect.Success<typeof make>>()(
  "d4research/resourceTelemetry/SystemMonitor",
) {}

export const layer = Layer.effect(SystemMonitor, make);
