// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic fixture setup and canonical Python parity run synchronously without an application runtime.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic fixture setup and canonical Python parity run synchronously without an application runtime.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic fixture setup and canonical Python parity run synchronously without an application runtime.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synthetic fixture setup and canonical Python parity run synchronously without an application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { D4BrainContext } from "@d4research/contracts";
import { createScopedBrain } from "./scopedBrain.ts";

const REFUSAL = "Context operation refused; inspect the selected scope configuration.";
const canonical = NodePath.join(import.meta.dirname, "fixtures", "brain.py");
const scratch = process.env.TMPDIR ?? NodeOS.tmpdir();
const digest = (raw: string | Buffer) => NodeCrypto.createHash("sha256").update(raw).digest("hex");
let temp: string;
let root: string;
let stateDir: string;
let brain: ReturnType<typeof createScopedBrain>;
function write(path: string, text: string) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), text);
}
function manifest(context: D4BrainContext, rows: Array<{ path: string; sha256: string }>) {
  write(
    context === "Global" ? "Global/sources.json" : `${context}/State/sources.json`,
    JSON.stringify({ files: rows }),
  );
}
function approve(context: D4BrainContext, path: string, text: string) {
  write(path, text);
  manifest(context, [{ path, sha256: digest(text) }]);
}
function python(context = "Personal") {
  return NodeChildProcess.spawnSync(
    "python3",
    [NodePath.join(root, "Tools/brain.py"), "inventory", "--domain", context],
    { encoding: "utf8", timeout: 5000 },
  );
}
function snapshotVault() {
  const paths = NodeChildProcess.execFileSync("find", [root, "-type", "f"], {
    encoding: "utf8",
    timeout: 5000,
  })
    .trim()
    .split("\n")
    .sort();
  return paths.map((path) => [path.slice(root.length), digest(NodeFS.readFileSync(path))]);
}
beforeEach(() => {
  NodeFS.mkdirSync(scratch, { recursive: true });
  temp = NodeFS.mkdtempSync(NodePath.join(scratch, "r4-brain-test-"));
  root = NodePath.join(temp, "vault");
  stateDir = NodePath.join(temp, "state");
  write("Tools/brain.py", NodeFS.readFileSync(canonical, "utf8"));
  approve("Global", "Global/Knowledge/method.md", "neutral method apple");
  approve("Personal", "Personal/State/current.md", "personal apple fruit");
  approve("YB", "YB/State/current.md", "excluded yb marker");
  approve("Dimaggi", "Dimaggi/State/current.md", "excluded dimaggi marker");
  brain = createScopedBrain({ stateDir });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  NodeFS.rmSync(temp, { recursive: true, force: true });
});

