import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import type { CodeViewDiffItem } from "@pierre/diffs";
import type { EnvironmentId, GitHistoryCommit, ProjectWorkspace } from "@d4research/contracts";
import {
  ChevronDownIcon,
  CircleDotIcon,
  FilesIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { workspaceDisplayName } from "~/lib/projectWorkspacePresentation";
import { cn } from "~/lib/utils";
import { gitEnvironment } from "~/state/git";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { useEnvironmentQuery } from "~/state/query";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { ResizableColumns } from "~/components/ui/resizable-columns";
import { DiffFilesTreeNavigator } from "~/components/diffs/DiffFilesTreeNavigator";
import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function relativeCommitTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return formatter.format(months, "month");
  return formatter.format(Math.round(months / 12), "year");
}

function decorationLabel(decoration: string): string {
  return decoration.replace(/^HEAD -> /, "").replace(/^tag: /, "");
}

function CommitRow(props: { commit: GitHistoryCommit; selected: boolean; onSelect: () => void }) {
  const isMerge = props.commit.parentShas.length > 1;
  return (
    <button
      type="button"
      className={cn(
        "group relative flex w-full gap-2 border-b border-border/45 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected ? "bg-accent text-foreground" : "hover:bg-muted/45",
      )}
      onClick={props.onSelect}
    >
      <span className="relative flex w-5 shrink-0 justify-center pt-0.5">
        <span className="absolute inset-y-[-9px] left-1/2 w-px -translate-x-1/2 bg-border" />
        <span className="relative z-10 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border group-hover:ring-foreground/30">
          {isMerge ? (
            <PullRequestGlyph.merged className="size-2.5 text-violet-500" />
          ) : (
            <CircleDotIcon className="size-2.5 text-blue-500" />
          )}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {props.commit.subject}
          </span>
          <time
            className="shrink-0 text-[10px] text-muted-foreground"
            dateTime={props.commit.authoredAt}
          >
            {relativeCommitTime(props.commit.authoredAt)}
          </time>
        </span>
        {props.commit.decorations.length > 0 ? (
          <span className="mt-1 flex min-w-0 flex-wrap gap-1">
            {props.commit.decorations.slice(0, 3).map((decoration) => (
              <span
                key={decoration}
                className="max-w-28 truncate rounded border border-blue-500/20 bg-blue-500/10 px-1 py-px text-[9px] font-medium text-blue-700 dark:text-blue-300"
              >
                {decorationLabel(decoration)}
              </span>
            ))}
          </span>
        ) : null}
        <span className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">{props.commit.authorName}</span>
          <code className="shrink-0 font-mono">{shortSha(props.commit.sha)}</code>
        </span>
      </span>
    </button>
  );
}

