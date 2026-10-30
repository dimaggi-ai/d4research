import { WS_METHODS } from "@d4research/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    detailedStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:detailed-status",
      tag: WS_METHODS.gitDetailedStatus,
      staleTimeMs: 10_000,
      idleTtlMs: 5 * 60_000,
    }),
    stageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:stage-files",
      tag: WS_METHODS.gitStageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    unstageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:unstage-files",
      tag: WS_METHODS.gitUnstageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    discardChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:discard-changes",
      tag: WS_METHODS.gitDiscardChanges,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    resolveConflict: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:resolve-conflict",
      tag: WS_METHODS.gitResolveConflict,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    commitStaged: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:commit-staged",
      tag: WS_METHODS.gitCommitStaged,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    generateCommitMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:generate-commit-message",
      tag: WS_METHODS.gitGenerateCommitMessage,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    fileDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:file-diff",
      tag: WS_METHODS.gitFileDiff,
      staleTimeMs: 5_000,
      idleTtlMs: 5 * 60_000,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:history",
      tag: WS_METHODS.gitHistory,
      staleTimeMs: 15_000,
      idleTtlMs: 5 * 60_000,
    }),
    commitDetails: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:commit-details",
      tag: WS_METHODS.gitCommitDetails,
      staleTimeMs: 60_000,
      idleTtlMs: 5 * 60_000,
    }),
    commitDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:commit-diff",
      tag: WS_METHODS.gitCommitDiff,
      staleTimeMs: 60_000,
      idleTtlMs: 5 * 60_000,
    }),
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
