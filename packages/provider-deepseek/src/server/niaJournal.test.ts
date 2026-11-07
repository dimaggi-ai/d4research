import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { UNVERIFIED_TOOL_RESULT, type NiaMessage } from "./nia.ts";
import { makeNiaJournal, preferJournal } from "./niaJournal.ts";

const call = (id: string): NiaMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "d4_agent_overview", arguments: "{}" } }],
});
const result = (id: string, content: string): NiaMessage => ({
  role: "tool",
  tool_call_id: id,
  content,
});
const user = { role: "user", content: "Hello" } as const;

describe("preferJournal", () => {
  it("keeps a journal that resolved a committed placeholder and started another tool", () => {
    const committed = [user, call("call-1"), result("call-1", UNVERIFIED_TOOL_RESULT)];
    const journal = [
      user,
      call("call-1"),
      result("call-1", "Observed result"),
      call("call-2"),
      result("call-2", UNVERIFIED_TOOL_RESULT),
    ];
    expect(preferJournal(committed, journal)).toBe(journal);
  });

  it("keeps a same-length journal that only resolved the placeholder", () => {
    const committed = [user, call("call-1"), result("call-1", UNVERIFIED_TOOL_RESULT)];
    const journal = [user, call("call-1"), result("call-1", "Observed result")];
    expect(preferJournal(committed, journal)).toBe(journal);
  });

  it("ignores key order but rejects a journal that diverges from committed history", () => {
    const reordered: NiaMessage[] = [{ content: "Hello", role: "user" }, call("call-1")];
    expect(preferJournal([user], reordered)).toBe(reordered);
    const committed = [user, call("call-1"), result("call-1", "Observed result")];
    expect(preferJournal(committed, [user, call("call-1"), result("call-1", "Other")])).toBe(
      committed,
    );
    expect(preferJournal(committed, [user])).toBe(committed);
  });
});

describe("makeNiaJournal", () => {
  it.effect("refuses to read a journal it cannot parse instead of reporting none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "nia-journal-" });
      const journal = yield* makeNiaJournal(stateDir);
      yield* journal.write("thread-1", [user]);
      expect(yield* journal.read("thread-1")).toEqual([user]);
      const directory = path.join(stateDir, "deepseek-nia");
      const [name] = yield* fs.readDirectory(directory);
      const target = path.join(directory, name!);
      for (const corrupt of [
        '{"history":',
        JSON.stringify({ providerThreadId: "other", history: [] }),
        JSON.stringify({ providerThreadId: "thread-1", history: [null] }),
        JSON.stringify({
          providerThreadId: "thread-1",
          history: [{ role: "system", content: "corrupt" }],
        }),
        JSON.stringify({
          providerThreadId: "thread-1",
          history: [{ role: "assistant", content: null, tool_calls: [{ id: 7 }] }],
        }),
      ]) {
        yield* fs.writeFileString(target, corrupt);
        expect((yield* Effect.exit(journal.read("thread-1")))._tag).toBe("Failure");
        expect(yield* fs.readFileString(target)).toBe(corrupt);
      }
      expect(yield* journal.read("thread-2")).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("removes its temporary file when the write cannot complete", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "nia-journal-" });
      const journal = yield* makeNiaJournal(stateDir);
      yield* journal.write("thread-1", [user]);
      const directory = path.join(stateDir, "deepseek-nia");
      const [name] = yield* fs.readDirectory(directory);
      const target = path.join(directory, name!);
      yield* fs.remove(target);
      // A directory at the target path makes the final rename fail.
      yield* fs.makeDirectory(path.join(target, "occupied"), { recursive: true });
      expect((yield* Effect.exit(journal.write("thread-1", [user])))._tag).toBe("Failure");
      expect(
        (yield* fs.readDirectory(directory)).filter((entry) => entry.endsWith(".tmp")),
      ).toEqual([]);
      yield* fs.remove(target, { recursive: true });
      yield* journal.write("thread-1", [user]);
      expect(yield* journal.read("thread-1")).toEqual([user]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
