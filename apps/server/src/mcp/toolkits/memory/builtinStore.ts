import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  MemoryConnectorError,
  type LocalMemoConnector,
  type MemoryEntry,
  type MemorySourceGroup,
} from "./connectors.ts";

/**
 * The zero-dependency local shared-memory store: one SQLite file inside the
 * server's state directory, searched with FTS5. This is honest keyword
 * search with BM25 ranking, not embedding similarity — for handoff context,
 * findings, and research notes that trade is fine and removes the external
 * Memo service from the critical path entirely.
 */
export const BUILTIN_MEMORY_BACKEND = "builtin-sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT,
  project TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_source_idx ON memories(source);
CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/**
 * FTS5 treats bare punctuation as syntax; quoting every whitespace-separated
 * term turns arbitrary natural-language queries into a valid OR-match without
 * inventing a query language of our own.
 */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/u)
    .map((term) => term.replaceAll('"', "").trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`);
  return terms.join(" OR ");
}

const storeError = (operation: string, cause: unknown) =>
  new MemoryConnectorError({
    connector: "local",
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

interface MemoryRow {
  readonly id: number | bigint;
  readonly text: string;
  readonly source: string | null;
  readonly project: string | null;
  readonly created_at: string;
  readonly score?: number | null;
}

interface MemorySourceGroupRow {
  readonly source: string;
  readonly project: string | null;
  readonly row_count: number | bigint;
  readonly created_at: string;
  readonly latest_text: string;
}

const rowToEntry = (row: MemoryRow): MemoryEntry => ({
  id: String(row.id),
  text: row.text,
  ...(typeof row.score === "number" ? { score: row.score } : {}),
  metadata: {
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.project === null ? {} : { project: row.project }),
    createdAt: row.created_at,
  },
});

/**
 * Opens (and migrates) the store at `dbPath`. The connector shape is the same
 * one the Memo REST client implements, so callers cannot tell the backends
 * apart — which is the point.
 */
export function makeBuiltinMemoryConnector(dbPath: string): LocalMemoConnector {
  // Opened lazily per operation: the server may run for weeks, and a handle
  // held across suspends is a corruption risk with nothing to show for it —
  // open+query on this scale is sub-millisecond.
  const withDb = <A>(
    operation: string,
    body: (db: NodeSqlite.DatabaseSync) => A,
  ): Effect.Effect<A, MemoryConnectorError> =>
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(dbPath);
        try {
          db.exec(SCHEMA_SQL);
          return body(db);
        } finally {
          db.close();
        }
      },
      catch: (cause) => storeError(operation, cause),
    });

  return {
    search: (query, k, project) =>
      withDb("search", (db) => {
        const ftsQuery = toFtsQuery(query);
        if (!ftsQuery) return { results: [] };
        const limit = Math.max(1, Math.min(k, 50));
        const rows = (project !== undefined && project.length > 0
          ? db
              .prepare(
                `SELECT m.id, m.text, m.source, m.project, m.created_at, bm25(memories_fts) AS score
                   FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                   WHERE memories_fts MATCH ? AND m.project = ?
                   ORDER BY score LIMIT ?`,
              )
              .all(ftsQuery, project, limit)
          : db
              .prepare(
                `SELECT m.id, m.text, m.source, m.project, m.created_at, bm25(memories_fts) AS score
                   FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                   WHERE memories_fts MATCH ?
                   ORDER BY score LIMIT ?`,
              )
              .all(ftsQuery, limit)) as unknown as ReadonlyArray<MemoryRow>;
        return { results: rows.map(rowToEntry) };
      }),
    searchBySource: (query, k, source, project) =>
      withDb("searchBySource", (db) => {
        const ftsQuery = toFtsQuery(query);
        if (!ftsQuery) return { results: [] };
        const limit = Math.max(1, Math.min(k, 50));
        const rows = (project !== undefined && project.length > 0
          ? db
              .prepare(
                `SELECT m.id, m.text, m.source, m.project, m.created_at, bm25(memories_fts) AS score
                   FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                   WHERE memories_fts MATCH ? AND m.source = ? AND m.project = ?
                   ORDER BY score LIMIT ?`,
              )
              .all(ftsQuery, source, project, limit)
          : db
              .prepare(
                `SELECT m.id, m.text, m.source, m.project, m.created_at, bm25(memories_fts) AS score
                   FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                   WHERE memories_fts MATCH ? AND m.source = ?
                   ORDER BY score LIMIT ?`,
              )
              .all(ftsQuery, source, limit)) as unknown as ReadonlyArray<MemoryRow>;
        return { results: rows.map(rowToEntry) };
      }),
    add: (text, source, project) =>
      DateTime.now.pipe(
        Effect.map(DateTime.formatIso),
        Effect.flatMap((createdAt) =>
          withDb("add", (db) => {
            const result = db
              .prepare(
                "INSERT INTO memories (text, source, project, created_at) VALUES (?, ?, ?, ?)",
              )
              .run(text, source ?? null, project ?? null, createdAt);
            return { ok: true, id: String(result.lastInsertRowid) };
          }),
        ),
      ),
    stats: () =>
      withDb("stats", (db) => {
        const row = db.prepare("SELECT COUNT(*) AS count FROM memories").get() as
          | { count: number | bigint }
          | undefined;
        return {
          status: "ok",
          backend: BUILTIN_MEMORY_BACKEND,
          count: Number(row?.count ?? 0),
        };
      }),
    health: () =>
      withDb("health", (db) => {
        const row = db.prepare("SELECT COUNT(*) AS count FROM memories").get() as
          | { count: number | bigint }
          | undefined;
        return {
          status: "ok",
          backend: BUILTIN_MEMORY_BACKEND,
          count: Number(row?.count ?? 0),
        };
      }),
    deleteBySource: (source, project) =>
      withDb("deleteBySource", (db) => {
        const result =
          project !== undefined && project.length > 0
            ? db
                .prepare("DELETE FROM memories WHERE source = ? AND project = ?")
                .run(source, project)
            : db.prepare("DELETE FROM memories WHERE source = ?").run(source);
        return { deleted: Number(result.changes) };
      }),
    listBySourcePrefix: (prefix, project) =>
      withDb("listBySourcePrefix", (db) => {
        const lastCharacter = prefix.charCodeAt(prefix.length - 1);
        if (prefix.length === 0 || lastCharacter === 0xffff) {
          throw new Error("Memory source prefix cannot define an indexed range.");
        }
        const prefixEnd = `${prefix.slice(0, -1)}${String.fromCharCode(lastCharacter + 1)}`;
        const rows = (project !== undefined && project.length > 0
          ? db
              .prepare(
                `SELECT grouped.source, grouped.project, grouped.row_count, grouped.created_at,
                        latest.text AS latest_text
                   FROM (
                     SELECT source, project, COUNT(*) AS row_count, MIN(created_at) AS created_at,
                            MAX(id) AS latest_id
                       FROM memories
                      WHERE source >= ? AND source < ? AND project = ?
                      GROUP BY source, project
                   ) grouped
                   JOIN memories latest ON latest.id = grouped.latest_id
                  ORDER BY grouped.created_at DESC`,
              )
              .all(prefix, prefixEnd, project)
          : db
              .prepare(
                `SELECT grouped.source, grouped.project, grouped.row_count, grouped.created_at,
                        latest.text AS latest_text
                   FROM (
                     SELECT source, project, COUNT(*) AS row_count, MIN(created_at) AS created_at,
                            MAX(id) AS latest_id
                       FROM memories
                      WHERE source >= ? AND source < ?
                      GROUP BY source, project
                   ) grouped
                   JOIN memories latest ON latest.id = grouped.latest_id
                  ORDER BY grouped.created_at DESC`,
              )
              .all(prefix, prefixEnd)) as unknown as ReadonlyArray<MemorySourceGroupRow>;
        return rows.map(
          (row): MemorySourceGroup => ({
            source: row.source,
            project: row.project,
            rowCount: Number(row.row_count),
            createdAt: row.created_at,
            latestText: row.latest_text,
          }),
        );
      }),
  };
}
