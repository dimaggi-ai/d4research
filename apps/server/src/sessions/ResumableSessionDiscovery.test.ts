import { assert, describe, it } from "@effect/vitest";

import {
  encodeClaudeProjectDir,
  parseClaudeSession,
  parseCodexSession,
} from "./ResumableSessionDiscovery.ts";

describe("encodeClaudeProjectDir", () => {
  it("encodes a path the way Claude Code names its project store dir", () => {
    assert.equal(
      encodeClaudeProjectDir("/Users/me/workplace/git/fun/t3code"),
      "-Users-me-workplace-git-fun-t3code",
    );
  });

  it("replaces dots and other non-alphanumerics with dashes", () => {
    assert.equal(encodeClaudeProjectDir("/Users/me/my.project_v2"), "-Users-me-my-project-v2");
  });
});

describe("parseClaudeSession", () => {
  it("extracts the first real user prompt, message count, and last timestamp", () => {
    const contents = [
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-06-17T00:56:18.392Z",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "pls check what dry runs we have running" }],
        },
        timestamp: "2026-06-17T00:56:18.644Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Checking now." }] },
        timestamp: "2026-06-17T00:56:20.000Z",
      }),
      "",
    ].join("\n");

    const parsed = parseClaudeSession(contents);
    assert.equal(parsed.title, "pls check what dry runs we have running");
    assert.equal(parsed.messageCount, 2);
    assert.equal(parsed.lastTimestamp, "2026-06-17T00:56:20.000Z");
  });

  it("skips command/system-wrapper user text and falls back to a summary", () => {
    const contents = [
      JSON.stringify({ type: "summary", summary: "Investigate tablet state" }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "<command-name>/clear</command-name>" }],
        },
        timestamp: "2026-06-17T00:56:18.644Z",
      }),
    ].join("\n");

    const parsed = parseClaudeSession(contents);
    assert.equal(parsed.title, "Investigate tablet state");
    assert.equal(parsed.messageCount, 1);
  });
});

describe("parseCodexSession", () => {
  it("reads cwd + id from the session_meta header and the first user prompt", () => {
    const contents = [
      JSON.stringify({
        timestamp: "2026-06-17T00:35:08.409Z",
        type: "session_meta",
        payload: {
          id: "019ed2ff-573a-7580-936f-338ff98621d4",
          timestamp: "2026-06-17T00:33:29.914Z",
          cwd: "/Users/me/workplace/git/fun/t3code",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions>" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "add a resume picker" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      }),
    ].join("\n");

    const parsed = parseCodexSession(contents);
    assert.equal(parsed.id, "019ed2ff-573a-7580-936f-338ff98621d4");
    assert.equal(parsed.cwd, "/Users/me/workplace/git/fun/t3code");
    assert.equal(parsed.title, "add a resume picker");
    // developer + user + assistant messages, but the developer wrapper is not a user prompt.
    assert.equal(parsed.messageCount, 2);
  });

  it("returns a null cwd for a legacy rollout header without one", () => {
    const contents = JSON.stringify({
      id: "f5c3a519-c5fb-4ff6-bca4-3708e63fa08b",
      timestamp: "2025-08-31T13:04:41.017Z",
      git: { branch: "main", repository_url: "https://example.com/repo.git" },
    });
    const parsed = parseCodexSession(contents);
    assert.equal(parsed.id, "f5c3a519-c5fb-4ff6-bca4-3708e63fa08b");
    assert.equal(parsed.cwd, null);
  });
});
