import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@d4research/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { MultiworkService, layer as multiworkLayer } from "./MultiworkService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-multiwork-service-test-",
});
const TestLayer = multiworkLayer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "multiwork-service-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "MultiworkService.test.git",
      cwd,
      args: [...args],
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });

// Build a source repo whose `origin` is a local bare repo, so clones stay offline.
const setUpSource = Effect.fn("setUpSource")(function* () {
  const origin = yield* makeTmpDir("multiwork-origin-");
  const src = yield* makeTmpDir("multiwork-src-");
  yield* git(origin, ["init", "--bare", "-b", "master"]);
  yield* git(src, ["init", "-b", "master"]);
  yield* git(src, ["config", "user.email", "test@test.com"]);
  yield* git(src, ["config", "user.name", "Test"]);
  // README is tracked; .claude/ and CLAUDE.md are git-ignored so they exercise context restore.
  yield* writeTextFile(src, ".gitignore", ".claude/\nCLAUDE.md\n");
  yield* writeTextFile(src, "README.md", "# source\n");
  yield* writeTextFile(src, ".claude/settings.json", "{}\n");
  yield* writeTextFile(src, "CLAUDE.md", "# project rules\n");
  yield* git(src, ["add", "."]);
  yield* git(src, ["commit", "-m", "initial commit"]);
  yield* git(src, ["remote", "add", "origin", origin]);
  yield* git(src, ["push", "-u", "origin", "master"]);
  return { origin, src };
});

it.layer(TestLayer)("MultiworkService", (it) => {
  describe("create", () => {
    it.effect("clones an isolated copy on a fresh branch and restores ignored context", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* MultiworkService;
        const { src } = yield* setUpSource();
        const baseDirectory = yield* makeTmpDir("multiwork-base-");

        yield* writeTextFile(src, "README.md", "Unsaved source edits\n");

        const result = yield* service.create({
          cwd: src,
          branch: "feature-test-task",
          baseDirectory,
        });

        assert.equal(result.reused, false);
        assert.equal(result.branch, "feature-test-task");
        assert.equal(result.projectName, path.basename(src));
        assert.equal(
          result.path,
          path.join(baseDirectory, `${path.basename(src)}-feature-test-task`),
        );

        // On the requested branch.
        assert.equal(
          yield* git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "feature-test-task",
        );
        // Tracked content came across.
        assert.equal(yield* git(result.path, ["show", "HEAD:README.md"]), "# source");
        assert.equal(
          yield* fileSystem.readFileString(path.join(src, "README.md")),
          "Unsaved source edits\n",
        );
        // Git-ignored project context was restored.
        assert.isTrue(yield* fileSystem.exists(path.join(result.path, "CLAUDE.md")));
        assert.isTrue(yield* fileSystem.exists(path.join(result.path, ".claude/settings.json")));
      }),
    );

    it.effect("continues an existing remote branch when one exists", () =>
      Effect.gen(function* () {
        const service = yield* MultiworkService;
        const { src } = yield* setUpSource();
        const baseDirectory = yield* makeTmpDir("multiwork-base-");

        // Publish a feature branch on origin from the source repo.
        yield* git(src, ["checkout", "-b", "feature-existing"]);
        yield* writeTextFile(src, "feature.txt", "feature\n");
        yield* git(src, ["add", "feature.txt"]);
        yield* git(src, ["commit", "-m", "feature commit"]);
        yield* git(src, ["push", "-u", "origin", "feature-existing"]);
        yield* git(src, ["checkout", "master"]);

        const result = yield* service.create({
          cwd: src,
          branch: "feature-existing",
          baseDirectory,
        });

        assert.equal(
          yield* git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "feature-existing",
        );
        // The committed feature file is present (we continued the existing branch).
        assert.equal(yield* git(result.path, ["show", "HEAD:feature.txt"]), "feature");
      }),
    );

    it.effect("reuses an existing copy and lists it", () =>
      Effect.gen(function* () {
        const service = yield* MultiworkService;
        const { src } = yield* setUpSource();
        const baseDirectory = yield* makeTmpDir("multiwork-base-");

        const first = yield* service.create({
          cwd: src,
          branch: "feature-reuse",
          baseDirectory,
        });
        assert.equal(first.reused, false);

        yield* git(first.path, ["config", "user.email", "test@test.com"]);
        yield* git(first.path, ["config", "user.name", "Test"]);
        yield* writeTextFile(first.path, "local.txt", "local commit");
        yield* git(first.path, ["add", "local.txt"]);
        yield* git(first.path, ["commit", "-m", "unpushed progress"]);
        const localHead = yield* git(first.path, ["rev-parse", "HEAD"]);
        yield* writeTextFile(first.path, "README.md", "dirty work");
        yield* writeTextFile(first.path, "CLAUDE.md", "copy-specific instructions");

        const second = yield* service.create({
          cwd: src,
          branch: "feature-reuse",
          baseDirectory,
        });
        assert.equal(second.reused, true);
        assert.equal(second.path, first.path);
        assert.equal(yield* git(second.path, ["rev-parse", "HEAD"]), localHead);
        const fs = yield* FileSystem.FileSystem;
        assert.equal(yield* fs.readFileString(`${second.path}/README.md`), "dirty work");
        assert.equal(
          yield* fs.readFileString(`${second.path}/CLAUDE.md`),
          "copy-specific instructions",
        );
        const unrelated = yield* setUpSource();
        assert.equal((yield* service.list({ baseDirectory, cwd: unrelated.src })).copies.length, 0);
        assert.equal((yield* service.list({ baseDirectory, cwd: src })).copies.length, 1);

        const listed = yield* service.list({ baseDirectory });
        assert.equal(listed.baseDirectory, baseDirectory);
        assert.include(
          listed.copies.map((copy) => copy.name),
          `${(yield* Path.Path).basename(src)}-feature-reuse`,
        );
      }),
    );

    it.effect("fails when the source is not a git repository", () =>
      Effect.gen(function* () {
        const service = yield* MultiworkService;
        const cwd = yield* makeTmpDir("multiwork-nonrepo-");
        const baseDirectory = yield* makeTmpDir("multiwork-base-");

        const exit = yield* Effect.exit(
          service.create({ cwd, branch: "feature-x", baseDirectory }),
        );
        assert.equal(exit._tag, "Failure");
      }),
    );
  });
});
