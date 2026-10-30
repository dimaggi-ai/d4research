import type { EnvironmentId, ProjectCodeSearchMatch, ProjectEntry } from "@d4research/contracts";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import {
  Braces,
  Box,
  FileCode2,
  FileText,
  LoaderCircle,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isCommandPaletteOpen, useOpenCommandPalette } from "~/commandPaletteContext";
import {
  editorWorkspaceKey,
  useEditorNavigationStore,
  type RecentEditorFile,
} from "~/editorNavigationStore";
import { useClientSettings, updateClientSettings as updateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";

type SearchScope = "all" | "classes" | "files" | "symbols" | "actions" | "text";
type DialogMode = "search" | "recent";

interface EditorNavigationDialogProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onToggleExplorer: () => void;
  readonly onRefreshFiles: () => void;
}

type SearchResultItem =
  | {
      readonly id: string;
      readonly section: "Recent" | "Files";
      readonly kind: "file";
      readonly path: string;
      readonly title: string;
      readonly detail: string;
    }
  | {
      readonly id: string;
      readonly section: "Classes" | "Symbols" | "Text";
      readonly kind: "code";
      readonly match: ProjectCodeSearchMatch;
      readonly title: string;
      readonly detail: string;
    }
  | {
      readonly id: string;
      readonly section: "Actions";
      readonly kind: "action";
      readonly title: string;
      readonly detail: string;
      readonly keywords: string;
      readonly run: () => void;
    };

const SEARCH_SCOPES: ReadonlyArray<{ readonly value: SearchScope; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "classes", label: "Classes" },
  { value: "files", label: "Files" },
  { value: "symbols", label: "Symbols" },
  { value: "actions", label: "Actions" },
  { value: "text", label: "Text" },
];

const SEARCH_RESULT_LIMIT = 60;
const DOUBLE_SHIFT_WINDOW_MS = 500;
const EMPTY_RECENT_FILES: ReadonlyArray<RecentEditorFile> = [];

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzyIncludes(value: string, query: string): boolean {
  const haystack = normalizeSearchText(value);
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  let needleIndex = 0;
  for (const character of haystack) {
    if (character === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function symbolTitle(match: ProjectCodeSearchMatch): string {
  const line = match.snippet.trim();
  const declaration = line.match(
    /\b(?:class|interface|enum|struct|trait|type|record|protocol|function|func|fn|def)\s+([A-Za-z_$][\w$]*)/u,
  );
  if (declaration?.[1]) return declaration[1];
  const method = line.match(/(?:^|\s)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|=>|:)/u);
  return method?.[1] ?? line;
}

function resultIcon(item: SearchResultItem) {
  if (item.kind === "file") return <FileCode2 className="size-4 text-sky-500" />;
  if (item.kind === "action") return <SquareTerminal className="size-4 text-amber-500" />;
  if (item.match.kind === "class" || item.match.kind === "interface") {
    return <Box className="size-4 text-blue-500" />;
  }
  if (item.match.kind === "text") return <FileText className="size-4 text-emerald-500" />;
  return <Braces className="size-4 text-violet-500" />;
}

/** Emphasize the matched portion of a result label, like IntelliJ's Search Everywhere. */
function MatchedText({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const index = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <span className="font-semibold text-foreground">
        {text.slice(index, index + trimmed.length)}
      </span>
      {text.slice(index + trimmed.length)}
    </>
  );
}

function recentFileItems(
  recentFiles: ReadonlyArray<RecentEditorFile>,
  _entries: ReadonlyArray<ProjectEntry>,
): SearchResultItem[] {
  // A shallow listing cannot prove a recent file in a collapsed directory is gone.
  return recentFiles.map((entry) => ({
    id: `recent:${entry.path}`,
    section: "Recent" as const,
    kind: "file" as const,
    path: entry.path,
    title: fileName(entry.path),
    detail: entry.path,
  }));
}

/**
 * Files to list before the user types: recent files first, then the rest of the project (deduped,
 * capped). A freshly opened workspace has no recent files, so without this the Double-Shift dialog
 * would open empty in the All/Files scopes and there'd be nothing to select until you typed — the
 * tree, by contrast, shows everything. This makes Double Shift immediately useful like VS Code's
 * quick-open. Typing then narrows via the server-side `searchEntries` query (remoteResults).
 */
function emptyQueryFileItems(
  recentFiles: ReadonlyArray<RecentEditorFile>,
  entries: ReadonlyArray<ProjectEntry>,
  limit: number,
): SearchResultItem[] {
  const recent = recentFileItems(recentFiles, entries);
  if (recent.length >= limit) return recent.slice(0, limit);
  const recentPaths = new Set(recent.flatMap((item) => (item.kind === "file" ? [item.path] : [])));
  const fileItems: SearchResultItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || recentPaths.has(entry.path)) continue;
    fileItems.push({
      id: `file:${entry.path}`,
      section: "Files",
      kind: "file",
      path: entry.path,
      title: fileName(entry.path),
      detail: entry.path,
    });
    if (recent.length + fileItems.length >= limit) break;
  }
  return [...recent, ...fileItems];
}

