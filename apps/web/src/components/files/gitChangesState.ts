import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GitCommitStagedResult,
  GitDetailedStatusResult,
  GitFileDiffResult,
} from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { gitEnvironment } from "~/state/git";

function getGitDetailedStatusAtom(environmentId: EnvironmentId, cwd: string) {
  return gitEnvironment.detailedStatus({ environmentId, input: { cwd } });
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Git status query failed.";
}

export interface GitDetailedStatusState {
  readonly data: GitDetailedStatusResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useGitDetailedStatus(
  environmentId: EnvironmentId,
  cwd: string,
): GitDetailedStatusState {
  const atom = getGitDetailedStatusAtom(environmentId, cwd);
  const result = useAtomValue(atom);
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

function refreshGitDetailedStatus(environmentId: EnvironmentId, cwd: string): void {
  appAtomRegistry.refresh(getGitDetailedStatusAtom(environmentId, cwd));
}

export interface GitFileDiffState {
  readonly data: GitFileDiffResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useGitFileDiff(
  environmentId: EnvironmentId,
  cwd: string,
  path: string,
): GitFileDiffState {
  const atom = gitEnvironment.fileDiff({ environmentId, input: { cwd, path } });
  const result = useAtomValue(atom);
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

async function runGitCommand<W, A, E>(command: AtomCommand<W, A, E>, target: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, target, {
    reportFailure: false,
  });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

export async function stageGitFiles(
  environmentId: EnvironmentId,
  cwd: string,
  paths: readonly string[],
): Promise<void> {
  await runGitCommand(gitEnvironment.stageFiles, {
    environmentId,
    input: { cwd, paths: [...paths] },
  });
  refreshGitDetailedStatus(environmentId, cwd);
}

export async function unstageGitFiles(
  environmentId: EnvironmentId,
  cwd: string,
  paths: readonly string[],
): Promise<void> {
  await runGitCommand(gitEnvironment.unstageFiles, {
    environmentId,
    input: { cwd, paths: [...paths] },
  });
  refreshGitDetailedStatus(environmentId, cwd);
}

export async function discardGitChanges(
  environmentId: EnvironmentId,
  cwd: string,
  paths: readonly string[],
): Promise<void> {
  await runGitCommand(gitEnvironment.discardChanges, {
    environmentId,
    input: { cwd, paths: [...paths] },
  });
  refreshGitDetailedStatus(environmentId, cwd);
}

export async function resolveGitConflict(
  environmentId: EnvironmentId,
  cwd: string,
  path: string,
  resolution: "ours" | "theirs" | "mark_resolved",
): Promise<void> {
  await runGitCommand(gitEnvironment.resolveConflict, {
    environmentId,
    input: { cwd, path, resolution },
  });
  refreshGitDetailedStatus(environmentId, cwd);
}

export async function commitGitStaged(
  environmentId: EnvironmentId,
  cwd: string,
  message: string,
  amend: boolean,
): Promise<GitCommitStagedResult> {
  const result = await runGitCommand(gitEnvironment.commitStaged, {
    environmentId,
    input: { cwd, message, ...(amend ? { amend: true } : {}) },
  });
  refreshGitDetailedStatus(environmentId, cwd);
  return result;
}

export async function generateGitCommitMessage(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<string> {
  const result = await runGitCommand(gitEnvironment.generateCommitMessage, {
    environmentId,
    input: { cwd },
  });
  return result.message;
}
