import type {
  ProjectFileLocation,
  ProjectLocateFileInput,
  ProjectLocateFileResult,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const MAX_WORKTREES = 64;
const MAX_LOCATIONS = 20;

export class SiblingWorktreeFiles extends Context.Service<
  SiblingWorktreeFiles,
  {
    readonly locate: (input: ProjectLocateFileInput) => Effect.Effect<ProjectLocateFileResult>;
  }
>()("d4research/workspace/SiblingWorktreeFiles") {}

export const layer = Layer.effect(
  SiblingWorktreeFiles,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const realPath = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

    const locate = Effect.fn("SiblingWorktreeFiles.locate")(function* (
      input: ProjectLocateFileInput,
    ) {
      const cwd = path.resolve(input.cwd);
      const realCwd = yield* realPath(cwd);
      const requested = input.relativePath.trim();
      const lexicalTarget = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(cwd, requested);
      const relativeToCwd = path.relative(cwd, lexicalTarget);
      const target =
        relativeToCwd === ".." ||
        relativeToCwd.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToCwd)
          ? lexicalTarget
          : path.join(realCwd, relativeToCwd);

      const listed = yield* git
        .listWorktrees(realCwd)
        .pipe(
          Effect.orElseSucceed(
            (): ReadonlyArray<{ readonly path: string; readonly branch: string | null }> => [],
          ),
        );
      const worktrees = yield* Effect.forEach(
        listed.slice(0, MAX_WORKTREES),
        (worktree) => realPath(worktree.path).pipe(Effect.map((real) => ({ ...worktree, real }))),
        { concurrency: 8 },
      );
      const contains = (root: string) => {
        const relative = path.relative(root, target);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      };
      const owner = worktrees
        .filter((worktree) => contains(worktree.real))
        .toSorted((left, right) => right.real.length - left.real.length)[0];
      if (owner === undefined) return { locations: [] };
      const repositoryPath = path.relative(owner.real, target);

      const found = yield* Effect.forEach(
        worktrees.filter((worktree) => worktree.real !== owner.real),
        (worktree) => {
          const absolutePath = path.join(worktree.real, repositoryPath);
          return fileSystem.stat(absolutePath).pipe(
            Effect.map((info) =>
              info.type === "File"
                ? Option.some<ProjectFileLocation>({
                    absolutePath,
                    worktreePath: worktree.real,
                    branch: worktree.branch,
                    modifiedAt: Option.match(info.mtime, {
                      onNone: () => 0,
                      onSome: (mtime) => mtime.getTime(),
                    }),
                  })
                : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none<ProjectFileLocation>()),
          );
        },
        { concurrency: 8 },
      );
      return {
        locations: found
          .flatMap((location) => (Option.isSome(location) ? [location.value] : []))
          .toSorted((left, right) => right.modifiedAt - left.modifiedAt)
          .slice(0, MAX_LOCATIONS),
      };
    });
    return SiblingWorktreeFiles.of({ locate });
  }),
);