describe("canonical approved scope boundary", () => {
  it.each(["Personal", "YB", "Dimaggi", "Global"] as const)(
    "matches canonical inventory for %s",
    async (context) => {
      const expected = python(context);
      expect(expected.status).toBe(0);
      const actual = await brain.inventory({ root, context });
      expect({
        context: actual.context,
        approved_files: actual.approvedFiles,
        bytes: actual.bytes,
        files: actual.files,
      }).toEqual(JSON.parse(expected.stdout));
      expect(NodeFS.existsSync(NodePath.join(root, "Runtime"))).toBe(false);
    },
  );
  const invalid = [
    ["parent", "Personal/../YB/State/current.md"],
    ["absolute", "/Personal/State/current.md"],
    ["hidden", "Personal/.hidden.md"],
    ["archive", "Personal/Archive/note.md"],
    ["other-context", "YB/State/current.md"],
    ["empty", ""],
  ];
  it.each(invalid)("refuses %s with canonical parity", async (_, path) => {
    manifest("Personal", [{ path: path!, sha256: digest("personal apple fruit") }]);
    expect(python().status).toBe(2);
    await expect(brain.inventory({ root, context: "Personal" })).rejects.toThrow(REFUSAL);
  });
  it("deliberately rejects an embedded dot that PurePosixPath collapses", async () => {
    manifest("Personal", [
      { path: "Personal/State/./current.md", sha256: digest("personal apple fruit") },
    ]);
    expect(python().status).toBe(0);
    await expect(brain.inventory({ root, context: "Personal" })).rejects.toThrow(REFUSAL);
  });
  it("matches canonical acceptance of repeated separators", async () => {
    manifest("Personal", [
      { path: "Personal//State/current.md", sha256: digest("personal apple fruit") },
    ]);
    expect(python().status).toBe(0);
    expect((await brain.inventory({ root, context: "Personal" })).files[0]).toBe(
      "Personal//State/current.md",
    );
  });
  it.each(["file", "directory", "manifest"])("refuses a linked %s", async (kind) => {
    if (kind === "file") {
      NodeFS.renameSync(
        NodePath.join(root, "Personal/State/current.md"),
        NodePath.join(temp, "outside.md"),
      );
      NodeFS.symlinkSync(
        NodePath.join(temp, "outside.md"),
        NodePath.join(root, "Personal/State/current.md"),
      );
    } else if (kind === "directory") {
      NodeFS.renameSync(NodePath.join(root, "Personal/State"), NodePath.join(temp, "outside"));
      NodeFS.symlinkSync(NodePath.join(temp, "outside"), NodePath.join(root, "Personal/State"));
    } else {
      NodeFS.renameSync(
        NodePath.join(root, "Personal/State/sources.json"),
        NodePath.join(temp, "outside.json"),
      );
      NodeFS.symlinkSync(
        NodePath.join(temp, "outside.json"),
        NodePath.join(root, "Personal/State/sources.json"),
      );
    }
    expect(python().status).toBe(2);
    await expect(brain.inventory({ root, context: "Personal" })).rejects.toThrow(REFUSAL);
  });
  it.each(["hash", "duplicate", "manifest-shape", "entry-shape", "json", "bom", "missing-global"])(
    "matches canonical failure for %s",
    async (kind) => {
      const row = { path: "Personal/State/current.md", sha256: digest("personal apple fruit") };
      if (kind === "hash") write(row.path, "changed");
      if (kind === "duplicate") manifest("Personal", [row, row]);
      if (kind === "manifest-shape") write("Personal/State/sources.json", '{"files":{}}');
      if (kind === "entry-shape")
        write(
          "Personal/State/sources.json",
          '{"files":[{"path":"Personal/State/current.md","sha256":"BAD"}]}',
        );
      if (kind === "json") write("Personal/State/sources.json", "not json");
      if (kind === "bom")
        write("Personal/State/sources.json", "\ufeff" + JSON.stringify({ files: [row] }));
      if (kind === "missing-global") NodeFS.unlinkSync(NodePath.join(root, "Global/sources.json"));
      const expected = python();
      expect(expected.status).toBe(2);
      expect(expected.stderr.trim()).toBe(REFUSAL);
      await expect(brain.inventory({ root, context: "Personal" })).rejects.toThrow(REFUSAL);
    },
  );
});

