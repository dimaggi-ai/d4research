import type { ScopedThreadRef } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Suspense } from "react";

import { lazyWithReload } from "../../lazyWithReload";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { RightPanelSheet } from "../RightPanelSheet";

const FilePreviewPanel = lazyWithReload(() => import("../files/FilePreviewPanel"));

/**
 * Nia's chat replaces the thread view, so it has no right panel; file links in its replies open
 * the file surface of Nia's own thread here instead.
 */
export function NiaFilePanel({
  threadRef,
  workspaceRoot,
  projectName,
}: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string;
  projectName: string;
}) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const file = surface?.kind === "file" ? surface : null;
  const openFile = (relativePath: string, root?: string) =>
    useRightPanelStore.getState().openFile(threadRef, relativePath, undefined, root);
  return (
    <RightPanelSheet
      animationDurationMs={180}
      open={file !== null}
      onClose={() => useRightPanelStore.getState().close(threadRef)}
      showCloseButton
    >
      {file ? (
        <Suspense fallback={null}>
          <FilePreviewPanel
            openInShortcutEnabled
            primaryCwd={workspaceRoot}
            projectRoot={workspaceRoot}
            environmentId={threadRef.environmentId}
            cwd={file.workspaceRoot ?? workspaceRoot}
            projectName={projectName}
            threadRef={threadRef}
            composerDraftTarget={threadRef}
            keybindings={keybindings}
            availableEditors={availableEditors}
            relativePath={file.relativePath}
            revealLine={file.revealLine}
            revealRequestId={file.revealRequestId}
            folderTrail={file.folderTrail}
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, file.id, relativePath, folderTrail, keepSource)
            }
            onOpenFile={openFile}
            onPendingChange={() => {}}
            selectedFilePending={false}
            workspaceMutationId={null}
          />
        </Suspense>
      ) : null}
    </RightPanelSheet>
  );
}
