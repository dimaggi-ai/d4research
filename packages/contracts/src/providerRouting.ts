import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ProviderRouteReason = Schema.Literals([
  "local_healthy",
  "task_requires_tools",
  "endpoint_unhealthy",
  "recent_errors",
  "recent_timeouts",
  "recent_latency",
  "context_pressure",
  "local_unavailable",
  "fallback_unavailable",
]);
export const ProviderRoute = Schema.Struct({
  source: ModelSelection,
  selected: ModelSelection,
  driver: ProviderDriverKind,
  taskMode: Schema.Literals(["text", "tools"]),
  reason: ProviderRouteReason,
  health: Schema.Literals(["healthy", "unhealthy", "unknown"]),
  decidedAt: Schema.Number,
  contextTokens: Schema.Number,
  fallbackCount: Schema.Number,
});
export type ProviderRoute = typeof ProviderRoute.Type;
