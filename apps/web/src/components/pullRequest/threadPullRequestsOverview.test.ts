import type { ThreadPullRequestLink } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import { threadPullRequestsOverview } from "./threadPullRequestsOverview";

function link(
  repository: string,
  number: number,
  headBranch: string,
  baseBranch = "main",
): { -readonly [K in keyof ThreadPullRequestLink]: ThreadPullRequestLink[K] } {
  return {
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-09-14T00:00:00Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch,
      baseBranch,
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-14T00:00:00Z",
    },
  };
}

describe("threadPullRequestsOverview", () => {
  it("aggregates five PRs across repositories without combining matching numbers or branches", () => {
    const a = link("acme/api", 1, "feature");
    const b = link("acme/api", 2, "followup", "feature");
    const c = link("acme/web", 1, "feature");
    const d = link("acme/web", 2, "fix");
    const e = link("acme/web", 3, "unknown");
    b.snapshot = {
      ...b.snapshot!,
      checksState: "failing",
      mergeability: "conflicting",
      reviewDecision: "changes-requested",
    };
    c.snapshot = { ...c.snapshot!, state: "merged", checksState: "failing" };
    d.snapshot = { ...d.snapshot!, state: "closed" };
    e.snapshot = null;
    const result = threadPullRequestsOverview([e, d, b, a, c]);
    expect(result.totals).toEqual({
      linked: 5,
      open: 2,
      merged: 1,
      closed: 1,
      unknown: 1,
      attention: 1,
      branches: 6,
    });
    expect(
      result.groups.map((group) => [group.repository, group.links.length, group.branches]),
    ).toEqual([
      ["acme/api", 2, ["feature", "followup", "main"]],
      ["acme/web", 3, ["feature", "fix", "main"]],
    ]);
    expect(result.groups[0]?.lines.map((line) => [line.link.number, line.depth])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("excludes dismissed PRs and duplicate identities without treating pending checks as failures", () => {
    const pending = link("acme/web", 1, "feature");
    pending.snapshot = { ...pending.snapshot!, checksState: "pending", isDraft: true };
    const hidden = { ...link("acme/web", 2, "hidden"), source: "stack-dismissed" as const };
    const result = threadPullRequestsOverview([pending, { ...pending }, hidden]);
    expect(result.totals).toMatchObject({ linked: 1, open: 1, unknown: 0, attention: 0 });
  });

  it("keeps same-named repositories on different hosts separate and handles detachment", () => {
    const a = link("acme/web", 1, "feature");
    const b = { ...a, host: "git.example.com", url: "https://git.example.com/acme/web/pull/1" };
    expect(threadPullRequestsOverview([a, b]).groups).toHaveLength(2);
    expect(threadPullRequestsOverview([a]).groups).toHaveLength(1);
    expect(threadPullRequestsOverview([]).totals).toMatchObject({
      linked: 0,
      branches: 0,
      attention: 0,
    });
  });
});
