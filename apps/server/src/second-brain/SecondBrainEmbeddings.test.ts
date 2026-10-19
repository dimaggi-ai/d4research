import { it, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Embeddings from "./SecondBrainEmbeddings.ts";
import * as Service from "./SecondBrainService.ts";
import { withBrain } from "./testkit.ts";

const result = (path: string) => ({
  score: 1,
  citation: { path, heading: "", startLine: 1, endLine: 1, hash: "h", excerpt: "text" },
});
it("fuses independent semantic candidates with lexical ranks", () => {
  const fused = Embeddings.reciprocalRankFusion(
    [result("a.md"), result("b.md")],
    [result("c.md"), result("b.md")],
    3,
  );
  expect(fused[0]?.citation.path).toBe("b.md");
  expect(fused.map((r) => r.citation.path)).toContain("c.md");
});
it.effect("falls back to lexical results when embedding transport is unavailable", () =>
  withBrain(
    (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SecondBrainService;
        yield* fs.writeFileString(`${root}/a.md`, "# Quartz\nA mineral");
        const found = yield* service.search({ query: "quartz" });
        expect(found.semanticStatus).toBe("unavailable");
        expect(found.results).toHaveLength(1);
      }),
    { embeddings: { enabled: true, model: "missing", baseUrl: "http://127.0.0.1:1" } },
  ),
);

it.effect("uses Nomic prefixes, caches documents and invalidates cache for model changes", () =>
  Effect.gen(function* () {
    const requests: Array<{ model: string; input: string[] }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as { model: string; input: string[] };
      requests.push(body);
      return Response.json({
        embeddings: body.input.map((text) => (text.includes("other") ? [0, 1] : [1, 0])),
      });
    });
    try {
      const embeddings = yield* Embeddings.SecondBrainEmbeddings;
      const settings = {
        enabled: true,
        model: "nomic-embed-text",
        baseUrl: "http://127.0.0.1:11434",
      };
      const candidates = [
        result("a.md"),
        { ...result("b.md"), citation: { ...result("b.md").citation, excerpt: "other" } },
      ];
      expect(
        (yield* embeddings.rank(settings, "text", candidates)).map((r) => r.citation.path),
      ).toEqual(["a.md"]);
      yield* embeddings.rank(settings, "text", candidates);
      yield* embeddings.rank({ ...settings, model: "nomic-embed-text:v2" }, "text", candidates);
      expect(requests).toHaveLength(5);
      expect(requests[0]?.input).toEqual(["search_query: text"]);
      expect(requests[1]?.input).toEqual(["search_document: text", "search_document: other"]);
    } finally {
      spy.mockRestore();
    }
  }).pipe(Effect.provide(Embeddings.layer)),
);
it.effect("rejects malformed embedding responses", () =>
  Effect.gen(function* () {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ embeddings: [[]] }));
    try {
      const embeddings = yield* Embeddings.SecondBrainEmbeddings;
      const outcome = yield* embeddings
        .rank(
          { enabled: true, model: "nomic-embed-text", baseUrl: "http://127.0.0.1:11434" },
          "q",
          [result("a.md")],
        )
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
    } finally {
      spy.mockRestore();
    }
  }).pipe(Effect.provide(Embeddings.layer)),
);
