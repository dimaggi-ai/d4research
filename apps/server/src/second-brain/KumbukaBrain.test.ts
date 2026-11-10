// @effect-diagnostics nodeBuiltinImport:off -- The test serves a stand-in HTTP API and writes token files.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Kumbuka from "./KumbukaBrain.ts";
import { SecondBrainService } from "./SecondBrainService.ts";
import { withBrain } from "./testkit.ts";

const SOURCE = "7e36da31-f6d0-4ffe-b13c-47151534d90b";
const REVISION = "11111111-2222-4333-8444-555555555555";
const CONTENT = "# Tea\n\nfirst line\nsecond line\n\n## Later\nthird line\n";
const START = CONTENT.indexOf("first");
const END = CONTENT.indexOf("\n\n## Later");

/** A stand-in for the Kumbuka API that knows one page and one token per context. */
const fakeApi = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: string[] = [];
    const tokens = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "d4-kumbuka-test-"));
    NodeFS.writeFileSync(NodePath.join(tokens, "d4-yb.token"), "yb-token\n");
    NodeFS.writeFileSync(NodePath.join(tokens, "d4-global.token"), "global-token\n");
    const server = NodeHttp.createServer((request, response) => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const bearer = request.headers.authorization ?? "";
      seen.push(`${bearer.replace("Bearer ", "")} ${request.method} ${request.url}`);
      // The shared token cannot see the page of the work context.
      if (bearer !== "Bearer yb-token")
        return request.url === "/search"
          ? reply(200, { results: [] })
          : request.url?.startsWith("/sources?")
            ? reply(200, { items: [], next_cursor: null })
            : reply(404, { detail: "Source does not exist or was deleted" });
      if (request.url === "/search")
        return reply(200, {
          results: [
            {
              source_id: SOURCE,
              revision_id: REVISION,
              start_offset: START,
              end_offset: END,
              path: "/Tea",
              text: "first line\nsecond line",
              score: 0.016,
              rerank_score: 0.9,
            },
          ],
        });
      if (request.url?.startsWith("/sources?"))
        return reply(200, {
          items: [{ id: SOURCE, uri: "obsidian:YB/notes/tea.md" }],
          next_cursor: null,
        });
      return reply(200, {
        uri: "obsidian:YB/notes/tea.md",
        content: CONTENT,
        content_hash: "abc",
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, seen, tokens, url: `http://127.0.0.1:${port}` };
  }),
  ({ server, tokens }) =>
    Effect.sync(() => {
      server.close();
      NodeFS.rmSync(tokens, { recursive: true, force: true });
    }),
);

describe("KumbukaBrain", () => {
  it.effect("maps a hit to the vault path and its lines, under the context's token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* fakeApi;
        const brain = Kumbuka.make(api);
        const found = yield* brain.search("YB", { query: "tea", limit: 5 });
        expect(found.abstain).toBe(false);
        expect(found.results).toEqual([
          {
            score: 0.9,
            citation: {
              path: "YB/notes/tea.md",
              heading: "/Tea",
              startLine: 3,
              endLine: 4,
              hash: "abc",
              excerpt: "first line\nsecond line",
            },
          },
        ]);
        expect(api.seen.every((line) => line.startsWith("yb-token "))).toBe(true);
        expect((yield* brain.search("YB", { query: "tea", path: "Global/" })).results).toEqual([]);
        expect((yield* brain.search("Global", { query: "tea" })).abstain).toBe(true);
        expect((yield* brain.search("YB", { query: "  " })).abstain).toBe(true);
      }),
    ),
  );

  it.effect("reads a page by its vault path and refuses another context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* fakeApi;
        const brain = Kumbuka.make(api);
        expect(yield* brain.page("YB", "YB/notes/tea.md")).toEqual({
          content: CONTENT,
          hash: "abc",
        });
        expect((yield* Effect.flip(brain.page("Global", "YB/notes/tea.md"))).code).toBe(
          "not_found",
        );
        expect((yield* Effect.flip(brain.page("Dimaggi", "YB/notes/tea.md"))).code).toBe(
          "unavailable",
        );
      }),
    ),
  );

  it.effect("reports a store that does not answer", () =>
    Effect.gen(function* () {
      const brain = Kumbuka.make({ url: "http://127.0.0.1:9", tokens: "/nonexistent" });
      expect((yield* Effect.flip(brain.search("Global", { query: "tea" }))).code).toBe(
        "unavailable",
      );
    }),
  );

  it.effect("serves brain reads with a context from Kumbuka and the others from the vault", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* fakeApi;
        return yield* withBrain(
          () =>
            Effect.gen(function* () {
              const service = yield* SecondBrainService;
              const read = yield* service.read(
                { path: "YB/notes/tea.md", startLine: 3, endLine: 4 },
                "YB",
              );
              expect(read.content).toBe("first line\nsecond line");
              expect(read.citation).toMatchObject({ startLine: 3, endLine: 4, hash: "abc" });
              const found = yield* service.search({ query: "tea" }, "YB");
              expect(found.results.map((hit) => hit.citation.path)).toEqual(["YB/notes/tea.md"]);
              // Without a context the vault is read, and it has no such file.
              expect((yield* Effect.flip(service.read({ path: "YB/notes/tea.md" }))).code).toBe(
                "not_found",
              );
              const turn = yield* service.buildTurnContext({
                userText: "what about tea",
                includeCore: false,
                brainContext: "YB",
              });
              expect(turn.retrieved).toContain("[brain: YB/notes/tea.md#L3-L4]");
              const shared = yield* service.buildTurnContext({
                userText: "what about tea",
                includeCore: false,
              });
              expect(shared.retrieved).toBe("");
            }),
          {},
          Layer.succeed(Kumbuka.KumbukaBrain, Kumbuka.make(api)),
        );
      }),
    ),
  );
});
