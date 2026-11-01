import type { EnvironmentId, ScopedThreadRef } from "@d4research/contracts";
import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";

import { AnnotatableCodeView } from "~/components/diffs/AnnotatableCodeView";
import type { DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";

import { useGitFileDiff } from "./gitChangesState";

type DiffThemeType = "light" | "dark";

interface CommitFileDiffViewProps {
  environmentId: EnvironmentId;
  cwd: string;
  path: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}

/** Renders the working-tree diff (staged + unstaged vs HEAD) for a single file from the Commit view. */
export function CommitFileDiffView({
  environmentId,
  cwd,
  path,
  composerDraftTarget,
  workspaceMutationId,
}: CommitFileDiffViewProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const diffQuery = useGitFileDiff(environmentId, cwd, path);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: diffQuery.refresh,
    resourceKey: `commit-file-diff:${environmentId}:${cwd}:${path}`,
  });
  const diff = diffQuery.data?.diff ?? "";

  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(diff, `commit-diff:${resolvedTheme}`, { compactPartialHunkOffsets: true }),
    [diff, resolvedTheme],
  );
  const files = useMemo(
    () =>
      renderablePatch?.kind === "files"
        ? renderablePatch.files.map((fileDiff) => ({
            fileDiff,
            filePath: resolveFileDiffPath(fileDiff),
            fileKey: buildFileDiffRenderKey(fileDiff),
            fileVersion: 0,
            collapsed: false,
          }))
        : [],
    [renderablePatch],
  );

  if (diffQuery.isPending && diffQuery.data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  if (diffQuery.error && diffQuery.data === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        {diffQuery.error}
      </div>
    );
  }
  if (diff.trim().length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
        No changes to show for {path}.
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-3 text-xs text-foreground">
        {diff}
      </pre>
    );
  }

  return (
    <AnnotatableCodeView
      pendingFiles={[]}
      onRevealSearchMatch={() => undefined}
      codeViewKey={`commit-diff:${environmentId}:${cwd}:${path}:${workspaceMutationId ?? "initial"}`}
      className="diff-render-surface min-h-0 flex-1 overflow-auto"
      files={files}
      sectionId={`commit-diff:${path}`}
      sectionTitle={path}
      composerDraftTarget={composerDraftTarget}
      renderHeaderFilenameSuffix={() => null}
      renderHeaderPrefix={() => null}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        overflow: settings.wordWrap ? "wrap" : "scroll",
        theme: resolveDiffThemeName(resolvedTheme),
        themeType: resolvedTheme as DiffThemeType,
        stickyHeaders: true,
      }}
    />
  );
}
