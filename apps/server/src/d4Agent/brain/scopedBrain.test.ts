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
const scratch = NodeOS.tmpdir();
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
  it.each(["hash", "duplicate", "manifest-shape", "entry-shape", "json", "missing-global"])(
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
  it("reports cached statuses without reading or rebuilding vault notes", async () => {
    await brain.status({ root, context: "Personal" });
    NodeFS.unlinkSync(NodePath.join(root, "Personal/State/current.md"));
    write("Global/sources.json", "invalid manifest");
    const statuses = await brain.indexStatuses({ root });
    expect(statuses.find((s) => s.context === "Personal")).toMatchObject({
      status: "ready",
      files: 2,
    });
    expect(statuses.find((s) => s.context === "Global")).toMatchObject({
      status: "not-available",
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
