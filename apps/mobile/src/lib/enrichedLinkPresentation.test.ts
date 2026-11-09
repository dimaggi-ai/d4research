import { describe, expect, it } from "vite-plus/test";
import type {
  ComposerContextId,
  ReviewCommentContextRecord,
  EnvironmentId,
  ThreadId,
} from "@d4research/contracts";
import {
  enrichedContextLinkPresentation,
  enrichedThreadLinkPresentation,
  threadChipTargets,
  enrichedLinkVariantPattern,
  buildEnrichedModelReferences,
  enrichedModelLinkRegex,
  enrichedModelReference,
  enrichedTextLinkRegex,
  enrichedSkillLinkRegex,
  enrichedSkillReference,
  ENRICHED_INLINE_FILE_LINK_REGEX,
} from "./enrichedLinkPresentation";

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path), path).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text), text).toBe(false);
    }
  });

  it("only recognizes complete known skill names and escapes their punctuation", () => {
    const regex = enrichedSkillLinkRegex([{ name: "check" }, { name: "check.mobile" }]);
    expect(regex?.exec("Try $check.mobile next")?.[0]).toBe("$check.mobile");
    expect(regex?.exec("Try $check-mobile next")).toBeNull();
    expect(regex?.exec("Try $checkXmobile next")).toBeNull();
    expect(regex?.exec("prefix$check next")).toBeNull();
    expect(enrichedSkillLinkRegex([])).toBeNull();
  });
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "recognizes and presents known skills with %s while rejecting adjacent tokens",
    (sigil) => {
      const skills = [{ name: "check", displayName: "Check" }];
      const regex = enrichedSkillLinkRegex(skills)!;
      expect(regex.exec(`Try ${sigil}check now`)?.[0]).toBe(`${sigil}check`);
      expect(enrichedSkillReference(`${sigil}check`, skills)).toBe(skills[0]);
      expect(regex.test(`prefix${sigil}check`)).toBe(false);
      expect(regex.test(`${sigil}check-extra`)).toBe(false);
      expect(regex.test(`${sigil}unknown`)).toBe(false);
      expect(regex.test(`${sigil}${sigil}check`)).toBe(false);
    },
  );

  it("recognizes only complete known models in prose and resolves their display names", () => {
    const models = buildEnrichedModelReferences([
      {
        instanceId: "codex",
        driver: "codex",
        models: [
          { slug: "gpt-6.1", name: "OpenAI GPT-6.1", subProvider: "OpenAI" },
          { slug: "gpt-6.1-sol[1m]", name: "GPT-6.1 Sol" },
        ],
      },
    ]);
    const regex = enrichedModelLinkRegex(models);
    for (const text of [
      "Try model:codex/gpt-6.1 next",
      "Try (model:codex/gpt-6.1).",
      "Try [model:codex/gpt-6.1] next",
      '"model:codex/gpt-6.1"',
    ]) {
      const source = regex?.exec(text)?.[0];
      expect(source, text).toBe("model:codex/gpt-6.1");
      expect(enrichedModelReference(source!, models)?.label).toBe("GPT-6.1");
    }
    expect(regex?.exec("Try model:codex/gpt-6.1-sol[1m].")?.[0]).toBe(
      "model:codex/gpt-6.1-sol[1m]",
    );
    for (const text of [
      "model:openai/gpt-4o",
      "model:codex/gpt-6.1-extra",
      "model:codex/gpt-6.1.2",
      "model:codex/gpt-6X1",
      "premodel:codex/gpt-6.1",
    ]) {
      expect(regex?.exec(text), text).toBeNull();
    }
    expect(enrichedModelReference("model:openai/gpt-4o", models)).toBeUndefined();
    expect(enrichedModelLinkRegex([])).toBeNull();
    expect(enrichedTextLinkRegex([], [])).toBeNull();
    const combined = enrichedTextLinkRegex([{ name: "review" }], models);
    expect(
      "Use $review with (model:codex/gpt-6.1).".match(new RegExp(combined!.source, "gu")),
    ).toEqual(["$review", "model:codex/gpt-6.1"]);
  });

  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });

  it("uses context identity for PR status even when labels are identical", () => {
    const record: ReviewCommentContextRecord = {
      version: 1,
      contextId: "review_1" as ComposerContextId,
      kind: "review-comment",
      label: "Review",
      sectionId: "pull-request:7",
      sectionTitle: "Review",
      filePath: "app.tsx",
      startIndex: 0,
      endIndex: 1,
      rangeLabel: "line 1",
      text: "Comment",
      diff: "",
      pullRequest: {
        number: 7,
        title: "Review",
        url: "https://github.com/example/repo/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: "merged",
        isDraft: false,
      },
    };
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_1", [record]),
    ).toEqual({ accent: "#8a70dd", icon: { kind: "chip", name: "git-merge" } });
    expect(
      enrichedContextLinkPresentation("t3-context://v1/review-comment/review_2", [record]),
    ).toEqual({ icon: { kind: "chip", name: "circle-dashed" } });
  });

  it("retains recognizable presentation for unavailable and future context kinds", () => {
    expect(enrichedContextLinkPresentation("t3-context://v1/terminal/missing")).toEqual({
      accent: "#009f6e",
      icon: { kind: "chip", name: "terminal" },
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/skill/missing")).toEqual({
      accent: "#b261be",
      icon: { kind: "chip", name: "skill" },
    });
    expect(enrichedContextLinkPresentation("t3-context://v1/future/missing")).toEqual({
      icon: { kind: "chip", name: "circle-dashed" },
    });
    expect(enrichedContextLinkPresentation("https://example.com/terminal/missing")).toBeUndefined();
  });

  it("presents thread links as thread chips and leaves other links alone", () => {
    for (const href of ["t3-thread://v1/thread%3Aproject%3A1", "t3-thread://v2/env/thread_1"]) {
      expect(enrichedThreadLinkPresentation(href), href).toEqual({
        accent: "#009c96",
        icon: { kind: "chip", name: "messages-square" },
      });
    }
    for (const href of [
      "https://github.com/example/repo/pull/7",
      "https://example.com",
      "t3-context://v1/thread/thread_1",
    ]) {
      expect(enrichedThreadLinkPresentation(href), href).toBeUndefined();
    }
  });

  it("finds each linked thread once and resolves thread records to their own environment", () => {
    const here = "env-here" as EnvironmentId;
    const there = "env-there" as EnvironmentId;
    expect(
      threadChipTargets(
        here,
        "See [A](t3-thread://v1/thread_a), [A again](t3-thread://v1/thread_a), [B](t3-thread://v1/thread_b) and [D](t3-thread://v2/env-there/thread_d).",
        [
          {
            version: 1,
            contextId: "thr1" as ComposerContextId,
            kind: "thread",
            label: "C",
            environmentId: there,
            threadId: "thread_c" as ThreadId,
            title: "C",
          },
        ],
      ),
    ).toEqual([
      { href: "t3-thread://v1/thread_a", environmentId: here, threadId: "thread_a", link: true },
      { href: "t3-thread://v1/thread_b", environmentId: here, threadId: "thread_b", link: true },
      {
        href: "t3-thread://v2/env-there/thread_d",
        environmentId: there,
        threadId: "thread_d",
        link: true,
      },
      {
        href: "t3-context://v1/thread/thr1",
        environmentId: there,
        threadId: "thread_c",
        link: false,
      },
    ]);
    expect(threadChipTargets(here, "No links here.")).toEqual([]);
  });

  it("finds thread links with angle-bracketed destinations", () => {
    const here = "env-here" as EnvironmentId;
    expect(threadChipTargets(here, "See [A](<t3-thread://v2/env-here/thread_a>).")).toEqual([
      {
        href: "t3-thread://v2/env-here/thread_a",
        environmentId: here,
        threadId: "thread_a",
        link: true,
      },
    ]);
  });
});
