import * as ServerConfig from "../../../config.ts";
import * as HostProcess from "@d4research/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Filesystem boundary tests exercise native no-follow behavior.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

import { publishArtifact, safeDirectory, safeRead } from "./artifactFiles.ts";
import { exportResearchNote } from "./noteExport.ts";
import {
  readRunArtifact,
  resolveResearchRunDirectory,
  readResearchLedger,
  inheritedBudget,
  recordDelegationOutcome,
  type DelegationOutcome,
} from "./runArtifacts.ts";

const platform = HostProcess.Platform.defaultValue();
let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d4-notes-safety-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const outcome = (result: DelegationOutcome["result"]): DelegationOutcome => ({
  runId: "run-1",
  step: "1",
  visit: 1,
  requestedTarget: "codex:terra",
  resolvedTarget: "codex:terra",
  substituted: false,
  durationMs: 100,
  completedAtMs: Date.UTC(2026, 9, 28),
  result,
});
const exportInput = (folder: string) => ({
  folder,
  projectId: "project-1",
  threadId: "thread-1",
  runId: "run-1",
  seq: 1,
  text: "# Saved evidence\n",
});
const exportedDirectory = (input: ReturnType<typeof exportInput>) =>
  NodePath.join(
    input.folder,
    "projects",
    hash(input.projectId),
    "threads",
    hash(input.threadId),
    "runs",
    hash(input.runId),
  );

