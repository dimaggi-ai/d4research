import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isAccentColorValue } from "./lib/accentColors";
import { resolveStorage } from "./lib/storage";

/**
 * Accent colours for threads and projects. Like the sidebar arrangement, this is a way of marking
 * up your own view of the work, so it stays on the device and never becomes thread or project
 * state the server has to carry.
 */
interface AccentColorState {
  /** Keyed by scoped thread key. */
  threadColors: Readonly<Record<string, string>>;
  /** Keyed by scoped project key. */
  projectColors: Readonly<Record<string, string>>;
  setThreadColor: (threadKey: string, color: string | null) => void;
  /**
   * Takes every key in a project group at once. A group can span environments, and a colour that
   * only marked the representative would leave the group's other members uncoloured.
   */
  setProjectColor: (projectKeys: readonly string[], color: string | null) => void;
}

const withEntry = (
  current: Readonly<Record<string, string>>,
  key: string,
  color: string | null,
): Readonly<Record<string, string>> => {
  if (color === null) {
    if (!(key in current)) return current;
    const { [key]: _removed, ...rest } = current;
    return rest;
  }
  if (!isAccentColorValue(color) || current[key] === color) return current;
  return { ...current, [key]: color };
};

export const useAccentColorStore = create<AccentColorState>()(
  persist(
    (set) => ({
      threadColors: {},
      projectColors: {},
      setThreadColor: (threadKey, color) =>
        set((state) => ({ threadColors: withEntry(state.threadColors, threadKey, color) })),
      setProjectColor: (projectKeys, color) =>
        set((state) => ({
          projectColors: projectKeys.reduce(
            (colors, projectKey) => withEntry(colors, projectKey, color),
            state.projectColors,
          ),
        })),
    }),
    {
      name: "t3code:accent-colors:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        threadColors: state.threadColors,
        projectColors: state.projectColors,
      }),
    },
  ),
);

export function readThreadAccentColor(threadKey: string): string | null {
  return useAccentColorStore.getState().threadColors[threadKey] ?? null;
}

export function setThreadAccentColor(threadKey: string, color: string | null): void {
  useAccentColorStore.getState().setThreadColor(threadKey, color);
}
