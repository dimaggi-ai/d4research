import { BrainSearchResponse, BrainReadResult } from "@d4research/contracts";
import * as Schema from "effect/Schema";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Service from "./SecondBrainService.ts";
import * as Index from "./SecondBrainIndex.ts";
import { withBrain } from "./testkit.ts";
import { contentHash, noteTemplate, INDEX_MARKER } from "./noteDocument.ts";

const encodeReadResult = Schema.encodeSync(Schema.fromJsonString(BrainReadResult));
const encodeSearchResponse = Schema.encodeSync(Schema.fromJsonString(BrainSearchResponse));
const proposal = {
  path: "notes/alpha.md",
  kind: "note" as const,
  operation: "create" as const,
  content: "# Alpha\nDurable knowledge",
  expectedHash: null,
  rationale: "User requested storage",
  evidence: [{ threadId: "t", messageId: "m", quote: "remember" }],
};
it.effect(
  "ranks headings, filters metadata, abstains and removes deleted or revised evidence",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SecondBrainService;
        yield* fs.makeDirectory(`${root}/notes`);
        yield* fs.writeFileString(
          `${root}/notes/a.md`,
          "---\ntags: [chosen]\n---\n# Quartz\nA mineral",
        );
        yield* fs.writeFileString(`${root}/notes/b.md`, "# Other\nQuartz occurs here.");
        const search = yield* service.search({ query: "quartz" });
        expect(search.results[0]?.citation.path).toBe("notes/a.md");
        expect(search.semanticStatus).toBe("disabled");
        expect((yield* service.search({ query: "quartz", tag: "chosen" })).results).toHaveLength(1);
        expect((yield* service.search({ query: '" OR * NOT : -' })).abstain).toBe(true);
        yield* fs.remove(`${root}/notes/a.md`);
        yield* fs.writeFileString(`${root}/notes/b.md`, "# Changed\nNo mineral");
        expect((yield* service.search({ query: "quartz" })).abstain).toBe(true);
        yield* service.reindex();
        expect((yield* service.status()).notes).toBe(1);
      }),
    ),
);
it.effect(
  "review mode prohibits writes, accepts once, rejects duplicates and records conflicts",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SecondBrainService;
        expect((yield* service.write(proposal, "agent").pipe(Effect.result))._tag).toBe("Failure");
        const pending = yield* service.propose(proposal, "agent");
        expect(yield* fs.exists(`${root}/notes/alpha.md`)).toBe(false);
        expect((yield* service.propose(proposal, "agent")).id).toBe(pending.id);
        expect((yield* service.acceptProposal(pending.id, "human")).state).toBe("accepted");
        expect((yield* service.acceptProposal(pending.id, "human").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const data = yield* service.read({ path: proposal.path });
        const edit = {
          ...proposal,
          operation: "append" as const,
          content: "Addition",
          expectedHash: data.hash,
        };
        const rejected = yield* service.propose(edit, "agent");
        yield* service.rejectProposal(rejected.id, "human", "not supported");
        expect((yield* service.propose(edit, "agent")).state).toBe("rejected");
        const conflict = yield* service.propose({ ...edit, content: "Different" }, "agent");
        yield* fs.writeFileString(`${root}/${proposal.path}`, "external edit");
        expect((yield* service.acceptProposal(conflict.id, "human")).state).toBe("conflict");
        expect(yield* fs.readFileString(`${root}/${proposal.path}`)).toBe("external edit");
        yield* service.reindex();
        expect((yield* service.getProposal(pending.id)).state).toBe("accepted");
      }),
    ),
);
it.effect("serializes concurrent direct writes and audits them", () =>
  withBrain(
    () =>
      Effect.gen(function* () {
        const service = yield* Service.SecondBrainService;
        yield* service.write(proposal, "agent");
        const old = yield* service.read({ path: proposal.path });
        const edits = yield* Effect.all(
          ["one", "two"].map((content) =>
            service
              .write({ ...proposal, operation: "append", content, expectedHash: old.hash }, "agent")
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(edits.filter((x) => x._tag === "Success")).toHaveLength(1);
        const index = yield* Index.SecondBrainIndex;
        expect(yield* index.pendingAudits((yield* service.status()).vault!)).toEqual([]);
      }),
    { writeMode: "direct" },
  ),
);
it.effect("recovers an interrupted acceptance from the durable audit journal", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const service = yield* Service.SecondBrainService;
      const index = yield* Index.SecondBrainIndex;
      const fs = yield* FileSystem.FileSystem;
      const p = yield* service.propose(proposal, "agent");
      yield* index.audit({
        id: "journal",
        vault: root,
        path: p.path,
        proposalId: p.id,
        operation: "create",
        oldHash: null,
        newHash: contentHash(p.content),
        actor: "human",
        timestamp: "2026-01-01T00:00:00Z",
        state: "prepared",
      });
      yield* fs.makeDirectory(`${root}/notes`);
      yield* fs.writeFileString(`${root}/${p.path}`, p.content);
      expect((yield* service.getProposal(p.id)).state).toBe("accepted");
      expect(yield* index.pendingAudits(root)).toEqual([]);
    }),
  ),
);
it.effect("changes roots without mixing proposals and reconciles when stale", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const service = yield* Service.SecondBrainService;
      const settings = yield* ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const p = yield* service.propose(proposal, "agent");
      yield* service.status();
      yield* fs.writeFileString(`${root}/new.md`, "new");
      expect((yield* service.status()).notes).toBe(0);
      yield* TestClock.adjust("301 seconds");
      expect((yield* service.status()).notes).toBe(1);
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "other-brain-" });
      yield* settings.updateSettings({ secondBrain: { path: other } });
      expect((yield* service.getProposal(p.id).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* service.status()).notes).toBe(0);
      yield* fs.writeFileString(`${root}/changed-while-away.md`, "# Updated");
      yield* settings.updateSettings({ secondBrain: { path: root } });
      expect((yield* service.status()).notes).toBe(2);
      expect((yield* service.getProposal(p.id)).id).toBe(p.id);
    }),
  ),
);
it.effect(
  "builds bounded first-turn core and ordinary-turn retrieval, skips slash and disabled injection",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SecondBrainService;
        const settings = yield* ServerSettingsService;
        yield* fs.writeFileString(`${root}/AGENTS.md`, "# Map\n@MEMORY.md\n@other.md");
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Core\nPersonal quartz fact");
        yield* fs.writeFileString(`${root}/other.md`, "# Other\n@AGENTS.md\nMore data");
        const first = yield* service.buildTurnContext({ userText: "quartz", includeCore: true });
        expect(first.core).toContain("Personal quartz fact");
        expect(first.retrieved).toContain("#L");
        expect(first.policy).toContain("untrusted");
        const next = yield* service.buildTurnContext({ userText: "quartz", includeCore: false });
        expect(next.core).toBe("");
        expect(next.retrieved).not.toBe("");
        expect(
          (yield* service.buildTurnContext({ userText: " /compact", includeCore: true })).policy,
        ).toBe("");
        yield* settings.updateSettings({
          secondBrain: { injection: { coreBudgetChars: 45, retrievalBudgetChars: 40 } },
        });
        const bounded = yield* service.buildTurnContext({ userText: "quartz", includeCore: true });
        expect(bounded.core.length).toBeLessThanOrEqual(45);
        expect(bounded.retrieved.length).toBeLessThanOrEqual(40);
        yield* settings.updateSettings({ secondBrain: { injection: { enabled: false } } });
        expect(
          (yield* service.buildTurnContext({ userText: "quartz", includeCore: true })).core,
        ).toBe("");
      }),
    ),
);
it.effect("map imports cannot traverse symlinks", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Service.SecondBrainService;
      yield* fs.writeFileString(`${root}/AGENTS.md`, "@linked.md");
      yield* service.reindex();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "outside-map-" });
      yield* fs.writeFileString(`${outside}/secret.md`, "secret");
      yield* fs.symlink(`${outside}/secret.md`, `${root}/linked.md`);
      expect((yield* service.map().pipe(Effect.result))._tag).toBe("Failure");
    }),
  ),
);
it.effect("finds backlinks and lint issues without renaming notes", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Service.SecondBrainService;
      yield* fs.makeDirectory(`${root}/projects`);
      yield* fs.writeFileString(
        `${root}/projects/stale.md`,
        noteTemplate("project", "Stale", "same", "1960-01-01"),
      );
      yield* fs.writeFileString(`${root}/Bad Name.md`, "# Duplicate\n[[Stale]] [[missing]]");
      yield* fs.writeFileString(`${root}/duplicate.md`, "# Duplicate\n[[Duplicate]]");
      expect((yield* service.backlinks("projects/stale.md")).paths).toEqual(["Bad Name.md"]);
      const codes = (yield* service.lint()).issues.map((i) => i.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "naming",
          "broken_link",
          "ambiguous_link",
          "duplicate_title",
          "stale_project",
        ]),
      );
      expect(yield* fs.exists(`${root}/Bad Name.md`)).toBe(true);
    }),
  ),
);
it.effect("generates a deterministic marked index and preserves human INDEX.md", () =>
  withBrain(
    (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SecondBrainService;
        yield* fs.writeFileString(`${root}/a.md`, "# A\nA fact");
        yield* service.reindex();
        const text = yield* fs.readFileString(`${root}/INDEX.md`);
        expect(text).toContain(INDEX_MARKER);
        yield* service.reindex();
        expect(yield* fs.readFileString(`${root}/INDEX.md`)).toBe(text);
        yield* fs.writeFileString(`${root}/INDEX.md`, "human index");
        expect((yield* service.reindex().pipe(Effect.result))._tag).toBe("Success");
        expect(yield* fs.readFileString(`${root}/INDEX.md`)).toBe("human index");
      }),
    { generateIndex: true },
  ),
);
it.effect("bounds read responses and validates line ranges", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Service.SecondBrainService;
      yield* fs.writeFileString(`${root}/a.md`, "line\n".repeat(60000));
      const read = yield* service.read({ path: "a.md" });
      expect(read.truncated).toBe(true);
      expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(262144);
      expect(Buffer.byteLength(encodeReadResult(read))).toBeLessThanOrEqual(262144);
      expect(
        (yield* service.read({ path: "a.md", startLine: 3, endLine: 2 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* service.read({ path: "a.md", startLine: 2, endLine: 3 })).content).toBe(
        "line\nline",
      );
    }),
  ),
);
it.effect("reports a disabled vault without accessing a configured directory", () =>
  withBrain(() =>
    Effect.gen(function* () {
      const service = yield* Service.SecondBrainService;
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ secondBrain: { path: "" } });
      expect((yield* service.status()).enabled).toBe(false);
      expect(
        (yield* service.buildTurnContext({ userText: "anything", includeCore: true })).citations,
      ).toEqual([]);
    }),
  ),
);
it.effect("bounds aggregate Unicode search responses", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Service.SecondBrainService;
      for (let i = 0; i < 50; i++)
        yield* fs.writeFileString(`${root}/note-${i}.md`, `# Common ${i}\n${"世".repeat(4000)}`);
      const result = yield* service.search({ query: "common", limit: 50 });
      expect(result.truncated).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(encodeSearchResponse(result))).toBeLessThanOrEqual(262144);
    }),
  ),
);
