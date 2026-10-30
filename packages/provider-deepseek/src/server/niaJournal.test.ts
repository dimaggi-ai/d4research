// @effect-diagnostics nodeBuiltinImport:off -- The journal under test is plain Node file I/O.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

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
const user: NiaMessage = { role: "user", content: "Hello" };

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
    const reordered = [{ content: "Hello", role: "user" } as NiaMessage, call("call-1")];
    expect(preferJournal([user], reordered)).toBe(reordered);
    const committed = [user, call("call-1"), result("call-1", "Observed result")];
    expect(preferJournal(committed, [user, call("call-1"), result("call-1", "Other")])).toBe(
      committed,
    );
    expect(preferJournal(committed, [user])).toBe(committed);
  });
});

describe("makeNiaJournal", () => {
  it("removes its temporary file when the write cannot complete", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "nia-journal-"));
    try {
      const directory = NodePath.join(stateDir, "deepseek-nia");
      const target = NodePath.join(
        directory,
        `${NodeCrypto.createHash("sha256").update("thread-1").digest("hex")}.json`,
      );
      // A directory at the target path makes the final rename fail.
      await NodeFSP.mkdir(NodePath.join(target, "occupied"), { recursive: true });
      await expect(makeNiaJournal(stateDir).write("thread-1", [user])).rejects.toThrow();
      expect((await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });
});
