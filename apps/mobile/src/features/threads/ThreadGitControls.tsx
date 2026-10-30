import { Toolbar } from "../../components/ui/Toolbar";
import * as Dialog from "../../components/ui/Dialog";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { createNativeHeaderMenu } from "../../components/ui/nativeHeaderMenu.ios";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  type GitRunStackedActionResult,
  type ProjectScript,
  ThreadId,
  type VcsStatusResult,
} from "@d4research/contracts";
import {
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@d4research/client-runtime/state/vcs";
import { useNavigation } from "@react-navigation/native";
import { sourceControlClients } from "@d4research/client-runtime/source-control-clients";

import { useEnvironmentScope } from "../../state/session";
import type { TerminalMenuSession } from "../terminal/terminalMenu";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: VcsStatusResult | null): string {
  if (!gitStatus) {
    return "Checking status";
  }
  if (!gitStatus.isRepo) {
    return "Not a repo";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree.files.length} changed`);
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(`${shortLabel} #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

type HeaderItem = Record<string, unknown>;
type HeaderItems = HeaderItem[];
type ThreadGitHeaderActionItems = {
  readonly files: HeaderItem;
  readonly more: HeaderItem;
};
type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

export type ThreadGitMenuProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly hasThread?: boolean;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly onMergeBack?: () => void;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
};

type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly auxiliaryPaneControl?: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly showActionControls?: boolean;
  readonly showDirectFileControl?: boolean;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

function useThreadGitControlModel(props: ThreadGitMenuProps) {
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const environmentId = props.environmentId;
  const canWriteSourceControl = useEnvironmentScope(
    environmentId ? EnvironmentId.make(String(environmentId)) : null,
    AuthSourceControlWriteScope,
  );
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD";
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: "Git unavailable",
        disabled: true,
        kind: "show_hint" as const,
        hint: "This workspace is not a git repository.",
      };
    }
    const action = resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote);
    return !canWriteSourceControl && (action.kind === "run_pull" || action.kind === "run_action")
      ? {
          ...action,
          disabled: true,
          hint: "This connection cannot change source control.",
        }
      : action;
  })();

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? "This action is unavailable.")
    : null;

  const quickActionIcon: QuickActionIcon = (() => {
    if (quickAction.kind === "run_pull") return "arrow.down.circle";
    if (quickAction.kind === "open_pr") return "arrow.up.right.circle";
    if (quickAction.kind === "run_action") {
      if (quickAction.action === "commit") return "checkmark.circle";
      if (quickAction.action === "push" || quickAction.action === "commit_push")
        return "arrow.up.circle";
    }
    return "arrow.up.right.circle";
  })();

  const openExistingPr = async () => {
    const { shortLabel, singular } = sourceControlClients.get(
      gitStatus?.sourceControlProvider?.kind,
    ).changeRequest;
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(`No open ${shortLabel}`, `This branch does not have an open ${singular}.`);
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(`Unable to open ${shortLabel}`, `The ${singular} could not be opened.`);
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      if (props.hasThread === false) {
        Dialog.alert(
          "Choose a feature branch",
          "Switch branches before publishing changes from this draft.",
        );
        return;
      }
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    await onRunAction(input);
  };

  const runQuickAction = async () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  };

  const openFiles = () => {
    if (props.onOpenFilesInspector) {
      props.onOpenFilesInspector();
      return;
    }
    navigation.navigate("ThreadFiles", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  const openReview = () => {
    navigation.navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  };

  const openGitInspector = () => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigation.navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  return {
    currentBranchLabel,
    isRepo,
    openFiles,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

function useThreadGitHeaderActionItems(props: ThreadGitControlsProps): ThreadGitHeaderActionItems {
  const model = useThreadGitControlModel(props);
  return {
    files: {
      accessibilityLabel: "Open files",
      disabled: !props.canOpenFiles,
      icon: { name: "folder", type: "sfSymbol" },
      identifier: "thread-right-files",
      label: "Files",
      onPress: model.openFiles,
      sharesBackground: true,
      type: "button",
      variant: "plain",
    },
    more: {
      accessibilityLabel: "Open thread details",
      disabled: props.hasThread === false,
      icon: { name: "ellipsis", type: "sfSymbol" },
      identifier: "thread-right-more",
      label: "More",
      onPress: model.openGitInspector,
      sharesBackground: true,
      type: "button",
      variant: "plain",
    },
  };
}

export function useThreadGitRightHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const items = useThreadGitHeaderActionItems(props);
  return [items.more, items.files];
}

export function useThreadGitCenterHeaderItems(props: ThreadGitControlsProps): HeaderItems {
  const items = useThreadGitHeaderActionItems(props);
  return [items.files, items.more];
}

export function ThreadGitControls(props: ThreadGitControlsProps) {
  const model = useThreadGitControlModel(props);
  if (props.showActionControls === false) return null;
  return (
    <Toolbar placement="right">
      <Toolbar.Button
        accessibilityLabel="Open files"
        disabled={!props.canOpenFiles}
        icon="folder"
        onPress={model.openFiles}
        separateBackground
      />
      <Toolbar.Button
        accessibilityLabel="Open thread details"
        disabled={props.hasThread === false}
        icon="ellipsis"
        onPress={model.openGitInspector}
        separateBackground
      />
    </Toolbar>
  );
}

export function ThreadGitMenu(props: ThreadGitMenuProps) {
  const menu = useThreadGitMenuDefinition(props);
  return menu ? createNativeHeaderMenu(menu) : null;
}

/** Returns menu data because native toolbars serialize direct items rather than rendering component children. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  return threadGitMenuDefinition(props, useThreadGitControlModel(props));
}

function threadGitMenuDefinition(
  props: ThreadGitMenuProps,
  model: ReturnType<typeof useThreadGitControlModel>,
): AppBarMenu {
  return {
    title: "Git controls",
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    separateBackground: false,
    items: [
      {
        id: "git-status",
        title: compactMenuBranchLabel(model.currentBranchLabel),
        icon: "point.topleft.down.curvedto.point.bottomright.up",
        disabled: true,
        subtitle: compactMenuStatus(props.gitStatus),
        onPress: () => {},
      },
      {
        id: "git-quick-action",
        title: model.quickAction.label,
        icon: model.quickActionIcon,
        disabled: model.quickAction.disabled,
        subtitle: model.quickActionHint ?? undefined,
        onPress: () => {
          void model.runQuickAction();
        },
      },
      {
        id: "git-review",
        title: "Review changes",
        icon: "text.bubble",
        disabled: !model.isRepo || props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Turn diffs and worktree changes",
        onPress: model.openReview,
      },
      {
        id: "git-more",
        title: "More",
        icon: "ellipsis",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Commit, files, branches",
        onPress: model.openGitInspector,
      },
    ],
  };
}
