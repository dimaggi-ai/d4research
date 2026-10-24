import {
  AgentMonitorError,
  AgentMonitorReport,
  type AgentMonitorPendingRequestKind,
  type AgentMonitorRunStatus,
  type AgentMonitorUpdate,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@d4research/contracts";
import { classifyThreadLiveness } from "@d4research/shared/threadLiveness";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

interface Observation {
  readonly thread_id: string;
  readonly sequence: number;
  readonly run_id: string | null;
  readonly attempt_id: string | null;
  readonly run_status: AgentMonitorRunStatus | null;
  readonly request_id: string | null;
  readonly request_kind: AgentMonitorPendingRequestKind | null;
  readonly session_status: string | null;
  readonly progress_at: string | null;
  readonly failure_class: string | null;
  readonly background_count: number;
  readonly lease_expired: number;
  readonly report_json: string | null;
  readonly revision: number;
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentMonitorReport));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.NullOr(AgentMonitorReport)));

function reportFor(row: Observation, now: number): AgentMonitorReport {
  const classification = classifyThreadLiveness({
    runId: row.run_id,
    attemptId: row.attempt_id,
    runStatus: row.run_status,
    pendingRequestId: row.request_id,
    pendingRequestKind: row.request_kind,
    waitingBackground:
      row.run_status === "waiting" ||
      ((row.run_status === "completed" || row.run_status === null) && row.background_count > 0),
    // A missing session is not proof of process loss during startup or recovery.
    providerState:
      row.session_status === "error"
        ? "error"
        : row.session_status === "stopped"
          ? "absent"
          : row.session_status === "running" || row.session_status === "ready"
            ? "running"
            : "unknown",
    lastProgressAt: row.progress_at,
    now,
    leaseExpired: row.lease_expired === 1,
    leaseRenewalSupported: false,
    failureClass: row.failure_class,
  });
  return {
    ...classification,
    notificationEligible: false,
    schemaVersion: 1,
    runId: row.run_id === null ? null : RunId.make(row.run_id),
    attemptId: row.attempt_id === null ? null : RunAttemptId.make(row.attempt_id),
    pendingRequestId: row.request_id === null ? null : RuntimeRequestId.make(row.request_id),
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    runStatus: row.run_status,
  };
}

export class AgentMonitorReactor extends Context.Service<
  AgentMonitorReactor,
  {
    readonly sweep: Effect.Effect<void, AgentMonitorError>;
    readonly snapshot: Effect.Effect<ReadonlyArray<AgentMonitorUpdate>, AgentMonitorError>;
    readonly changes: Stream.Stream<AgentMonitorUpdate>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly claimAttention: (input: {
      readonly threadId: ThreadId;
      readonly reportKey: string;
      readonly clientId: string;
    }) => Effect.Effect<{ readonly claimed: boolean }, AgentMonitorError>;
  }