describe("context-local index", () => {
  it.each(["YB", "Global"] as const)(
    "%s search and reads exclude every other work context",
    async (context) => {
      for (const selected of ["Global", "Personal", "YB", "Dimaggi"] as const) {
        const path =
          selected === "Global" ? "Global/Knowledge/method.md" : `${selected}/State/current.md`;
        approve(selected, path, `shared-query ${selected} private-marker`);
      }
      const before = snapshotVault();
      const results = await brain.search({ root, context, query: "shared-query" });
      expect(results.results.map((hit) => hit.path).sort()).toEqual(
        context === "Global"
          ? ["Global/Knowledge/method.md"]
          : ["Global/Knowledge/method.md", "YB/State/current.md"],
      );
      for (const other of ["Personal", "Dimaggi", ...(context === "Global" ? ["YB"] : [])]) {
        expect(JSON.stringify(results)).not.toContain(`${other} private-marker`);
        await expect(
          brain.read({ root, context, path: `${other}/State/current.md` }),
        ).rejects.toThrow(REFUSAL);
      }
      expect((await brain.read({ root, context, path: "Global/Knowledge/method.md" })).text).toBe(
        "shared-query Global private-marker",
      );
      expect(snapshotVault()).toEqual(before);
    },
  );
  it("searches and reads only approved selected files plus Global", async () => {
    const before = snapshotVault();
    const result = await brain.search({ root, context: "Personal", query: "apple" });
    expect(result.results.map((hit) => hit.path).sort()).toEqual([
      "Global/Knowledge/method.md",
      "Personal/State/current.md",
    ]);
    expect((await brain.search({ root, context: "Personal", query: "excluded" })).results).toEqual(
      [],
    );
    await expect(
      brain.read({ root, context: "Personal", path: "YB/State/current.md" }),
    ).rejects.toThrow(REFUSAL);
    expect(
      (await brain.read({ root, context: "Personal", path: "Personal/State/current.md" })).text,
    ).toBe("personal apple fruit");
    expect(snapshotVault()).toEqual(before);
  });
  it("creates one database per context and excludes all other context data", async () => {
    for (const context of ["Personal", "YB", "Dimaggi", "Global"] as const)
      await brain.status({ root, context });
    expect(NodeFS.readdirSync(NodePath.join(stateDir, "d4-agent/brain")).sort()).toEqual([
      "Dimaggi.sqlite",
      "Global.sqlite",
      "Personal.sqlite",
      "YB.sqlite",
    ]);
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      const rows = db.prepare("SELECT text FROM chunks").all();
      expect(JSON.stringify(rows)).not.toContain("excluded");
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get()!.sql,
      ).toContain("fts5");
    } finally {
      db.close();
    }
  });
  it("reports valid manifests as not indexed without creating state", async () => {
    expect(await brain.indexStatuses({ root })).toEqual([
      { context: "Global", status: "not-indexed", files: 1, lastRebuild: null },
      { context: "Personal", status: "not-indexed", files: 2, lastRebuild: null },
      { context: "YB", status: "not-indexed", files: 2, lastRebuild: null },
      { context: "Dimaggi", status: "not-indexed", files: 2, lastRebuild: null },
    ]);
    expect(NodeFS.existsSync(stateDir)).toBe(false);
    NodeFS.unlinkSync(NodePath.join(root, "YB/State/sources.json"));
    expect((await brain.indexStatuses({ root })).find((row) => row.context === "YB")?.status).toBe(
      "not-available",
    );
  });
  it("refuses stale statuses without rebuilding indexes or creating databases", async () => {
    await brain.status({ root, context: "Personal" });
    NodeFS.unlinkSync(NodePath.join(root, "Personal/State/current.md"));
    expect(
      (await brain.indexStatuses({ root })).find((s) => s.context === "Personal"),
    ).toMatchObject({ status: "ready", files: 2 });
    write("Global/sources.json", "invalid manifest");
    const statuses = await brain.indexStatuses({ root });
    expect(statuses.find((s) => s.context === "Personal")).toMatchObject({
      status: "refused",
      files: 0,
    });
    expect(statuses.find((s) => s.context === "Global")).toMatchObject({
      status: "refused",
      files: 0,
    });
    expect(NodeFS.readdirSync(NodePath.join(stateDir, "d4-agent/brain"))).toEqual([
      "Personal.sqlite",
    ]);
    expect(
      (await brain.indexStatuses({ root, enabled: false })).every((s) => s.status === "disabled"),
    ).toBe(true);
    expect(
      (await brain.indexStatuses({ root: NodePath.join(temp, "absent") })).every(
        (s) => s.status === "not-available",
      ),
    ).toBe(true);
    await expect(brain.search({ root, context: "Personal", query: "apple" })).rejects.toThrow(
      REFUSAL,
    );
  });
  it("reports a changed valid manifest as not indexed until an explicit indexing operation", async () => {
    await brain.status({ root, context: "Personal" });
    const dbPath = NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite");
    const before = NodeFS.readFileSync(dbPath);
    manifest("Personal", []);
    expect(
      (await brain.indexStatuses({ root })).find((s) => s.context === "Personal")?.status,
    ).toBe("not-indexed");
    expect(NodeFS.readFileSync(dbPath)).toEqual(before);
    await brain.search({ root, context: "Personal", query: "apple" });
    expect(
      (await brain.indexStatuses({ root })).find((s) => s.context === "Personal"),
    ).toMatchObject({ status: "ready", files: 1 });
  });
  it.each(["directory", "database", "dangling-database"])(
    "refuses linked state %s",
    async (kind) => {
      NodeFS.mkdirSync(NodePath.join(stateDir, "d4-agent"), { recursive: true });
      const outside = NodePath.join(temp, "outside-state");
      NodeFS.mkdirSync(outside);
      if (kind === "directory")
        NodeFS.symlinkSync(outside, NodePath.join(stateDir, "d4-agent/brain"));
      else {
        NodeFS.mkdirSync(NodePath.join(stateDir, "d4-agent/brain"));
        const target = NodePath.join(outside, "target.sqlite");
        if (kind === "database") NodeFS.writeFileSync(target, "protected");
        NodeFS.symlinkSync(target, NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"));
      }
      expect((await brain.status({ root, context: "Personal" })).available).toBe(false);
      expect(NodeFS.readdirSync(outside)).toEqual(kind === "database" ? ["target.sqlite"] : []);
    },
  );
  it("never serves a stale indexed source after content or manifest change", async () => {
    const first = await brain.status({ root, context: "Personal" });
    expect(first.available).toBe(true);
    write("Personal/State/current.md", "new verified banana");
    await expect(brain.search({ root, context: "Personal", query: "apple" })).rejects.toThrow(
      REFUSAL,
    );
    await expect(
      brain.read({ root, context: "Personal", path: "Personal/State/current.md" }),
    ).rejects.toThrow(REFUSAL);
    expect((await brain.status({ root, context: "Personal" })).available).toBe(false);
    manifest("Personal", [
      { path: "Personal/State/current.md", sha256: digest("new verified banana") },
    ]);
    await brain.read({ root, context: "Personal", path: "Personal/State/current.md" });
    const rebuilt = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
      { readOnly: true },
    );
    try {
      const chunks = JSON.stringify(rebuilt.prepare("SELECT text FROM chunks").all());
      expect(chunks).toContain("banana");
      expect(chunks).not.toContain("personal apple fruit");
    } finally {
      rebuilt.close();
    }
    const second = await brain.status({ root, context: "Personal" });
    expect(second.available && first.available && second.manifestHash !== first.manifestHash).toBe(
      true,
    );
    expect(
      (await brain.search({ root, context: "Personal", query: "banana" })).results[0]!.text,
    ).toContain("banana");
    manifest("Personal", []);
    expect((await brain.search({ root, context: "Personal", query: "banana" })).results).toEqual(
      [],
    );
  });
  it("keeps pending proposals only in context SQLite without vault writes", async () => {
    const before = snapshotVault();
    const proposal = await brain.propose({
      context: "Personal",
      text: "candidate learning",
      sessionId: "session_1",
    });
    expect(proposal.status).toBe("pending");
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      expect(db.prepare("SELECT context,session_id,text,status FROM proposals").get()).toEqual({
        context: "Personal",
        session_id: "session_1",
        text: "candidate learning",
        status: "pending",
      });
    } finally {
      db.close();
    }
    expect((await brain.search({ root, context: "Personal", query: "candidate" })).results).toEqual(
      [],
    );
    expect(snapshotVault()).toEqual(before);
  });
  it("keeps absent state untouched when polling proposal lists and counts", async () => {
    expect(NodeFS.existsSync(stateDir)).toBe(false);
    for (const context of ["Global", "Personal", "YB", "Dimaggi"] as const)
      expect(await brain.listProposals(context)).toEqual([]);
    expect(await brain.proposalCounts()).toEqual([
      { context: "Global", pending: 0 },
      { context: "Personal", pending: 0 },
      { context: "YB", pending: 0 },
      { context: "Dimaggi", pending: 0 },
    ]);
    expect(NodeFS.existsSync(stateDir)).toBe(false);
  });
  it("lists only the requested context and resolves proposals without vault writes", async () => {
    const before = snapshotVault();
    const personal = await brain.propose({
      context: "Personal",
      text: "personal candidate",
      sessionId: "session_1",
    });
    const yb = await brain.propose({ context: "YB", text: "yb candidate", sessionId: "session_2" });
    expect(await brain.listProposals("Personal")).toEqual([
      expect.objectContaining({
        id: personal.id,
        context: "Personal",
        text: "personal candidate",
        status: "pending",
        createdAt: expect.stringMatching(/^\d{4}-/),
      }),
    ]);
    expect(await brain.proposalCounts()).toEqual([
      { context: "Global", pending: 0 },
      { context: "Personal", pending: 1 },
      { context: "YB", pending: 1 },
      { context: "Dimaggi", pending: 0 },
    ]);
    await expect(brain.resolveProposal("Personal", yb.id, true)).rejects.toThrow(REFUSAL);
    expect(await brain.resolveProposal("Personal", personal.id, true)).toEqual({
      id: personal.id,
      context: "Personal",
      status: "approved",
    });
    expect(await brain.resolveProposal("YB", yb.id, false)).toEqual({
      id: yb.id,
      context: "YB",
      status: "rejected",
    });
    expect((await brain.listProposals("Personal"))[0]?.status).toBe("approved");
    expect((await brain.listProposals("YB"))[0]?.status).toBe("rejected");
    expect((await brain.proposalCounts()).every((row) => row.pending === 0)).toBe(true);
    expect(snapshotVault()).toEqual(before);
  });
  it("lists a bounded page of pending proposals and the latest resolved ones", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 75; index++)
      ids.push(
        (await brain.propose({ context: "YB", text: `candidate ${index}`, sessionId: "session" }))
          .id,
      );
    for (const id of ids.slice(60)) await brain.resolveProposal("YB", id, true);
    const listed = await brain.listProposals("YB");
    const pending = listed.filter((proposal) => proposal.status === "pending");
    const resolved = listed.filter((proposal) => proposal.status !== "pending");
    expect(pending.map((proposal) => proposal.id)).toEqual(ids.slice(0, 50));
    expect(resolved.map((proposal) => proposal.id)).toEqual(ids.slice(65).toReversed());
    expect((await brain.proposalCounts()).find((row) => row.context === "YB")?.pending).toBe(60);
  });
  it("migrates pending-only proposal stores without dropping proposal content", async () => {
    await brain.propose({ context: "Personal", text: "initialize", sessionId: "session_1" });
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
    );
    const id = NodeCrypto.randomUUID();
    try {
      db.exec(
        "DROP TABLE proposals; CREATE TABLE proposals (id TEXT PRIMARY KEY, context TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK(status='pending'));",
      );
      db.prepare("INSERT INTO proposals VALUES(?,?,?,?,'pending')").run(
        id,
        "Personal",
        "old_session",
        "legacy candidate",
      );
    } finally {
      db.close();
    }
    const migrated = createScopedBrain({ stateDir });
    expect(await migrated.listProposals("Personal")).toEqual([
      expect.objectContaining({ id, text: "legacy candidate", status: "pending", createdAt: null }),
    ]);
    await migrated.resolveProposal("Personal", id, true);
    expect((await migrated.listProposals("Personal"))[0]?.status).toBe("approved");
  });
  it("redacts failures and diagnostic categories contain no paths or content", async () => {
    const diagnostics: unknown[] = [];
    brain = createScopedBrain({ stateDir, diagnostic: (entry) => diagnostics.push(entry) });
    write("Personal/State/current.md", "private-error-marker");
    await expect(
      brain.read({ root, context: "Personal", path: "Personal/State/current.md" }),
    ).rejects.toThrow(REFUSAL);
    expect(diagnostics).toEqual([{ operation: "read", category: "source-hash" }]);
    expect(await brain.status({ root: NodePath.join(temp, "missing"), context: "Global" })).toEqual(
      {
        available: false,
        context: "Global",
      },
    );
  });
});

