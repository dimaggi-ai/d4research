import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PROJECT_SLOT_COUNT = 9;

/**
 * Numbered project slots. Which project a number recalls is a habit built at one desk, so it stays
 * on the device rather than travelling with the projects themselves.
 */
interface ProjectSlotState {
  /** Slot index (0-based) to project scope key. */
  slots: Readonly<Record<number, string>>;
  assignSlot: (index: number, projectKey: string) => void;
  clearSlot: (index: number) => void;
}

export const useProjectSlotStore = create<ProjectSlotState>()(
  persist(
    (set) => ({
      slots: {},
      assignSlot: (index, projectKey) =>
        set((state) => {
          if (index < 0 || index >= PROJECT_SLOT_COUNT) return state;
          // A project holds one slot at a time: assigning it again moves it rather than answering
          // to two numbers, which would make the second one impossible to guess.
          const slots = Object.fromEntries(
            Object.entries(state.slots).filter(([, key]) => key !== projectKey),
          );
          return { slots: { ...slots, [index]: projectKey } };
        }),
      clearSlot: (index) =>
        set((state) => {
          if (!(index in state.slots)) return state;
          const { [index]: _removed, ...rest } = state.slots;
          return { slots: rest };
        }),
    }),
    {
      name: "t3code:project-slots:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ slots: state.slots }),
    },
  ),
);

/** Slot number (1-based) shown on a project row, or null when it holds none. */
export function projectSlotNumber(
  slots: Readonly<Record<number, string>>,
  projectKey: string,
): number | null {
  for (const [index, key] of Object.entries(slots)) {
    if (key === projectKey) return Number(index) + 1;
  }
  return null;
}
