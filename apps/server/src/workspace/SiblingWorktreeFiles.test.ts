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
import { SiblingWorktreeFiles, layer } from "./SiblingWorktreeFiles.ts";

const layerTest = layer.pipe(
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sibling-worktree-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    timeout: 10_000,
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
        const { locations } = yield* (yield* SiblingWorktreeFiles).locate({
          cwd: main,
          relativePath,
        });
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

      const fromAgent = yield* (yield* SiblingWorktreeFiles).locate({
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
      const missing = yield* (yield* SiblingWorktreeFiles).locate({
        cwd: main,
        relativePath: "missing.md",
      });
      expect(missing.locations).toEqual([]);
      const outside = yield* (yield* SiblingWorktreeFiles).locate({
        cwd: main,
        relativePath: "/definitely/not/here.md",
      });
      expect(outside.locations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "checks at most 64 worktrees and returns the 20 newest files without changing checkouts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "sibling-bounds-" });
        const worktrees = Array.from({ length: 70 }, (_, index) => ({
          path: NodePath.join(root, `worktree-${index}`),
          branch: index === 0 ? "main" : `branch-${index}`,
        }));
        for (const [index, worktree] of worktrees.entries()) {
          NodeFS.mkdirSync(worktree.path);
          const target = NodePath.join(worktree.path, "report.md");
          NodeFS.writeFileSync(target, "report");
          NodeFS.utimesSync(target, index + 1, index + 1);
        }
        const visited: string[] = [];
        const measuredFileSystem = {
          ...fileSystem,
          realPath: (target: string) => {
            visited.push(target);
            return fileSystem.realPath(target);
          },
        };
        const boundedLayer = layer.pipe(
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              listWorktrees: () => Effect.succeed(worktrees),
            }),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, measuredFileSystem)),
        );
        const { locations } = yield* Effect.gen(function* () {
          return yield* (yield* SiblingWorktreeFiles).locate({
            cwd: worktrees[0]!.path,
            relativePath: "report.md",
          });
        }).pipe(Effect.provide(boundedLayer));
        expect(locations).toHaveLength(20);
        expect(locations.map((location) => location.branch)).toEqual(
          Array.from({ length: 20 }, (_, index) => `branch-${63 - index}`),
        );
        expect(visited.filter((target) => target !== worktrees[0]!.path)).toHaveLength(63);
        expect(visited).not.toContain(worktrees[64]!.path);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolves a symlinked working directory and ignores directory or invalid file targets",
    () =>
      Effect.gen(function* () {
        const { main, lead } = yield* makeRepository;
        const linkedMain = `${main}-link`;
        NodeFS.symlinkSync(main, linkedMain, "dir");
        NodeFS.writeFileSync(NodePath.join(lead, "report.md"), "report");
        const before = git(main, "rev-parse", "HEAD").toString();
        const service = yield* SiblingWorktreeFiles;
        const { locations } = yield* service.locate({ cwd: linkedMain, relativePath: "report.md" });
        expect(locations.map((location) => location.absolutePath)).toEqual([
          NodePath.join(lead, "report.md"),
        ]);
        for (const relativePath of [".", "..", "directory", "invalid\0file.md"]) {
          NodeFS.mkdirSync(NodePath.join(lead, "directory"), { recursive: true });
          expect((yield* service.locate({ cwd: main, relativePath })).locations).toEqual([]);
        }
        expect(git(main, "rev-parse", "HEAD").toString()).toEqual(before);
        expect(git(main, "branch", "--show-current").toString().trim()).toEqual("main");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
