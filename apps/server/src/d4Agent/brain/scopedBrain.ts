// @effect-diagnostics-next-line nodeBuiltinImport:off -- This factory owns the synchronous, validated filesystem boundary used by the Effect-facing coordinator.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Manifest approval hashes and database identities use exact bytes.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Portable manifest paths are resolved at the filesystem boundary.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import type { D4BrainContext } from "@d4research/contracts";

const REFUSAL = "Context operation refused; inspect the selected scope configuration.";
const SourceManifest = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
});
const decodeManifest = Schema.decodeUnknownSync(SourceManifest);
const EmbedResponse = Schema.Struct({ embeddings: Schema.Array(Schema.Array(Schema.Number)) });
const decodeEmbeddings = Schema.decodeUnknownSync(EmbedResponse);
const decodeProposalStatus = Schema.decodeUnknownSync(
  Schema.Literals(["pending", "approved", "rejected"]),
);
const contexts = new Set<string>(["Global", "Personal", "YB", "Dimaggi"]);
type Scope = { root: string; context: D4BrainContext };
type Approved = { path: string; raw: Buffer; sha256: string };
type Snapshot = { rows: Approved[]; manifestHash: string; root: string };
type Embeddings = { enabled: boolean; baseUrl: string; model: string };
type Hit = { path: string; chunk: number; text: string; score: number };
type Chunk = { id: number; path: string; chunk: number; text: string };

class BoundaryError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(REFUSAL);
    this.category = category;
  }
}
const hash = (raw: string | Buffer) => NodeCrypto.createHash("sha256").update(raw).digest("hex");
const refuse = (category: string): never => {
  throw new BoundaryError(category);
};
function validateContext(context: string) {
  if (!contexts.has(context)) refuse("context");
}
function safe(root: string, relative: string) {
  if (typeof relative !== "string" || !relative.trim() || relative.includes("\0")) refuse("path");
  const segments = relative.split("/");
  // PurePosixPath removes embedded '.' before checking. This port deliberately rejects them.
  if (
    relative.startsWith("/") ||
    segments.some((p) => p === "." || p === ".." || p.startsWith(".") || p === "Archive")
  )
    refuse("path");
  const parts = segments.filter(Boolean);
  if (!parts.length) refuse("path");
  let location = root;
  for (const part of parts) {
    location = NodePath.join(location, part);
    if (NodeFS.lstatSync(location).isSymbolicLink()) refuse("symlink");
  }
  const resolved = NodeFS.realpathSync(location);
  const within = NodePath.relative(root, resolved);
  if (within === ".." || within.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(within))
    refuse("escape");
  return { location, first: parts[0] };
}
function readSafe(root: string, path: string) {
  const before = safe(root, path);
  const fd = NodeFS.openSync(
    before.location,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) refuse("file-type");
    const raw = NodeFS.readFileSync(fd);
    const after = safe(root, path);
    const final = NodeFS.statSync(after.location);
    if (final.dev !== stat.dev || final.ino !== stat.ino) refuse("changed-input");
    return raw;
  } finally {
    NodeFS.closeSync(fd);
  }
}
function approved(input: Scope, readSources = true): Snapshot {
  validateContext(input.context);
  const root = NodeFS.realpathSync(input.root);
  const manifests =
    input.context === "Global"
      ? [{ path: "Global/sources.json", prefix: "Global" }]
      : [
          { path: `${input.context}/State/sources.json`, prefix: input.context },
          { path: "Global/sources.json", prefix: "Global" },
        ];
  const rows: Approved[] = [];
  const manifestBytes: string[] = [root, input.context];
  for (const manifest of manifests) {
    const raw = readSafe(root, manifest.path);
    manifestBytes.push(manifest.path, hash(raw));
    if (raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) refuse("manifest-bom");
    const data = decodeManifest(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(raw)));
    for (const row of data.files) {
      if (!/^[0-9a-f]{64}$/.test(row.sha256)) refuse("source-entry");
      if (row.path.split("/")[0] !== manifest.prefix) refuse("source-scope");
      const content = readSources ? readSafe(root, row.path) : Buffer.alloc(0);
      if (readSources && hash(content) !== row.sha256) refuse("source-hash");
      rows.push({ path: row.path, raw: content, sha256: row.sha256 });
    }
  }
  if (new Set(rows.map((row) => row.path)).size !== rows.length) refuse("duplicate");
  return { rows, root, manifestHash: hash(JSON.stringify(manifestBytes)) };
}
function chunks(text: string) {
  const result: string[] = [];
  for (let start = 0; start < text.length; start += 1600)
    result.push(text.slice(start, start + 2000));
  return result;
}
function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) refuse("embedding-dimensions");
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
function encodeVector(vector: number[]) {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
}
function decodeVector(blob: Uint8Array) {
  const buffer = Buffer.from(blob);
  if (buffer.length % 4) refuse("embedding-data");
  return Array.from({ length: buffer.length / 4 }, (_, i) => buffer.readFloatLE(i * 4));
}

