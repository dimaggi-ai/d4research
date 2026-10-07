import { describe, expect, it } from "vite-plus/test";
import {
  applyProposal,
  cloudEndpoint,
  decodeProposal,
  decodeWorkspace,
  emptyWorkspace,
  modelMessages,
  putFile,
  validatePath,
} from "./workspace";

describe("local development workspace", () => {
  it("round-trips files and the full conversation without API keys", () => {
    const workspace = {
      ...emptyWorkspace(),
      files: { "src/main.js": "console.log(1)" },
      messages: [{ role: "user" as const, content: "make a test", model: "Apple Intelligence" }],
    };
    expect(decodeWorkspace(JSON.stringify(workspace))).toEqual(workspace);
    expect(decodeWorkspace(null)).toEqual(emptyWorkspace());
  });
  it.each([
    "../private",
    "a/../b",
    "/private",
    "a\\b",
    "a//b",
    "__proto__",
    "constructor",
    "a\u0000b",
  ])("rejects unsafe file path %s", (path) => {
    expect(() => validatePath(path)).toThrow();
  });
  it("rejects corrupted persisted data rather than overwriting it with an empty workspace", () => {
    expect(() => decodeWorkspace('{"version":1,"files":{},"messages":[]}')).toThrow();
    expect(() =>
      decodeWorkspace(JSON.stringify({ ...emptyWorkspace(), files: { "a.js": 123 } })),
    ).toThrow();
  });
  it("applies reviewed edits atomically and detects changes to existing and newly created files", () => {
    const base = { "a.js": "old", "b.js": "unchanged" };
    const workspace = { ...emptyWorkspace(), files: base };
    const changes = [
      { path: "a.js", content: "new" },
      { path: "c.js", content: "created" },
    ];
    expect(applyProposal(workspace, base, changes).files).toEqual({
      "a.js": "new",
      "b.js": "unchanged",
      "c.js": "created",
    });
    expect(workspace.files).toEqual(base);
    const edited = { ...workspace, files: { ...base, "c.js": "manual" } };
    expect(() => applyProposal(edited, base, changes)).toThrow("changed");
    expect(edited.files["a.js"]).toBe("old");
  });
  it("rejects duplicated or oversized proposed edits", () => {
    expect(() =>
      decodeProposal(
        JSON.stringify({
          reply: "ok",
          edits: [
            { path: "a.js", content: "a" },
            { path: "a.js", content: "b" },
          ],
        }),
      ),
    ).toThrow("more than once");
    expect(() => putFile({}, "large.js", "x".repeat(100_001))).toThrow("limit");
    expect(decodeProposal('```json\n{"reply":"ok","edits":[]}\n```')).toEqual({
      reply: "ok",
      edits: [],
    });
  });
  it("attaches only the selected file, preserves all history, and fails rather than silently compacting", () => {
    const workspace = {
      ...emptyWorkspace(),
      files: { "a.js": "selected", "b.js": "PRIVATE_OTHER_FILE" },
      messages: [{ role: "assistant" as const, content: "earlier", model: "Apple Intelligence" }],
    };
    const messages = modelMessages(workspace, "a.js", "fix this");
    expect(JSON.stringify(messages)).not.toContain("PRIVATE_OTHER_FILE");
    expect(messages[1]).toEqual({ role: "assistant", content: "earlier" });
    expect(() =>
      modelMessages({ ...workspace, files: { "a.js": "x".repeat(9000) } }, "a.js", "fix"),
    ).toThrow("too long");
  });
  it.each([
    "http://cloud.example/v1",
    "https://user:secret@host/v1",
    "https://host/v1?key=secret",
    "https://host/v1#fragment",
  ])("rejects unsafe API endpoint %s", (endpoint) =>
    expect(() => cloudEndpoint(endpoint)).toThrow(),
  );
  it("retains custom API prefixes", () =>
    expect(cloudEndpoint("https://host/custom/v1/")).toBe(
      "https://host/custom/v1/chat/completions",
    ));
});
