import type { EnvironmentId } from "@d4research/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const MAX_RECENT_FILES_PER_WORKSPACE = 100;
const MAX_HISTORY_ENTRIES_PER_WORKSPACE = 100;
const EDITOR_NAVIGATION_STORAGE_KEY = "t3code:editor-navigation:v1";

export interface RecentEditorFile {
  readonly path: string;
  readonly openedAt: number;
}

export interface EditorLocation {
  readonly path: string;
  readonly lineNumber: number;
  readonly column: number;
}

export interface EditorNavigationRequest {
  readonly workspaceKey: string;
  readonly path: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly requestId: number;
}

interface WorkspaceNavigationHistory {
  readonly entries: EditorLocation[];
  readonly index: number;
}

export interface NavigationTarget {
  readonly path: string;
  readonly lineNumber?: number;
  readonly column?: number;
}

interface EditorNavigationState {
  recentFilesByWorkspace: Record<string, RecentEditorFile[]>;
  historyByWorkspace: Record<string, WorkspaceNavigationHistory>;
  navigationRequest: EditorNavigationRequest | null;
  recordRecentFile: (environmentId: EnvironmentId, cwd: string, path: string) => void;
  /**
   * Passively note the location the editor is currently showing so it becomes part of the
   * back/forward history. Opening the same file that is already the current history entry is a
   * no-op, which keeps replays (back/forward) and re-renders from creating duplicate entries.
   */
  recordActiveLocation: (
    environmentId: EnvironmentId,
    cwd: string,
    location: NavigationTarget,
  ) => void;
  navigateTo: (
    environmentId: EnvironmentId,
    cwd: string,
    target: NavigationTarget,
    from?: EditorLocation,
  ) => void;
  goBack: (environmentId: EnvironmentId, cwd: string) => void;
  goForward: (environmentId: EnvironmentId, cwd: string) => void;
}

export function editorWorkspaceKey(environmentId: EnvironmentId, cwd: string): string {
  return `${encodeURIComponent(environmentId)}|${encodeURIComponent(cwd)}`;
}

function normalizeLocation(target: NavigationTarget): EditorLocation {
  return {
    path: target.path,
    lineNumber: Math.max(1, target.lineNumber ?? 1),
    column: Math.max(0, target.column ?? 0),
  };
}

function promoteRecentFile(
  current: ReadonlyArray<RecentEditorFile>,
  path: string,
): RecentEditorFile[] {
  return [{ path, openedAt: Date.now() }, ...current.filter((entry) => entry.path !== path)].slice(
    0,
    MAX_RECENT_FILES_PER_WORKSPACE,
  );
}

export const useEditorNavigationStore = create<EditorNavigationState>()(
  persist(
    (set) => ({
      recentFilesByWorkspace: {},
      historyByWorkspace: {},
      navigationRequest: null,
      recordRecentFile: (environmentId, cwd, path) =>
        set((state) => {
          const workspaceKey = editorWorkspaceKey(environmentId, cwd);
          const current = state.recentFilesByWorkspace[workspaceKey] ?? [];
          return {
            recentFilesByWorkspace: {
              ...state.recentFilesByWorkspace,
              [workspaceKey]: promoteRecentFile(current, path),
            },
          };
        }),
      recordActiveLocation: (environmentId, cwd, location) =>
        set((state) => {
          const workspaceKey = editorWorkspaceKey(environmentId, cwd);
          const history = state.historyByWorkspace[workspaceKey] ?? { entries: [], index: -1 };
          const next = normalizeLocation(location);
          const current = history.entries[history.index];
          if (current && current.path === next.path) {
            return {};
          }
          const entries = [...history.entries.slice(0, history.index + 1), next].slice(
            -MAX_HISTORY_ENTRIES_PER_WORKSPACE,
          );
          return {
            historyByWorkspace: {
              ...state.historyByWorkspace,
              [workspaceKey]: { entries, index: entries.length - 1 },
            },
          };
        }),
      navigateTo: (environmentId, cwd, target, from) =>
        set((state) => {
          const workspaceKey = editorWorkspaceKey(environmentId, cwd);
          const history = state.historyByWorkspace[workspaceKey] ?? { entries: [], index: -1 };
          const nextTarget = normalizeLocation(target);
          const entries = history.entries.slice(0, history.index + 1);
          if (from) {
            const origin = normalizeLocation(from);
            const current = entries[entries.length - 1];
            // Capture the exact line we are leaving so "back" returns to it rather than the top
            // of the origin file.
            if (current && current.path === origin.path) {
              entries[entries.length - 1] = origin;
            } else {
              entries.push(origin);
            }
          }
          entries.push(nextTarget);
          const trimmed = entries.slice(-MAX_HISTORY_ENTRIES_PER_WORKSPACE);
          const current = state.recentFilesByWorkspace[workspaceKey] ?? [];
          return {
            navigationRequest: {
              workspaceKey,
              path: nextTarget.path,
              lineNumber: nextTarget.lineNumber,
              column: nextTarget.column,
              requestId: (state.navigationRequest?.requestId ?? 0) + 1,
            },
            historyByWorkspace: {
              ...state.historyByWorkspace,
              [workspaceKey]: { entries: trimmed, index: trimmed.length - 1 },
            },
            recentFilesByWorkspace: {
              ...state.recentFilesByWorkspace,
              [workspaceKey]: promoteRecentFile(current, nextTarget.path),
            },
          };
        }),
      goBack: (environmentId, cwd) =>
        set((state) => {
          const workspaceKey = editorWorkspaceKey(environmentId, cwd);
          const history = state.historyByWorkspace[workspaceKey];
          if (!history || history.index <= 0) return {};
          const index = history.index - 1;
          const location = history.entries[index]!;
          return {
            navigationRequest: {
              workspaceKey,
              path: location.path,
              lineNumber: location.lineNumber,
              column: location.column,
              requestId: (state.navigationRequest?.requestId ?? 0) + 1,
            },
            historyByWorkspace: {
              ...state.historyByWorkspace,
              [workspaceKey]: { ...history, index },
            },
          };
        }),
      goForward: (environmentId, cwd) =>
        set((state) => {
          const workspaceKey = editorWorkspaceKey(environmentId, cwd);
          const history = state.historyByWorkspace[workspaceKey];
          if (!history || history.index >= history.entries.length - 1) return {};
          const index = history.index + 1;
          const location = history.entries[index]!;
          return {
            navigationRequest: {
              workspaceKey,
              path: location.path,
              lineNumber: location.lineNumber,
              column: location.column,
              requestId: (state.navigationRequest?.requestId ?? 0) + 1,
            },
            historyByWorkspace: {
              ...state.historyByWorkspace,
              [workspaceKey]: { ...history, index },
            },
          };
        }),
    }),
    {
      name: EDITOR_NAVIGATION_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ recentFilesByWorkspace: state.recentFilesByWorkspace }),
    },
  ),
);

export function canGoBack(
  state: EditorNavigationState,
  environmentId: EnvironmentId,
  cwd: string,
): boolean {
  const history = state.historyByWorkspace[editorWorkspaceKey(environmentId, cwd)];
  return history ? history.index > 0 : false;
}

export function canGoForward(
  state: EditorNavigationState,
  environmentId: EnvironmentId,
  cwd: string,
): boolean {
  const history = state.historyByWorkspace[editorWorkspaceKey(environmentId, cwd)];
  return history ? history.index < history.entries.length - 1 : false;
}
