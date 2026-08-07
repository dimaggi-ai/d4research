// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BUILTIN_MEMORY_BACKEND, makeBuiltinMemoryConnector, toFtsQuery } from "./builtinStore.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-builtin-memory-"));
afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

const connector = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));

describe("toFtsQuery", () => {
  it("quotes terms so punctuation cannot break FTS5 syntax", () => {
    expect(toFtsQuery('handoff "compress" (v2)')).toBe('"handoff" OR "compress" OR "(v2)"');
    expect(toFtsQuery("   ")).toBe("");
  });
});

describe("builtin memory store", () => {
  it.effect("stores and finds memories by keyword with ranking", () =>
    Effect.gen(function* () {
      yield* connector.add("The PTY wrapper hangs on macOS without a terminal.", "test");
      yield* connector.add("Grocery list: milk and eggs.", "test");
      const found = yield* connector.search("PTY macOS hangs", 5);
      expect(found.results.length).toBeGreaterThan(0);
      expect(found.results[0]?.text).toContain("PTY wrapper");
    }),
  );

  it.effect("scopes search by project when one is given", () =>
    Effect.gen(function* () {
      yield* connector.add("Tool Guard policy modes analysis.", "test", "t3code");
      yield* connector.add("Tool Guard release retro.", "test", "other");
      const scoped = yield* connector.search("Tool Guard", 10, "t3code");
      expect(scoped.results.length).toBeGreaterThan(0);
      for (const entry of scoped.results) {
        expect((entry.metadata as { project?: string }).project).toBe("t3code");
      }
    }),
  );

  it.effect("returns empty results for an unmatchable query instead of failing", () =>
    Effect.gen(function* () {
      const found = yield* connector.search("zzzunfindabletoken", 3);
      expect(found.results).toEqual([]);
    }),
  );

  it.effect("reports health with a count and the builtin backend name", () =>
    Effect.gen(function* () {
      const health = yield* connector.health();
      expect(health.status).toBe("ok");
      expect(health.backend).toBe(BUILTIN_MEMORY_BACKEND);
      expect(health.count).toBeGreaterThanOrEqual(4);
    }),
  );

  it.effect("persists across connector instances — it is a file, not a process", () =>
    Effect.gen(function* () {
      const reopened = makeBuiltinMemoryConnector(NodePath.join(dir, "memory.sqlite"));
      const found = yield* reopened.search("grocery milk", 3);
      expect(found.results[0]?.text).toContain("Grocery");
    }),
  );
});
