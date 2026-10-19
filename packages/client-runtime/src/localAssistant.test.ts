import { describe, expect, it } from "vite-plus/test";
import { runLocalAssistant, selectLocalExcerpts, splitLocalSource } from "./localAssistant.ts";
const signal = () => new AbortController().signal;
describe("on-device assistant", () => {
  it("preserves Unicode across bounded chunks and refuses oversized sources", () => {
    const text = "你好😀".repeat(1500);
    const chunks = splitLocalSource(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 5000)).toBe(true);
    expect(() => splitLocalSource("x".repeat(48001))).toThrow("smaller excerpt");
  });
  it("rejects a rewrite that loses a path, code, URL or number", async () => {
    for (const literal of [
      "/src/main.ts",
      "src/main.ts",
      "`--force`",
      "https://example.org",
      "42",
    ]) {
      await expect(
        runLocalAssistant("clean", `Fix ${literal} please`, async () => "Fix it please", signal()),
      ).rejects.toThrow("draft is unchanged");
    }
  });
  it("accepts a shorter draft only when protected details survive", async () => {
    const result = await runLocalAssistant(
      "shorten",
      "Please please fix `/src/main.ts` using 42",
      async () => "Fix `/src/main.ts` using 42",
      signal(),
    );
    expect(result).toBe("Fix `/src/main.ts` using 42");
    await expect(
      runLocalAssistant("shorten", "Fix it", async () => "Please fix this problem", signal()),
    ).rejects.toThrow("did not shorten");
  });
  it("never runs a model for an oversized rewrite or an aborted request", async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      return "summary";
    };
    await expect(runLocalAssistant("clean", "a".repeat(5001), generate, signal())).rejects.toThrow(
      "shorter draft",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      runLocalAssistant("summary", "text", generate, controller.signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("labels every part of a long summary without silently dropping source", async () => {
    const inputs: string[] = [];
    const source = "x".repeat(11000);
    const result = await runLocalAssistant(
      "summary",
      source,
      async (_, input) => {
        inputs.push(input);
        return "note";
      },
      signal(),
    );
    expect(inputs.join("")).toBe(source);
    expect(result).toContain("Source part 3:");
  });
  it("selects original matching excerpts within budget instead of inventing context", () => {
    const excerpts = selectLocalExcerpts(
      "cache",
      [{ label: "Chat A", text: "Unrelated text\n\nFix the cache\n\n" + "cache ".repeat(1000) }],
      100,
    );
    expect(excerpts).toEqual([{ label: "Chat A · excerpt 2", text: "Fix the cache" }]);
    expect(selectLocalExcerpts("", [{ label: "A", text: "anything" }])).toEqual([]);
  });
});