export function createScopedBrain(options: {
  stateDir: string;
  diagnostic?: (entry: { operation: string; category: string }) => void;
}) {
  const directory = NodePath.join(options.stateDir, "d4-agent", "brain");
  function run<A>(operation: string, body: () => A): A {
    try {
      return body();
    } catch (error) {
      options.diagnostic?.({
        operation,
        category: error instanceof BoundaryError ? error.category : "unavailable",
      });
      // oxlint-disable-next-line eslint/preserve-caught-error -- Public failures must omit filesystem details; the callback receives only a bounded category.
      throw new Error(REFUSAL);
    }
  }
  function database<A>(context: D4BrainContext, body: (db: NodeSqlite.DatabaseSync) => A) {
    validateContext(context);
    NodeFS.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    let location = options.stateDir;
    for (const segment of ["d4-agent", "brain"]) {
      location = NodePath.join(location, segment);
      try {
        if (NodeFS.lstatSync(location).isSymbolicLink()) refuse("database-location");
      } catch (error) {
        if (
          error instanceof BoundaryError ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
        NodeFS.mkdirSync(location, { mode: 0o700 });
      }
    }
    const path = NodePath.join(directory, `${context}.sqlite`);
    try {
      if (NodeFS.lstatSync(path).isSymbolicLink()) refuse("database-location");
    } catch (error) {
      if (
        error instanceof BoundaryError ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    const db = new NodeSqlite.DatabaseSync(path);
    try {
      NodeFS.chmodSync(path, 0o600);
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, chunk INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, text, content='chunks', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,path,text) VALUES(new.id,new.path,new.text); END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,path,text) VALUES('delete',old.id,old.path,old.text); END;
        CREATE TABLE IF NOT EXISTS vectors (chunk_id INTEGER NOT NULL, configuration TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(chunk_id,configuration));
        CREATE TABLE IF NOT EXISTS embedding_retries (configuration TEXT PRIMARY KEY, retry_after INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, context TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
      if (
        !db
          .prepare("PRAGMA table_info(proposals)")
          .all()
          .some((row) => row.name === "created_at")
      ) {
        db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE proposals RENAME TO proposals_legacy;
          CREATE TABLE proposals (id TEXT PRIMARY KEY, context TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
          INSERT INTO proposals(id,context,session_id,text,status,created_at) SELECT id,context,session_id,text,status,NULL FROM proposals_legacy;
          DROP TABLE proposals_legacy;
          COMMIT;`);
      }
      return body(db);
    } finally {
      db.close();
    }
  }
  function reconcile(db: NodeSqlite.DatabaseSync, snapshot: Snapshot) {
    const current = db.prepare("SELECT value FROM metadata WHERE key='manifestHash'").get();
    if (current?.value === snapshot.manifestHash) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM vectors; DELETE FROM chunks;");
      const insert = db.prepare("INSERT INTO chunks(path,chunk,text) VALUES(?,?,?)");
      for (const row of snapshot.rows) {
        const text = new TextDecoder("utf8", { fatal: true }).decode(row.raw);
        chunks(text).forEach((text, i) => insert.run(row.path, i, text));
      }
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES('manifestHash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(snapshot.manifestHash);
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES('lastRebuild',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(
        // @effect-diagnostics-next-line globalDate:off -- This imperative SQLite factory timestamps rebuild metadata without creating an Effect runtime.
        new Date().toISOString(),
      );
      const metadata = db.prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      metadata.run("rootHash", hash(snapshot.root));
      metadata.run("approvedFiles", String(snapshot.rows.length));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const inventory = async (input: Scope) =>
    run("inventory", () => {
      const snapshot = approved(input);
      return {
        context: input.context,
        approvedFiles: snapshot.rows.length,
        bytes: snapshot.rows.reduce((sum, row) => sum + row.raw.length, 0),
        files: snapshot.rows.map((row) => row.path),
        manifestHash: snapshot.manifestHash,
      };
    });
  const status = async (input: Scope) => {
    try {
      return run("status", () => {
        const snapshot = approved(input);
        return database(input.context, (db) => {
          reconcile(db, snapshot);
          return {
            available: true as const,
            context: input.context,
            lastRebuild:
              String(
                db.prepare("SELECT value FROM metadata WHERE key='lastRebuild'").get()?.value ?? "",
              ) || null,
            approvedFiles: snapshot.rows.length,
            bytes: snapshot.rows.reduce((sum, row) => sum + row.raw.length, 0),
            files: snapshot.rows.map((row) => row.path),
            manifestHash: snapshot.manifestHash,
            indexedChunks: Number(db.prepare("SELECT count(*) AS count FROM chunks").get()!.count),
            vectorBackend: "float32-cosine" as const,
          };
        });
      });
    } catch {
      return { available: false as const, context: input.context };
    }
  };
  const read = async (input: Scope & { path: string }) =>
    run("read", () => {
      const snapshot = approved(input);
      const row = snapshot.rows.find((row) => row.path === input.path);
      if (!row) return refuse("unapproved-read");
      database(input.context, (db) => reconcile(db, snapshot));
      return {
        context: input.context,
        path: row.path,
        text: new TextDecoder("utf8", { fatal: true }).decode(row.raw),
        sha256: row.sha256,
      };
    });
  async function embed(settings: Embeddings, input: string[], signal: AbortSignal) {
    const url = new URL(settings.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      refuse("embedding-endpoint");
    // @effect-diagnostics-next-line globalFetch:off -- Optional embedding calls share a bounded operation deadline and never change approval.
    const response = await fetch(new URL("/api/embed", url), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model, input, truncate: false }),
      signal,
    });
    if (!response.ok || !response.body) return refuse("embedding-response");
    const reader = response.body.getReader();
    let length = 0;
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 2 * 1024 * 1024) refuse("embedding-response");
        parts.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const vectors = decodeEmbeddings(JSON.parse(Buffer.concat(parts).toString("utf8"))).embeddings;
    if (
      vectors.length !== input.length ||
      vectors.some(
        (v) =>
          !v.length ||
          v.length > 8192 ||
          v.some((n) => !Number.isFinite(n) || !Number.isFinite(Math.fround(n))),
      )
    )
      refuse("embedding-response");
    return vectors.map((v) => [...v]);
  }
  const search = async (
    input: Scope & { query: string; limit?: number; embeddings?: Embeddings },
  ) => {
    const initial = run("search", () => {
      if (
        !input.query.trim() ||
        input.query.length > 10000 ||
        (input.limit !== undefined &&
          (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
      )
        refuse("query");
      const snapshot = approved(input);
      return database(input.context, (db) => {
        reconcile(db, snapshot);
        const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 64) ?? [];
        const lexical: Hit[] = terms.length
          ? db
              .prepare(
                "SELECT c.path,c.chunk,c.text,bm25(chunks_fts,0,1) AS score FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score,c.path,c.chunk LIMIT ?",
              )
              .all(terms.map((t) => `"${t}"`).join(" OR "), input.limit ?? 20)
              .map((row) => ({
                path: String(row.path),
                chunk: Number(row.chunk),
                text: String(row.text),
                score: -Number(row.score),
              }))
          : [];
        const all: Chunk[] = input.embeddings?.enabled
          ? db
              .prepare("SELECT * FROM chunks ORDER BY id")
              .all()
              .map((row) => ({
                id: Number(row.id),
                path: String(row.path),
                chunk: Number(row.chunk),
                text: String(row.text),
              }))
          : [];
        return { snapshot, lexical, all };
      });
    });
    let results = initial.lexical;
    let embeddingStatus: "disabled" | "ready" | "unavailable" = "disabled";
    const settings = input.embeddings;
    if (settings?.enabled) {
      const key = hash(JSON.stringify([settings.baseUrl, settings.model]));
      try {
        const retryAfter = run("embedding-cache", () =>
          database(input.context, (db) =>
            Number(
              db.prepare("SELECT retry_after FROM embedding_retries WHERE configuration=?").get(key)
                ?.retry_after ?? 0,
            ),
          ),
        );
        // @effect-diagnostics-next-line globalDate:off -- The persistent retry deadline must survive factory and process restarts.
        if (retryAfter > Date.now()) refuse("embedding-backoff");
        const signal = AbortSignal.timeout(15000);
        const cached = run("embedding-cache", () =>
          database(
            input.context,
            (db) =>
              new Map(
                db
                  .prepare("SELECT chunk_id,vector FROM vectors WHERE configuration=?")
                  .all(key)
                  .map((row) => [Number(row.chunk_id), decodeVector(row.vector as Uint8Array)]),
              ),
          ),
        );
        const prefix = settings.model.startsWith("nomic-embed-text");
        const [query] = await embed(
          settings,
          [`${prefix ? "search_query: " : ""}${input.query}`],
          signal,
        );
        const missing = initial.all.filter((row) => !cached.has(row.id));
        for (let offset = 0; offset < missing.length; offset += 16) {
          const batch = missing.slice(offset, offset + 16);
          const vectors = await embed(
            settings,
            batch.map((row) => `${prefix ? "search_document: " : ""}${row.text}`),
            signal,
          );
          run("embedding-cache", () =>
            database(input.context, (db) => {
              const latest = approved(input);
              if (
                latest.manifestHash !== initial.snapshot.manifestHash ||
                db.prepare("SELECT value FROM metadata WHERE key='manifestHash'").get()?.value !==
                  latest.manifestHash
              )
                refuse("changed-input");
              db.exec("BEGIN IMMEDIATE");
              try {
                const insert = db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?)");
                batch.forEach((row, i) => insert.run(row.id, key, encodeVector(vectors[i]!)));
                db.exec("COMMIT");
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            }),
          );
          batch.forEach((row, i) => cached.set(row.id, vectors[i]!));
        }
        const semantic = initial.all
          .map((row) => ({
            path: row.path,
            chunk: row.chunk,
            text: row.text,
            score: cosine(query!, cached.get(row.id)!),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, input.limit ?? 20);
        run("embedding-cache", () =>
          database(input.context, (db) => {
            const latest = approved(input);
            if (
              latest.manifestHash !== initial.snapshot.manifestHash ||
              db.prepare("SELECT value FROM metadata WHERE key='manifestHash'").get()?.value !==
                latest.manifestHash
            )
              refuse("changed-input");
            db.prepare("DELETE FROM embedding_retries WHERE configuration=?").run(key);
          }),
        );
        const fused = new Map<string, Hit>();
        for (const ranking of [initial.lexical, semantic])
          ranking.forEach((hit, i) => {
            const key = `${hit.path}\0${hit.chunk}`;
            fused.set(key, { ...hit, score: (fused.get(key)?.score ?? 0) + 1 / (61 + i) });
          });
        results = [...fused.values()]
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.chunk - b.chunk)
          .slice(0, input.limit ?? 20);
        embeddingStatus = "ready";
      } catch {
        run("embedding-backoff", () =>
          database(input.context, (db) => {
            // Backoff is not extended by searches that already skipped the network.
            // @effect-diagnostics-next-line globalDate:off -- The retry timestamp is persisted for subsequent processes.
            const now = Date.now();
            db.prepare(
              "INSERT INTO embedding_retries(configuration,retry_after) VALUES(?,?) ON CONFLICT(configuration) DO UPDATE SET retry_after=excluded.retry_after WHERE embedding_retries.retry_after<=?",
            ).run(key, now + 60000, now);
          }),
        );
        options.diagnostic?.({ operation: "embeddings", category: "unavailable" });
        embeddingStatus = "unavailable";
      }
    }
    // Optional network calls may outlast a manifest edit. Never return the earlier snapshot then.
    run("search-revalidate", () => {
      if (approved(input).manifestHash !== initial.snapshot.manifestHash) refuse("changed-input");
    });
    return { context: input.context, results, embeddingStatus };
  };
  const propose = async (input: { context: D4BrainContext; text: string; sessionId: string }) =>
    run("propose", () => {
      validateContext(input.context);
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(input.sessionId) ||
        !input.text.trim() ||
        input.text.length > 100000
      )
        refuse("proposal");
      return database(input.context, (db) => {
        const id = NodeCrypto.randomUUID();
        db.prepare(
          "INSERT INTO proposals(id,context,session_id,text,status) VALUES(?,?,?,?,'pending')",
        ).run(id, input.context, input.sessionId, input.text);
        return { id, context: input.context, status: "pending" as const };
      });
    });
  const listProposals = async (context: D4BrainContext) =>
    run("proposal-list", () => {
      validateContext(context);
      if (!NodeFS.existsSync(NodePath.join(directory, `${context}.sqlite`))) return [];
      return database(context, (db) =>
        db
          .prepare(
            "SELECT id,context,text,status,created_at FROM proposals WHERE context=? ORDER BY created_at,id",
          )
          .all(context)
          .map((row) => ({
            id: String(row.id),
            context,
            text: String(row.text),
            status: decodeProposalStatus(row.status),
            createdAt: row.created_at === null ? null : String(row.created_at),
          })),
      );
    });
  const proposalCounts = async () =>
    run("proposal-counts", () =>
      [...contexts].map((context) => ({
        context: context as D4BrainContext,
        pending: NodeFS.existsSync(NodePath.join(directory, `${context}.sqlite`))
          ? database(context as D4BrainContext, (db) =>
              Number(
                db
                  .prepare(
                    "SELECT count(*) AS count FROM proposals WHERE context=? AND status='pending'",
                  )
                  .get(context)!.count,
              ),
            )
          : 0,
      })),
    );
  const resolveProposal = async (context: D4BrainContext, id: string, approve: boolean) =>
    run("proposal-resolve", () => {
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || typeof approve !== "boolean")
        refuse("proposal");
      return database(context, (db) => {
        const status = approve ? ("approved" as const) : ("rejected" as const);
        const result = db
          .prepare("UPDATE proposals SET status=? WHERE context=? AND id=?")
          .run(status, context, id);
        if (result.changes !== 1) refuse("proposal");
        return { id, context, status };
      });
    });
  const indexStatuses = async (input: { root: string | null; enabled?: boolean }) => {
    type IndexStatus = {
      context: D4BrainContext;
      status: "ready" | "not-indexed" | "not-available" | "disabled" | "refused";
      files: number;
      lastRebuild: string | null;
    };
    return [...contexts].map((context): IndexStatus => {
      const base = { context: context as D4BrainContext, files: 0, lastRebuild: null };
      if (input.enabled === false || !input.root) return { ...base, status: "disabled" };
      let rootHash: string;
      try {
        if (!NodeFS.statSync(input.root).isDirectory()) return { ...base, status: "not-available" };
        rootHash = hash(NodeFS.realpathSync(input.root));
      } catch {
        return { ...base, status: "not-available" };
      }
      let snapshot: Snapshot;
      try {
        snapshot = approved({ root: input.root, context: context as D4BrainContext }, false);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return { ...base, status: "not-available" };
        return { ...base, status: "refused" };
      }
      const notIndexed = { ...base, files: snapshot.rows.length, status: "not-indexed" as const };
      const path = NodePath.join(directory, `${context}.sqlite`);
      try {
        for (const location of [NodePath.join(options.stateDir, "d4-agent"), directory, path]) {
          if (NodeFS.lstatSync(location).isSymbolicLink()) return { ...base, status: "refused" };
        }
        const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        try {
          const metadata = new Map(
            db
              .prepare("SELECT key,value FROM metadata")
              .all()
              .map((row) => [String(row.key), String(row.value)]),
          );
          if (
            metadata.get("rootHash") !== rootHash ||
            metadata.get("manifestHash") !== snapshot.manifestHash
          )
            return notIndexed;
          return {
            context: context as D4BrainContext,
            status: "ready",
            files: Number(metadata.get("approvedFiles") ?? 0),
            lastRebuild: metadata.get("lastRebuild") ?? null,
          };
        } finally {
          db.close();
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return notIndexed;
        return { ...base, status: "refused" };
      }
    });
  };
  return {
    inventory,
    status,
    read,
    search,
    propose,
    listProposals,
    proposalCounts,
    resolveProposal,
    indexStatuses,
  };
}
