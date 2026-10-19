import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Brain from "./SecondBrainService.ts";
import { withBrain } from "./testkit.ts";

it.effect("reviews current content and accepts an audited human replacement", () =>
  withBrain(() =>
    Effect.gen(function* () {
      const brain = yield* Brain.SecondBrainService;
      const proposal = yield* brain.propose(
        {
          path: "notes/alpha.md",
          kind: "note",
          operation: "create",
          content: "# Alpha\nOriginal",
          expectedHash: null,
          rationale: "Keep a fact",
          evidence: [{ threadId: "thread", messageId: "message", quote: "Original" }],
        },
        "agent",
      );
      const detail = yield* brain.reviewProposal(proposal.id);
      expect(detail).toMatchObject({ currentHash: null, conflict: false, truncated: false });
      expect(detail.diff).toContain("+# Alpha");
      expect(detail.proposal.evidence[0]?.messageId).toBe("message");
      const summaries = yield* brain.listProposalSummaries({
        state: "pending",
        offset: 0,
        limit: 1,
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).not.toHaveProperty("content");
      expect(yield* brain.listProposalSummaries({ state: "pending", offset: 1, limit: 1 })).toEqual(
        [],
      );
      const accepted = yield* brain.acceptProposal(proposal.id, "human-session", {
        id: proposal.id,
        expectedHash: null,
        contentOverride: "# Alpha\nReviewed",
      });
      expect(accepted.state).toBe("accepted");
      expect((yield* brain.reviewProposal(proposal.id)).conflict).toBe(false);
      expect(yield* brain.listProposalSummaries({ state: "pending" })).toEqual([]);
      expect(yield* brain.listProposalSummaries({ state: "accepted" })).toHaveLength(1);
      expect((yield* brain.read({ path: proposal.path })).content).toContain("Reviewed");
      expect((yield* brain.read({ path: "log.md" })).content).toContain(proposal.path);
    }),
  ),
);

it.effect("detects external edits and refuses stale acceptance without overwriting", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const brain = yield* Brain.SecondBrainService;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/notes`);
      yield* fs.writeFileString(`${root}/notes/alpha.md`, "# Alpha\nBefore");
      const before = yield* brain.read({ path: "notes/alpha.md" });
      const p = yield* brain.propose(
        {
          path: "notes/alpha.md",
          kind: "note",
          operation: "append",
          content: "Additional",
          expectedHash: before.hash,
          rationale: "Keep",
          evidence: [],
        },
        "agent",
      );
      expect((yield* brain.reviewProposal(p.id)).conflict).toBe(false);
      yield* fs.writeFileString(`${root}/notes/alpha.md`, "# Alpha\nExternal");
      const detail = yield* brain.reviewProposal(p.id);
      expect(detail.conflict).toBe(true);
      expect(detail.diff).toContain("+Additional");
      expect(
        yield* brain
          .acceptProposal(p.id, "human", { id: p.id, expectedHash: detail.currentHash })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "stale_revision" });
      expect(
        (yield* brain.acceptProposal(p.id, "human", { id: p.id, expectedHash: before.hash })).state,
      ).toBe("conflict");
      expect((yield* brain.read({ path: p.path })).content).toBe("# Alpha\nExternal");
      expect((yield* brain.rejectProposal(p.id, "human", "Changed externally")).state).toBe(
        "rejected",
      );
    }),
  ),
);

it.effect("validates edited note kinds and preserves pending proposals on invalid overrides", () =>
  withBrain(() =>
    Effect.gen(function* () {
      const brain = yield* Brain.SecondBrainService;
      const p = yield* brain.propose(
        {
          path: "notes/alpha.md",
          kind: "note",
          operation: "create",
          content: "# Alpha",
          expectedHash: null,
          rationale: "Keep",
          evidence: [],
        },
        "agent",
      );
      expect(
        yield* brain
          .acceptProposal(p.id, "human", {
            id: p.id,
            expectedHash: null,
            contentOverride: "---\nkind: person\n---\n# Alpha",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "malformed" });
      expect((yield* brain.getProposal(p.id)).state).toBe("pending");
    }),
  ),
);

it.effect("refuses oversized review details rather than presenting an incomplete diff", () =>
  withBrain(() =>
    Effect.gen(function* () {
      const brain = yield* Brain.SecondBrainService;
      const p = yield* brain.propose(
        {
          path: "notes/large.md",
          kind: "note",
          operation: "create",
          content: "# Large\n" + "long note ".repeat(20000),
          expectedHash: null,
          rationale: "Keep",
          evidence: [],
        },
        "agent",
      );
      expect(yield* brain.reviewProposal(p.id).pipe(Effect.flip)).toMatchObject({
        code: "oversized",
      });
      expect((yield* brain.listProposalSummaries({}))[0]?.path).toBe("notes/large.md");
    }),
  ),
);
