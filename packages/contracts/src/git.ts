import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ForwardCompatibleOptional,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GitFilePath = Schema.String.check(Schema.isNonEmpty());
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /** Unix timestamp of the newest commit on this ref. */
  lastCommitAt: Schema.optional(NonNegativeInt),
  /** Full configured upstream ref. Null when the branch tracks nothing. */
  upstreamRef: Schema.optional(TrimmedNonEmptyStringSchema.pipe(Schema.NullOr)),
  /** Commits on this branch the upstream does not have. Null when there is no upstream. */
  aheadCount: Schema.optional(NonNegativeInt.pipe(Schema.NullOr)),
  /** Commits on the upstream this branch does not have. Null when there is no upstream. */
  behindCount: Schema.optional(NonNegativeInt.pipe(Schema.NullOr)),
  /** True when the branch tracks an upstream that no longer exists on the remote. */
  upstreamGone: Schema.optional(Schema.Boolean),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsStatusSubscriptionInput = Schema.Struct({
  ...VcsStatusInput.fields,
  /** Passive observers receive cached remote status without retaining its refresh loop. */
  includeRemote: Schema.optional(Schema.Boolean),
});
export type VcsStatusSubscriptionInput = typeof VcsStatusSubscriptionInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** Fast-forward this local branch instead of the checked-out one. */
  refName: Schema.optionalKey(TrimmedNonEmptyStringSchema),
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const VcsFetchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /**
   * "current" fetches only what the checked-out branch tracks. "remote" fetches and prunes the
   * whole primary remote, which is what refreshes the ahead/behind counts of every branch.
   */
  scope: Schema.optionalKey(Schema.Literals(["current", "remote"])),
});
export type VcsFetchInput = typeof VcsFetchInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(GitFilePath).check(Schema.isMinLength(1))),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    // Absolute worktree root on the environment that every files[].path is
    // relative to. Absent when the server could not resolve it.
    rootPath: Schema.optional(GitFilePath),
    files: Schema.Array(
      Schema.Struct({
        path: GitFilePath,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  branchChanges: Schema.optional(
    Schema.Struct({
      baseRef: Schema.NullOr(TrimmedNonEmptyStringSchema),
      insertions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  isAtRepositoryRoot: Schema.optional(Schema.Boolean),
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /** False when local commits or edits prevented a reused worktree from reaching the PR head. */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  /**
   * "diverged" is a refused fast-forward, not a failure: the branch and its upstream both moved,
   * so reconciling them is a decision the user (or an agent) has to make.
   */
  status: Schema.Literals(["pulled", "skipped_up_to_date", "diverged"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  aheadCount: Schema.optionalKey(NonNegativeInt),
  behindCount: Schema.optionalKey(NonNegativeInt),
  /** Git's own message for a refused fast-forward, shown verbatim. */
  detail: Schema.optionalKey(TrimmedNonEmptyStringSchema),
});
export type VcsPullResult = typeof VcsPullResult.Type;

export const VcsFetchResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
  // Null when the current branch has no upstream and we fell back to fetching the primary remote.
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsFetchResult = typeof VcsFetchResult.Type;

// Granular git index operations (Commit panel)

/** The kind of change git reports for a file, in either the index or the working tree. */
export const GitChangeKind = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "typechange",
  "unmerged",
  "untracked",
]);
export type GitChangeKind = typeof GitChangeKind.Type;

/**
 * A single changed path with its staged (index) and unstaged (working-tree) state, parsed from
 * `git status --porcelain=2`. `staged`/`unstaged` are derived from the X/Y status codes so the UI
 * can render checkbox state (staged, unstaged, or partially staged when both are set).
 */
export const GitFileChange = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  origPath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  untracked: Schema.Boolean,
  indexStatus: Schema.NullOr(GitChangeKind),
  worktreeStatus: Schema.NullOr(GitChangeKind),
});
export type GitFileChange = typeof GitFileChange.Type;

export const GitDetailedStatusResult = Schema.Struct({
  isRepo: Schema.Boolean,
  files: Schema.Array(GitFileChange),
});
export type GitDetailedStatusResult = typeof GitDetailedStatusResult.Type;

const GitFilePathsShape = {
  cwd: TrimmedNonEmptyStringSchema,
  paths: Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
};

export const GitStageFilesInput = Schema.Struct(GitFilePathsShape);
export type GitStageFilesInput = typeof GitStageFilesInput.Type;

export const GitUnstageFilesInput = Schema.Struct(GitFilePathsShape);
export type GitUnstageFilesInput = typeof GitUnstageFilesInput.Type;

export const GitDiscardChangesInput = Schema.Struct(GitFilePathsShape);
export type GitDiscardChangesInput = typeof GitDiscardChangesInput.Type;

export const GitResolveConflictInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  resolution: Schema.Literals(["ours", "theirs", "mark_resolved"]),
});
export type GitResolveConflictInput = typeof GitResolveConflictInput.Type;

