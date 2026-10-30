// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import {
  AgentMonitorError,
  AgentMonitorReport,
  type AgentMonitorPendingRequestKind,
  type AgentMonitorRunStatus,
  type AgentMonitorSettings,
  type AgentMonitorUpdate,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@d4research/contracts";
import {
  THREAD_LIVENESS_SLOW_AFTER_MS,
  classifyThreadLiveness,
} from "@d4research/shared/threadLiveness";
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
  readonly settled: number;
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentMonitorReport));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.NullOr(AgentMonitorReport)));

function reportFor(
  row: Observation,
  now: number,
  config: AgentMonitorSettings,
): AgentMonitorReport {
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
    staleAfterMs: config.stuckAfterMinutes * 60_000,
  });
  return {
    ...classification,
    notificationEligible: false,
    attentionRequired:
      classification.attentionRequired ||
      (classification.classification === "idle" &&
        row.run_status === "completed" &&
        config.notifyClasses.includes("completed")),
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
  const updates = yield* PubSub.bounded<AgentMonitorUpdate>(1_024);
  const sweepLock = yield* Semaphore.make(1);
  const settings = yield* ServerSettings.ServerSettingsService;

  // SQL returns an allowlist of scalar evidence, never transcript or tool payloads.
  const observe = (now: number, threadId?: ThreadId) => sql<Observation>`
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
      COALESCE(json_extract(t.payload_json, '$.agentMonitorRevision'), 0) AS revision,
      json_extract(t.payload_json, '$.settledAt') IS NOT NULL AS settled
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
      ${threadId === undefined ? sql`` : sql`AND t.thread_id = ${threadId}`}
  `;

  interface Candidate {
    readonly report_key: string;
    readonly evidence_key: string | null;
    readonly episode_started_at: number;
    readonly first_seen_at: number;
    readonly last_seen_at: number;
    readonly baseline: number;
    readonly eligible_at: number | null;
  }
  interface Metadata {
    readonly thread_id: string;
    readonly sequence: number;
    readonly updated_at: string;
    readonly parent_id: string | null;
    readonly is_child: number;
    readonly sessions: string | null;
    readonly report_json: string | null;
    readonly revision: number;
  }
  interface Cached {
    fingerprint: string;
    parentId: string | null;
    row: Observation;
    report: AgentMonitorReport | null;
    candidate: Candidate | undefined;
    nextCheck: number;
  }
  const cache = new Map<string, Cached>();
  let lastClock = 0;
  let lastConfig = "";
  let nextPrune = 0;
  const metadata = (threadId?: string) => sql<Metadata>`
    SELECT t.thread_id, t.updated_at,
      COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent', 0) AS is_child,
      CASE WHEN json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        THEN json_extract(t.payload_json, '$.lineage.parentThreadId') ELSE NULL END AS parent_id,
      COALESCE((SELECT MAX(sequence) FROM orchestration_events e
        WHERE e.stream_id = t.thread_id AND e.aggregate_kind = 'thread'
        AND e.application_event_version = 2), 0) AS sequence,
      (SELECT GROUP_CONCAT(s.provider_session_id || ':' || s.status || ':' || s.updated_at)
        FROM orchestration_v2_projection_provider_sessions s WHERE s.thread_id = t.thread_id) AS sessions,
      json_extract(t.payload_json, '$.agentMonitor') AS report_json,
      COALESCE(json_extract(t.payload_json, '$.agentMonitorRevision'), 0) AS revision
    FROM orchestration_v2_projection_threads t
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
      ${threadId === undefined ? sql`` : sql`AND t.thread_id = ${threadId}`}
  `;
  const fingerprint = (row: Metadata) =>
    JSON.stringify([
      row.sequence,
      row.updated_at,
      row.parent_id,
      row.is_child,
      row.sessions,
      row.revision,
    ]);
  const safeReport = (json: string | null) =>
    json === null
      ? Effect.succeed(null)
      : decodeReport(json).pipe(Effect.catch(() => Effect.succeed(null)));
  const readCandidate = (threadId: string) =>
    sql<Candidate>`SELECT * FROM agent_monitor_observations WHERE thread_id = ${threadId}`;
  const notificationWindowMs = 300_000;
  const persistenceMs = 30_000;
  const maximumObservationGapMs = 60_000;
  const suspicious = (report: AgentMonitorReport) =>
    report.classification === "wedged" || report.classification === "suspected_stuck";
  const snapshot = Effect.gen(function* () {
    if (!(yield* settings.getSettings).agentMonitor.enabled) return [];
    const rows = yield* sql<Pick<Metadata, "thread_id" | "report_json" | "revision">>`
      SELECT thread_id, json_extract(payload_json, '$.agentMonitor') AS report_json,
        COALESCE(json_extract(payload_json, '$.agentMonitorRevision'), 0) AS revision
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'
        AND json_extract(payload_json, '$.agentMonitor') IS NOT NULL
      ORDER BY thread_id`;
    const reports = yield* Effect.forEach(rows, (row) =>
      safeReport(row.report_json).pipe(
        Effect.map((report) => ({
          threadId: ThreadId.make(row.thread_id),
          report,
          revision: row.revision,
        })),
      ),
    );
    return reports.filter((update) => update.report !== null);
  }).pipe(Effect.mapError(() => new AgentMonitorError({})));

  const rootFor = (row: Metadata, byId: Map<string, Metadata>): string | null => {
    const seen = new Set<string>();
    let current = row;
    while (current.is_child === 1) {
      if (current.parent_id === null) return null;
      if (seen.has(current.thread_id)) return null;
      seen.add(current.thread_id);
      const parent = byId.get(current.parent_id);
      if (!parent) return null;
      current = parent;
    }
    return current.thread_id;
  };
  const reportPriority = (report: AgentMonitorReport) =>
    report.classification === "needs_user"
      ? 4
      : report.attentionRequired
        ? 3
        : report.classification === "waiting_background"
          ? 2
          : report.classification === "idle"
            ? 0
            : 1;
  const rollup = (
    rows: ReadonlyArray<Observation>,
    root: string,
    now: number,
    config: AgentMonitorSettings,
  ) => {
    const own = rows.find((row) => row.thread_id === root)!;
    let report = reportFor(own, now, config);
    for (const row of rows) {
      if (row.thread_id === root) continue;
      const child = reportFor(row, now, config);
      if (
        !child.attentionRequired ||
        child.classification === "idle" ||
        reportPriority(child) <= reportPriority(report)
      )
        continue;
      report = { ...child, reportKey: JSON.stringify([row.thread_id, child.reportKey]) };
    }
    // Settling a thread is the user's acknowledgment of its state, including failed subagents.
    return own.settled === 1 ? { ...report, attentionRequired: false } : report;
  };
  const notificationsAllowed = (
    report: AgentMonitorReport,
    rows: ReadonlyArray<Observation>,
    config: AgentMonitorSettings,
  ) =>
    config.notifyClasses.includes(
      report.classification === "needs_user"
        ? rows.find((row) => row.request_id === report.pendingRequestId)?.request_kind ===
          "auth_refresh"
          ? "auth"
          : "waiting"
        : report.classification === "failed" || report.classification === "limited"
          ? "failed"
          : report.classification === "idle" && report.runStatus === "completed"
            ? "completed"
            : "stuck",
    );
  const candidateFor = (
    report: AgentMonitorReport,
    previous: AgentMonitorReport | null,
    state: Candidate | undefined,
    now: number,
    baseline: boolean,
    revision: number,
    notificationsAllowed: boolean,
  ) => {
    const same =
      state !== undefined &&
      (state.evidence_key === report.reportKey ||
        (state.evidence_key === null &&
          previous?.classification === report.classification &&
          previous.reason === report.reason &&
          previous.runId === report.runId &&
          previous.attemptId === report.attemptId &&
          previous.pendingRequestId === report.pendingRequestId));
    const continuous =
      same && now >= state.last_seen_at && now - state.last_seen_at <= maximumObservationGapMs;
    const episodeStartedAt = same ? state.episode_started_at : now;
    const firstSeenAt = same && (!suspicious(report) || continuous) ? state.first_seen_at : now;
    const isBaseline = same ? state.baseline === 1 : baseline;
    const eligibleAt =
      same && state.eligible_at !== null
        ? state.eligible_at
        : !report.attentionRequired ||
            isBaseline ||
            (suspicious(report) && now - firstSeenAt < persistenceMs)
          ? null
          : now;
    const reportKey = same
      ? state.report_key
      : JSON.stringify([report.reportKey, now, revision + 1]);
    return {
      report: {
        ...report,
        reportKey,
        notificationEligible:
          notificationsAllowed &&
          report.attentionRequired &&
          !isBaseline &&
          eligibleAt !== null &&
          now >= eligibleAt &&
          now - eligibleAt <= notificationWindowMs &&
          now - episodeStartedAt <= notificationWindowMs + persistenceMs &&
          (!suspicious(report) || (continuous && now - firstSeenAt >= persistenceMs)),
      },
      state: {
        report_key: reportKey,
        evidence_key: report.reportKey,
        episode_started_at: episodeStartedAt,
        first_seen_at: firstSeenAt,
        last_seen_at: now,
        baseline: isBaseline ? 1 : 0,
        eligible_at: eligibleAt,
      } satisfies Candidate,
    };
  };
  const reportChanged = (previous: AgentMonitorReport | null, report: AgentMonitorReport | null) =>
    previous?.reportKey !== report?.reportKey ||
    previous?.reason !== report?.reason ||
    previous?.runStatus !== report?.runStatus ||
    previous?.notificationEligible !== report?.notificationEligible ||
    previous?.attentionRequired !== report?.attentionRequired;
  const deadline = (
    rows: ReadonlyArray<Observation>,
    report: AgentMonitorReport,
    state: Candidate,
    now: number,
    config: AgentMonitorSettings,
  ) => {
    let next = Infinity;
    if (report.notificationEligible && state.eligible_at !== null)
      next = Math.min(
        state.eligible_at + notificationWindowMs + 1,
        state.episode_started_at + notificationWindowMs + persistenceMs + 1,
      );
    if (
      suspicious(report) &&
      (state.baseline === 1 ||
        now - state.episode_started_at > notificationWindowMs + persistenceMs)
    )
      return Infinity;
    if (suspicious(report))
      return Math.min(
        next,
        now + 15_000,
        state.first_seen_at + persistenceMs > now ? state.first_seen_at + persistenceMs : Infinity,
      );
    for (const row of rows) {
      if (row.run_status !== "running" && row.run_status !== "starting") continue;
      const progress = row.progress_at === null ? NaN : Date.parse(row.progress_at);
      for (const duration of [THREAD_LIVENESS_SLOW_AFTER_MS, config.stuckAfterMinutes * 60_000]) {
        if (Number.isFinite(progress) && progress + duration > now)
          next = Math.min(next, progress + duration);
      }
    }
    return next;
  };
  const persist = (
    root: Metadata,
    report: AgentMonitorReport | null,
    state: Candidate | undefined,
  ) =>
    Effect.gen(function* () {
      const revision = (yield* sql<{ revision: number }>`UPDATE agent_monitor_control
      SET revision = revision + 1 WHERE id = 1 RETURNING revision`)[0]!.revision;
      const reportJson = yield* encodeReport(report);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
      '$.agentMonitor', json(${reportJson}), '$.agentMonitorRevision', ${revision}) WHERE thread_id = ${root.thread_id}`;
      yield* sql`DELETE FROM agent_monitor_device_claims WHERE thread_id = ${root.thread_id}
      AND report_key != ${state?.report_key ?? ""}`;
      return {
        threadId: ThreadId.make(root.thread_id),
        report,
        revision,
      } satisfies AgentMonitorUpdate;
    });
  const persistCandidate = (threadId: string, state: Candidate) => sql`
    INSERT INTO agent_monitor_observations(thread_id, report_key, evidence_key, episode_started_at, first_seen_at, last_seen_at, baseline, eligible_at)
    VALUES (${threadId}, ${state.report_key}, ${state.evidence_key}, ${state.episode_started_at}, ${state.first_seen_at}, ${state.last_seen_at}, ${state.baseline}, ${state.eligible_at})
    ON CONFLICT(thread_id) DO UPDATE SET report_key=excluded.report_key, evidence_key=excluded.evidence_key,
      episode_started_at=excluded.episode_started_at, first_seen_at=excluded.first_seen_at,
      last_seen_at=excluded.last_seen_at, baseline=excluded.baseline, eligible_at=excluded.eligible_at`;

  const sweep = Effect.gen(function* () {
    const config = (yield* settings.getSettings).agentMonitor;
    let control = (yield* sql<{
      enabled: number;
      baseline_sequence: number;
    }>`SELECT enabled, baseline_sequence FROM agent_monitor_control WHERE id=1`)[0]!;
    if ((control.enabled === 1) !== config.enabled) {
      control = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = (yield* sql<{
            enabled: number;
            baseline_sequence: number;
          }>`SELECT enabled, baseline_sequence FROM agent_monitor_control WHERE id=1`)[0]!;
          if ((current.enabled === 1) === config.enabled) return current;
          const sequence = (yield* sql<{
            sequence: number;
          }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`)[0]!.sequence;
          yield* sql`UPDATE agent_monitor_control SET enabled=${config.enabled ? 1 : 0}, baseline_sequence=${sequence} WHERE id=1`;
          yield* sql`DELETE FROM agent_monitor_observations`;
          return { enabled: config.enabled ? 1 : 0, baseline_sequence: sequence };
        }),
      );
      cache.clear();
    }
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* metadata();
    const byId = new Map(rows.map((row) => [row.thread_id, row]));
    const groups = new Map<string, Metadata[]>();
    for (const row of rows) {
      const root = rootFor(row, byId);
      if (root !== null) groups.set(root, [...(groups.get(root) ?? []), row]);
    }
    const removed = [...cache.keys()].filter((id) => !byId.has(id));
    for (const id of removed) cache.delete(id);
    const configKey = [config.enabled, config.stuckAfterMinutes, ...config.notifyClasses].join(":");
    const changedConfig = lastConfig !== configKey;
    const changed = rows.filter(
      (row) =>
        config.enabled &&
        (changedConfig || cache.get(row.thread_id)?.fingerprint !== fingerprint(row)),
    );
    const lineageChanged = changed.some(
      (row) => cache.has(row.thread_id) && cache.get(row.thread_id)!.parentId !== row.parent_id,
    );
    const loaded =
      changed.length === rows.length && changed.length > 0
        ? yield* observe(now)
        : yield* Effect.forEach(changed, (row) =>
            observe(now, ThreadId.make(row.thread_id)).pipe(Effect.map((rows) => rows[0]!)),
          );
    for (const row of loaded) {
      const meta = byId.get(row.thread_id)!;
      cache.set(row.thread_id, {
        fingerprint: fingerprint(meta),
        parentId: meta.parent_id,
        row,
        report: yield* safeReport(meta.report_json),
        candidate: (yield* readCandidate(row.thread_id))[0],
        nextCheck: 0,
      });
    }
    const dirty = new Set(changed.map((row) => rootFor(row, byId)));
    if (removed.length > 0 || lineageChanged) for (const root of groups.keys()) dirty.add(root);
    for (const root of rows) {
      // Old child reports are cleared, but no child report is ever published or claimable.
      if (root.is_child === 1 || !config.enabled) {
        if (root.report_json !== null) {
          const update = yield* sql.withTransaction(persist(root, null, undefined));
          if (root.is_child === 0) yield* PubSub.publish(updates, update);
        }
        continue;
      }
      const cached = cache.get(root.thread_id)!;
      if (!dirty.has(root.thread_id) && now >= lastClock && now < cached.nextCheck) continue;
      const group = groups.get(root.thread_id)!;
      const evidence = group.map((row) => cache.get(row.thread_id)!.row);
      const raw = rollup(evidence, root.thread_id, now, config);
      if (raw.classification === "idle" && !raw.attentionRequired && root.report_json === null) {
        cached.nextCheck = Infinity;
        continue;
      }
      const { report, state } = candidateFor(
        raw,
        cached.report,
        cached.candidate,
        now,
        cached.candidate === undefined &&
          group.every((row) => row.sequence <= control.baseline_sequence),
        root.revision,
        notificationsAllowed(raw, evidence, config),
      );
      const needsReport = reportChanged(cached.report, report);
      const needsCandidate =
        !cached.candidate ||
        cached.candidate.report_key !== state.report_key ||
        cached.candidate.eligible_at !== state.eligible_at ||
        suspicious(report);
      if (needsReport || needsCandidate) {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const member of group) {
              const current = (yield* metadata(member.thread_id))[0];
              if (!current || fingerprint(current) !== fingerprint(member)) return null;
            }
            if (needsCandidate) yield* persistCandidate(root.thread_id, state);
            return { update: needsReport ? yield* persist(root, report, state) : null };
          }),
        );
        if (result === null) {
          cached.nextCheck = 0;
          continue;
        }
        if (result.update !== null) {
          cached.fingerprint = fingerprint({ ...root, revision: result.update.revision });
          yield* PubSub.publish(updates, result.update);
        }
      }
      cached.report = report;
      cached.candidate = state;
      cached.nextCheck = deadline(evidence, report, state, now, config);
    }
    if (now >= nextPrune || now < lastClock) {
      yield* sql`DELETE FROM agent_monitor_device_claims WHERE claimed_at < ${DateTime.formatIso(DateTime.makeUnsafe(now - notificationWindowMs - persistenceMs))}
        OR NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=agent_monitor_device_claims.thread_id
          AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND json_extract(t.payload_json, '$.agentMonitor.reportKey')=agent_monitor_device_claims.report_key)`;
      yield* sql`DELETE FROM agent_monitor_observations WHERE NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads t
        WHERE t.thread_id=agent_monitor_observations.thread_id AND t.deleted_at IS NULL AND t.archived_at IS NULL)`;
      nextPrune = now + notificationWindowMs;
    }
    lastConfig = configKey;
    lastClock = now;
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
          const rows = yield* metadata();
          const byId = new Map(rows.map((row) => [row.thread_id, row]));
          const root = byId.get(input.threadId);
          if (!root || root.is_child === 1 || root.report_json === null) return { claimed: false };
          const persisted = yield* safeReport(root.report_json);
          const state = (yield* readCandidate(input.threadId))[0];
          if (
            !persisted?.notificationEligible ||
            !state ||
            state.eligible_at === null ||
            now < state.eligible_at ||
            now - state.eligible_at > notificationWindowMs ||
            now - state.episode_started_at > notificationWindowMs + persistenceMs ||
            persisted.reportKey !== input.reportKey ||
            state.report_key !== input.reportKey
          )
            return { claimed: false };
          const group = rows.filter((row) => rootFor(row, byId) === root.thread_id);
          const evidence = yield* Effect.forEach(group, (row) =>
            observe(now, ThreadId.make(row.thread_id)).pipe(Effect.map((rows) => rows[0]!)),
          );
          const current = rollup(evidence, root.thread_id, now, config);
          if (
            !current.attentionRequired ||
            !notificationsAllowed(current, evidence, config) ||
            current.reportKey !== state.evidence_key ||
            (suspicious(current) &&
              (now < state.last_seen_at || now - state.last_seen_at > maximumObservationGapMs))
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
