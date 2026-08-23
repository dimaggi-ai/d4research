import { describe, expect, it } from "vite-plus/test";

import type { PreviewAnnotationPayload } from "@d4research/contracts";

import type { ReviewCommentContext } from "../reviewCommentContext";
import { parseDevTrigger } from "../devPipeline";
import { appendEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import type { ElementContextSelection } from "./elementContext";
import { makePastedContext } from "./pastedContext";
import {
  composeUserMessageContexts,
  extractUserMessageContexts,
} from "./userMessageContextComposition";

/**
 * Each context type round-trips alone — that was already covered. What was NOT
 * covered, and what broke, is COMBINING them: every extractor matches an
 * anchored trailing block, so append order at send must be the exact mirror of
 * strip order at display. These tests pin that contract.
 *
 * The tests call the production composition helpers used by ChatView and the
 * transcript. They do not reimplement either order in a fixture.
 */

const paste = (name: string, content: string) =>
  makePastedContext({ name, content, fromFile: true });

const element = (): ElementContextSelection => ({
  pageUrl: "https://example.test/page",
  pageTitle: "Page",
  tagName: "button",
  selector: ".submit",
  htmlPreview: "<button>Go</button>",
  componentName: "SubmitButton",
  source: null,
  styles: "",
});

const terminal = () => ({
  id: "t1",
  threadId: "thread-1" as never,
  createdAt: "2026-01-01T00:00:00.000Z",
  terminalId: "term-1" as never,
  terminalLabel: "bash",
  lineStart: 1,
  lineEnd: 2,
  text: "$ echo hi\nhi",
});

function assembleForSend(input: {
  prompt: string;
  pasted?: ReturnType<typeof paste>[];
  terminals?: ReturnType<typeof terminal>[];
  elements?: ElementContextSelection[];
  previews?: PreviewAnnotationPayload[];
  reviews?: ReviewCommentContext[];
}): string {
  return composeUserMessageContexts({
    prompt: input.prompt,
    pastedContexts: input.pasted ?? [],
    terminalContexts: input.terminals ?? [],
    elementContexts: input.elements ?? [],
    previewAnnotations: input.previews ?? [],
    reviewComments: input.reviews ?? [],
  });
}

const displayOf = extractUserMessageContexts;

const preview = (): PreviewAnnotationPayload => ({
  id: "preview-1",
  pageUrl: "https://example.test/page",
  pageTitle: "Preview page",
  comment: "Move the button",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const review = (): ReviewCommentContext => ({
  id: "review-1",
  sectionId: "file:src/button.tsx",
  sectionTitle: "File comment",
  filePath: "src/button.tsx",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "L1",
  text: "Keep this accessible.",
  diff: "<button>Go</button>",
  fenceLanguage: "tsx",
});

describe("context composition", () => {
  it("keeps the prompt clean with pasted + element together", () => {
    const sent = assembleForSend({
      prompt: "review this",
      pasted: [paste("log.txt", "line a\nline b")],
      elements: [element()],
    });
    const shown = displayOf(sent);
    expect(shown.visibleText).toBe("review this");
    // The regression: element XML leaked into the bubble when pasted was last.
    expect(shown.visibleText).not.toContain("<element_context>");
    expect(shown.visibleText).not.toContain("<pasted_context>");
    expect(shown.pastedContexts).toHaveLength(1);
    expect(shown.elementContexts.length).toBeGreaterThan(0);
  });

  it("keeps the prompt clean with pasted + terminal together", () => {
    const sent = assembleForSend({
      prompt: "explain the failure",
      pasted: [paste("out.log", "boom")],
      terminals: [terminal()],
    });
    const shown = displayOf(sent);
    expect(shown.visibleText).toBe("explain the failure");
    expect(shown.visibleText).not.toContain("<terminal_context>");
    expect(shown.pastedContexts[0]?.name).toBe("out.log");
    expect(shown.terminalContexts.length).toBeGreaterThan(0);
  });

  it("survives all three context types at once", () => {
    const sent = assembleForSend({
      prompt: "do the thing",
      pasted: [paste("a.md", "alpha"), paste("b.md", "beta")],
      terminals: [terminal()],
      elements: [element()],
    });
    const shown = displayOf(sent);
    expect(shown.visibleText).toBe("do the thing");
    expect(shown.visibleText).not.toMatch(/<(pasted|terminal|element)_context>/);
    expect(shown.pastedContexts.map((entry) => entry.name)).toEqual(["a.md", "b.md"]);
    expect(shown.elementContexts.length).toBeGreaterThan(0);
    expect(shown.terminalContexts.length).toBeGreaterThan(0);
  });

  it("survives every composer context type without leaking anchored markup", () => {
    const sent = appendEnabledSkillsContext(
      assembleForSend({
        prompt: "fix the button",
        pasted: [paste("failure.log", "click failed")],
        terminals: [terminal()],
        elements: [element()],
        previews: [preview()],
        reviews: [review()],
      }),
      [
        {
          name: "focus-mode",
          path: "/home/test/.agents/skills/focus-mode/SKILL.md",
        },
        {
          name: "security-review",
          path: "/home/test/.agents/skills/security-review/SKILL.md",
          scope: "session",
        },
      ],
    );
    const shown = displayOf(sent);

    expect(shown.visibleText).toContain("fix the button");
    expect(shown.visibleText).toContain("<review_comment");
    expect(shown.visibleText).not.toMatch(
      /<(pasted_context|terminal_context|element_context|preview_annotation|enabled_skills)[ >]/,
    );
    expect(shown.pastedContexts).toMatchObject([{ name: "failure.log", body: "click failed" }]);
    expect(shown.terminalContexts).toHaveLength(1);
    expect(shown.elementContexts).toHaveLength(1);
    expect(shown.previewAnnotations).toMatchObject([
      { id: "preview-1", comment: "Move the button" },
    ]);
    expect(shown.enabledSkills).toEqual(["focus-mode", "security-review"]);
    expect(shown.globalEnabledSkills).toEqual(["focus-mode"]);
    expect(shown.sessionEnabledSkills).toEqual(["security-review"]);
    expect(shown.copyText).not.toContain("<enabled_skills");
  });

  it("preserves the order of several preview annotations around other contexts", () => {
    const first = preview();
    const second = { ...preview(), id: "preview-2", comment: "Then change the color" };
    const shown = displayOf(
      assembleForSend({
        prompt: "update it",
        pasted: [paste("notes.txt", "details")],
        previews: [first, second],
      }),
    );

    expect(shown.previewAnnotations.map((annotation) => annotation.id)).toEqual([
      "preview-1",
      "preview-2",
    ]);
    expect(shown.visibleText).toBe("update it");
    expect(shown.pastedContexts).toHaveLength(1);
  });

  it("carries an attachment with an empty prompt", () => {
    const sent = assembleForSend({ prompt: "", pasted: [paste("only.txt", "content")] });
    const shown = displayOf(sent);
    expect(shown.visibleText).toBe("");
    expect(shown.pastedContexts).toHaveLength(1);
  });

  it("leaves a plain prompt untouched", () => {
    const sent = assembleForSend({ prompt: "just a question" });
    const shown = displayOf(sent);
    expect(shown.visibleText).toBe("just a question");
    expect(shown.pastedContexts).toHaveLength(0);
  });

  it("preserves attachment content verbatim through the round trip", () => {
    // Markdown, blank lines, and code fences must not be mangled in transit.
    const body = "# Title\n\n```ts\nconst x = 1;\n```\n\n- bullet";
    const sent = assembleForSend({ prompt: "summarize", pasted: [paste("doc.md", body)] });
    expect(displayOf(sent).pastedContexts[0]?.body).toBe(body);
  });

  it("does not treat prompt prose about the tag as an attachment", () => {
    const sent = assembleForSend({ prompt: "what does <pasted_context> mean?" });
    expect(displayOf(sent).visibleText).toBe("what does <pasted_context> mean?");
    expect(displayOf(sent).pastedContexts).toHaveLength(0);
  });

  it("keeps a dev trigger parsable through every context attachment type", () => {
    const sent = assembleForSend({
      prompt: "!dev:default fix the parser",
      pasted: [paste("failure.log", "unexpected token")],
      terminals: [terminal()],
      elements: [element()],
    });

    const trigger = parseDevTrigger(sent);
    expect(trigger?.scenarioName).toBe("default");
    expect(trigger?.task).toContain("fix the parser");
    expect(trigger?.task).toContain('<pasted_context version="2">');
    expect(trigger?.task).toContain("<terminal_context>");
    expect(trigger?.task).toContain("<element_context>");
    const displayed = displayOf(sent);
    expect(displayed.visibleText).toBe("!dev:default fix the parser");
    expect(displayed.pastedContexts).toMatchObject([
      { name: "failure.log", body: "unexpected token" },
    ]);
    expect(displayed.terminalContexts).toHaveLength(1);
    expect(displayed.elementContexts).toHaveLength(1);
  });
});
