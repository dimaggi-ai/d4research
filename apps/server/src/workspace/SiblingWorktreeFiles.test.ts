// @effect-diagnostics nodeBuiltinImport:off - builds real Git worktrees on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { locateInSiblingWorktrees } from "./SiblingWorktreeFiles.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sibling-worktree-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = NodeFS.realpathSync.native(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "sibling-worktree-" }),
  );
  const main = NodePath.join(root, "main");
  NodeFS.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(main, "README.md"), "# repo\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const lead = NodePath.join(root, "lead");
  git(main, "worktree", "add", "-q", "-b", "lead", lead);
  const agent = NodePath.join(main, ".claude", "worktrees", "agent");
  git(main, "worktree", "add", "-q", "--detach", agent);
  return { main, lead, agent };
});

describe("locateInSiblingWorktrees", () => {
  it.effect("finds a missing file in the repository's other worktrees, newest first", () =>
    Effect.gen(function* () {
      const { main, lead, agent } = yield* makeRepository;
      const report = NodePath.join("reports", "REPORT.md");
      for (const [worktree, seconds] of [
        [lead, 2_000],
        [agent, 1_000],
      ] as const) {
        NodeFS.mkdirSync(NodePath.join(worktree, "reports"));
        NodeFS.writeFileSync(NodePath.join(worktree, report), "# report\n");
        NodeFS.utimesSync(NodePath.join(worktree, report), seconds, seconds);
      }

      for (const relativePath of [report, NodePath.join(main, report)]) {
        const { locations } = yield* locateInSiblingWorktrees({ cwd: main, relativePath });
        expect(locations).toEqual([
          {
            absolutePath: NodePath.join(lead, report),
            worktreePath: lead,
            branch: "lead",
            modifiedAt: 2_000_000,
          },
          {
            absolutePath: NodePath.join(agent, report),
            worktreePath: agent,
            branch: null,
            modifiedAt: 1_000_000,
          },
        ]);
      }

      const fromAgent = yield* locateInSiblingWorktrees({
        cwd: main,
        relativePath: NodePath.join(agent, "README.md"),
      });
      expect(fromAgent.locations.map((location) => location.worktreePath)).toEqual(
        expect.arrayContaining([main, lead]),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("returns nothing outside a repository or when no worktree has the file", () =>
    Effect.gen(function* () {
      const { main } = yield* makeRepository;
      const missing = yield* locateInSiblingWorktrees({ cwd: main, relativePath: "missing.md" });
      expect(missing.locations).toEqual([]);
      const outside = yield* locateInSiblingWorktrees({
        cwd: main,
        relativePath: "/definitely/not/here.md",
      });
      expect(outside.locations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
