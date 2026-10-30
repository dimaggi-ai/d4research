import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  MultiworkError,
  type MultiworkCreateResult,
  type MultiworkListResult,
} from "@d4research/contracts";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

const GIT_TIMEOUT_MS = 60_000;
// Cloning fetches from the remote and copies borrowed objects, so allow a generous window.
const CLONE_TIMEOUT_MS = 5 * 60_000;
const GIT_OUTPUT_MAX_BYTES = 4_000_000;
// Project context files that are commonly git-ignored, so a fresh clone won't carry them.
const CONTEXT_PATHS = [".claude", "CLAUDE.md", "AGENTS.md"] as const;

export interface MultiworkCreateServiceInput {
  readonly cwd: string;
  readonly branch: string;
  /** The raw `multiworkBaseDirectory` setting; empty resolves to ~/workplace/git/multiwork. */
  readonly baseDirectory: string;
}

export interface MultiworkServiceShape {
  readonly create: (
    input: MultiworkCreateServiceInput,
  ) => Effect.Effect<MultiworkCreateResult, MultiworkError>;
  readonly list: (input: {
    readonly baseDirectory: string;
    readonly cwd?: string | undefined;
  }) => Effect.Effect<MultiworkListResult, MultiworkError>;
}

export class MultiworkService extends Context.Service<MultiworkService, MultiworkServiceShape>()(
  "d4research/multiwork/MultiworkService",
) {}

