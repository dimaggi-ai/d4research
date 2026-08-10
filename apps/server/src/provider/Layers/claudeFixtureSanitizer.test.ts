import { describe, expect, it } from "vite-plus/test";

import { claudeFixtureFileName, sanitizeClaudeFixtureMessages } from "./claudeFixtureSanitizer.ts";

describe("sanitizeClaudeFixtureMessages", () => {
  it("removes prompts, local paths, tokens, tool input, and identifiers", () => {
    const privateValues = [
      "private customer prompt",
      "/home/example/private-project",
      "secret-token-value",
      "cat /home/example/.config/credentials",
    ];
    const sanitized = sanitizeClaudeFixtureMessages([
      {
        type: "assistant",
        session_id: "real-session-id",
        uuid: "real-message-id",
        message: {
          id: "real-content-id",
          content: [
            { type: "text", text: privateValues[0] },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: privateValues[3], cwd: privateValues[1], token: privateValues[2] },
            },
          ],
        },
      },
    ]);
    const json = JSON.stringify(sanitized);

    for (const value of privateValues) expect(json).not.toContain(value);
    expect(sanitized).toMatchObject([
      {
        type: "assistant",
        session_id: "fixture-session-id",
        uuid: "fixture-uuid",
        message: {
          content: [
            { type: "text", text: "[redacted fixture text]" },
            { type: "tool_use", input: { __fixtureRedacted: true } },
          ],
        },
      },
    ]);
  });

  it("keeps result semantics but redacts provider diagnostics", () => {
    expect(
      sanitizeClaudeFixtureMessages([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: [
            "[ede_diagnostic] cwd=/home/example/private token=secret-token-value",
            "unexpected private provider response",
          ],
        },
      ]),
    ).toEqual([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["[ede_diagnostic] details redacted", "[redacted provider error]"],
      },
    ]);
  });
});

describe("claudeFixtureFileName", () => {
  it("rejects traversal and shell-shaped names", () => {
    expect(claudeFixtureFileName("rate-limit")).toBe("rate-limit.json");
    expect(() => claudeFixtureFileName("../../private")).toThrow();
    expect(() => claudeFixtureFileName("fixture;echo-private")).toThrow();
    expect(() => claudeFixtureFileName("UPPERCASE")).toThrow();
  });
});
