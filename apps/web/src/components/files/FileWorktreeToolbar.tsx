import type { EnvironmentId, ScopedThreadRef, VcsRef } from "@d4research/contracts";
import type { SelectedProjectWorkspace } from "@d4research/shared/threadWorkspaces";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderGit2, RefreshCw } from "lucide-react";
import { threadEnvironment } from "~/state/threads";
import { vcsEnvironment } from "~/state/vcs";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "~/components/ui/toast";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { workspaceDirectoryName } from "~/lib/projectWorkspacePresentation";
import { resolveFileWorktreeOptions, type FileWorktreeOption } from "./filePreviewRoots";

function worktreeOptionLabel(option: FileWorktreeOption): string {
  return option.refName ?? (workspaceDirectoryName(option.path) || "Current checkout");
}

export function FileWorktreeToolbar(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  root: SelectedProjectWorkspace;
  onSelected?: ((cwd: string) => void) | undefined;
}) {
  const [pending, setPending] = useState(false);
  const selectWorkspace = useAtomCommand(threadEnvironment.workspaceSelect);
  const [cursor, setCursor] = useState<number | undefined>();
  const [loadedRefs, setLoadedRefs] = useState<ReadonlyArray<VcsRef>>([]);
  const refsQuery = useEnvironmentQuery(
    vcsEnvironment.listRefs({
      environmentId: props.environmentId,
      input: {
        // Discover recovery choices even when the selected checkout was removed.
        cwd: props.root.workspaceRoot,
        refKind: "local",
        refresh: true,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
  useEffect(() => {
    if (!refsQuery.data) return;
    setLoadedRefs((previous) => [
      ...new Map(
        [...(cursor === undefined ? [] : previous), ...refsQuery.data!.refs].map((ref) => [
          ref.name,
          ref,
        ]),
      ).values(),
    ]);
  }, [cursor, refsQuery.data]);
  const refresh = () => {
    setCursor(undefined);
    refsQuery.refresh();
  };
  const options = useMemo(
    () => resolveFileWorktreeOptions(props.root.path, loadedRefs),
    [props.root.path, loadedRefs],
  );
  const activeOption = options.find((option) => option.current) ?? options[0]!;
  const select = async (selection: { path: string } | { branch: string }) => {
    setPending(true);
    try {
      const result = await selectWorkspace({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          workspaceRoot: props.root.workspaceRoot,
          ...selection,
        },
      });
      if (result._tag === "Success") props.onSelected?.(result.value.cwd);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not select checkout",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setPending(false);
    }
  };
  if (refsQuery.data?.isRepo === false) return null;
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2"
      data-file-worktree-selector={props.root.workspaceRoot}
    >
      <Menu
        onOpenChange={(open) => {
          if (open) {
            refresh();
          }
        }}
      >
        <MenuTrigger
          disabled={pending}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Select checkout for ${props.root.label ?? workspaceDirectoryName(props.root.workspaceRoot)}`}
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {pending ? "Switching…" : worktreeOptionLabel(activeOption)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-80">
          <MenuGroup>
            <MenuGroupLabel>Worktrees</MenuGroupLabel>
            <MenuRadioGroup
              value={activeOption.path}
              onValueChange={(path) => {
                if (path !== activeOption.path) void select({ path });
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option.path} value={option.path}>
                  <div className="min-w-0 py-0.5">
                    <div className="truncate text-xs font-medium">
                      {worktreeOptionLabel(option)}
                    </div>
                    <code className="block truncate text-[10px] text-muted-foreground">
                      {option.path}
                    </code>
                  </div>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuGroup>
            <MenuGroupLabel>Branches</MenuGroupLabel>
            {loadedRefs.map((ref) => (
              <MenuItem
                key={ref.name}
                disabled={pending}
                onClick={() => void select({ branch: ref.name })}
              >
                <span className="truncate">{ref.name}</span>
                {ref.worktreePath === null ? (
                  <span className="ml-auto text-2xs text-muted-foreground">New worktree</span>
                ) : null}
              </MenuItem>
            ))}
          </MenuGroup>
          {refsQuery.data?.nextCursor != null ? (
            <MenuItem
              disabled={refsQuery.isPending}
              closeOnClick={false}
              onClick={() => setCursor(refsQuery.data?.nextCursor ?? undefined)}
            >
              Load more branches
            </MenuItem>
          ) : null}
          {refsQuery.error ? <MenuItem disabled>{refsQuery.error}</MenuItem> : null}
          <MenuItem onClick={refresh}>
            <RefreshCw className={cn("size-3.5", refsQuery.isPending && "animate-spin")} />
            Refresh checkouts
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