describe("research artifact file boundaries", () => {
  it("publishes new files without overwriting an existing artifact", async () => {
    const file = NodePath.join(root, "note.md");
    await publishArtifact(file, "first evidence", platform);
    await expect(publishArtifact(file, "replacement", platform)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await safeRead(file, platform)).toBe("first evidence");
    expect(await NodeFSP.readdir(root)).toEqual(["note.md"]);
  });

  it("refuses leaf symlinks for reads and publication without changing the target", async () => {
    const target = NodePath.join(root, "target.md");
    const link = NodePath.join(root, "linked.md");
    await NodeFSP.writeFile(target, "original");
    await NodeFSP.symlink(target, link);
    await expect(safeRead(link, platform)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(publishArtifact(link, "replacement", platform)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
    expect((await NodeFSP.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("refuses symlink directory leaves and ancestors before creating or reading children", async () => {
    const real = NodePath.join(root, "real");
    const link = NodePath.join(root, "linked");
    await NodeFSP.mkdir(real);
    await NodeFSP.writeFile(NodePath.join(real, "note.md"), "original");
    await NodeFSP.symlink(real, link, "dir");
    await expect(safeDirectory(link, false, platform)).rejects.toThrow("cannot contain symlinks");
    await expect(safeDirectory(NodePath.join(link, "nested"), true, platform)).rejects.toThrow(
      "cannot contain symlinks",
    );
    await expect(safeRead(NodePath.join(link, "note.md"), platform)).rejects.toThrow(
      "cannot contain symlinks",
    );
    await expect(publishArtifact(NodePath.join(link, "new.md"), "new", platform)).rejects.toThrow(
      "cannot contain symlinks",
    );
    expect(await NodeFSP.readdir(real)).toEqual(["note.md"]);
  });

  it("refuses symlink ancestors hidden by a parent traversal component", async () => {
    const scope = NodePath.join(root, "scope");
    const outside = NodePath.join(root, "outside");
    await NodeFSP.mkdir(scope);
    await NodeFSP.mkdir(NodePath.join(outside, "nested"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(outside, "secret.md"), "outside evidence");
    await NodeFSP.symlink(NodePath.join(outside, "nested"), NodePath.join(scope, "link"), "dir");
    // Preserve the raw traversal: path.join would normalize it before the filesystem sees it.
    await expect(safeRead(`${scope}/link/../secret.md`, platform)).rejects.toBeDefined();
    await expect(
      publishArtifact(`${scope}/link/../new.md`, "crossed boundary", platform),
    ).rejects.toBeDefined();
    expect(await NodeFSP.readdir(outside)).toEqual(["nested", "secret.md"]);
  });

  it("refuses relative destinations and hard-linked files", async () => {
    await expect(safeDirectory("relative/notes", true, platform)).rejects.toThrow("absolute path");
    const file = NodePath.join(root, "note.md");
    await NodeFSP.writeFile(file, "evidence");
    await NodeFSP.link(file, NodePath.join(root, "other.md"));
    await expect(safeRead(file, platform)).rejects.toThrow("supported regular file");
  });
});

describe("environment-local notes exports", () => {
  it.effect("hashes arbitrary context IDs and keeps every export within its exact scope", () =>
    Effect.gen(function* () {
      const input = {
        ...exportInput(root),
        projectId: "../../outside-project",
        threadId: "/absolute/thread\n---\nscope: global",
        runId: "../outside-run",
      };
      yield* exportResearchNote(input);
      const directory = exportedDirectory(input);
      const names = yield* Effect.promise(() => NodeFSP.readdir(directory));
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^001-[a-f0-9-]+\.md$/);
      expect(NodePath.relative(root, directory)).toBe(
        NodePath.join(
          "projects",
          hash(input.projectId),
          "threads",
          hash(input.threadId),
          "runs",
          hash(input.runId),
        ),
      );
      const text = yield* Effect.promise(() =>
        safeRead(NodePath.join(directory, names[0]!), platform),
      );
      expect(text).toContain("scope: project-thread\n");
      expect(text).toContain('thread: "/absolute/thread\\n---\\nscope: global"');
      expect(text).toContain(input.text);
      expect(yield* Effect.promise(() => NodeFSP.readdir(root))).toEqual(["projects"]);
    }),
  );

  it.effect("uses unique names for repeated sequence numbers and preserves earlier evidence", () =>
    Effect.gen(function* () {
      const input = exportInput(root);
      yield* exportResearchNote(input);
      const directory = exportedDirectory(input);
      const first = (yield* Effect.promise(() => NodeFSP.readdir(directory)))[0]!;
      const before = yield* Effect.promise(() =>
        safeRead(NodePath.join(directory, first), platform),
      );
      yield* exportResearchNote({ ...input, text: "second evidence" });
      expect(yield* Effect.promise(() => NodeFSP.readdir(directory))).toHaveLength(2);
      expect(yield* Effect.promise(() => safeRead(NodePath.join(directory, first), platform))).toBe(
        before,
      );
    }),
  );

  it.effect("fails for an unavailable folder without creating a new export root", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(root, "missing");
      expect((yield* Effect.exit(exportResearchNote(exportInput(missing))))._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readdir(root))).toEqual([]);
      const file = NodePath.join(root, "file");
      yield* Effect.promise(() => NodeFSP.writeFile(file, "original"));
      expect((yield* Effect.exit(exportResearchNote(exportInput(file))))._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toBe("original");
    }),
  );

  it.effect("refuses an existing symlink in the hashed export path", () =>
    Effect.gen(function* () {
      const input = exportInput(root);
      const outside = NodePath.join(root, "outside");
      yield* Effect.promise(() => NodeFSP.mkdir(outside));
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "projects")));
      yield* Effect.promise(() =>
        NodeFSP.symlink(outside, NodePath.join(root, "projects", hash(input.projectId)), "dir"),
      );
      expect((yield* Effect.exit(exportResearchNote(input)))._tag).toBe("Failure");
      expect(yield* Effect.promise(() => NodeFSP.readdir(outside))).toEqual([]);
    }),
  );

  it.effect.each(["success", "partial"] as const)(
    "redacts secrets from persisted and exported %s output",
    (kind) =>
      Effect.gen(function* () {
        const secret = "sk-123456789012345678901234567890";
        const vault = NodePath.join(root, "notes");
        yield* Effect.promise(() => NodeFSP.mkdir(vault));
        const runDirectory = NodePath.join(root, "workspace", "research-runs", "thread-1");
        const result: DelegationOutcome["result"] =
          kind === "success"
            ? { ok: true, text: `Evidence ${secret}`, truncated: false }
            : {
                ok: false,
                detail: `Interrupted ${secret}`,
                failureKind: "partial",
                partialText: `Partial evidence ${secret}`,
              };
        const entry = yield* recordDelegationOutcome({
          runDirectory,
          outcome: outcome(result),
          notes: { folder: vault, projectId: "project-1", threadId: "thread-1" },
        });
        expect(entry).not.toBeNull();
        const localText = yield* Effect.promise(() =>
          safeRead(NodePath.join(runDirectory, entry!.artifact), platform),
        );
        expect(localText).toContain("[REDACTED]");
        expect(localText).not.toContain(secret);
        if (kind === "partial") expect(localText).toContain("Partial output");
        const directory = exportedDirectory(exportInput(vault));
        const names = yield* Effect.promise(() => NodeFSP.readdir(directory));
        expect(names).toHaveLength(1);
        const exported = yield* Effect.promise(() =>
          safeRead(NodePath.join(directory, names[0]!), platform),
        );
        expect(exported).toContain(localText);
        expect(exported).not.toContain(secret);
        const read = yield* readRunArtifact({ runDirectory, artifact: entry!.artifact, offset: 0 });
        expect(read).toMatchObject({ ok: true, text: localText });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an artifact altered after recording", () =>
    Effect.gen(function* () {
      const runDirectory = NodePath.join(root, "research-runs", "thread-1");
      const entry = yield* recordDelegationOutcome({
        runDirectory,
        outcome: outcome({ ok: true, text: "original evidence", truncated: false }),
      });
      expect(entry).not.toBeNull();
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(runDirectory, entry!.artifact), "altered evidence"),
      );
      const read = yield* readRunArtifact({ runDirectory, artifact: entry!.artifact, offset: 0 });
      expect(read).toMatchObject({ ok: false });
      if (!read.ok) expect(read.detail).toContain("changed after recording");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains readable workspace evidence when export fails and preserves existing artifacts",
    () =>
      Effect.gen(function* () {
        const runDirectory = NodePath.join(root, "research-runs", "thread-1");
        const steps = NodePath.join(runDirectory, "steps");
        yield* Effect.promise(() => NodeFSP.mkdir(steps, { recursive: true }));
        const orphan = NodePath.join(steps, "001-step1-v1-codex-terra.md");
        yield* Effect.promise(() => NodeFSP.writeFile(orphan, "previous crash evidence"));
        const entry = yield* recordDelegationOutcome({
          runDirectory,
          outcome: outcome({ ok: true, text: "new evidence", truncated: false }),
          notes: {
            folder: NodePath.join(root, "missing-vault"),
            projectId: "project-1",
            threadId: "thread-1",
          },
        });
        expect(entry).not.toBeNull();
        expect(entry!.notesError).toContain("Notes export failed");
        expect(entry!.artifact).not.toBe("steps/001-step1-v1-codex-terra.md");
        expect(yield* Effect.promise(() => safeRead(orphan, platform))).toBe(
          "previous crash evidence",
        );
        const read = yield* readRunArtifact({ runDirectory, artifact: entry!.artifact, offset: 0 });
        expect(read).toMatchObject({ ok: true });
        if (read.ok) expect(read.text).toContain("new evidence");
        expect(yield* Effect.promise(() => NodeFSP.readdir(steps))).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("thread-scoped artifact evidence", () => {
  it.effect("isolates colliding legacy directory names by ledger identity", () =>
    Effect.gen(function* () {
      const runDirectory = NodePath.join(root, "runs");
      const own = yield* recordDelegationOutcome({
        runDirectory,
        outcome: {
          ...outcome({ ok: true, text: "own evidence", truncated: false }),
          runId: "a/b:run",
        },
        notes: { folder: "", projectId: "p", threadId: "a/b" },
      });
      const other = yield* recordDelegationOutcome({
        runDirectory,
        outcome: {
          ...outcome({ ok: true, text: "other evidence", truncated: false }),
          runId: "a-b:run",
        },
        notes: { folder: "", projectId: "p", threadId: "a-b" },
      });
      expect(
        (yield* readRunArtifact({
          runDirectory,
          artifact: other!.artifact,
          threadId: "a/b",
          offset: 0,
        })).ok,
      ).toBe(false);
      expect(
        (yield* readRunArtifact({
          runDirectory,
          artifact: own!.artifact,
          threadId: "a/b",
          offset: 0,
        })).ok,
      ).toBe(true);
      const ledger = yield* readRunArtifact({
        runDirectory,
        artifact: "ledger.jsonl",
        threadId: "a/b",
        offset: 0,
      });
      expect(ledger.ok && ledger.text).not.toContain("a-b:run");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps a completed record after a torn ledger tail and charges unfinished checkpoints once",
    () =>
      Effect.gen(function* () {
        const runDirectory = NodePath.join(root, "runs");
        yield* recordDelegationOutcome({
          runDirectory,
          outcome: outcome({
            ok: false,
            detail: "partial",
            failureKind: "partial",
            partialText: "first",
          }),
        });
        yield* recordDelegationOutcome({
          runDirectory,
          outcome: outcome({
            ok: false,
            detail: "partial",
            failureKind: "partial",
            partialText: "second",
          }),
        });
        const before = yield* readResearchLedger(runDirectory);
        expect(inheritedBudget(before, new Set(["run-1"])).total).toBe(1);
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(runDirectory, "ledger.jsonl"), '{"seq":'),
        );
        yield* recordDelegationOutcome({
          runDirectory,
          outcome: outcome({ ok: true, text: "complete", truncated: false }),
        });
        const after = yield* readResearchLedger(runDirectory);
        expect(after.at(-1)?.outcome).toBe("success");
        expect(inheritedBudget(after, new Set(["run-1"])).total).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("interrupted artifact transactions", () => {
  it("allows a reader to recover a publication before the writer cleans up", async () => {
    const file = NodePath.join(root, "note.md");
    const link = NodeFSP.link;
    vi.spyOn(NodeFSP, "link").mockImplementation(async (source, destination) => {
      await link(source, destination);
      expect(await safeRead(file, platform)).toBe("complete evidence");
    });
    await publishArtifact(file, "complete evidence", platform);
    expect(await safeRead(file, platform)).toBe("complete evidence");
    expect(await NodeFSP.readdir(root)).toEqual(["note.md"]);
  });

  it.effect("isolates unreadable receipts while retaining committed evidence and new saves", () =>
    Effect.gen(function* () {
      const directory = NodePath.join(root, "runs");
      const first = yield* recordDelegationOutcome({
        runDirectory: directory,
        outcome: outcome({ ok: true, text: "first", truncated: false }),
      });
      const receipt = NodePath.join(
        directory,
        "receipts",
        `${NodePath.basename(first!.artifact)}.json`,
      );
      yield* Effect.promise(async () => {
        await NodeFSP.unlink(receipt);
        await NodeFSP.symlink("missing", receipt);
        await NodeFSP.symlink("missing", NodePath.join(directory, "receipts", "orphan.json"));
      });
      expect(yield* readResearchLedger(directory)).toHaveLength(1);
      const second = yield* recordDelegationOutcome({
        runDirectory: directory,
        outcome: outcome({ ok: true, text: "second", truncated: false }),
      });
      expect(second?.seq).toBe(2);
      expect(yield* readResearchLedger(directory)).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("recovers the app-owned publication link after a crash", async () => {
    const file = NodePath.join(root, "note.md");
    const temporary = NodePath.join(root, ".d4-12345678-1234-1234-1234-123456789abc.tmp");
    await NodeFSP.writeFile(temporary, "complete evidence");
    await NodeFSP.link(temporary, file);
    expect(await safeRead(file, platform)).toBe("complete evidence");
    expect(await NodeFSP.readdir(root)).toEqual(["note.md"]);
  });

  it.effect(
    "recovers published evidence without its ledger line and refuses incomplete bytes",
    () =>
      Effect.gen(function* () {
        const directory = NodePath.join(root, "runs");
        const entry = yield* recordDelegationOutcome({
          runDirectory: directory,
          outcome: outcome({ ok: true, text: "durable answer", truncated: false }),
          notes: { folder: NodePath.join(root, "unavailable"), projectId: "p", threadId: "t" },
        });
        expect(entry).not.toBeNull();
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(directory, "ledger.jsonl")));
        const recovered = yield* readResearchLedger(directory);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.notesError).toContain("interrupted");
        expect(
          (yield* readRunArtifact({
            runDirectory: directory,
            artifact: entry!.artifact,
            threadId: "t",
            offset: 0,
          })).ok,
        ).toBe(true);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, entry!.artifact), "incomplete"),
        );
        expect(yield* readResearchLedger(directory)).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a thread's artifact location after the project workspace changes", () =>
    Effect.gen(function* () {
      const first = yield* resolveResearchRunDirectory(
        NodePath.join(root, "first"),
        "thread",
        true,
      );
      const after = yield* resolveResearchRunDirectory(NodePath.join(root, "second"), "thread");
      expect(after).toBe(first);
      expect(
        yield* resolveResearchRunDirectory(NodePath.join(root, "second"), "other-thread"),
      ).not.toBe(first);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(root, NodePath.join(root, "config")).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
