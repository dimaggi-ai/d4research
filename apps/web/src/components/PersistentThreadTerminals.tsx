import { type ResolvedKeybindingsConfig, type ScopedThreadRef } from "@d4research/contracts";
import { scopeProjectRef } from "@d4research/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@d4research/shared/projectScripts";
import { resolveTerminalSessionLabel } from "@d4research/shared/terminalLabels";
import { memo } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { type RightPanelSurface } from "../rightPanelStore";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

/** Where a drawer or panel opens new terminals when a script run overrides the thread's own. */
export type PersistentTerminalLaunchContext = {
  readonly cwd: string;
  readonly worktreePath: string | null;
};

interface TerminalLaunchLocationWithEnv {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

export interface PersistentThreadTerminalPanelProps {
  visible: boolean;
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

export const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  visible,
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions?.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath =
    launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd =
    launchContext?.cwd ??
    activeSummary?.cwd ??
    (project ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }) : null);
  const runtimeEnv = project
    ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
    : {};
  const terminalLabelsById = new Map<string, string>();
  const terminalLaunchLocationsById = new Map<string, TerminalLaunchLocationWithEnv>();
  for (const terminalId of surface.terminalIds) {
    const summary =
      knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
        .summary ?? null;
    terminalLabelsById.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    if (!project) continue;
    const terminalWorktreePath =
      launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath;
    terminalLaunchLocationsById.set(terminalId, {
      cwd:
        launchContext?.cwd ??
        summary?.cwd ??
        projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      worktreePath: terminalWorktreePath,
      runtimeEnv: projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: terminalWorktreePath,
      }),
    });
  }

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      visible={visible}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});
