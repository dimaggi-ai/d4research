import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Brain from "./SecondBrainService.ts";
import * as Index from "./SecondBrainIndex.ts";
import { withBrain } from "./testkit.ts";
import { applyEdit } from "./noteDocument.ts";
import { redactSecrets, assertNoSecrets } from "./secrets.ts";

it.effect(
  "delivers core once, retrieves every turn, resends changed generation and handoff core",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const brain = yield* Brain.SecondBrainService;
        yield* fs.makeDirectory(`${root}/projects`);
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Memory\nQuartz preferences");
        yield* fs.writeFileString(
          `${root}/projects/atlas.md`,
          "---\nkind: project\nsummary: Atlas\nstatus: active\n---\n# Atlas\n## Status\nQuartz research\n## Next steps\nRead evidence",
        );
        const input = {
          userText: "Quartz",
          includeCore: true,
          providerThreadId: "native",
          projectTitle: "Atlas",
        };
        const first = yield* brain.buildTurnContext(input);
        expect(first.core).toContain("MEMORY.md");
        expect(first.core).toContain("Read evidence");
        expect(first.core).toContain("Catalog:");
        expect(first.retrieved).toContain("[brain:");
        expect(Brain.formatTurnContext(first)).toContain("<second_brain_context>");
        yield* brain.markContextDelivered(first);
        const second = yield* brain.buildTurnContext({ ...input, includeCore: false });
        expect(second.core).toBe("");
        expect(second.retrieved).toContain("Quartz");
        yield* brain.reindex();
        expect((yield* brain.buildTurnContext({ ...input, includeCore: false })).core).toBe("");
        yield* fs.writeFileString(`${root}/MEMORY.md`, "# Memory\nChanged Quartz preferences");
        yield* brain.reindex();
        expect((yield* brain.buildTurnContext({ ...input, includeCore: false })).core).toContain(
          "Changed",
        );
        expect((yield* brain.buildTurnContext(input)).core).toContain("Changed");
        expect((yield* brain.buildTurnContext({ ...input, userText: "/compact" })).policy).toBe("");
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ secondBrain: { injection: { enabled: false } } });
        expect((yield* brain.buildTurnContext(input)).policy).toBe("");
        yield* settings.updateSettings({ secondBrain: { path: "", injection: { enabled: true } } });
        expect((yield* brain.buildTurnContext(input)).policy).toBe("");
        expect(input.userText).toBe("Quartz");
      }),
    ),
);
it.effect(
  "applies surgical edits, rejects stale hashes, updates metadata and logs each accepted write",
  () =>
    withBrain(() =>
      Effect.gen(function* () {
        const brain = yield* Brain.SecondBrainService;
        const base = {
          path: "notes/alpha.md",
          kind: "note" as const,
          rationale: "requested",
          evidence: [],
        };
        const created = yield* brain.propose(
          {
            ...base,
            operation: "create",
            content: "---\ntitle: Alpha\n---\n# Alpha\n## State\nOld\n## Other\nKeep",
            expectedHash: null,
          },
          "agent",
        );
        yield* brain.acceptProposal(created.id, "human");
        let current = yield* brain.read({ path: base.path });
        expect(current.content).toContain("updated:");
        for (const edit of [
          { operation: "patch_section" as const, heading: "State", content: "New" },
          { operation: "str_replace" as const, oldStr: "New", newStr: "Better", content: "" },
          { operation: "supersede" as const, oldStr: "Better", content: "Best" },
          { operation: "append" as const, content: "End" },
        ]) {
          const p = yield* brain.propose({ ...base, ...edit, expectedHash: current.hash }, "agent");
          yield* brain.acceptProposal(p.id, "human");
          current = yield* brain.read({ path: base.path });
        }
        expect(current.content).toContain("~~Better~~ (superseded");
        expect(current.content).toContain("## Other\nKeep");
        expect(current.content).toContain("End");
        const stale = yield* brain
          .propose(
            { ...base, operation: "replace_file", content: "# Changed", expectedHash: "wrong" },
            "agent",
          )
          .pipe(Effect.result);
        expect(stale._tag).toBe("Failure");
        const replacement = yield* brain.propose(
          { ...base, operation: "replace_file", content: "# Changed", expectedHash: current.hash },
          "agent",
        );
        yield* brain.acceptProposal(replacement.id, "human");
        expect((yield* brain.read({ path: base.path })).content).toBe("# Changed");
        const log = yield* brain.read({ path: "log.md" });
        expect(log.content.match(/^## \[/gm)).toHaveLength(6);
        yield* brain.status();
        expect((yield* brain.read({ path: "log.md" })).content).toBe(log.content);
      }),
    ),
);
it("refuses ambiguous or absent str_replace matches", () => {
  for (const previous of ["same same", "other"]) {
    expect(() =>
      applyEdit(previous, {
        path: "x.md",
        kind: "note",
        operation: "str_replace",
        content: "",
        oldStr: "same",
        newStr: "new",
        expectedHash: "hash",
      }),
    ).toThrow();
  }
});
it.effect("warns about duplicate creates and keeps raw sources immutable in review mode", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const brain = yield* Brain.SecondBrainService;
      yield* fs.makeDirectory(`${root}/notes`);
      yield* fs.writeFileString(`${root}/notes/atlas.md`, "# Atlas\nResearch");
      const p = yield* brain.propose(
        {
          path: "notes/atlass.md",
          kind: "note",
          operation: "create",
          content: "# Atlass",
          expectedHash: null,
          rationale: "requested",
          evidence: [],
        },
        "agent",
      );
      expect(p.possibleDuplicates?.[0]?.path).toBe("notes/atlas.md");
      const source = yield* brain.ingest(
        { sourceTitle: "Atlas source", sourceText: "Source material" },
        "agent",
      );
      expect(source.path).toMatch(/^raw\/\d{4}-\d{2}-\d{2}-atlas-source.md$/);
      expect(
        (yield* brain
          .ingest({ sourceTitle: "Atlas source", sourceText: "Changed" }, "agent")
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const raw = yield* brain.read({ path: source.path });
      expect(raw.content).toBe("Source material");
      expect(
        (yield* brain
          .propose(
            {
              path: source.path,
              kind: "note",
              operation: "append",
              content: "Changed",
              expectedHash: raw.hash,
              rationale: "requested",
              evidence: [],
            },
            "agent",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* brain.lint()).issues).toEqual(
        expect.arrayContaining([
          { path: source.path, code: "unreferenced_raw" },
          { path: "notes/atlas.md", code: "orphan" },
          { path: "notes/atlas.md", code: "missing_summary" },
        ]),
      );
      expect((yield* brain.read({ path: "log.md" })).content).toContain("ingest | raw/");
    }),
  ),
);
it.effect("records ADR and project link as proposals, supporting the single-file convention", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const brain = yield* Brain.SecondBrainService;
      yield* fs.makeDirectory(`${root}/projects`);
      yield* fs.writeFileString(`${root}/projects/atlas.md`, "---\nkind: project\n---\n# Atlas");
      const input = {
        title: "Local storage",
        context: "Offline",
        decision: "Use local storage",
        consequences: "No cloud",
        project: "projects/atlas.md",
      };
      const proposals = yield* brain.recordDecision(input, "agent");
      expect(proposals.map((p) => p.path)).toEqual([
        "decisions/local-storage.md",
        "projects/atlas.md",
      ]);
      expect(proposals[1]?.content).toContain("[[decisions/local-storage.md]]");
      yield* fs.writeFileString(`${root}/decisions.md`, "# Decisions");
      expect((yield* brain.recordDecision(input, "agent"))[0]?.operation).toBe("append");
    }),
  ),
);
it.each([
  "sk-abcdefghijklmnopqrstuvwxyz1234",
  "ghp_abcdefghijklmnopqrstuvwxyz",
  "github_pat_abcdefghijklmnopqrstuvwxyz",
  "AKIAABCDEFGHIJKLMNOP",
  "xoxb-1234567890123456789012",
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "API_KEY=abcdefghijklmnopqrstuvwxyz",
  "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
])("redacts and rejects high-confidence secret %s", (secret) => {
  expect(redactSecrets(secret)).toBe("[REDACTED]");
  expect(() => assertNoSecrets(secret)).toThrow();
});
it.effect("secret gate protects proposals, direct writes, evidence, ingest and the log", () =>
  withBrain(
    () =>
      Effect.gen(function* () {
        const brain = yield* Brain.SecondBrainService;
        const index = yield* Index.SecondBrainIndex;
        const edit = {
          path: "notes/secret.md",
          kind: "note" as const,
          operation: "create" as const,
          content: "sk-abcdefghijklmnopqrstuvwxyz1234",
          expectedHash: null,
        };
        for (const action of [
          brain.propose({ ...edit, rationale: "x", evidence: [] }, "agent"),
          brain.propose(
            {
              ...edit,
              content: "# Safe",
              rationale: "x",
              evidence: [{ threadId: "t", messageId: "m", quote: edit.content }],
            },
            "agent",
          ),
          brain.write(edit, "agent"),
          brain.ingest({ sourceTitle: "secret", sourceText: edit.content }, "agent"),
        ]) {
          const result = yield* Effect.result(
            action as Effect.Effect<unknown, import("@d4research/contracts").SecondBrainError>,
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.code).toBe("secret_detected");
        }
        expect(yield* brain.listProposals({})).toEqual([]);
        expect((yield* brain.read({ path: "log.md" }).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* index.pendingCaptures()).toEqual([]);
      }),
    { writeMode: "direct" },
  ),
);
