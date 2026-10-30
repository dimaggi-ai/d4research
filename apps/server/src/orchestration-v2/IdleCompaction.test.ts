import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompaction from "./IdleCompaction.ts";

const dependencies = Layer.merge(
  SqlitePersistence.layerMemory,
  ServerSettings.layerTest({ idleCompactionEnabled: true }),
);
const testLayer = IdleCompaction.layer.pipe(Layer.provideMerge(dependencies));
const threadId = ThreadId.make("compact-test");
const projectId = ProjectId.make("project");
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const seed = Effect.fn(function* (driver: "claudeAgent" | "codex") {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: threadId,
    project_id: "project",
    title: "Compaction test",
    default_provider: driver,
    provider_instance_id: driver,
    runtime_mode: "full-access",
    interaction_mode: "default",
    active_provider_thread_id: "provider",
    created_at: now,
    updated_at: now,
    payload_json: "{}",
  })}`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
    provider_thread_id: "provider",
    thread_id: threadId,
    provider: driver,
    driver,
    provider_instance_id: driver,
    status: "idle",
    updated_at: now,
    payload_json: json({
      contextUsage: { usedTokens: 400000 },
      pendingBackgroundTasks: [],
    }),
  })}`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
    run_id: "run",
    thread_id: threadId,
    ordinal: 1,
    provider: driver,
    provider_instance_id: driver,
    provider_thread_id: "provider",
    status: "completed",
    requested_at: now,
    completed_at: now,
    payload_json: json({ userMessageId: "message" }),
  })}`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
    message_id: "message",
    thread_id: threadId,
    run_id: "run",
    role: "user",
    streaming: 0,
    created_at: now,
    updated_at: now,
    payload_json: json({ text: "Do some work" }),
  })}`;
});