export default function GitHistoryPanel(props: {
  environmentId: EnvironmentId;
  primaryCwd: string;
  workspaceRoots?: ReadonlyArray<ProjectWorkspace>;
}) {
  const { resolvedTheme } = useTheme();
  const roots = useMemo(() => {
    const configured = props.workspaceRoots?.length
      ? props.workspaceRoots
      : [{ path: props.primaryCwd }];
    return [
      { ...configured[0], path: props.primaryCwd },
      ...configured.slice(1).filter((root) => root.path !== props.primaryCwd),
    ];
  }, [props.primaryCwd, props.workspaceRoots]);
  const [selectedCwd, setSelectedCwd] = useState(props.primaryCwd);
  const activeCwd = roots.some((root) => root.path === selectedCwd)
    ? selectedCwd
    : props.primaryCwd;
  const activeRootIndex = roots.findIndex((root) => root.path === activeCwd);
  const activeRoot = roots[activeRootIndex];
  const history = useEnvironmentQuery(
    gitEnvironment.history({
      environmentId: props.environmentId,
      input: { cwd: activeCwd, limit: 100 },
    }),
  );
  const commits = history.data?.commits ?? [];
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const resolvedSelectedSha = commits.some((commit) => commit.sha === selectedSha)
    ? selectedSha
    : (commits[0]?.sha ?? null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  useEffect(() => setSelectedSha(null), [activeCwd]);
  const details = useEnvironmentQuery(
    resolvedSelectedSha
      ? gitEnvironment.commitDetails({
          environmentId: props.environmentId,
          input: { cwd: activeCwd, sha: resolvedSelectedSha },
        })
      : null,
  );
  const detailFilePaths = details.data?.files.map((file) => file.path) ?? [];
  const resolvedFilePath = detailFilePaths.includes(selectedFilePath ?? "")
    ? selectedFilePath
    : (detailFilePaths[0] ?? null);
  const commitDiff = useEnvironmentQuery(
    resolvedSelectedSha && resolvedFilePath
      ? gitEnvironment.commitDiff({
          environmentId: props.environmentId,
          input: { cwd: activeCwd, sha: resolvedSelectedSha, path: resolvedFilePath },
        })
      : null,
  );
  const diffRenderMode = useClientSettings().diffLayout;
  const setDiffRenderMode = (diffLayout: "stacked" | "split") =>
    updateClientSettings({ diffLayout });
  const [wordWrap, setWordWrap] = useState(false);
  useEffect(() => setSelectedFilePath(null), [activeCwd, resolvedSelectedSha]);
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        commitDiff.data?.diff,
        `git-history:${activeCwd}:${resolvedSelectedSha ?? "none"}`,
        { compactPartialHunkOffsets: true },
      ),
    [activeCwd, commitDiff.data?.diff, resolvedSelectedSha],
  );
  const commitDiffFiles = renderablePatch?.kind === "files" ? renderablePatch.files : [];
  const selectedCommitDiff =
    commitDiffFiles.find((file) => resolveFileDiffPath(file) === resolvedFilePath) ??
    commitDiffFiles[0];
  const commitDiffItems = useMemo<CodeViewDiffItem[]>(
    () =>
      selectedCommitDiff
        ? [
            {
              id: buildFileDiffRenderKey(selectedCommitDiff),
              type: "diff",
              fileDiff: selectedCommitDiff,
              collapsed: false,
              version: 1,
            },
          ]
        : [],
    [selectedCommitDiff],
  );
  const totalAdditions = details.data?.files.reduce(
    (total, file) => total + (file.additions ?? 0),
    0,
  );
  const totalDeletions = details.data?.files.reduce(
    (total, file) => total + (file.deletions ?? 0),
    0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        className="surface-subheader flex shrink-0 items-center gap-2 px-2"
        data-surface-subheader
      >
        {roots.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 min-w-0 max-w-52 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {activeRoot ? workspaceDisplayName(activeRoot, activeRootIndex) : "Repository"}
              </span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              {roots.map((root, index) => (
                <DropdownMenuItem key={root.path} onClick={() => setSelectedCwd(root.path)}>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      {workspaceDisplayName(root, index)}
                    </div>
                    <code className="block truncate text-[10px] text-muted-foreground">
                      {root.path}
                    </code>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 px-1 text-xs font-medium">
            <GitBranchIcon className="size-3.5" />
            <span className="truncate">
              {activeRoot ? workspaceDisplayName(activeRoot, activeRootIndex) : "Repository"}
            </span>
          </span>
        )}
        {history.data?.branch ? (
          <span className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {history.data.branch}
          </span>
        ) : null}
        <span className="ms-auto text-[10px] tabular-nums text-muted-foreground">
          {commits.length} commit{commits.length === 1 ? "" : "s"}
          {history.data?.truncated ? "+" : ""}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh Git history"
                onClick={history.refresh}
              />
            }
          >
            <RefreshCwIcon className={cn("size-3.5", history.isPending && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup>Refresh Git history</TooltipPopup>
        </Tooltip>
      </div>
      {history.error && history.data === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-destructive">
          {history.error}
        </div>
      ) : history.isPending && history.data === null ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <LoaderCircleIcon className="size-5 animate-spin" />
        </div>
      ) : history.data?.isRepo === false ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          This directory is not a Git repository.
        </div>
      ) : commits.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          No commits yet.
        </div>
      ) : (
        <ResizableColumns
          storageKey="t3code.gitHistoryCommitListRatio"
          defaultRatio={0.43}
          firstMinPx={210}
          secondMinPx={320}
          className="min-h-0 flex-1"
          separatorLabel="Resize commit list and details"
          first={
            <div className="h-full min-h-0 overflow-auto">
              {commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  selected={commit.sha === resolvedSelectedSha}
                  onSelect={() => setSelectedSha(commit.sha)}
                />
              ))}
            </div>
          }
          second={
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              {details.isPending && details.data === null ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <LoaderCircleIcon className="size-5 animate-spin" />
                </div>
              ) : details.error && details.data === null ? (
                <div className="p-4 text-xs text-destructive">{details.error}</div>
              ) : details.data ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="max-h-[40%] shrink-0 overflow-auto border-b border-border/60 p-4">
                    <h2 className="text-sm font-semibold leading-snug">
                      {details.data.commit.subject}
                    </h2>
                    {details.data.commit.body ? (
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                        {details.data.commit.body}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                      <span>{details.data.commit.authorName}</span>
                      <span>{new Date(details.data.commit.authoredAt).toLocaleString()}</span>
                      <code className="font-mono">{details.data.commit.sha}</code>
                    </div>
                  </div>
                  <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
                    <FilesIcon className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">
                      {details.data.files.length} changed file
                      {details.data.files.length === 1 ? "" : "s"}
                    </span>
                    <DiffStatLabel
                      className="ms-auto text-[10px]"
                      additions={totalAdditions ?? 0}
                      deletions={totalDeletions ?? 0}
                      layout="inline"
                    />
                    <ToggleGroup
                      value={[diffRenderMode]}
                      onValueChange={(value) => {
                        const next = value[0];
                        if (next === "stacked" || next === "split") setDiffRenderMode(next);
                      }}
                    >
                      <Toggle value="stacked" aria-label="Unified commit diff" size="sm">
                        <Rows3Icon className="size-3.5" />
                      </Toggle>
                      <Toggle value="split" aria-label="Split commit diff" size="sm">
                        <Columns2Icon className="size-3.5" />
                      </Toggle>
                    </ToggleGroup>
                    <Toggle
                      aria-label="Wrap commit diff lines"
                      size="sm"
                      pressed={wordWrap}
                      onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
                    >
                      <TextWrapIcon className="size-3.5" />
                    </Toggle>
                  </div>
                  <div className="min-h-0 flex-1">
                    {commitDiff.isPending && commitDiff.data === null ? (
                      <div className="flex h-full items-center justify-center text-muted-foreground">
                        <LoaderCircleIcon className="size-5 animate-spin" />
                      </div>
                    ) : commitDiff.error && commitDiff.data === null ? (
                      <div className="p-4 text-xs text-destructive">{commitDiff.error}</div>
                    ) : renderablePatch?.kind === "files" && commitDiffFiles.length > 0 ? (
                      <ResizableColumns
                        storageKey="t3code.gitHistoryFilesTreeRatio"
                        defaultRatio={0.3}
                        firstMinPx={150}
                        secondMinPx={240}
                        className="h-full"
                        separatorLabel="Resize commit files tree"
                        first={
                          <DiffFilesTreeNavigator
                            files={details.data.files.map((file) => ({
                              path: file.path,
                              ...(file.additions === null ? {} : { additions: file.additions }),
                              ...(file.deletions === null ? {} : { deletions: file.deletions }),
                            }))}
                            resolvedTheme={resolvedTheme}
                            selectedPath={resolvedFilePath}
                            onSelectFile={setSelectedFilePath}
                          />
                        }
                        second={
                          <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
                            <StyledDiffCodeView
                              key={`${resolvedSelectedSha}:${resolvedFilePath}`}
                              className="block h-full min-h-0 min-w-0 flex-1 overflow-auto"
                              items={commitDiffItems}
                              options={{
                                diffStyle: diffRenderMode === "split" ? "split" : "unified",
                                lineDiffType: "none",
                                overflow: wordWrap ? "wrap" : "scroll",
                                theme: resolveDiffThemeName(resolvedTheme),
                                themeType: resolvedTheme,
                                stickyHeaders: true,
                              }}
                            />
                          </div>
                        }
                      />
                    ) : renderablePatch?.kind === "raw" ? (
                      <div className="h-full overflow-auto p-3">
                        <p className="mb-2 text-[11px] text-muted-foreground">
                          {renderablePatch.reason}
                        </p>
                        <pre className="whitespace-pre-wrap font-mono text-[11px]">
                          {renderablePatch.text}
                        </pre>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        This commit has no textual diff.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          }
        />
      )}
    </div>
  );
}
