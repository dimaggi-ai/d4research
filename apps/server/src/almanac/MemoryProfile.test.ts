import { describe, expect, it } from "@effect/vitest";

import {
  detectProfile,
  fill,
  parseProfile,
  pick,
  PROFILES,
  readRecall,
  readSearch,
} from "./MemoryProfile.ts";

const names = (profile: string) => PROFILES.find((entry) => entry.name === profile)!.detect;

describe("MemoryProfile", () => {
  it("fills variables and leaves out the ones without a value", () => {
    expect(
      fill(
        { q: "$query", n: "$limit", tag: "$scope", groups: ["$scope"], fixed: "$5", list: [] },
        { query: "a", limit: 3, scope: "" },
      ),
    ).toEqual({ q: "a", n: 3, fixed: "$5", list: [] });
    expect(
      fill({ entities: [{ name: "$title", kinds: ["$text"] }] }, { title: "t", text: "x" }),
    ).toEqual({ entities: [{ name: "t", kinds: ["x"] }] });
  });

  it("picks the first path that is present", () => {
    const value = { chunks: [{ content: "c" }], summary: "s" };
    expect(pick(value, ["missing.0", "chunks.0.content", "summary"])).toBe("c");
    expect(pick([1], "")).toEqual([1]);
    expect(pick(value, "summary.deep")).toBeUndefined();
  });

  it("tells the built-in providers apart by their tools", () => {
    for (const profile of PROFILES) expect(detectProfile(profile.detect)?.name).toBe(profile.name);
    // Tool names that several providers share do not decide alone.
    expect(detectProfile(["add_memory", "search_memory"])).toBeNull();
    expect(detectProfile([...names("supermemory"), "list_memories"])?.name).toBe("supermemory");
    expect(detectProfile(["kumbuka_search", ...names("mem0")])?.name).toBe("kumbuka");
  });

  it("reads memories from structured content, JSON text and prose", () => {
    const shape = { items: ["results", ""], id: "id", text: ["memory", "text"] };
    expect(
      readRecall({ structuredContent: { results: [{ id: 7, memory: "m" }, { id: 8 }] } }, shape)
        ?.memories,
    ).toEqual([{ id: "7", date: null, text: "m", category: null, replacedBy: null }]);
    const text = (value: string) => ({ content: [{ type: "text", text: value }] });
    expect(
      readRecall(text('["plain", {"text": "t"}]'), shape)?.memories.map((m) => m.text),
    ).toEqual(["plain", "t"]);
    expect(readRecall(text("Anna prefers tea."), shape)?.memories[0]?.text).toBe(
      "Anna prefers tea.",
    );
    // JSON without the list is an unreadable reply, not a memory.
    expect(readRecall(text('{"error": "quota"}'), { ...shape, items: "results" })).toBeNull();
  });

  it("reads passages without offsets as 0-0", () => {
    const found = readSearch(
      { structuredContent: { results: [{ documentId: "d", title: "T", content: "c" }, {}] } },
      { items: "results", sourceId: "documentId", text: "content", title: "title" },
    );
    expect(found?.passages).toEqual([
      { sourceId: "d", start: 0, end: 0, date: null, title: "T", text: "c" },
    ]);
  });

  it("accepts a custom profile and refuses a broken one", () => {
    const recall = { tool: "find", args: { q: "$query" }, memories: { items: "", text: "t" } };
    expect(parseProfile(JSON.stringify({ recall }))?.name).toBe("custom");
    expect(parseProfile(JSON.stringify({ browse: recall }))?.browse?.pageSize).toBe(20);
    expect(parseProfile("not json")).toBeNull();
    expect(parseProfile(JSON.stringify({ recall: { tool: "find" } }))).toBeNull();
    expect(parseProfile(JSON.stringify({ recall: { tool: "find", args: {} } }))).toBeNull();
  });
});