it.effect.each(["claudeAgent", "codex"] as const)(
  "%s: native background work can continue; strict mode still waits",
  (driver) =>
    Effect.gen(function* () {
      yield* seed(driver);
      const sql = yield* SqlClient.SqlClient;
      const policy = yield* IdleCompaction.IdleCompaction;
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(yield* policy.due()).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      const now = DateTime.formatIso(yield* DateTime.now);
      // Fresh background output must not restart the parent's idle timer.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET updated_at = ${now},
        payload_json = ${json({
          contextUsage: { usedTokens: 400000 },
          pendingBackgroundTasks: [
            { taskId: "task", kind: driver === "claudeAgent" ? "monitor" : "command" },
          ],
        })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: "command",
        thread_id: threadId,
        run_id: "run",
        provider_thread_id: "provider",
        ordinal: 1,
        type: "command_execution",
        status: "running",
        updated_at: now,
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents ${sql.insert({
        subagent_id: "child",
        thread_id: threadId,
        run_id: "run",
        parent_node_id: "root",
        provider: driver,
        driver,
        provider_instance_id: driver,
        origin: "provider_native",
        status: "running",
        updated_at: now,
        payload_json: "{}",
      })}`;
      expect(yield* policy.due(threadId)).toEqual([{ threadId, runId: "run" }]);
      yield* settings.updateSettings({ idleCompactionAllowBackgroundWork: false });
      expect(yield* policy.due()).toEqual([]);
      yield* settings.updateSettings({ idleCompactionAllowBackgroundWork: true });
      // A missing process must not be restarted with an old task roster.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET status = 'not_loaded'`;
      expect(yield* policy.due()).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET status = 'idle'`;
      yield* sql`UPDATE orchestration_v2_projection_subagents SET origin = 'app_owned'`;
      expect(yield* policy.due()).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_subagents SET origin = 'provider_native'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
        payload_json = '{"toolName":"external_monitor"}'`;
      expect(yield* policy.due()).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed'`;
      expect(yield* policy.due()).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
        ${json({ contextUsage: { usedTokens: 400000 }, pendingBackgroundTasks: [{ taskId: "unknown" }] })}`;
      expect(yield* policy.due()).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["claudeAgent", "codex"] as const)(
  "%s: idle timeout uses current native turn usage instead of a stale handoff snapshot",
  (driver) =>
    Effect.gen(function* () {
      yield* seed(driver);
      const sql = yield* SqlClient.SqlClient;
      const policy = yield* IdleCompaction.IdleCompaction;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = ${json({
        nativeThreadRef: { nativeId: "native" },
        contextUsage: { usedTokens: 10000 },
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: "attempt",
        thread_id: threadId,
        run_id: "run",
        attempt_ordinal: 1,
        root_node_id: "root",
        provider: driver,
        provider_instance_id: driver,
        provider_thread_id: "provider",
        status: "completed",
        payload_json: json({ nativeThreadId: "native" }),
      })}`;
      const usage = (usedTokens: number) => json({ tokenUsage: { usedTokens, updatedAt: now } });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
        provider_turn_id: "turn",
        thread_id: threadId,
        provider_thread_id: "provider",
        node_id: "root",
        run_attempt_id: "attempt",
        ordinal: 1,
        status: "completed",
        payload_json: usage(400000),
      })}`;
      expect(yield* policy.due()).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      expect(yield* policy.due()).toEqual([{ threadId, runId: "run" }]);
      // Codex can report live usage without a thread-level snapshot at all.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
        ${json({ nativeThreadRef: { nativeId: "native" } })}`;
      expect(yield* policy.due()).toHaveLength(1);
      // A stale large snapshot must not compact an already small context.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
        ${json({ nativeThreadRef: { nativeId: "native" }, contextUsage: { usedTokens: 500000 } })}`;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json = ${usage(10000)}`;
      expect(yield* policy.due()).toEqual([]);
      // A report from a different native session must not replace this snapshot.
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
        ${json({ nativeThreadRef: { nativeId: "other-native" }, contextUsage: { usedTokens: 10000 } })}`;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET payload_json = ${usage(400000)}`;
      expect(yield* policy.due()).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
        ${json({ nativeThreadRef: { nativeId: "native" }, contextUsage: { usedTokens: 10000 } })}`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"/compact"}'`;
      yield* TestClock.adjust("5 minutes");
      expect(yield* policy.due()).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("project overrides control enablement, background work, timeout, and tokens", () =>
  Effect.gen(function* () {
    yield* seed("claudeAgent");
    const policy = yield* IdleCompaction.IdleCompaction;
    const settings = yield* ServerSettings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    yield* settings.updateSettings({
      idleCompactionEnabled: false,
      projectSettingsOverrides: {
        [projectId]: {
          idleCompactionEnabled: true,
          idleCompactionMinutes: 10,
          idleCompactionTokens: 500000,
        },
      },
    });
    yield* TestClock.adjust("10 minutes");
    expect(yield* policy.due()).toEqual([]);
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: {
          idleCompactionEnabled: true,
          idleCompactionMinutes: 11,
          idleCompactionTokens: 400000,
        },
      },
    });
    expect(yield* policy.due()).toEqual([]);
    yield* TestClock.adjust("1 minute");
    expect(yield* policy.due()).toHaveLength(1);
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json =
      ${json({ contextUsage: { usedTokens: 400000 }, pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }] })}`;
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { idleCompactionEnabled: true, idleCompactionAllowBackgroundWork: false },
      },
    });
    expect(yield* policy.due()).toEqual([]);
    // Removing the project override inherits the global background-work value.
    yield* settings.updateSettings({
      projectSettingsOverrides: { [projectId]: { idleCompactionEnabled: true } },
    });
    expect(yield* policy.due()).toHaveLength(1);
    yield* settings.updateSettings({ projectSettingsOverrides: { [projectId]: {} } });
    expect(yield* policy.due()).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("active work, questions, queued turns, and consecutive compactions remain blocked", () =>
  Effect.gen(function* () {
    yield* seed("codex");
    yield* TestClock.adjust("5 minutes");
    const sql = yield* SqlClient.SqlClient;
    const policy = yield* IdleCompaction.IdleCompaction;
    expect(yield* policy.due()).toHaveLength(1);
    for (const status of ["running", "waiting", "queued", "failed", "interrupted"]) {
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status}`;
      expect(yield* policy.due()).toEqual([]);
    }
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests ${sql.insert({
      runtime_request_id: "question",
      thread_id: threadId,
      node_id: "root",
      kind: "user_input",
      status: "pending",
      created_at: DateTime.formatIso(yield* DateTime.now),
      payload_json: "{}",
    })}`;
    expect(yield* policy.due()).toEqual([]);
    yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'answered'`;
    expect(yield* policy.due()).toHaveLength(1);
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"/compact"}'`;
    expect(yield* policy.due()).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "strict mode counts idle time from background completion and requires reported usage",
  () =>
    Effect.gen(function* () {
      yield* seed("claudeAgent");
      const policy = yield* IdleCompaction.IdleCompaction;
      const settings = yield* ServerSettings.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* settings.updateSettings({ idleCompactionAllowBackgroundWork: false });
      yield* TestClock.adjust("5 minutes");
      const finished = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET updated_at = ${finished}`;
      expect(yield* policy.due()).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      expect(yield* policy.due()).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'`;
      expect(yield* policy.due()).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "native subagent items and Claude monitors are allowed, unrelated provider work is not",
  () =>
    Effect.gen(function* () {
      yield* seed("claudeAgent");
      yield* TestClock.adjust("5 minutes");
      const sql = yield* SqlClient.SqlClient;
      const policy = yield* IdleCompaction.IdleCompaction;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: "agent-item",
        thread_id: threadId,
        run_id: "run",
        provider_thread_id: "provider",
        ordinal: 1,
        type: "subagent",
        status: "running",
        updated_at: DateTime.formatIso(yield* DateTime.now),
        payload_json: json({
          origin: "provider_native",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
        }),
      })}`;
      expect(yield* policy.due()).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
      payload_json = '{"toolName":"Monitor"}'`;
      expect(yield* policy.due()).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET provider_thread_id = 'other-provider'`;
      expect(yield* policy.due()).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);
