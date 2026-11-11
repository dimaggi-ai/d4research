import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";

import * as ServerSettings from "../serverSettings.ts";
import * as Almanac from "./AlmanacService.ts";

const fake = NodeURL.fileURLToPath(new URL("./fakeAlmanacServer.testkit.mjs", import.meta.url));

const provider = NodeURL.fileURLToPath(
  new URL("./fakeMemoryProvider.testkit.mjs", import.meta.url),
);

const withCommand = (command: string, almanac: { scope?: string; profile?: string } = {}) =>
  Almanac.layer.pipe(Layer.provide(ServerSettings.layerTest({ almanac: { command, ...almanac } })));

describe("AlmanacService", () => {
  it.effect("reports an unset command without starting a process", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: false, connected: false });
      const failure = yield* Effect.flip(service.browse({ path: "", offset: 0 }));
      expect(failure.code).toBe("not_configured");
    }).pipe(Effect.provide(withCommand(""))),
  );

  it.effect("reports a configured command that cannot start", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: false });
    }).pipe(Effect.provide(withCommand("exit 7"))),
  );

  it.effect("talks to a real stdio MCP server and maps its replies", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: true });
      const browsed = yield* service.browse({ path: "/work", offset: 0 });
      expect(browsed.categories).toEqual([{ path: "/work", items: 2 }]);
      const read = yield* service.read({ sourceId: "7e36da31-f6d0-4ffe-b13c-47151534d90b" });
      expect(read.content).toBe("line one\nline two");
      expect(yield* service.remember({ text: "A fact" })).toEqual({ result: "created A fact" });
      expect(
        yield* service.update({ memoryId: "7e36da31-f6d0-4ffe-b13c-47151534d90b", text: "New" }),
      ).toEqual({ result: "updated v4" });
      const refused = yield* Effect.flip(
        service.forget({ memoryId: "7e36da31-f6d0-4ffe-b13c-47151534d90b" }),
      );
      expect(refused.code).toBe("rejected");
    }).pipe(Effect.provide(withCommand(`exec ${process.execPath} ${fake}`))),
  );

  it.effect("detects a JSON provider by its tools and maps the memory operations", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: true });
      const recalled = yield* service.recall({ query: "facts", limit: 2 });
      expect(recalled.memories).toEqual([
        { id: "mem-0", date: "2026-11-10", text: "fact 0", category: "work", replacedBy: null },
        { id: "mem-1", date: "2026-11-10", text: "fact 1", category: "work", replacedBy: null },
      ]);
      const second = yield* service.browse({ path: "", offset: 20 });
      expect(second.memories.map((memory) => memory.id)).toEqual([
        "mem-20",
        "mem-21",
        "mem-22",
        "mem-23",
        "mem-24",
      ]);
      expect(second.nextOffset).toBeNull();
      expect((yield* service.browse({ path: "", offset: 0 })).nextOffset).toBe(20);
      // The provider returns the whole text; the window is cut here.
      expect(yield* service.read({ sourceId: "mem-3", start: 2, maxChars: 4 })).toEqual({
        uri: "mem-3",
        start: 2,
        end: 6,
        total: 10,
        content: "2345",
      });
      const stored = yield* service.remember({ text: "A fact" });
      expect(JSON.parse(stored.result)).toEqual({ stored: { text: "A fact", user_id: "team" } });
      const updated = yield* service.update({ memoryId: "mem-3", text: "New" });
      expect(JSON.parse(updated.result)).toEqual({ updated: { memory_id: "mem-3", text: "New" } });
      expect((yield* Effect.flip(service.forget({ memoryId: "nope" }))).code).toBe("rejected");
      // This provider has no document search.
      expect((yield* Effect.flip(service.search({ query: "facts" }))).code).toBe("unsupported");
    }).pipe(Effect.provide(withCommand(`exec ${process.execPath} ${provider}`, { scope: "team" }))),
  );

  it.effect("serves a provider that implements only the neutral contract", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: true });
      expect((yield* service.recall({ query: "q" })).memories).toEqual([
        { id: "a", date: "2026-11-10", text: "team:q", category: "x", replacedBy: null },
      ]);
      expect((yield* service.search({ query: "q" })).passages).toEqual([
        { sourceId: "doc-1", start: 3, end: 9, date: null, title: "Doc", text: "body" },
      ]);
      expect(yield* service.remember({ text: "A fact" })).toEqual({ result: "stored A fact" });
      expect((yield* Effect.flip(service.forget({ memoryId: "a" }))).code).toBe("unavailable");
    }).pipe(
      Effect.provide(
        withCommand(`exec ${process.execPath} ${provider} contract`, { scope: "team" }),
      ),
    ),
  );

  it.effect("opens one Meko conversation and names it in every call", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect((yield* service.recall({ query: "q" })).memories).toEqual([
        { id: "m1", date: null, text: "pack:q", category: null, replacedBy: null },
      ]);
      expect((yield* service.search({ query: "q" })).passages).toEqual([
        { sourceId: "doc-9", start: 0, end: 0, date: null, title: "", text: "chunk" },
      ]);
      expect((yield* service.read({ sourceId: "m1" })).content).toBe("whole");
      const stored = yield* service.remember({ text: "A fact" });
      expect(JSON.parse(stored.result).results[0].memory).toBe("A fact");
      expect(JSON.parse((yield* service.forget({ memoryId: "m1" })).result)).toEqual({
        deleted: "m1",
      });
    }).pipe(
      Effect.provide(withCommand(`exec ${process.execPath} ${provider} meko`, { scope: "pack" })),
    ),
  );

  it.effect("uses a custom profile from settings for an unknown provider", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      const recalled = yield* service.recall({ query: "facts", limit: 1 });
      expect(recalled.memories.map((memory) => memory.text)).toEqual(["fact 0"]);
      expect((yield* Effect.flip(service.remember({ text: "x" }))).code).toBe("unsupported");
    }).pipe(
      Effect.provide(
        withCommand(`exec ${process.execPath} ${provider}`, {
          profile: JSON.stringify({
            recall: {
              tool: "search_memories",
              args: { query: "$query", limit: "$limit" },
              memories: { items: "results", id: "id", text: "memory" },
            },
          }),
        }),
      ),
    ),
  );
});
