import { describe, expect, it } from "vite-plus/test";

import { appendEnabledSkillsContext } from "./enabledSkillsContext.ts";
import { stripUserMessageTransport } from "./userMessageTransport.ts";

describe("stripUserMessageTransport", () => {
  it("strips the full web composition stack and preserves useful mobile summaries", () => {
    const body = "line one\nline two";
    const pasted = `<pasted_context version="2">\n${JSON.stringify({ name: "trace.log", contentLength: body.length })}\n${body}\n</pasted_context>`;
    const terminal = `<terminal_context>\n- shell lines 1-2:\n  output\n</terminal_context>`;
    const element = `<element_context>\n- button#save:\n  Save\n</element_context>`;
    const preview = `<preview_annotation>\nPage: Checkout\nComment: align it\n</preview_annotation>`;
    const prompt = appendEnabledSkillsContext(
      `Fix this\n\n${pasted}\n\n${terminal}\n\n${element}\n\n${preview}`,
      [{ name: "review", path: "/skills/review/SKILL.md", scope: "session" }],
    );

    expect(stripUserMessageTransport(prompt)).toEqual({
      promptText: "Fix this",
      skills: ["review"],
      globalSkills: [],
      sessionSkills: ["review"],
      contexts: [
        { kind: "pasted", label: "trace.log" },
        { kind: "terminal", label: "shell lines 1-2" },
        { kind: "element", label: "button#save" },
        { kind: "preview", label: "Checkout" },
      ],
    });
  });

  it("leaves malformed pasted transport visible instead of silently deleting text", () => {
    const prompt =
      'Task\n\n<pasted_context version="2">\n{"name":"x","contentLength":99}\nshort\n</pasted_context>';
    expect(stripUserMessageTransport(prompt).promptText).toBe(prompt);
  });
});