>()("d4research/orchestration-v2/AgentMonitorReactor") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const updates = yield* PubSub.unbounded<AgentMonitorUpdate>();
  const sweepLock = yield* Semaphore.make(1);
  const settings = yield* ServerSettings.ServerSettingsService;

  // SQL returns an allowlist of scalar evidence, never transcript or tool payloads.
  const observe = (now: number, threadId?: ThreadId, enabled = true) => sql<Observation>`
    SELECT t.thread_id,
      COALESCE((SELECT MAX(sequence) FROM orchestration_events e
        WHERE e.stream_id = t.thread_id AND e.aggregate_kind = 'thread'
        AND e.application_event_version = 2), 0) AS sequence,
      r.run_id, r.status AS run_status,
      json_extract(r.payload_json, '$.activeAttemptId') AS attempt_id,
      COALESCE(q.runtime_request_id, secret.turn_item_id) AS request_id,
      CASE WHEN q.runtime_request_id IS NOT NULL THEN q.kind
        WHEN secret.turn_item_id IS NOT NULL THEN 'user_input' ELSE NULL END AS request_kind,
      s.status AS session_status,
      COALESCE((SELECT MAX(i.updated_at) FROM orchestration_v2_projection_turn_items i
        WHERE i.run_id = r.run_id AND i.provider_turn_id = a.provider_turn_id),
        json_extract(a.payload_json, '$.startedAt'), json_extract(r.payload_json, '$.startedAt'), r.requested_at) AS progress_at,
      (SELECT json_extract(i.payload_json, '$.failure.class')
        FROM orchestration_v2_projection_turn_items i WHERE i.run_id = r.run_id
        AND i.type = 'error' AND i.status = 'failed'
        AND i.provider_turn_id = a.provider_turn_id
        AND i.node_id = json_extract(r.payload_json, '$.rootNodeId')
        ORDER BY i.updated_at DESC, i.ordinal DESC LIMIT 1) AS failure_class,
      (COALESCE(json_array_length(p.payload_json, '$.pendingBackgroundTasks'), 0)
        + EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs owner ON owner.run_id = item.run_id
          WHERE item.thread_id = t.thread_id AND item.type IN ('command_execution','dynamic_tool','subagent')
          AND item.status IN ('pending','running','waiting') AND COALESCE(owner.status, '') != 'rolled_back'
          AND NOT(item.type = 'dynamic_tool' AND COALESCE(json_extract(item.payload_json, '$.input.persistent'), 0) = 1))
        + EXISTS(SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
          WHERE json_type(link.value, '$.watch') = 'object'
          AND COALESCE(json_extract(link.value, '$.source'), '') != 'stack-dismissed')) AS background_count,
      EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox o WHERE o.thread_id = t.thread_id
        AND o.status = 'running' AND o.lease_expires_at < ${DateTime.formatIso(DateTime.makeUnsafe(now))}) AS lease_expired,
      json_extract(t.payload_json, '$.agentMonitor') AS report_json,
      COALESCE(json_extract(t.payload_json, '$.agentMonitorRevision'), 0) AS revision
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
      SELECT candidate.run_id FROM orchestration_v2_projection_runs candidate
      WHERE candidate.thread_id = t.thread_id
      ORDER BY CASE WHEN candidate.status IN ('preparing','starting','running','waiting') THEN 0 ELSE 1 END,
        candidate.ordinal DESC LIMIT 1)
    LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = json_extract(r.payload_json, '$.activeAttemptId')
    LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = COALESCE(a.provider_thread_id, r.provider_thread_id)
    LEFT JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = p.provider_session_id
    LEFT JOIN orchestration_v2_projection_runtime_requests q ON q.runtime_request_id = (
      SELECT request.runtime_request_id FROM orchestration_v2_projection_runtime_requests request
      JOIN orchestration_v2_projection_nodes node ON node.node_id = request.node_id
      WHERE request.thread_id = t.thread_id AND request.status = 'pending' AND node.run_id = r.run_id
        AND r.status IN ('preparing','starting','running','waiting')
        AND (request.provider_turn_id IS NULL OR request.provider_turn_id = a.provider_turn_id)
      ORDER BY request.created_at DESC, request.runtime_request_id DESC LIMIT 1)
    LEFT JOIN orchestration_v2_projection_turn_items secret ON secret.turn_item_id = (
      SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
      WHERE item.thread_id = t.thread_id AND item.run_id = r.run_id
        AND r.status IN ('preparing','starting','running','waiting')
        AND item.type = 'secret_request' AND item.status = 'waiting'
        AND (item.provider_turn_id IS NULL OR item.provider_turn_id = a.provider_turn_id)
      ORDER BY item.updated_at DESC, item.ordinal DESC LIMIT 1)
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
      AND (${enabled} OR json_extract(t.payload_json, '$.agentMonitor') IS NOT NULL)
      AND (${threadId ?? null} IS NULL OR t.thread_id = ${threadId ?? null})
  `;

  interface Candidate {
    readonly report_key: string;
    readonly first_seen_at: number;
    readonly last_seen_at: number;
    readonly baseline: number;
    readonly eligible_at: number | null;
  }
  const safeReport = (json: string | null) =>
    json === null
      ? Effect.succeed(null)
      : decodeReport(json).pipe(Effect.catch(() => Effect.succeed(null)));
  const readCandidate = (threadId: string) =>
    sql<Candidate>`SELECT * FROM agent_monitor_observations WHERE thread_id = ${threadId}`;
  const notificationWindowMs = 300_000;
  const persistenceMs = 30_000;
  const maximumObservationGapMs = 60_000;

  const snapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* observe(now);
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return {
          threadId: ThreadId.make(row.thread_id),
          report: yield* safeReport(row.report_json),
          revision: row.revision,
        };
      }),
    );
  }).pipe(Effect.mapError(() => new AgentMonitorError({})));

  const sweep = Effect.gen(function* () {
    const config = (yield* settings.getSettings).agentMonitor;
    const baselineSequence = yield* sql.withTransaction(
      Effect.gen(function* () {
        const control = (yield* sql<{
          enabled: number;
          baseline_sequence: number;
        }>`SELECT enabled, baseline_sequence FROM agent_monitor_control WHERE id = 1`)[0]!;
        if (!config.enabled) {
          yield* sql`UPDATE agent_monitor_control SET enabled = 0 WHERE id = 1`;
          return control.baseline_sequence;
        }
        if (control.enabled === 1) return control.baseline_sequence;
        const sequence = (yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`)[0]!.sequence;
        yield* sql`UPDATE agent_monitor_control SET enabled = 1, baseline_sequence = ${sequence} WHERE id = 1`;
        yield* sql`DELETE FROM agent_monitor_observations`;
        return sequence;
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    const observations = yield* observe(now, undefined, config.enabled);
    for (const row of observations) {
      const update = yield* sql.withTransaction(
        Effect.gen(function* () {
          // Fence both semantic events and another reactor's derived write in this transaction.
          const current = (yield* observe(now, ThreadId.make(row.thread_id), config.enabled))[0];
          if (
            !current ||
            current.sequence !== row.sequence ||
            current.report_json !== row.report_json ||
            current.revision !== row.revision
          )
            return null;
          const previous = yield* safeReport(row.report_json);
          let report = config.enabled ? reportFor(row, now) : null;
          if (report !== null && report.classification === "idle" && row.report_json === null)
            return null;
          if (report !== null) {
            const state = (yield* readCandidate(row.thread_id))[0];
            const same = state?.report_key === report.reportKey;
            const baseline = same
              ? state.baseline === 1
              : state === undefined && row.sequence <= baselineSequence;
            const suspicious =
              report.classification === "wedged" || report.classification === "suspected_stuck";
            const continuous =
              same &&
              now >= state.last_seen_at &&
              now - state.last_seen_at <= maximumObservationGapMs;
            const firstSeenAt = continuous ? state.first_seen_at : now;
            const eligibleAt =
              !report.attentionRequired ||
              baseline ||
              (suspicious && now - firstSeenAt < persistenceMs)
                ? null
                : ((same && (!suspicious || continuous) ? state.eligible_at : null) ?? now);
            report = {
              ...report,
              notificationEligible:
                eligibleAt !== null &&
                now >= eligibleAt &&
                now - eligibleAt <= notificationWindowMs,
            };
            // Only suspicious candidates need a durable heartbeat between transitions.
            if (!same || suspicious || state.eligible_at !== eligibleAt) {
              yield* sql`INSERT INTO agent_monitor_observations(thread_id, report_key, first_seen_at, last_seen_at, baseline, eligible_at)
              VALUES (${row.thread_id}, ${report.reportKey}, ${firstSeenAt}, ${now}, ${baseline ? 1 : 0}, ${eligibleAt})
              ON CONFLICT(thread_id) DO UPDATE SET report_key=excluded.report_key, first_seen_at=excluded.first_seen_at,
                last_seen_at=excluded.last_seen_at, baseline=excluded.baseline, eligible_at=excluded.eligible_at`;
            }
            if (
              previous !== null &&
              previous.reportKey === report.reportKey &&
              previous.reason === report.reason &&
              previous.runStatus === report.runStatus &&
              previous.notificationEligible === report.notificationEligible
            )
              return null;
          } else if (row.report_json === null) return null;
          const revision = (yield* sql<{
            revision: number;
          }>`UPDATE agent_monitor_control SET revision = revision + 1 WHERE id = 1 RETURNING revision`)[0]!
            .revision;
          const reportJson = yield* encodeReport(report);
          yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.agentMonitor', json(${reportJson}), '$.agentMonitorRevision', ${revision})
          WHERE thread_id = ${row.thread_id}`;
          return {
            threadId: ThreadId.make(row.thread_id),
            report,
            revision,
          } satisfies AgentMonitorUpdate;
        }),
      );
      // Derived state never enters the replay log, command receipts, or effect outbox.
      if (update !== null) yield* PubSub.publish(updates, update);
    }
  }).pipe(
    sweepLock.withPermits(1),
    Effect.mapError(() => new AgentMonitorError({})),
  );

  const claimAttention: AgentMonitorReactor["Service"]["claimAttention"] = (input) =>
    Effect.gen(function* () {
      const config = (yield* settings.getSettings).agentMonitor;
      if (!config.enabled || !config.notificationsEnabled) return { claimed: false };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const row = (yield* observe(now, input.threadId))[0];
          if (row === undefined || row.report_json === null) return { claimed: false };
          const persisted = yield* safeReport(row.report_json);
          const current = reportFor(row, now);
          const state = (yield* readCandidate(input.threadId))[0];
          if (
            !persisted?.notificationEligible ||
            !state ||
            state.eligible_at === null ||
            now < state.eligible_at ||
            now - state.eligible_at > notificationWindowMs ||
            !current.attentionRequired ||
            current.reportKey !== input.reportKey ||
            persisted.reportKey !== input.reportKey ||
            state.report_key !== input.reportKey
          )
            return { claimed: false };
          if (
            (current.classification === "wedged" || current.classification === "suspected_stuck") &&
            (now < state.last_seen_at || now - state.last_seen_at > maximumObservationGapMs)
          )
            return { claimed: false };
          const inserted =
            yield* sql`INSERT INTO agent_monitor_device_claims(thread_id, report_key, client_id, claimed_at)
            VALUES (${input.threadId}, ${input.reportKey}, ${input.clientId}, ${DateTime.formatIso(DateTime.makeUnsafe(now))})
            ON CONFLICT(thread_id, report_key, client_id) DO NOTHING RETURNING thread_id`;
          return { claimed: inserted.length === 1 };
        }),
      );
    }).pipe(Effect.mapError(() => new AgentMonitorError({})));

  const start = () =>
    forkParked(
      sweep.pipe(
        Effect.catch(() => Effect.logWarning("Agent monitor sweep failed")),
        Effect.repeat(Schedule.spaced("15 seconds")),
      ),
    );
  return { sweep, start, claimAttention, snapshot, changes: Stream.fromPubSub(updates) };
});

export const layer = Layer.effect(AgentMonitorReactor, make);