export function EditorNavigationDialog(props: EditorNavigationDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DialogMode>("search");
  const [scope, setScope] = useState<SearchScope>("all");
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastShiftReleasedAtRef = useRef(0);
  const navigate = useNavigate();
  const openCommandPalette = useOpenCommandPalette();
  const settings = useClientSettings();
  const searchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const searchCode = useAtomQueryRunner(projectEnvironment.searchCode, {
    reportFailure: false,
  });
  const workspaceKey = editorWorkspaceKey(props.environmentId, props.cwd);
  const recentFiles = useEditorNavigationStore(
    (state) => state.recentFilesByWorkspace[workspaceKey] ?? EMPTY_RECENT_FILES,
  );

  const openSearch = useCallback(() => {
    setMode("search");
    setScope("all");
    setQuery("");
    setOpen(true);
  }, []);

  const openRecent = useCallback(() => {
    setMode("recent");
    setScope("files");
    setQuery("");
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Shift" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        lastShiftReleasedAtRef.current = 0;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        event.stopPropagation();
        openRecent();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const now = performance.now();
      if (
        lastShiftReleasedAtRef.current > 0 &&
        now - lastShiftReleasedAtRef.current <= DOUBLE_SHIFT_WINDOW_MS &&
        !isCommandPaletteOpen()
      ) {
        event.preventDefault();
        openSearch();
        lastShiftReleasedAtRef.current = 0;
        return;
      }
      lastShiftReleasedAtRef.current = now;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [openRecent, openSearch]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, mode, scope]);

  const actions = useMemo<SearchResultItem[]>(
    () => [
      {
        id: "action:command-palette",
        section: "Actions",
        kind: "action",
        title: "Open Command Palette",
        detail: "Search all T3 Code commands",
        keywords: "commands actions t3 code palette",
        run: openCommandPalette,
      },
      {
        id: "action:settings",
        section: "Actions",
        kind: "action",
        title: "Open Settings",
        detail: "Configure T3 Code",
        keywords: "preferences configuration settings",
        run: () => void navigate({ to: "/settings" }),
      },
      {
        id: "action:tabs",
        section: "Actions",
        kind: "action",
        title: settings.showEditorTabs ? "Hide Editor Tabs" : "Show Editor Tabs",
        detail: "Toggle the right-panel tab strip",
        keywords: "editor tabs hide show",
        run: () => updateSettings({ showEditorTabs: !settings.showEditorTabs }),
      },
      {
        id: "action:explorer",
        section: "Actions",
        kind: "action",
        title: "Toggle File Explorer",
        detail: props.projectName,
        keywords: "project tree files explorer sidebar",
        run: props.onToggleExplorer,
      },
      {
        id: "action:refresh",
        section: "Actions",
        kind: "action",
        title: "Refresh Workspace Files",
        detail: props.projectName,
        keywords: "reload rescan index files refresh",
        run: props.onRefreshFiles,
      },
    ],
    [
      navigate,
      openCommandPalette,
      props.onRefreshFiles,
      props.onToggleExplorer,
      props.projectName,
      settings.showEditorTabs,
      updateSettings,
    ],
  );

  const filteredActions = useMemo(
    () =>
      actions.filter((action) =>
        fuzzyIncludes(
          `${action.title} ${action.detail} ${action.kind === "action" ? action.keywords : ""}`,
          query,
        ),
      ),
    [actions, query],
  );

  useEffect(() => {
    if (!open || mode === "recent") {
      setRemoteResults([]);
      setLoading(false);
      return;
    }
    const trimmedQuery = query.trim();
    if (!trimmedQuery || scope === "actions") {
      setRemoteResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      const requests: Array<Promise<SearchResultItem[]>> = [];

      if (scope === "all" || scope === "files") {
        requests.push(
          searchEntries({
            environmentId: props.environmentId,
            input: { cwd: props.cwd, query: trimmedQuery, limit: 40 },
          }).then((result) => {
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return result.value.entries.flatMap((entry) =>
              entry.kind === "file"
                ? [
                    {
                      id: `file:${entry.path}`,
                      section: "Files" as const,
                      kind: "file" as const,
                      path: entry.path,
                      title: fileName(entry.path),
                      detail: entry.path,
                    },
                  ]
                : [],
            );
          }),
        );
      }

      const codeScopes =
        scope === "all"
          ? (["symbols", "text"] as const)
          : scope === "classes" || scope === "symbols" || scope === "text"
            ? ([scope] as const)
            : [];
      for (const codeScope of codeScopes) {
        requests.push(
          searchCode({
            environmentId: props.environmentId,
            input: {
              cwd: props.cwd,
              query: trimmedQuery,
              scope: codeScope,
              limit: scope === "all" ? 20 : SEARCH_RESULT_LIMIT,
            },
          }).then((result) => {
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return result.value.matches.map((match) => ({
              id: `code:${codeScope}:${match.path}:${match.lineNumber}:${match.column}`,
              section:
                codeScope === "classes"
                  ? ("Classes" as const)
                  : codeScope === "symbols"
                    ? ("Symbols" as const)
                    : ("Text" as const),
              kind: "code" as const,
              match,
              title: codeScope === "text" ? match.snippet.trim() : symbolTitle(match),
              detail: `${match.path}:${match.lineNumber}`,
            }));
          }),
        );
      }

      void Promise.all(requests)
        .then((groups) => {
          if (cancelled) return;
          const seen = new Set<string>();
          const next = groups.flat().filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
          setRemoteResults(next.slice(0, SEARCH_RESULT_LIMIT));
        })
        .catch(() => {
          if (!cancelled) setRemoteResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 100);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [mode, open, props.cwd, props.environmentId, query, scope, searchCode, searchEntries]);

  const results = useMemo(() => {
    if (mode === "recent") {
      return recentFileItems(recentFiles, props.entries).filter((item) =>
        fuzzyIncludes(`${item.title} ${item.detail}`, query),
      );
    }
    if (!query.trim()) {
      return scope === "actions"
        ? filteredActions
        : scope === "all" || scope === "files"
          ? emptyQueryFileItems(recentFiles, props.entries, SEARCH_RESULT_LIMIT)
          : [];
    }
    return scope === "actions" || scope === "all"
      ? [...remoteResults, ...filteredActions].slice(0, SEARCH_RESULT_LIMIT)
      : remoteResults;
  }, [filteredActions, mode, props.entries, query, recentFiles, remoteResults, scope]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, scope, mode, results.length]);

  const execute = useCallback(
    (item: SearchResultItem) => {
      setOpen(false);
      if (item.kind === "action") {
        window.setTimeout(item.run, 0);
        return;
      }
      if (item.kind === "file") {
        useEditorNavigationStore
          .getState()
          .recordRecentFile(props.environmentId, props.cwd, item.path);
        props.onOpenFile(item.path);
        return;
      }
      // The file preview panel owns navigation-driven opens (it watches navigationRequest), so we
      // only record the jump here and let it switch files and scroll to the target line.
      useEditorNavigationStore.getState().navigateTo(props.environmentId, props.cwd, {
        path: item.match.path,
        lineNumber: item.match.lineNumber,
        column: item.match.column,
      });
    },
    [props.cwd, props.environmentId, props.onOpenFile],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(results.length - 1, current + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Enter") {
      const selected = results[selectedIndex];
      if (selected) {
        event.preventDefault();
        execute(selected);
      }
      return;
    }
    if (event.key === "Tab" && mode === "search") {
      event.preventDefault();
      const index = SEARCH_SCOPES.findIndex((entry) => entry.value === scope);
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (index + direction + SEARCH_SCOPES.length) % SEARCH_SCOPES.length;
      setScope(SEARCH_SCOPES[nextIndex]!.value);
    }
  };

  let previousSection: SearchResultItem["section"] | null = null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup
        aria-label={mode === "recent" ? "Recent Files" : "Search Everywhere"}
        className="max-w-2xl overflow-hidden rounded-lg p-0 duration-100 before:rounded-[7px]"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        {mode === "search" ? (
          <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border px-2">
            {SEARCH_SCOPES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={cn(
                  "h-8 shrink-0 border-b-2 px-2.5 text-xs text-muted-foreground",
                  scope === entry.value
                    ? "border-primary text-foreground"
                    : "border-transparent hover:text-foreground",
                )}
                onClick={() => setScope(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-9 items-center border-b border-border px-4 text-sm font-medium">
            Recent Files
          </div>
        )}
        <div className="flex h-11 items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              mode === "recent" ? "Search recent files" : "Search files, symbols, text, and actions"
            }
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label={mode === "recent" ? "Search recent files" : "Search everywhere"}
          />
          {loading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>
        <div className="max-h-[min(30rem,62vh)] min-h-56 overflow-y-auto p-1.5">
          {results.length === 0 && !loading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {query.trim() ? "No matching results" : "Start typing to search this scope"}
            </div>
          ) : (
            results.map((item, index) => {
              const showSection = item.section !== previousSection;
              previousSection = item.section;
              return (
                <div key={item.id}>
                  {showSection ? (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {item.section}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={cn(
                      "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left",
                      index === selectedIndex ? "bg-accent text-foreground" : "hover:bg-accent/60",
                    )}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => execute(item)}
                  >
                    {resultIcon(item)}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <MatchedText text={item.title} query={query} />
                    </span>
                    <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex h-8 items-center justify-between border-t border-border px-4 text-xs text-muted-foreground">
          <span>{props.projectName}</span>
          <span className="flex items-center gap-2">
            <Kbd>↑↓</Kbd> Navigate <Kbd>Enter</Kbd> Open <Kbd>Esc</Kbd> Close
          </span>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
