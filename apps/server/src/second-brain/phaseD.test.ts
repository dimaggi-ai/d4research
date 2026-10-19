import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { SecondBrainError } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as Brain from "./SecondBrainService.ts";
import * as Files from "./SecondBrainFiles.ts";
import * as Index from "./SecondBrainIndex.ts";
import { NOTE_BYTES } from "./noteDocument.ts";
import { withBrain } from "./testkit.ts";

const proposal = (path = "notes/new.md") => ({
  path,
  kind: "note" as const,
  operation: "create" as const,
  content: "# New\nDurable knowledge",
  expectedHash: null,
  rationale: "Keep",
  evidence: [],
});

it.effect("indexes 1000 notes with eight links and serves catalog and lint under 500 ms", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const brain = yield* Brain.SecondBrainService;
      yield* fs.makeDirectory(`${root}/notes`);
      for (let n = 0; n < 1000; n++)
        yield* fs.writeFileString(
          `${root}/notes/n-${n}.md`,
          `# N ${n}\n` +
            Array.from({ length: 8 }, (_, i) => `[[n-${(n + i + 1) % 1000}]]`).join("\n"),
        );
      yield* brain.reindex();
      const start = performance.now();
      const map = yield* brain.map();
      const lint = yield* brain.lint();
      const elapsed = performance.now() - start;
      expect(map.catalog).toHaveLength(1000);
      expect(map.catalog.every((n) => n.inboundLinks === 8)).toBe(true);
      expect((yield* brain.backlinks("notes/n-0.md")).paths).toHaveLength(8);
      expect(lint.issues.some((i) => i.code === "broken_link")).toBe(false);
      expect(elapsed).toBeLessThan(500);
      yield* Effect.logInfo(`1000-note catalog + lint: ${elapsed.toFixed(1)} ms`);
    }),
  ),
);

it.effect("preserves handwritten index while status search map and turn context stay usable", () =>
  withBrain(
    (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const brain = yield* Brain.SecondBrainService;
        yield* fs.writeFileString(`${root}/INDEX.md`, "Handwritten index");
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Preferences\nConcise answers");
        expect((yield* brain.status()).notes).toBe(1);
        expect((yield* brain.search({ query: "Concise" })).results).toHaveLength(1);
        expect((yield* brain.map()).catalog).toHaveLength(1);
        expect(
          (yield* brain.buildTurnContext({ userText: "Concise", includeCore: true })).core,
        ).toContain("Concise");
        expect((yield* brain.lint()).issues).toContainEqual({
          path: "INDEX.md",
          code: "index_generation_skipped",
        });
        expect(yield* fs.readFileString(`${root}/INDEX.md`)).toBe("Handwritten index");
      }),
    { generateIndex: true },
  ),
);

it.effect("skips unsafe and vanished scan entries without weakening direct reads or writes", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* Files.SecondBrainFiles;
      const brain = yield* Brain.SecondBrainService;
      yield* fs.writeFileString(`${root}/safe.md`, "# Safe\nUseful fact");
      yield* fs.writeFileString(`${root}/gone.md`, "# Gone");
      yield* fs.symlink(`${root}/safe.md`, `${root}/unsafe.md`);
      const read = files.read;
      const mock = vi
        .spyOn(files, "read")
        .mockImplementation((vault, path) =>
          path === "gone.md"
            ? Effect.fail(new SecondBrainError({ code: "not_found" }))
            : read(vault, path),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => mock.mockRestore()));
      expect((yield* brain.status()).notes).toBe(1);
      expect((yield* brain.lint()).issues).toEqual(
        expect.arrayContaining([
          { path: "gone.md", code: "not_found" },
          { path: "unsafe.md", code: "unsafe_path" },
        ]),
      );
      expect((yield* files.read(root, "unsafe.md").pipe(Effect.flip)).code).toBe("unsafe_path");
      expect((yield* files.write(root, "unsafe.md", "bad", null).pipe(Effect.flip)).code).toBe(
        "unsafe_path",
      );
    }),
  ),
);

