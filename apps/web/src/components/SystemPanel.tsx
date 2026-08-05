import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

export const SYSTEM_MONITOR_POLL_INTERVAL_MS = 2_000;
const SYSTEM_MONITOR_URL = "/api/system-monitor";
const TOOL_GUARD_STATUS_URL = "/api/tool-guard/status";
const TOOL_GUARD_POLL_INTERVAL_MS = 30_000;

export function startSystemMonitorPolling(
  refresh: () => void,
  schedule: (callback: () => void, intervalMs: number) => number = window.setInterval,
  cancel: (timerId: number) => void = window.clearInterval,
): () => void {
  refresh();
  const timer = schedule(refresh, SYSTEM_MONITOR_POLL_INTERVAL_MS);
  return () => cancel(timer);
}

interface SystemSnapshot {
  cpu: { overall: number; load: number[]; temp: number | null };
  mem: { total: number; used: number; pct: number; available: number; swap_pct: number };
  gpu: {
    name: string;
    util: number;
    vram_used: number;
    vram_total: number;
    vram_pct: number;
    temp: number | null;
    procs: { pid: number; name: string; vram_mb: number }[];
  } | null;
  disks: { mount: string; total_gb: number; used_gb: number; pct: number }[];
  services: { name: string; active: boolean; state: string }[];
  procs: { pid: number; comm: string; cpu: number; mem: number; rss_mb: number; user: string }[];
  procsum: { total: number; running: number; threads: number };
  uptime: number;
}

interface ToolGuardSnapshot {
  integration: "managed" | "disabled" | "external" | "available" | "unavailable";
  installed: boolean;
  enabled: boolean;
  policyProfilesAvailable: boolean;
  message: string;
}

function ToolGuardMonitor({ snapshot }: { snapshot: ToolGuardSnapshot | null }) {
  return (
    <section className="mb-5 rounded-lg border border-border/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-xs font-medium">
          <ShieldCheck className="size-3.5" /> Tool Guard
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-xs",
            snapshot?.enabled
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-muted text-muted-foreground",
          )}
        >
          {snapshot?.enabled ? "enforcing" : (snapshot?.integration ?? "checking")}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {snapshot?.message ?? "Checking environment policy status..."}
      </p>
      {snapshot?.installed ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Policy profiles {snapshot.policyProfilesAvailable ? "available" : "missing"}
        </p>
      ) : null}
    </section>
  );
}

