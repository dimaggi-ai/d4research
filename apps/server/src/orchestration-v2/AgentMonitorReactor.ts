import {
  AgentMonitorError,
  AgentMonitorReport,
  type AgentMonitorPendingRequestKind,
  type AgentMonitorRunStatus,
  CommandId,
  EventId,
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
import * as EventSink from "./EventSink.ts";

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
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentMonitorReport));

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
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly claimAttention: (input: {
      readonly threadId: ThreadId;
      readonly reportKey: string;
    }) => Effect.Effect<{ readonly claimed: boolean }, AgentMonitorError>;
  }
>()("d4research/orchestration-v2/AgentMonitorReactor") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
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
      json_extract(t.payload_json, '$.agentMonitor') AS report_json
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

  let previouslyEnabled = true;
  const sweep = Effect.gen(function* () {
    const config = (yield* settings.getSettings).agentMonitor;
    if (!config.enabled && !previouslyEnabled) return;
    const now = yield* Clock.currentTimeMillis;
    const observations = yield* observe(now, undefined, config.enabled);
    let pendingClear = false;
    for (const row of observations) {
      if (!config.enabled && row.report_json === null) continue;
      const report = config.enabled ? reportFor(row, now) : null;
      const previous =
        report === null || row.report_json === null ? null : yield* decodeReport(row.report_json);
      if (
        report !== null &&
        previous !== null &&
        report.reportKey === previous.reportKey &&
        report.reason === previous.reason &&
        report.runStatus === previous.runStatus
      )
        continue;
      const threadId = ThreadId.make(row.thread_id);
      // Sequence fencing covers terminalization, new attempts, approval resolution and metadata edits.
      // Rejected observations can be recomputed next sweep; they never notify or mutate a run.
      const commandId = CommandId.make(`monitor:${threadId}:${row.sequence}`);
      const committed = yield* sink.commitCommand({
        commandId,
        threadId,
        commandType: "thread.monitor.report",
        expectedThreadSequence: row.sequence,
        acceptedAt: DateTime.makeUnsafe(now),
        events: [
          {
            id: EventId.make(`${commandId}:report`),
            threadId,
            type: "thread.monitor-updated",
            occurredAt: DateTime.makeUnsafe(now),
            payload: { report },
          },
        ],
        effects: [],
      });
      if (!config.enabled && !committed.committed) pendingClear = true;
    }
    previouslyEnabled = config.enabled || pendingClear;
  }).pipe(Effect.mapError(() => new AgentMonitorError({})));

  const claimAttention: AgentMonitorReactor["Service"]["claimAttention"] = (input) =>
    Effect.gen(function* () {
      const config = (yield* settings.getSettings).agentMonitor;
      if (!config.enabled || !config.notificationsEnabled) return { claimed: false };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const row = (yield* observe(now, input.threadId))[0];
          if (row === undefined || row.report_json === null) return { claimed: false };
          const persisted = yield* decodeReport(row.report_json);
          const current = reportFor(row, now);
          if (
            !current.attentionRequired ||
            current.reportKey !== input.reportKey ||
            persisted.reportKey !== input.reportKey
          )
            return { claimed: false };
          const inserted =
            yield* sql`INSERT INTO agent_monitor_notification_claims(thread_id, report_key, claimed_at)
          VALUES (${input.threadId}, ${input.reportKey}, ${DateTime.formatIso(DateTime.makeUnsafe(now))})
          ON CONFLICT(thread_id, report_key) DO NOTHING RETURNING thread_id`;
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
  return { sweep, start, claimAttention };
});

export const layer = Layer.effect(AgentMonitorReactor, make);
