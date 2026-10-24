import type { ProviderRoute } from "@d4research/contracts";

export interface RecentRouteOutcome {
  readonly latencyMs: number | null;
  readonly outcome: string;
  readonly timeout: boolean;
}

// Fixed precedence and thresholds make a decision reproducible from its inputs.
export function localRouteReason(input: {
  readonly taskMode: "text" | "tools";
  readonly hasAttachments: boolean;
  readonly available: boolean;
  readonly health: ProviderRoute["health"];
  readonly contextTokens: number;
  readonly contextWindowTokens: number;
  readonly recent: ReadonlyArray<RecentRouteOutcome>;
}): ProviderRoute["reason"] {
  if (input.taskMode === "tools" || input.hasAttachments) return "task_requires_tools";
  if (!input.available) return "local_unavailable";
  if (input.contextTokens + 4096 > input.contextWindowTokens) return "context_pressure";
  if (input.health !== "healthy") return "endpoint_unhealthy";
  const samples = input.recent.filter(
    (row) => row.outcome === "completed" || row.outcome === "failed",
  );
  if (samples.length >= 3) {
    if (samples.filter((row) => row.timeout).length / samples.length >= 0.25)
      return "recent_timeouts";
    if (samples.filter((row) => row.outcome === "failed").length / samples.length >= 0.5)
      return "recent_errors";
    const latencies = samples
      .flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))
      .toSorted((a, b) => a - b);
    if (latencies.length >= 3 && latencies[Math.ceil(latencies.length * 0.9) - 1]! > 60_000)
      return "recent_latency";
  }
  return "local_healthy";
}
