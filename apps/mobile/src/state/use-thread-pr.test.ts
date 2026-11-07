import {
  ProjectId,
  type PullRequestSummary,
  type VcsStatusResult,
  SourceControlProviderKind,
  type ThreadPullRequestLink,
} from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  knownPullRequestSummary,
  rememberBounded,
  presentThreadLinkedPullRequests,
  presentThreadPr,
  resolveThreadPrBadgeAction,
  resolveThreadPrSource,
} from "./thread-pr-presentation";

const pullRequest: NonNullable<VcsStatusResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/t3tools/t3code/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
};

describe("presentThreadPr", () => {
  it("uses the compact pull request number label without a hash prefix", () => {
    expect(presentThreadPr(pullRequest, undefined)).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 pull request merged",
      textClassName: "text-adaptive-violet-600-400",
    });
  });

  it("uses merge-request terminology for GitLab", () => {
    expect(
      presentThreadPr(pullRequest, {
        kind: SourceControlProviderKind.make("gitlab"),
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
    });
  });

  it("uses gray for draft pull requests", () => {
    expect(
      presentThreadPr({ ...pullRequest, state: "open", isDraft: true }, undefined),
    ).toMatchObject({
      accessibilityLabel: "#3774 pull request draft",
      textClassName: "text-foreground-muted",
    });
  });
});

