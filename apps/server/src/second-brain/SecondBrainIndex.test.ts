import { it, expect } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Index from "./SecondBrainIndex.ts";
import * as ServerConfig from "../config.ts";
import { parseNote } from "./noteDocument.ts";

it.effect(
  "persists proposals and audit across connections and rebuilds, while replacing FTS content",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "brain-durable-" });
        const config = ServerConfig.layerTest(state, state);
        const connect = Index.layer.pipe(Layer.provide(config));
        const p = {
          id: "proposal",
          vault: "v",
          actor: "agent",
          state: "pending" as const,
          createdAt: "2026-01-01",
          reviewedAt: null,
          reason: null,
          path: "a.md",
          kind: "note" as const,
          operation: "create" as const,
          content: "new",
          expectedHash: null,
          rationale: "requested",
          evidence: [],
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const index = yield* Index.SecondBrainIndex;
            yield* index.saveProposal(p);
            yield* index.markDelivered("v", "provider", 7);
            yield* index.setCaptureCursor(42);
            yield* index.enqueueCapture({
              id: "job",
              vault: "v",
              threadId: "thread",
              runFrom: 1,
              runTo: 2,
              transcriptHash: "hash",
              version: "v1",
              messages: [{ messageId: "m", text: "Safe" }],
              state: "pending",
              proposalIds: [],
            });
            yield* index.audit({
              id: "audit",
              vault: "v",
              path: "a.md",
              proposalId: p.id,
              operation: "create",
              oldHash: null,
              newHash: "h",
              actor: "human",
              timestamp: "2026-01-01",
              state: "prepared",
            });
            yield* index.reconcile(
              "v",
              [{ document: parseNote("a.md", "# Quartz\nMineral"), mtime: 1, size: 16 }],
              "2026-01-01",
              false,
            );
          }).pipe(Effect.provide(Layer.fresh(connect))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const index = yield* Index.SecondBrainIndex;
            expect((yield* index.proposal("v", p.id)).state).toBe("pending");
            expect(yield* index.pendingAudits("v")).toHaveLength(1);
            expect(yield* index.deliveredGeneration("v", "provider")).toBe(7);
            expect(yield* index.deliveredGeneration("other", "provider")).toBeNull();
            expect(yield* index.captureCursor()).toBe(42);
            expect(yield* index.pendingCaptures()).toHaveLength(1);
            expect(yield* index.search("v", { query: "quartz", path: "a" })).toHaveLength(1);
            expect(yield* index.search("other", { query: "quartz" })).toHaveLength(0);
            yield* index.reconcile(
              "v",
              [{ document: parseNote("a.md", "# Sapphire\nGem"), mtime: 2, size: 14 }],
              "2026-01-02",
              false,
            );
            expect(yield* index.search("v", { query: "quartz" })).toHaveLength(0);
            expect(yield* index.search("v", { query: "sapphire" })).toHaveLength(1);
            yield* index.reconcile("v", [], "2026-01-03", false);
            expect(yield* index.search("v", { query: "sapphire" })).toHaveLength(0);
            expect((yield* index.proposal("v", p.id)).id).toBe(p.id);
          }).pipe(Effect.provide(Layer.fresh(connect))),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
