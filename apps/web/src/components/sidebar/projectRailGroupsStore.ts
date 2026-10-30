import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { sanitizeRailGroups, type RailGroup } from "./projectRailGroups.logic";

/**
 * Rail groups stay on this device, like the rail's manual project order they
 * are laid over.
 */
interface ProjectRailGroupsState {
  groups: ReadonlyArray<RailGroup>;
  setGroups: (groups: ReadonlyArray<RailGroup>) => void;
  settledProjectKeys: ReadonlyArray<string>;
  setProjectSettled: (projectKey: string, settled: boolean) => void;
}

function sanitizeSettledProjectKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0))]
    : [];
}

export const useProjectRailGroupsStore = create<ProjectRailGroupsState>()(
  persist(
    (set) => ({
      groups: [],
      setGroups: (groups) => set({ groups: sanitizeRailGroups(groups) }),
      settledProjectKeys: [],
      setProjectSettled: (projectKey, settled) =>
        set((state) => ({
          settledProjectKeys: settled
            ? sanitizeSettledProjectKeys([...state.settledProjectKeys, projectKey])
            : state.settledProjectKeys.filter((key) => key !== projectKey),
        })),
    }),
    {
      name: "t3code:project-rail-groups:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        groups: state.groups,
        settledProjectKeys: state.settledProjectKeys,
      }),
      merge: (persisted, current) => {
        const saved = persisted as { groups?: unknown; settledProjectKeys?: unknown } | undefined;
        return {
          ...current,
          groups: sanitizeRailGroups(saved?.groups),
          settledProjectKeys: sanitizeSettledProjectKeys(saved?.settledProjectKeys),
        };
      },
    },
  ),
);