function gib(kib: number): string {
  return `${(kib / 1024 / 1024).toFixed(1)} GB`;
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function severity(value: number): string {
  if (value >= 90) return "bg-red-500";
  if (value >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function Meter(props: { label: string; value: number; detail: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{props.label}</span>
        <span className="text-muted-foreground">{props.detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", severity(props.value))}
          style={{ width: `${props.value}%` }}
        />
      </div>
    </div>
  );
}

export function SystemPanel() {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [toolGuard, setToolGuard] = useState<ToolGuardSnapshot | null>(null);
  const toolGuardReadAtRef = useRef(0);

  const refresh = useCallback(async () => {
    const now = Date.now();
    const toolGuardRequest =
      now - toolGuardReadAtRef.current >= TOOL_GUARD_POLL_INTERVAL_MS
        ? (() => {
            toolGuardReadAtRef.current = now;
            return fetch(TOOL_GUARD_STATUS_URL, {
              signal: AbortSignal.timeout(3_000),
              credentials: "include",
              cache: "no-store",
            })
              .then((response) => {
                if (!response.ok) {
                  throw new Error(`Tool Guard status returned ${response.status}`);
                }
                return response.json() as Promise<ToolGuardSnapshot>;
              })
              .then(setToolGuard)
              .catch(() => setToolGuard(null));
          })()
        : Promise.resolve();
    try {
      const response = await fetch(SYSTEM_MONITOR_URL, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`Mission Control returned ${response.status}`);
      setSnapshot((await response.json()) as SystemSnapshot);
      setError(null);
      setUpdatedAt(new Date());
    } catch {
      setError("Mission Control is unavailable. Check mission-control.service.");
    }
    await toolGuardRequest;
  }, []);

  useEffect(() => {
    return startSystemMonitorPolling(() => void refresh());
  }, [refresh]);

  if (!snapshot) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <ToolGuardMonitor snapshot={toolGuard} />
        <div className="flex flex-col items-center justify-center gap-3 text-center">
          <Activity className="size-6 text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">
            {error ?? "Loading live system status..."}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">System</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Mission Control ·{" "}
            {updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : "connecting"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh system status"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {error ? (
        <p className="mb-4 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600">{error}</p>
      ) : null}

      <ToolGuardMonitor snapshot={toolGuard} />

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/70 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="size-3.5" /> CPU
          </div>
          <Meter
            label={`${snapshot.cpu.overall}% utilization`}
            value={snapshot.cpu.overall}
            detail={`load ${snapshot.cpu.load.join(" / ")}`}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {snapshot.cpu.temp ?? "-"} C · uptime {uptime(snapshot.uptime)}
          </p>
        </div>
        <div className="rounded-lg border border-border/70 p-3">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <MemoryStick className="size-3.5" /> Memory
          </div>
          <Meter
            label={`${snapshot.mem.pct}% RAM`}
            value={snapshot.mem.pct}
            detail={`${gib(snapshot.mem.used)} / ${gib(snapshot.mem.total)}`}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {gib(snapshot.mem.available)} available · swap {snapshot.mem.swap_pct}%
          </p>
        </div>
        {snapshot.gpu ? (
          <div className="rounded-lg border border-border/70 p-3 sm:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Activity className="size-3.5" /> {snapshot.gpu.name}
              </span>
              <span>{snapshot.gpu.temp ?? "-"} C</span>
            </div>
            <Meter
              label={`${snapshot.gpu.util}% GPU`}
              value={snapshot.gpu.util}
              detail={`${snapshot.gpu.vram_used} / ${snapshot.gpu.vram_total} GB VRAM`}
            />
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {snapshot.gpu.procs.map((process) => (
                <span key={process.pid}>
                  {process.name} {Math.round(process.vram_mb)} MB
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-5">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <HardDrive className="size-3.5" /> Disks
        </h3>
        <div className="space-y-3 rounded-lg border border-border/70 p-3">
          {snapshot.disks.map((disk) => (
            <Meter
              key={disk.mount}
              label={disk.mount}
              value={disk.pct}
              detail={`${disk.used_gb} / ${disk.total_gb} GB`}
            />
          ))}
        </div>
      </section>

      <section className="mt-5">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Server className="size-3.5" /> Services
        </h3>
        <div className="flex flex-wrap gap-2 rounded-lg border border-border/70 p-3">
          {snapshot.services.map((service) => (
            <span
              key={service.name}
              className={cn(
                "rounded-full px-2 py-1 text-xs",
                service.active
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-red-500/10 text-red-600",
              )}
            >
              {service.name} · {service.state}
            </span>
          ))}
        </div>
      </section>

      <section className="mt-5">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Top processes · {snapshot.procsum.running} running / {snapshot.procsum.total}
        </h3>
        <div className="overflow-hidden rounded-lg border border-border/70">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Process</th>
                <th className="px-2 py-2 text-right font-medium">CPU</th>
                <th className="px-3 py-2 text-right font-medium">RAM</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.procs.slice(0, 10).map((process) => (
                <tr key={process.pid} className="border-t border-border/60">
                  <td className="px-3 py-2">
                    <span className="block truncate text-foreground">{process.comm}</span>
                    <span className="text-muted-foreground">
                      {process.pid} · {process.user}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">{process.cpu}%</td>
                  <td className="px-3 py-2 text-right">{process.rss_mb} MB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