describe("optional persisted vectors", () => {
  const embeddings = {
    enabled: true,
    baseUrl: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
  };
  it("degrades embedding failure to FTS", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private endpoint error")));
    const result = await brain.search({ root, context: "Personal", query: "apple", embeddings });
    expect(result.embeddingStatus).toBe("unavailable");
    expect(result.results).toHaveLength(2);
  });
  it("returns FTS after the embedding deadline aborts and skips network calls during backoff", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const searching = brain.search({ root, context: "Personal", query: "apple", embeddings });
    expect(timeout).toHaveBeenCalledWith(15000);
    controller.abort(new DOMException("deadline reached", "TimeoutError"));
    expect(await searching).toMatchObject({
      embeddingStatus: "unavailable",
      results: expect.arrayContaining([expect.objectContaining({ text: "personal apple fruit" })]),
    });
    await brain.search({ root, context: "Personal", query: "apple", embeddings });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("persists float32 vectors and reuses them across factory instances", async () => {
    const fetch = vi.fn(async (_: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          embeddings: body.input.map((text: string) =>
            text.includes("personal") ? [1, 0] : [0, 1],
          ),
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      (await brain.search({ root, context: "Personal", query: "personal", embeddings }))
        .embeddingStatus,
    ).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
    const again = createScopedBrain({ stateDir });
    expect(
      (await again.search({ root, context: "Personal", query: "personal", embeddings }))
        .embeddingStatus,
    ).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(3);
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
      {
        readOnly: true,
      },
    );
    try {
      expect(
        db
          .prepare("SELECT length(vector) AS bytes FROM vectors")
          .all()
          .map((r) => r.bytes),
      ).toEqual([8, 8]);
    } finally {
      db.close();
    }
  });
  it("persists each completed vector batch when a later batch times out and backs off across instances", async () => {
    approve("Personal", "Personal/State/current.md", "apple ".repeat(6000));
    let calls = 0;
    const fetch = vi.fn(async (_: unknown, init: RequestInit) => {
      calls++;
      if (calls === 3) throw new DOMException("timed out", "TimeoutError");
      return new Response(
        JSON.stringify({ embeddings: JSON.parse(String(init.body)).input.map(() => [1, 0]) }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const first = await brain.search({ root, context: "Personal", query: "apple", embeddings });
    expect(first.embeddingStatus).toBe("unavailable");
    expect(first.results.length).toBeGreaterThan(0);
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
    );
    try {
      expect(db.prepare("SELECT count(*) AS count FROM vectors").get()!.count).toBe(16);
      const again = createScopedBrain({ stateDir });
      expect(
        (await again.search({ root, context: "Personal", query: "apple", embeddings }))
          .embeddingStatus,
      ).toBe("unavailable");
      expect(fetch).toHaveBeenCalledTimes(3);
      db.exec("UPDATE embedding_retries SET retry_after=0");
      expect(
        (await again.search({ root, context: "Personal", query: "apple", embeddings }))
          .embeddingStatus,
      ).toBe("ready");
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(db.prepare("SELECT count(*) AS count FROM vectors").get()!.count).toBe(24);
    } finally {
      db.close();
    }
  });
  it("backs off failed query embeddings without extending the original retry deadline", async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetch);
    await brain.search({ root, context: "Personal", query: "apple", embeddings });
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(stateDir, "d4-agent/brain/Personal.sqlite"),
      { readOnly: true },
    );
    try {
      const deadline = db.prepare("SELECT retry_after FROM embedding_retries").get()!.retry_after;
      await createScopedBrain({ stateDir }).search({
        root,
        context: "Personal",
        query: "apple",
        embeddings,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT retry_after FROM embedding_retries").get()!.retry_after).toBe(
        deadline,
      );
    } finally {
      db.close();
    }
  });
  it("revalidates after a source changes during network work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_: unknown, init: RequestInit) => {
        write("Personal/State/current.md", "changed during network");
        return new Response(
          JSON.stringify({ embeddings: JSON.parse(String(init.body)).input.map(() => [1, 0]) }),
        );
      }),
    );
    await expect(
      brain.search({ root, context: "Personal", query: "apple", embeddings }),
    ).rejects.toThrow(REFUSAL);
  });
});
