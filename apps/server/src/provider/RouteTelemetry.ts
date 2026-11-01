// @effect-diagnostics nodeBuiltinImport:off -- d4research host integration uses Node APIs directly.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not provide HMAC.
// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const reasons = [
  "local_healthy",
  "task_requires_tools",
  "endpoint_unhealthy",
  "recent_errors",
  "recent_timeouts",
  "recent_latency",
  "context_pressure",
  "local_unavailable",
  "fallback_unavailable",
] as const;
const outcomes = ["completed", "failed", "cancelled", "interrupted", "abandoned"] as const;
export type RouteReason = (typeof reasons)[number];
export type RouteOutcome = (typeof outcomes)[number];
export type RouteHealth = "healthy" | "unhealthy" | "unknown";

export interface RouteStart {
  readonly threadId: string;
  readonly runId: string;
  readonly driver: string;
  readonly instanceId: string;
  readonly model: string;
  readonly reason: RouteReason;
  readonly health: RouteHealth;
  readonly startedAt: number;
  readonly contextTokens?: number | null;
  readonly fallback?: boolean;
}

export interface RouteEnd {
  readonly endedAt: number;
  readonly outcome: RouteOutcome;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly contextTokens?: number | null;
  readonly timeout?: boolean;
}

export interface RecentRoute {
  readonly latencyMs: number | null;
  readonly outcome: RouteOutcome;
  readonly timeout: boolean;
}

export class RouteTelemetryError extends Schema.TaggedError<RouteTelemetryError>()(
  "RouteTelemetryError",
  { operation: Schema.Literals(["initialize", "start", "end", "recent"]) },
) {
  override get message(): string {
    return "Routing telemetry operation failed.";
  }
}

export class RouteTelemetry extends Context.Service<
  RouteTelemetry,
  {
    readonly recordStart: (input: RouteStart) => Effect.Effect<void, RouteTelemetryError>;
    readonly recordEnd: (
      runId: string,
      input: RouteEnd,
    ) => Effect.Effect<void, RouteTelemetryError>;
    readonly recent: (
      instanceId: string,
      model: string,
      nowMs: number,
    ) => Effect.Effect<ReadonlyArray<RecentRoute>, RouteTelemetryError>;
  }
>()("d4research/provider/RouteTelemetry") {}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isOptionalCount = (value: unknown) => value == null || isCount(value);
const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 16384;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly salt: string }>`
    SELECT salt FROM provider_route_telemetry_salt WHERE singleton = 1
  `.pipe(Effect.mapError(() => new RouteTelemetryError({ operation: "initialize" })));
  const salt = rows[0]?.salt;
  if (!salt) return yield* new RouteTelemetryError({ operation: "initialize" });
  const fingerprint = (kind: string, value: string) =>
    NodeCrypto.createHmac("sha256", salt).update(kind).update("\0").update(value).digest("hex");

  const recordStart = (input: RouteStart) =>
    Effect.gen(function* () {
      if (
        !isIdentifier(input.threadId) ||
        !isIdentifier(input.runId) ||
        !isIdentifier(input.instanceId) ||
        !isIdentifier(input.model) ||
        typeof input.driver !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(input.driver) ||
        !reasons.includes(input.reason) ||
        !["healthy", "unhealthy", "unknown"].includes(input.health) ||
        !isCount(input.startedAt) ||
        !isOptionalCount(input.contextTokens) ||
        (input.fallback !== undefined && typeof input.fallback !== "boolean")
      ) {
        return yield* new RouteTelemetryError({ operation: "start" });
      }
      // Explicit columns keep arbitrary provider metadata out of durable telemetry.
      yield* sql`
      INSERT INTO provider_route_telemetry (
        run_hash, thread_hash, driver, instance_hash, model_hash, route_reason,
        health, started_at, context_tokens, fallbacks
      ) VALUES (
        ${fingerprint("run", input.runId)}, ${fingerprint("thread", input.threadId)},
        ${input.driver}, ${fingerprint("instance", input.instanceId)},
        ${fingerprint("model", input.model)}, ${input.reason}, ${input.health},
        ${input.startedAt}, ${input.contextTokens ?? null}, ${input.fallback ? 1 : 0}
      ) ON CONFLICT(run_hash) DO NOTHING
    `;
    }).pipe(Effect.mapError(() => new RouteTelemetryError({ operation: "start" })));

  const recordEnd = (runId: string, input: RouteEnd) =>
    Effect.gen(function* () {
      if (
        !isIdentifier(runId) ||
        !isCount(input.endedAt) ||
        !outcomes.includes(input.outcome) ||
        !isOptionalCount(input.inputTokens) ||
        !isOptionalCount(input.outputTokens) ||
        !isOptionalCount(input.contextTokens) ||
        (input.timeout !== undefined && typeof input.timeout !== "boolean")
      ) {
        return yield* new RouteTelemetryError({ operation: "end" });
      }
      yield* sql`
      UPDATE provider_route_telemetry SET
        ended_at = ${input.endedAt}, latency_ms = MAX(0, ${input.endedAt} - started_at),
        outcome = ${input.outcome}, timeout = ${input.timeout ? 1 : 0},
        input_tokens = ${input.inputTokens ?? null}, output_tokens = ${input.outputTokens ?? null},
        context_tokens = COALESCE(${input.contextTokens ?? null}, context_tokens),
        failures = ${input.outcome === "failed" ? 1 : 0}
      WHERE run_hash = ${fingerprint("run", runId)} AND outcome = 'running'
    `;
    }).pipe(Effect.mapError(() => new RouteTelemetryError({ operation: "end" })));

  const recent = (instanceId: string, model: string, nowMs: number) =>
    Effect.gen(function* () {
      if (!isIdentifier(instanceId) || !isIdentifier(model) || !isCount(nowMs)) {
        return yield* new RouteTelemetryError({ operation: "recent" });
      }
      const entries = yield* sql<{
        readonly latency_ms: number | null;
        readonly outcome: RouteOutcome;
        readonly timeout: number;
      }>`
      SELECT latency_ms, outcome, timeout FROM provider_route_telemetry
      WHERE instance_hash = ${fingerprint("instance", instanceId)}
        AND model_hash = ${fingerprint("model", model)} AND outcome != 'running'
        AND ended_at >= ${Math.max(0, nowMs - 3600000)} AND ended_at <= ${nowMs}
      ORDER BY ended_at DESC, sequence DESC LIMIT 20
    `;
      return entries.map((entry) => ({
        latencyMs: entry.latency_ms,
        outcome: entry.outcome,
        timeout: entry.timeout === 1,
      }));
    }).pipe(Effect.mapError(() => new RouteTelemetryError({ operation: "recent" })));

  return RouteTelemetry.of({ recordStart, recordEnd, recent });
});

export const layer = Layer.effect(RouteTelemetry, make);
