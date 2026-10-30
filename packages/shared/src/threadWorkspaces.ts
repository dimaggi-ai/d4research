import type {
  OrchestrationV2ThreadShell,
  ProjectWorkspace,
  ThreadWorkspaceSelection,
} from "@d4research/contracts";

export const PRIMARY_WORKSPACE_BUSY_MESSAGE =
  "The primary checkout cannot change while this thread has active or background work. Wait for it to finish or press Stop first.";

/** Work bound to the current provider cwd must survive ordinary checkout selection. */
export function threadHasWorkspaceBoundWork(
  thread:
    | Pick<
        OrchestrationV2ThreadShell,
        "activityRunStatus" | "pendingBackgroundTasks" | "pendingRuntimeRequest"
      >
    | null
    | undefined,
): boolean {
  return (
    thread != null &&
    (thread.activityRunStatus != null ||
      thread.pendingRuntimeRequest != null ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0)
  );
}

export interface SelectedProjectWorkspace extends ProjectWorkspace {
  /** Configured repository identity, independent of its selected checkout. */
  readonly workspaceRoot: string;
  readonly branch: string | null;
  readonly primary: boolean;
}

export function resolveThreadWorkspaces(
  project: {
    readonly workspaceRoot: string;
    readonly workspaceRoots?: ReadonlyArray<ProjectWorkspace> | undefined;
  },
  thread: {
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly workspaceSelections?: ReadonlyArray<ThreadWorkspaceSelection> | undefined;
  },
): ReadonlyArray<SelectedProjectWorkspace> {
  const roots = project.workspaceRoots ?? [];
  const primary = roots.find((root) => root.path === project.workspaceRoot) ?? {
    path: project.workspaceRoot,
  };
  const configured = [primary, ...roots.filter((root) => root.path !== project.workspaceRoot)];
  return configured.map((root) => {
    const primary = root.path === project.workspaceRoot;
    const selected = thread.workspaceSelections?.find(
      (selection) => selection.workspaceRoot === root.path,
    );
    return {
      ...root,
      workspaceRoot: root.path,
      path: primary ? (thread.worktreePath ?? root.path) : (selected?.cwd ?? root.path),
      branch: primary ? thread.branch : (selected?.branch ?? null),
      primary,
    };
  });
}

/** Instructions are injected every turn so resumed sessions see newer selections. */
export function threadWorkspaceInstructions(
  roots: ReadonlyArray<SelectedProjectWorkspace>,
  hasControls: boolean,
): string {
  if (roots.length < 2 && !hasControls) return "";
  return `\n\n<project-workspaces>\nSelected directories for this thread:\n${roots
    .map(
      (root) =>
        `- ${root.primary ? "primary" : (root.label ?? "additional repository")}: repository ${root.workspaceRoot}; selected cwd ${root.path}${root.branch ? `; branch ${root.branch}` : ""}`,
    )
    .join(
      "\n",
    )}\nUse each repository's selected absolute cwd for its commands and file operations. ${
    hasControls
      ? "Use thread_workspace_inspect with workspaceRoot to inspect a specific repository (omit it for the primary). For additional repositories, call thread_workspace_select with workspaceRoot and path or branch, or thread_workspace_create with workspaceRoot, mode: worktree and branch BEFORE editing. These tools update this thread's Files selectors; simply running cd or git worktree add does not update them. Select each additional repository independently, then use the returned cwd. The primary checkout is pinned while a turn, question, or background task is active: do not use thread_workspace_create/select to move your own running session. From the project root, use t3_worktree_handoff as the last action with continuationPrompt to resume automatically. If already in a primary worktree, keep this binding and use another checkout's absolute cwd, or launch a separate thread with t3_thread_launch and workspaceStrategy."
      : "Keep work in these selected checkouts."
  }\n</project-workspaces>`;
}