function linkedPr(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `change-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinkedPullRequests", () => {
  it("renders unsynced links with neutral pending status", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1, { snapshot: null })])).toMatchObject({
      number: 1,
      label: "1",
      state: null,
      textClassName: "text-foreground-muted",
      accessibilityLabel: "#1 pull request status pending",
    });
  });

  it("counts unrelated links without labelling them a stack", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1), linkedPr(2)])).toMatchObject({
      kind: "pull-request",
      label: "+2",
      others: 1,
      state: "open",
      isDraft: false,
      textClassName: "text-adaptive-emerald-600-400",
    });
  });

  it.each([
    ["closed", false, "closed", false, "closed", false, "text-adaptive-rose-600-400"],
    ["open", true, "open", true, "open", true, "text-foreground-muted"],
    ["open", true, "open", false, "open", false, "text-adaptive-emerald-600-400"],
    ["closed", false, "open", false, "open", false, "text-adaptive-emerald-600-400"],
    ["merged", false, "merged", false, "merged", false, "text-adaptive-violet-600-400"],
    ["closed", false, "merged", false, "closed", false, "text-adaptive-rose-600-400"],
  ] as const)(
    "colors linked %s (draft %s) and %s (draft %s) by their aggregate state",
    (firstState, firstDraft, secondState, secondDraft, state, isDraft, textClassName) => {
      const first = linkedPr(1);
      const second = linkedPr(2);
      expect(
        presentThreadLinkedPullRequests([
          { ...first, snapshot: { ...first.snapshot!, state: firstState, isDraft: firstDraft } },
          {
            ...second,
            snapshot: { ...second.snapshot!, state: secondState, isDraft: secondDraft },
          },
        ]),
      ).toMatchObject({
        label: "+2",
        state,
        isDraft,
        textClassName,
        accessibilityLabel: `2 linked pull requests, overall ${isDraft ? "draft" : state}`,
      });
    },
  );

  it("uses the top of a derived stack even when its bottom was linked later", () => {
    const bottom = linkedPr(1, { linkedAt: "2026-09-09T00:00:00.000Z" });
    const top = linkedPr(2);
    expect(
      presentThreadLinkedPullRequests([
        bottom,
        {
          ...top,
          snapshot: { ...top.snapshot!, baseBranch: "change-1" },
        },
      ]),
    ).toMatchObject({ kind: "stack", label: "2", number: 2, url: top.url });
  });

  it("hides dismissed stack members", () => {
    expect(
      presentThreadLinkedPullRequests([linkedPr(1, { source: "stack-dismissed" })]),
    ).toBeNull();
  });

  it("retains merged state from the persisted snapshot", () => {
    const link = linkedPr(1);
    expect(
      presentThreadLinkedPullRequests([
        { ...link, snapshot: { ...link.snapshot!, state: "merged" } },
      ]),
    ).toMatchObject({ state: "merged", textClassName: "text-adaptive-violet-600-400" });
  });
});

describe("resolveThreadPrBadgeAction", () => {
  it("opens a single linked or branch pull request directly", () => {
    expect(resolveThreadPrBadgeAction(presentThreadLinkedPullRequests([linkedPr(1)])!)).toEqual({
      kind: "open",
      accessibilityLabel: "Open #1 pull request open",
    });
    expect(resolveThreadPrBadgeAction(presentThreadPr(pullRequest, null))).toMatchObject({
      kind: "open",
    });
  });

  it("lists unrelated linked pull requests", () => {
    expect(
      resolveThreadPrBadgeAction(presentThreadLinkedPullRequests([linkedPr(1), linkedPr(2)])!),
    ).toEqual({
      kind: "list",
      accessibilityLabel: "Show 2 linked pull requests, overall open",
    });
  });

  it("lists a stack even though the badge shows its top pull request", () => {
    const top = linkedPr(2);
    const stack = presentThreadLinkedPullRequests([
      linkedPr(1),
      { ...top, snapshot: { ...top.snapshot!, baseBranch: "change-1" } },
    ])!;
    expect(resolveThreadPrBadgeAction(stack)).toMatchObject({ kind: "list" });
  });
});

describe("resolveThreadPrSource compatibility", () => {
  const legacyRef = {
    projectId: ProjectId.make("project"),
    repository: "t3tools/t3code",
    number: 1,
    url: "https://github.com/t3tools/t3code/pull/1",
  };
  const branchRef = { ...legacyRef, number: 2, url: "https://github.com/t3tools/t3code/pull/2" };

  it("polls the legacy reference when only the older linking capability exists", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("keeps the legacy reference for a server without either capability", () => {
    expect(resolveThreadPrSource({ pullRequests: [], linkedPullRequest: legacyRef }, {})).toEqual({
      linkedPresentation: null,
      pullRequestRef: legacyRef,
    });
  });

  it("ignores stale snapshots after reconnecting to a server without array support", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef },
        { threadPullRequestLinking: true, threadPullRequests: false },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling when both capabilities are advertised", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true, threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequests: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: branchRef });
  });

  it("does not poll when a modern link is waiting for its first snapshot", () => {
    expect(
      resolveThreadPrSource(
        {
          pullRequests: [linkedPr(3, { snapshot: null })],
          linkedPullRequest: legacyRef,
          branchPullRequest: branchRef,
        },
        { threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });
});

describe("knownPullRequestSummary", () => {
  it("seeds from the newest summary of the same pull request, never another's", () => {
    const projectId = ProjectId.make("project");
    const link = linkedPr(7);
    const threads = [
      {
        projectId,
        pullRequests: [
          { ...link, snapshot: { ...link.snapshot!, updatedAt: "2026-09-08T00:00:00.000Z" } },
        ],
      },
    ];
    const listed: PullRequestSummary = {
      provider: SourceControlProviderKind.make("github"),
      projectId,
      repository: "t3tools/t3code",
      number: 7,
      title: "Listed title",
      url: "https://github.com/t3tools/t3code/pull/7",
      state: "open",
      headBranch: "change-7",
      baseBranch: "main",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const lookup = (host: string, number: number, summaries = [listed]) =>
      knownPullRequestSummary({ host, repository: "t3tools/t3code", number }, threads, summaries);

    expect(lookup("github.com", 7, [])?.title).toBe("Change 7");
    expect(lookup("github.com", 7)?.title).toBe("Listed title");
    expect(lookup("github.com", 8)).toBeUndefined();
    expect(lookup("gitlab.com", 7)).toBeUndefined();

    const sameVersion = { ...listed, updatedAt: "2026-09-08T00:00:00.000Z" };
    const syncedAt = Date.parse(link.snapshot!.syncedAt);
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt - 1 }])?.title).toBe(
      "Change 7",
    );
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt + 1 }])?.title).toBe(
      "Listed title",
    );
  });
});

describe("rememberBounded", () => {
  it("moves a re-answered entry to the newest slot and evicts the oldest past the limit", () => {
    let snapshots: ReadonlyMap<string, number> = new Map();
    snapshots = rememberBounded(snapshots, "a", 1, 2);
    snapshots = rememberBounded(snapshots, "b", 2, 2);
    snapshots = rememberBounded(snapshots, "a", 3, 2);
    snapshots = rememberBounded(snapshots, "c", 4, 2);
    expect([...snapshots]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });
});
