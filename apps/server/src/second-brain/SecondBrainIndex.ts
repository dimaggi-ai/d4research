import * as NodeSqlite from "node:sqlite";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure path operations also run inside synchronous SQLite and filesystem boundaries.
import * as NodePath from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous hashing and exclusive temporary names are required inside the filesystem transaction.
import * as NodeCrypto from "node:crypto";
import {
  BrainProposal,
  SecondBrainError,
  type BrainSearchInput,
  type BrainSearchResult,
  type BrainProposalQuery,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { type NoteDocument } from "./noteDocument.ts";

const decodeBrainProposal = Schema.decodeUnknownSync(BrainProposal);

const isBrainError = Schema.is(SecondBrainError);

export type CaptureJob = {
  id: string;
  vault: string;
  threadId: string;
  runFrom: number;
  runTo: number;
  transcriptHash: string;
  version: string;
  messages: Array<{ messageId: string; text: string }>;
  state: "pending" | "completed" | "failed";
  proposalIds: string[];
  attempts?: number;
};
export type IndexedNote = { document: NoteDocument; mtime: number; size: number };
export type IndexSnapshot = {
  notes: IndexedNote[];
  generation: number;
  lastIndexedAt: string | null;
  truncated: boolean;
};
export type AuditEntry = {
  id: string;
  vault: string;
  path: string;
  proposalId: string | null;
  operation: string;
  oldHash: string | null;
  newHash: string;
  actor: string;
  timestamp: string;
  state: "prepared" | "applied" | "conflict";
  logStatus?: "written" | "skipped";
};
export class SecondBrainIndex extends Context.Service<
  SecondBrainIndex,
  {
    readonly enqueueCapture: (job: CaptureJob) => Effect.Effect<CaptureJob, SecondBrainError>;
    readonly saveCapture: (job: CaptureJob) => Effect.Effect<void, SecondBrainError>;
    readonly pendingCaptures: () => Effect.Effect<CaptureJob[], SecondBrainError>;
    readonly captureCursor: () => Effect.Effect<number, SecondBrainError>;
    readonly setCaptureCursor: (sequence: number) => Effect.Effect<void, SecondBrainError>;
    readonly deliveredGeneration: (
      vault: string,
      thread: string,
    ) => Effect.Effect<number | null, SecondBrainError>;
    readonly markDelivered: (
      vault: string,
      thread: string,
      generation: number,
    ) => Effect.Effect<void, SecondBrainError>;
    readonly metadata: (
      vault: string,
    ) => Effect.Effect<Omit<IndexSnapshot, "notes">, SecondBrainError>;
    readonly captureCounts: (
      vault: string,
    ) => Effect.Effect<{ pending: number; failed: number }, SecondBrainError>;
    readonly completedCaptureRun: (
      vault: string,
      thread: string,
    ) => Effect.Effect<number, SecondBrainError>;
    readonly snapshot: (vault: string) => Effect.Effect<IndexSnapshot, SecondBrainError>;
    readonly reconcile: (
      vault: string,
      notes: IndexedNote[],
      timestamp: string,
      truncated: boolean,
      rebuild?: boolean,
    ) => Effect.Effect<void, SecondBrainError>;
    readonly search: (
      vault: string,
      input: BrainSearchInput,
      approvedOnly?: boolean,
    ) => Effect.Effect<BrainSearchResult[], SecondBrainError>;
    readonly saveProposal: (proposal: BrainProposal) => Effect.Effect<void, SecondBrainError>;
    readonly proposals: (
      vault: string,
      query: BrainProposalQuery,
      actor?: string,
    ) => Effect.Effect<BrainProposal[], SecondBrainError>;
    readonly proposal: (
      vault: string,
      id: string,
    ) => Effect.Effect<BrainProposal, SecondBrainError>;
    readonly duplicate: (
      vault: string,
      fingerprint: string,
    ) => Effect.Effect<BrainProposal | null, SecondBrainError>;
    readonly audit: (entry: AuditEntry) => Effect.Effect<void, SecondBrainError>;
    readonly pendingAudits: (vault: string) => Effect.Effect<AuditEntry[], SecondBrainError>;
  }
>()("d4research/second-brain/SecondBrainIndex") {}

export const proposalFingerprint = (
  p: Pick<
    BrainProposal,
    "path" | "operation" | "content" | "expectedHash" | "heading" | "oldStr" | "newStr"
  >,
) =>
  JSON.stringify([
    p.path,
    p.operation,
    p.content,
    p.expectedHash,
    p.heading ?? null,
    p.oldStr ?? null,
    p.newStr ?? null,
  ]);
const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(NodePath.join(config.stateDir, "second-brain.sqlite")),
      catch: () => new SecondBrainError({ code: "unavailable" }),
    }),
    (db) => Effect.sync(() => db.close()),
  );
  const run = <A>(body: () => A) =>
    Effect.try({
      try: body,
      catch: (e) => (isBrainError(e) ? e : new SecondBrainError({ code: "unavailable" })),
    });
  yield* run(() => {
    db.exec("PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL;");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 3) throw new SecondBrainError({ code: "unavailable" });
    if (version === 0)
      db.exec(`BEGIN;
      CREATE TABLE vaults (root TEXT PRIMARY KEY, generation INTEGER NOT NULL, indexed_at TEXT, truncated INTEGER NOT NULL);
      CREATE TABLE notes (vault TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, document TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(vault,path));
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, vault TEXT NOT NULL, path TEXT NOT NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL, tags TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX chunks_vault ON chunks(vault,path);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(title, heading, tags, text, content='chunks', content_rowid='id');
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,title,heading,tags,text) VALUES(new.id,new.title,new.heading,new.tags,new.text); END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,heading,tags,text) VALUES('delete',old.id,old.title,old.heading,old.tags,old.text); END;
      CREATE TABLE links (vault TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, fragment TEXT NOT NULL, line INTEGER NOT NULL, relative INTEGER NOT NULL);
      CREATE INDEX links_vault ON links(vault,source);
      CREATE TABLE proposals (id TEXT PRIMARY KEY, vault TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX proposals_vault ON proposals(vault,state);
      CREATE TABLE audit (id TEXT PRIMARY KEY, vault TEXT NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX audit_vault ON audit(vault,state);
      PRAGMA user_version=1; COMMIT;`);
    if (version < 2)
      db.exec(`BEGIN;
      CREATE TABLE brain_deliveries(vault TEXT NOT NULL, thread TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(vault,thread));
      PRAGMA user_version=2; COMMIT;`);
    if (version < 3)
      db.exec(`BEGIN;
      CREATE TABLE brain_capture_jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE brain_capture_cursor(id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
      PRAGMA user_version=3; COMMIT;`);
  });
  const transaction = (body: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      body();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const decodeProposal = (row: Record<string, unknown>) =>
    decodeBrainProposal(JSON.parse(String(row.document)));
  const snapshots = new Map<string, IndexSnapshot>();
  const metadata = (vault: string) => {
    const row = db.prepare("SELECT * FROM vaults WHERE root=?").get(vault);
    return {
      generation: Number(row?.generation ?? 0),
      lastIndexedAt: row?.indexed_at ? String(row.indexed_at) : null,
      truncated: row?.truncated === 1,
    };
  };
  return SecondBrainIndex.of({
    metadata: (vault) => run(() => metadata(vault)),
    captureCounts: (vault) =>
      run(() => {
        const rows = db
          .prepare(
            "SELECT state,count(*) AS count FROM brain_capture_jobs WHERE json_extract(document,'$.vault')=? GROUP BY state",
          )
          .all(vault);
        return {
          pending: Number(rows.find((r) => r.state === "pending")?.count ?? 0),
          failed: Number(rows.find((r) => r.state === "failed")?.count ?? 0),
        };
      }),
    completedCaptureRun: (vault, thread) =>
      run(() =>
        Number(
          db
            .prepare(
              "SELECT max(json_extract(document,'$.runTo')) AS ordinal FROM brain_capture_jobs WHERE state='completed' AND json_extract(document,'$.vault')=? AND json_extract(document,'$.threadId')=?",
            )
            .get(vault, thread)?.ordinal ?? 0,
        ),
      ),
    enqueueCapture: (job) =>
      run(() => {
        db.prepare("INSERT OR IGNORE INTO brain_capture_jobs VALUES(?,?,?)").run(
          job.id,
          job.state,
          JSON.stringify(job),
        );
        return JSON.parse(
          String(
            db.prepare("SELECT document FROM brain_capture_jobs WHERE id=?").get(job.id)!.document,
          ),
        ) as CaptureJob;
      }),
    saveCapture: (job) =>
      run(() => {
        db.prepare("UPDATE brain_capture_jobs SET state=?, document=? WHERE id=?").run(
          job.state,
          JSON.stringify(job),
          job.id,
        );
      }),
    pendingCaptures: () =>
      run(() =>
        db
          .prepare(
            "SELECT document FROM brain_capture_jobs WHERE state='pending' OR (state='failed' AND coalesce(json_extract(document,'$.attempts'),0)<3) ORDER BY rowid",
          )
          .all()
          .map((r) => JSON.parse(String(r.document)) as CaptureJob),
      ),
    captureCursor: () =>
      run(() =>
        Number(
          db.prepare("SELECT sequence FROM brain_capture_cursor WHERE id=1").get()?.sequence ?? 0,
        ),
      ),
    setCaptureCursor: (sequence) =>
      run(() => {
        db.prepare(
          "INSERT INTO brain_capture_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET sequence=max(sequence,excluded.sequence)",
        ).run(sequence);
      }),
    deliveredGeneration: (vault, thread) =>
      run(() => {
        const row = db
          .prepare("SELECT generation FROM brain_deliveries WHERE vault=? AND thread=?")
          .get(vault, thread);
        return row ? Number(row.generation) : null;
      }),
    markDelivered: (vault, thread, generation) =>
      run(() => {
        db.prepare(
          "INSERT INTO brain_deliveries VALUES(?,?,?) ON CONFLICT(vault,thread) DO UPDATE SET generation=excluded.generation",
        ).run(vault, thread, generation);
      }),
    snapshot: (vault) =>
      run(() => {
        const meta = metadata(vault);
        const cached = snapshots.get(vault);
        if (cached?.generation === meta.generation) {
          Object.assign(cached, meta);
          return cached;
        }
        const notes = db
          .prepare("SELECT document,mtime,size FROM notes WHERE vault=? ORDER BY path")
          .all(vault)
          .map((r) => ({
            document: JSON.parse(String(r.document)) as NoteDocument,
            mtime: Number(r.mtime),
            size: Number(r.size),
          }));
        const snapshot = { notes, ...meta };
        snapshots.set(vault, snapshot);
        return snapshot;
      }),
    reconcile: (vault, notes, timestamp, truncated, rebuild = false) =>
      run(() =>
        transaction(() => {
          const existing = new Map(
            db
              .prepare("SELECT path,hash FROM notes WHERE vault=?")
              .all(vault)
              .map((r) => [String(r.path), String(r.hash)]),
          );
          const changed =
            notes.length !== existing.size ||
            notes.some((n) => existing.get(n.document.path) !== n.document.hash);
          const incoming = new Set(notes.map((n) => n.document.path));
          const remove = (file: string) => {
            db.prepare("DELETE FROM chunks WHERE vault=? AND path=?").run(vault, file);
            db.prepare("DELETE FROM links WHERE vault=? AND source=?").run(vault, file);
            db.prepare("DELETE FROM notes WHERE vault=? AND path=?").run(vault, file);
          };
          for (const file of existing.keys()) if (!incoming.has(file)) remove(file);
          for (const { document: note, mtime, size } of notes) {
            if (!rebuild && existing.get(note.path) === note.hash) {
              db.prepare("UPDATE notes SET mtime=?,size=? WHERE vault=? AND path=?").run(
                mtime,
                size,
                vault,
                note.path,
              );
              continue;
            }
            remove(note.path);
            db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?)").run(
              vault,
              note.path,
              note.hash,
              JSON.stringify(note),
              mtime,
              size,
            );
            for (const [ordinal, chunk] of note.chunks.entries())
              db.prepare(
                "INSERT INTO chunks(vault,path,ordinal,title,heading,tags,kind,start_line,end_line,hash,text) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              ).run(
                vault,
                note.path,
                ordinal,
                note.title,
                chunk.heading,
                JSON.stringify(note.metadata.tags ?? []),
                note.kind,
                chunk.startLine,
                chunk.endLine,
                note.hash,
                chunk.text,
              );
            for (const link of note.links)
              db.prepare("INSERT INTO links VALUES(?,?,?,?,?,?)").run(
                vault,
                note.path,
                link.target,
                link.fragment,
                link.line,
                Number(link.relative),
              );
          }
          db.prepare(
            "INSERT INTO vaults VALUES(?,1,?,?) ON CONFLICT(root) DO UPDATE SET generation=generation+?,indexed_at=excluded.indexed_at,truncated=excluded.truncated",
          ).run(vault, timestamp, Number(truncated), Number(changed));
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const meta = metadata(vault);
            const cached = snapshots.get(vault);
            if (cached?.generation === meta.generation)
              Object.assign(cached, meta, {
                notes: [...notes].sort((a, b) => a.document.path.localeCompare(b.document.path)),
              });
            else
              snapshots.set(vault, {
                notes: [...notes].sort((a, b) => a.document.path.localeCompare(b.document.path)),
                ...meta,
              });
          }),
        ),
      ),
    search: (vault, input, approvedOnly = false) =>
      run(() => {
        const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 64) ?? [];
        if (!terms.length) return [];
        const query = terms.map((t) => `"${t}"`).join(" OR ");
        const rows = db
          .prepare(
            `SELECT c.*, bm25(chunks_fts,8,5,3,1) AS rank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ? AND c.vault=? AND (?=0 OR (c.path!='log.md' AND c.path NOT LIKE 'raw/%')) AND (? IS NULL OR c.kind=?) AND (? IS NULL OR c.path LIKE ? ESCAPE '\\') AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(c.tags) WHERE value=?)) ORDER BY rank,c.path,c.ordinal LIMIT ?`,
          )
          .all(
            query,
            vault,
            Number(approvedOnly),
            input.kind ?? null,
            input.kind ?? null,
            input.path ?? null,
            input.path ? `${input.path.replace(/[\\%_]/g, "\\$&")}%` : null,
            input.tag ?? null,
            input.tag ?? null,
            input.limit ?? 20,
          );
        return rows.map((r) => ({
          score: -Number(r.rank),
          citation: {
            path: String(r.path),
            heading: String(r.heading),
            startLine: Number(r.start_line),
            endLine: Number(r.end_line),
            hash: String(r.hash),
            excerpt: String(r.text).slice(0, 4096),
          },
        }));
      }),
    saveProposal: (proposal) =>
      run(() => {
        db.prepare(
          "INSERT INTO proposals VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document",
        ).run(
          proposal.id,
          proposal.vault,
          proposal.actor,
          proposal.state,
          proposalFingerprint(proposal),
          JSON.stringify(proposal),
        );
      }),
    proposal: (vault, id) =>
      run(() => {
        const row = db
          .prepare("SELECT document FROM proposals WHERE vault=? AND id=?")
          .get(vault, id);
        if (!row) throw new SecondBrainError({ code: "not_found" });
        return decodeProposal(row);
      }),
    proposals: (vault, query, actor) =>
      run(() =>
        db
          .prepare(
            "SELECT document FROM proposals WHERE vault=? AND (? IS NULL OR state=?) AND (? IS NULL OR actor=?) ORDER BY rowid DESC LIMIT ? OFFSET ?",
          )
          .all(
            vault,
            query.state ?? "pending",
            query.state ?? "pending",
            actor ?? null,
            actor ?? null,
            query.limit ?? 50,
            query.offset ?? 0,
          )
          .map(decodeProposal),
      ),
    duplicate: (vault, fingerprint) =>
      run(() => {
        const row = db
          .prepare(
            "SELECT document FROM proposals WHERE vault=? AND fingerprint=? AND state IN ('pending','rejected') ORDER BY rowid DESC LIMIT 1",
          )
          .get(vault, fingerprint);
        return row ? decodeProposal(row) : null;
      }),
    audit: (entry) =>
      run(() => {
        db.prepare(
          "INSERT INTO audit VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document",
        ).run(entry.id || NodeCrypto.randomUUID(), entry.vault, entry.state, JSON.stringify(entry));
      }),
    pendingAudits: (vault) =>
      run(() =>
        db
          .prepare("SELECT document FROM audit WHERE vault=? AND state='prepared'")
          .all(vault)
          .map((r) => JSON.parse(String(r.document)) as AuditEntry),
      ),
  });
});
export const layer = Layer.effect(SecondBrainIndex, make);
