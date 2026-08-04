import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type {
  MemoryConnectorConfig,
  MemoryRecord,
  ProviderConfig,
  ResearchPlan,
  ResearchRun,
  RunMessage,
  RunEvent,
} from "./contracts";

type RunRow = {
  id: string;
  title: string;
  question: string;
  status: ResearchRun["status"];
  active_provider_id: string;
  depth: ResearchRun["depth"];
  plan_json: string | null;
  report: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type ProviderRow = {
  id: string;
  name: string;
  driver: ProviderConfig["driver"];
  model: string;
  endpoint: string;
  command: string;
  enabled: number;
};

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: RunRow): ResearchRun {
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    status: row.status,
    activeProviderId: row.active_provider_id,
    depth: row.depth,
    plan: parseJson<ResearchPlan | null>(row.plan_json, null),
    report: row.report,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ResearchDatabase {
  readonly sqlite: Database;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.sqlite = new Database(join(dataDirectory, "t3research.sqlite"), { create: true });
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.seedProviders();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        driver TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        active_provider_id TEXT NOT NULL REFERENCES providers(id),
        depth TEXT NOT NULL,
        plan_json TEXT,
        report TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        provider_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run_id_id ON run_events(run_id, id);
      CREATE TABLE IF NOT EXISTS run_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        provider_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_messages_run_id_created_at ON run_messages(run_id, created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_run_id_created_at ON memories(run_id, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tokenize='unicode61'
      );
      CREATE TABLE IF NOT EXISTS memory_connectors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (this.listMemoryConnectors().length === 0) {
      this.upsertMemoryConnector({ id: "local", name: "Local SQLite", kind: "sqlite", url: "", enabled: true });
      this.upsertMemoryConnector({ id: "memo", name: "Local Memo", kind: "memo", url: "http://host.docker.internal:8099", enabled: false });
      this.upsertMemoryConnector({ id: "meko", name: "Meko Cloud", kind: "meko", url: "https://mcp.mekodata.ai/mcp", enabled: false });
    }
  }

  private seedProviders(): void {
    if (this.listProviders().length > 0) return;
    const providers: ProviderConfig[] = [
      {
        id: "local-mock",
        name: "Local deterministic QA",
        driver: "mock",
        model: "deterministic-v1",
        endpoint: "",
        command: "",
        enabled: true,
      },
      {
        id: "ollama-local",
        name: "Ollama local",
        driver: "ollama",
        model: "gemma4-12b-sys:latest",
        endpoint: "http://host.docker.internal:11434",
        command: "",
        enabled: true,
      },
      ...(["codex", "claude", "agy", "junie"] as const).map((driver) => ({
        id: `${driver}-local`,
        name: `${driver[0]?.toUpperCase()}${driver.slice(1)} local`,
        driver,
        model: "",
        endpoint: "",
        command: driver,
        enabled: driver !== "junie",
      })),
    ];
    for (const provider of providers) this.upsertProvider(provider);
  }

  listProviders(): ProviderConfig[] {
    const rows = this.sqlite.query<ProviderRow, []>("SELECT * FROM providers ORDER BY name").all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      driver: row.driver,
      model: row.model,
      endpoint: row.endpoint,
      command: row.command,
      enabled: row.enabled === 1,
    }));
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.sqlite.query<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?").get(id);
    return row
      ? {
          id: row.id,
          name: row.name,
          driver: row.driver,
          model: row.model,
          endpoint: row.endpoint,
          command: row.command,
          enabled: row.enabled === 1,
        }
      : null;
  }

  upsertProvider(provider: ProviderConfig): void {
    const timestamp = now();
    this.sqlite
      .query(`
        INSERT INTO providers (id, name, driver, model, endpoint, command, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, driver=excluded.driver, model=excluded.model,
          endpoint=excluded.endpoint, command=excluded.command,
          enabled=excluded.enabled, updated_at=excluded.updated_at
      `)
      .run(
        provider.id,
        provider.name,
        provider.driver,
        provider.model,
        provider.endpoint,
        provider.command,
        provider.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
  }

  createRun(input: {
    title: string;
    question: string;
    providerId: string;
    depth: ResearchRun["depth"];
  }): ResearchRun {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.sqlite
      .query(`
        INSERT INTO runs
          (id, title, question, status, active_provider_id, depth, created_at, updated_at)
        VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
      `)
      .run(id, input.title, input.question, input.providerId, input.depth, timestamp, timestamp);
    this.addEvent(id, "run.created", input.providerId, input);
    return this.requireRun(id);
  }

  listRuns(): ResearchRun[] {
    return this.sqlite
      .query<RunRow, []>("SELECT * FROM runs ORDER BY updated_at DESC")
      .all()
      .map(mapRun);
  }

  getRun(id: string): ResearchRun | null {
    const row = this.sqlite.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? mapRun(row) : null;
  }

  requireRun(id: string): ResearchRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`Research run ${id} was not found.`);
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<ResearchRun, "status" | "activeProviderId" | "plan" | "report" | "error">>,
  ): ResearchRun {
    const current = this.requireRun(id);
    const next = { ...current, ...patch, updatedAt: now() };
    this.sqlite
      .query(`
        UPDATE runs SET status=?, active_provider_id=?, plan_json=?, report=?, error=?, updated_at=?
        WHERE id=?
      `)
      .run(
        next.status,
        next.activeProviderId,
        next.plan ? JSON.stringify(next.plan) : null,
        next.report,
        next.error,
        next.updatedAt,
        id,
      );
    return this.requireRun(id);
  }

  addEvent(runId: string, type: string, providerId: string | null, payload: unknown): void {
    this.sqlite
      .query("INSERT INTO run_events (run_id, type, provider_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, type, providerId, JSON.stringify(payload), now());
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.sqlite
      .query<{
        id: number;
        run_id: string;
        type: string;
        provider_id: string | null;
        payload_json: string;
        created_at: string;
      }, [string]>("SELECT * FROM run_events WHERE run_id = ? ORDER BY id")
      .all(runId);
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      providerId: row.provider_id,
      payload: parseJson(row.payload_json, null),
      createdAt: row.created_at,
    }));
  }

  addMessage(
    runId: string,
    role: RunMessage["role"],
    providerId: string | null,
    text: string,
  ): RunMessage {
    const message: RunMessage = {
      id: crypto.randomUUID(),
      runId,
      role,
      providerId,
      text,
      createdAt: now(),
    };
    this.sqlite
      .query("INSERT INTO run_messages (id, run_id, role, provider_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, runId, role, providerId, text, message.createdAt);
    return message;
  }

  listMessages(runId: string): RunMessage[] {
    return this.sqlite
      .query<{
        id: string;
        run_id: string;
        role: RunMessage["role"];
        provider_id: string | null;
        text: string;
        created_at: string;
      }, [string]>("SELECT * FROM run_messages WHERE run_id = ? ORDER BY created_at, id")
      .all(runId)
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        role: row.role,
        providerId: row.provider_id,
        text: row.text,
        createdAt: row.created_at,
      }));
  }

  remember(input: Omit<MemoryRecord, "id" | "createdAt">): MemoryRecord {
    const record: MemoryRecord = { ...input, id: crypto.randomUUID(), createdAt: now() };
    const transaction = this.sqlite.transaction(() => {
      this.sqlite
        .query("INSERT INTO memories (id, run_id, kind, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.id,
          record.runId,
          record.kind,
          record.content,
          JSON.stringify(record.metadata),
          record.createdAt,
        );
      this.sqlite
        .query("INSERT INTO memories_fts (memory_id, content) VALUES (?, ?)")
        .run(record.id, record.content);
    });
    transaction();
    return record;
  }

  searchMemory(query: string, runId: string | null, limit = 12): MemoryRecord[] {
    const normalized = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    if (!normalized) return [];
    const rows = this.sqlite
      .query<{
        id: string;
        run_id: string | null;
        kind: MemoryRecord["kind"];
        content: string;
        metadata_json: string;
        created_at: string;
      }, [string, string | null, string | null, number]>(`
        SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.memory_id
        WHERE memories_fts MATCH ? AND (? IS NULL OR m.run_id = ?)
        ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
      `)
      .all(normalized, runId, runId, limit);
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      content: row.content,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
    }));
  }

  listMemoryConnectors(): MemoryConnectorConfig[] {
    return this.sqlite
      .query<{ id: string; name: string; kind: MemoryConnectorConfig["kind"]; url: string; enabled: number }, []>(
        "SELECT id, name, kind, url, enabled FROM memory_connectors ORDER BY name",
      )
      .all()
      .map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  getMemoryConnector(id: string): MemoryConnectorConfig | null {
    return this.listMemoryConnectors().find((connector) => connector.id === id) ?? null;
  }

  upsertMemoryConnector(connector: MemoryConnectorConfig): void {
    const timestamp = now();
    this.sqlite
      .query(`
        INSERT INTO memory_connectors (id, name, kind, url, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
          url=excluded.url, enabled=excluded.enabled, updated_at=excluded.updated_at
      `)
      .run(
        connector.id,
        connector.name,
        connector.kind,
        connector.url,
        connector.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
  }
}