export const GitCommitStagedInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000)),
  amend: Schema.optional(Schema.Boolean),
});
export type GitCommitStagedInput = typeof GitCommitStagedInput.Type;

export const GitCommitStagedResult = Schema.Struct({
  commitSha: TrimmedNonEmptyStringSchema,
});
export type GitCommitStagedResult = typeof GitCommitStagedResult.Type;

/** A generated commit message (subject line plus optional body, joined with a blank line). */
export const GitGenerateCommitMessageResult = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
});
export type GitGenerateCommitMessageResult = typeof GitGenerateCommitMessageResult.Type;

export const GitFileDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
});
export type GitFileDiffInput = typeof GitFileDiffInput.Type;

/** Unified diff of a single file's working-tree changes vs HEAD. Empty when there is no change. */
export const GitFileDiffResult = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  diff: Schema.String,
});
export type GitFileDiffResult = typeof GitFileDiffResult.Type;

export const GitHistoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)),
});
export type GitHistoryInput = typeof GitHistoryInput.Type;

export const GitHistoryCommit = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  parentShas: Schema.Array(TrimmedNonEmptyStringSchema),
  authorName: TrimmedNonEmptyStringSchema,
  authorEmail: Schema.String,
  authoredAt: TrimmedNonEmptyStringSchema,
  subject: TrimmedNonEmptyStringSchema,
  body: Schema.String,
  decorations: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type GitHistoryCommit = typeof GitHistoryCommit.Type;

export const GitHistoryResult = Schema.Struct({
  isRepo: Schema.Boolean,
  branch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  commits: Schema.Array(GitHistoryCommit),
  truncated: Schema.Boolean,
});
export type GitHistoryResult = typeof GitHistoryResult.Type;

export const GitCommitDetailsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  sha: TrimmedNonEmptyStringSchema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[0-9a-f]{7,64}$/i),
  ),
});
export type GitCommitDetailsInput = typeof GitCommitDetailsInput.Type;

export const GitCommitFile = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
});
export type GitCommitFile = typeof GitCommitFile.Type;

export const GitCommitDetailsResult = Schema.Struct({
  commit: GitHistoryCommit,
  files: Schema.Array(GitCommitFile),
});
export type GitCommitDetailsResult = typeof GitCommitDetailsResult.Type;

export const GitCommitDiffInput = Schema.Struct({
  ...GitCommitDetailsInput.fields,
  /** Limit the patch to one repository-relative path. Omitted for the full commit patch. */
  path: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4096))),
});
export type GitCommitDiffInput = typeof GitCommitDiffInput.Type;

/** Unified patch for exactly one commit against its first parent (or the empty tree). */
export const GitCommitDiffResult = Schema.Struct({
  sha: TrimmedNonEmptyStringSchema,
  diff: Schema.String,
  truncated: Schema.Boolean,
});
export type GitCommitDiffResult = typeof GitCommitDiffResult.Type;

// RPC / domain errors

// Git stderr can echo credentials from argv and remote URLs. Only a fixed
// reason reaches the error and its diagnostic suffix; newer, unknown reasons
// decode as absent through GitCommandError.
export const GitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "config_locked",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "push_rejected_by_remote",
  "push_rejected_non_fast_forward",
  "ref_not_found",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);
export type GitCommandFailureReason = typeof GitCommandFailureReason.Type;

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  reason: ForwardCompatibleOptional(GitCommandFailureReason),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}${reason}`;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: TrimmedNonEmptyStringSchema,
    localBranch: TrimmedNonEmptyStringSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
