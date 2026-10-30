// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentMonitor from "./AgentMonitorReactor.ts";
import { measureLegacyMonitorSweep } from "./AgentMonitorReactor.legacyBenchmark.ts";

const seedMonitorBenchmark = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  yield* sql`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<693)
    INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    SELECT 'benchmark:'||n, 'benchmark', 'Synthetic thread', 'codex', 'full-access', 'default', ${now}, ${now},
      json_object('lineage', json_object('parentThreadId', NULL, 'relationshipToParent', NULL)) FROM ids`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
    SELECT 'run:'||thread_id, thread_id, 1, 'codex', 'provider:'||thread_id, 'running', ${now},
      json_object('activeAttemptId', 'attempt:'||thread_id, 'rootNodeId', 'node:'||thread_id, 'startedAt', ${now})
    FROM orchestration_v2_projection_threads`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, provider_turn_id, status, payload_json)
    SELECT 'attempt:'||thread_id, thread_id, 'run:'||thread_id, 1, 'node:'||thread_id, 'codex', 'provider:'||thread_id, 'turn:'||thread_id, 'running', json_object('startedAt', ${now}) FROM orchestration_v2_projection_threads`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json)
    SELECT 'provider:'||thread_id, thread_id, 'codex', 'session:'||thread_id, 'running', ${now}, '{}' FROM orchestration_v2_projection_threads`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id, thread_id, provider, status, updated_at, payload_json)
    SELECT 'session:'||thread_id, thread_id, 'codex', 'running', ${now}, '{}' FROM orchestration_v2_projection_threads`;
  yield* sql`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<140925)
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
    SELECT 'item:'||n, 'benchmark:'||(n%694), 'run:benchmark:'||(n%694), 'turn:benchmark:'||(n%694), n, 'command_execution', 'completed', ${now}, '{}' FROM ids`;
  yield* sql`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<140925)
    INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
    SELECT 'event:'||n, 'thread', 'benchmark:'||(n%694), n, 'turn-item.updated', ${now}, 'server', '{}', '{}', 2 FROM ids`;
});

export const runMonitorBenchmark = (includeLegacy = true) =>
  Effect.gen(function* () {
    yield* seedMonitorBenchmark;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      agentMonitor: { ...(yield* settings.getSettings).agentMonitor, enabled: true },
    });
    const monitor = yield* AgentMonitor.make;
    const started = performance.now();
    yield* monitor.sweep;
    const initialSweepMs = performance.now() - started;
    // SQLite rejects any unexpected writes during all measured unchanged sweeps.
    const sql = yield* SqlClient.SqlClient;
    const legacyEvidenceSweepMs = includeLegacy
      ? yield* Effect.gen(function* () {
          yield* sql`DROP INDEX agent_monitor_progress`;
          const elapsed = yield* measureLegacyMonitorSweep;
          yield* sql`CREATE INDEX agent_monitor_progress ON orchestration_v2_projection_turn_items(run_id, provider_turn_id, updated_at DESC)`;
          return elapsed;
        })
      : null;
    yield* sql`CREATE TRIGGER benchmark_no_projection_write BEFORE UPDATE ON orchestration_v2_projection_threads
    BEGIN SELECT RAISE(ABORT, 'unchanged sweep wrote a projection'); END`;
    yield* sql`CREATE TRIGGER benchmark_no_observation_write BEFORE INSERT ON agent_monitor_observations
    BEGIN SELECT RAISE(ABORT, 'unchanged sweep wrote an observation'); END`;
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      yield* monitor.sweep;
      samples.push(performance.now() - start);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    const snapshotStart = performance.now();
    const snapshot = yield* monitor.snapshot;
    return {
      threads: 694,
      turnItems: 140_926,
      events: 140_926,
      initialSweepMs,
      legacyEvidenceSweepMs,
      idleSweepMedianMs: sorted[10]!,
      idleSweepP95Ms: sorted[18]!,
      idleSweepMaxMs: sorted[19]!,
      snapshotMs: performance.now() - snapshotStart,
      snapshotReports: snapshot.length,
      idleSweepTargetMs: 50,
      passes: sorted[18]! < 50,
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(SqlitePersistence.layerMemory, ServerSettings.layerTest())),
  );

if (import.meta.main) {
  const benchmark = await Effect.runPromise(runMonitorBenchmark());
  process.stdout.write(`${JSON.stringify({ benchmark })}\n`);
  process.exitCode = benchmark.passes ? 0 : 1;
}
