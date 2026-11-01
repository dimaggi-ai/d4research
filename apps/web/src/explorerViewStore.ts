import { create } from "zustand";

/** The explorer sidebar's active view (file tree, file outline, or the commit panel). */
export type ExplorerView = "files" | "structure" | "commit";

const VIEW_STORAGE_KEY = "t3code.explorerView";
const OPEN_STORAGE_KEY = "t3code.fileExplorerOpen";

function readView(): ExplorerView {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return stored === "structure" || stored === "commit" ? stored : "files";
  } catch {
    return "files";
  }
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistView(view: ExplorerView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {}
}

function persistOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, String(open));
  } catch {}
}

interface ExplorerViewStore {
  /** Whether the explorer sidebar is expanded. */
  open: boolean;
  /** The selected explorer view. */
  view: ExplorerView;
  setView: (view: ExplorerView) => void;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  /** Ensure the explorer is open and switch it to the given view (used by keyboard shortcuts). */
  showView: (view: ExplorerView) => void;
}

/**
 * The explorer sidebar's open/view state, lifted out of `FilePreviewPanel` into a shared store so it
 * can be driven both from the panel UI and from global keyboard shortcuts. Persisted to localStorage
 * so it survives reloads and desktop updates.
 */
export const useExplorerViewStore = create<ExplorerViewStore>((set) => ({
  open: readOpen(),
  view: readView(),
  setView: (view) => {
    persistView(view);
    set({ view });
  },
  setOpen: (open) => {
    persistOpen(open);
    set({ open });
  },
  toggleOpen: () =>
    set((state) => {
      const next = !state.open;
      persistOpen(next);
      return { open: next };
    }),
  showView: (view) => {
    persistView(view);
    persistOpen(true);
    set({ view, open: true });
  },
}));