it.effect(
  "rotates a full log and accepts despite concurrent log edits or oversized legacy logs",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const brain = yield* Brain.SecondBrainService;
        const files = yield* Files.SecondBrainFiles;
        const index = yield* Index.SecondBrainIndex;
        yield* fs.writeFileString(`${root}/log.md`, "x".repeat(NOTE_BYTES));
        const p = yield* brain.propose(proposal(), "agent");
        expect((yield* brain.acceptProposal(p.id, "human")).state).toBe("accepted");
        const log = yield* files.read(root, "log.md");
        expect(log.size).toBeLessThan(NOTE_BYTES / 2);
        expect(log.content).toContain("notes/new.md");
        const audits: Index.AuditEntry[] = [];
        const audit = index.audit;
        const auditSpy = vi.spyOn(index, "audit").mockImplementation((entry) => {
          audits.push(entry);
          return audit(entry);
        });
        const write = files.write;
        const writeSpy = vi
          .spyOn(files, "write")
          .mockImplementation((vault, path, content, hash) =>
            path === "log.md"
              ? Effect.fail(new SecondBrainError({ code: "stale_revision" }))
              : write(vault, path, content, hash),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            auditSpy.mockRestore();
            writeSpy.mockRestore();
          }),
        );
        const next = yield* brain.propose(proposal("notes/next.md"), "agent");
        expect((yield* brain.acceptProposal(next.id, "human")).state).toBe("accepted");
        expect(audits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              proposalId: next.id,
              state: "applied",
              logStatus: "skipped",
            }),
          ]),
        );
        writeSpy.mockRestore();
        yield* fs.writeFileString(`${root}/log.md`, "x".repeat(NOTE_BYTES + 1));
        const last = yield* brain.propose(proposal("notes/last.md"), "agent");
        expect((yield* brain.acceptProposal(last.id, "human")).state).toBe("accepted");
        expect(yield* index.pendingAudits(root)).toEqual([]);
        expect((yield* brain.status()).enabled).toBe(true);
      }),
    ),
);

it.effect(
  "reuses decoded snapshots and skips scans until reconciliation is due; lint does not force writes",
  () =>
    withBrain(
      (root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const files = yield* Files.SecondBrainFiles;
          const index = yield* Index.SecondBrainIndex;
          const brain = yield* Brain.SecondBrainService;
          yield* fs.writeFileString(`${root}/a.md`, "# Alpha\nA fact");
          yield* brain.status();
          const first = yield* index.snapshot(root);
          const walk = vi.spyOn(files, "walk");
          const write = vi.spyOn(files, "write");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              walk.mockRestore();
              write.mockRestore();
            }),
          );
          yield* fs.writeFileString(`${root}/b.md`, "# Beta");
          yield* brain.reconcile();
          yield* brain.search({ query: "Alpha" });
          yield* brain.buildTurnContext({ userText: "Alpha", includeCore: false });
          yield* brain.lint();
          expect(walk).not.toHaveBeenCalled();
          expect(write).not.toHaveBeenCalled();
          expect(yield* index.snapshot(root)).toBe(first);
          yield* TestClock.adjust("61 seconds");
          expect((yield* brain.reconcile()).notes).toBe(2);
          expect(walk).toHaveBeenCalledTimes(1);
          expect(yield* index.snapshot(root)).not.toBe(first);
        }),
      { generateIndex: true, reconcileIntervalSeconds: 60 },
    ),
);

it.effect(
  "keeps raw and log searchable but excludes retrieval and core resend for their changes",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const brain = yield* Brain.SecondBrainService;
        yield* fs.makeDirectory(`${root}/raw`);
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Preferences\nConcise answers");
        const input = { userText: "sourceword", includeCore: false, providerThreadId: "provider" };
        const first = yield* brain.buildTurnContext(input);
        yield* brain.markContextDelivered(first);
        yield* fs.writeFileString(`${root}/raw/source.md`, "# sourceword\nUnreviewed sourceword");
        yield* fs.writeFileString(`${root}/log.md`, "# sourceword\nOperation sourceword");
        yield* brain.reindex();
        expect((yield* brain.search({ query: "sourceword" })).results).toHaveLength(2);
        const next = yield* brain.buildTurnContext(input);
        expect(next.core).toBe("");
        expect(next.retrieved).toBe("");
        expect(next.delivery).toBeUndefined();
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Preferences\nDetailed answers");
        yield* brain.reindex();
        expect((yield* brain.buildTurnContext(input)).core).toContain("Detailed");
      }),
    ),
);