function resolveBaseDirectory(path: Path.Path, raw: string): string {
  const trimmed = raw.trim();
  const home = NodeOS.homedir();
  if (trimmed.length === 0) {
    return path.join(home, "workplace", "git", "multiwork");
  }
  if (trimmed === "~") {
    return home;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

const make = Effect.fn("makeMultiworkService")(function* () {
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const multiworkError =
    (operation: string) =>
    (cause: unknown): MultiworkError =>
      new MultiworkError({
        operation,
        detail: cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause),
        cause,
      });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: { readonly timeoutMs?: number },
  ) =>
    git
      .execute({
        operation,
        cwd,
        args: [...args],
        allowNonZeroExit: true,
        timeoutMs: options?.timeoutMs ?? GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
        appendTruncationMarker: true,
      })
      .pipe(Effect.mapError(multiworkError(operation)));

  const gitOk = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: { readonly timeoutMs?: number },
  ) =>
    runGit(operation, cwd, args, options).pipe(
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          new MultiworkError({
            operation,
            detail:
              result.stderr.trim() || `git ${args.join(" ")} failed (code ${result.exitCode})`,
          }),
      ),
    );

  const resolveDefaultBaseRef = Effect.fn("MultiworkService.resolveDefaultBaseRef")(function* (
    dest: string,
  ) {
    for (const ref of ["origin/master", "origin/main"]) {
      const verify = yield* runGit("MultiworkService.verifyBaseRef", dest, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      if (verify.exitCode === 0) {
        return ref;
      }
    }
    const head = yield* runGit("MultiworkService.resolveOriginHead", dest, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    const headRef = head.stdout.trim();
    if (head.exitCode === 0 && headRef.length > 0) {
      return headRef.replace(/^refs\/remotes\//, "");
    }
    return "HEAD";
  });

  // Best-effort restore of git-ignored project context (skills, agent instructions) the clone drops.
  const restoreContext = Effect.fn("MultiworkService.restoreContext")(function* (
    src: string,
    dest: string,
  ) {
    for (const name of CONTEXT_PATHS) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      const exists = yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      if (yield* fs.exists(to).pipe(Effect.orElseSucceed(() => true))) continue;
      yield* fs.copy(from, to).pipe(Effect.ignore);
    }
  });

  const create: MultiworkServiceShape["create"] = Effect.fn("MultiworkService.create")(
    function* (input) {
      const branch = input.branch.trim();
      if (branch.length === 0) {
        return yield* new MultiworkError({
          operation: "MultiworkService.create",
          detail: "A branch name is required.",
        });
      }

      yield* gitOk("MultiworkService.validateBranch", input.cwd, [
        "check-ref-format",
        "--branch",
        branch,
      ]);

      const topLevel = yield* gitOk("MultiworkService.resolveSource", input.cwd, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const src = topLevel.stdout.trim();
      if (src.length === 0) {
        return yield* new MultiworkError({
          operation: "MultiworkService.create",
          detail: `${input.cwd} is not inside a Git repository.`,
        });
      }

      const projectName = path.basename(src);
      const originResult = yield* gitOk("MultiworkService.resolveOrigin", src, [
        "remote",
        "get-url",
        "origin",
      ]);
      const origin = originResult.stdout.trim();
      if (origin.length === 0) {
        return yield* new MultiworkError({
          operation: "MultiworkService.create",
          detail: "The source repository has no 'origin' remote.",
        });
      }

      const baseDir = resolveBaseDirectory(path, input.baseDirectory);
      yield* fs
        .makeDirectory(baseDir, { recursive: true })
        .pipe(Effect.mapError(multiworkError("MultiworkService.makeBaseDirectory")));

      const safeBranch = branch.replace(/\//g, "-");
      const dest = path.join(baseDir, `${projectName}-${safeBranch}`);
      const reused = yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false));

      if (reused) {
        const existingOrigin = yield* gitOk("MultiworkService.verifyReuse", dest, [
          "remote",
          "get-url",
          "origin",
        ]);
        if (existingOrigin.stdout.trim() !== origin) {
          return yield* new MultiworkError({
            operation: "MultiworkService.verifyReuse",
            detail: "The existing directory belongs to a different repository.",
          });
        }
        const existingBranch = yield* gitOk("MultiworkService.reuseBranch", dest, [
          "branch",
          "--show-current",
        ]);
        return {
          path: dest,
          branch: existingBranch.stdout.trim() || branch,
          projectName,
          reused: true,
        };
      }

      if (!reused) {
        // Fast path borrows local objects and detaches; fall back to a plain clone if it fails.
        const cloneReference = yield* runGit(
          "MultiworkService.cloneReference",
          src,
          ["clone", "--reference", src, "--dissociate", origin, dest],
          { timeoutMs: CLONE_TIMEOUT_MS },
        );
        if (cloneReference.exitCode !== 0) {
          yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* gitOk("MultiworkService.clone", src, ["clone", origin, dest], {
            timeoutMs: CLONE_TIMEOUT_MS,
          });
        }
      }

      yield* gitOk("MultiworkService.fetch", dest, ["fetch", "origin"], {
        timeoutMs: CLONE_TIMEOUT_MS,
      });

      const remoteBranch = yield* runGit("MultiworkService.lsRemoteBranch", dest, [
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        branch,
      ]);
      if (remoteBranch.exitCode === 0) {
        yield* gitOk("MultiworkService.checkoutExisting", dest, [
          "checkout",
          "-B",
          branch,
          `origin/${branch}`,
        ]);
      } else {
        const baseRef = yield* resolveDefaultBaseRef(dest);
        yield* gitOk("MultiworkService.checkoutNew", dest, ["checkout", "-B", branch, baseRef]);
      }

      yield* restoreContext(src, dest);

      return { path: dest, branch, projectName, reused };
    },
  );

  const list: MultiworkServiceShape["list"] = Effect.fn("MultiworkService.list")(function* (input) {
    const baseDir = resolveBaseDirectory(path, input.baseDirectory);
    const exists = yield* fs.exists(baseDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { baseDirectory: baseDir, copies: [] };
    }

    const names = yield* fs
      .readDirectory(baseDir)
      .pipe(Effect.mapError(multiworkError("MultiworkService.list")));
    const sourceOrigin = input.cwd
      ? (yield* runGit("MultiworkService.sourceOrigin", input.cwd, [
          "remote",
          "get-url",
          "origin",
        ])).stdout.trim()
      : null;
    const copies: Array<{ path: string; name: string; branch: string }> = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(baseDir, name);
      const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => null));
      if (stat?.type === "Directory") {
        if (!(yield* fs.exists(path.join(full, ".git")).pipe(Effect.orElseSucceed(() => false))))
          continue;
        const origin = yield* runGit("MultiworkService.copyOrigin", full, [
          "remote",
          "get-url",
          "origin",
        ]);
        if (
          origin.exitCode !== 0 ||
          (sourceOrigin !== null && origin.stdout.trim() !== sourceOrigin)
        )
          continue;
        const branch = yield* runGit("MultiworkService.copyBranch", full, [
          "branch",
          "--show-current",
        ]);
        copies.push({ path: full, name, branch: branch.stdout.trim() });
      }
    }
    copies.sort((a, b) => a.name.localeCompare(b.name));
    return { baseDirectory: baseDir, copies };
  });

  return MultiworkService.of({ create, list });
});

export const layer = Layer.effect(MultiworkService, make());
