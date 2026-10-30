import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { generateSpreadPinOrderKeys } from "@d4research/client-runtime/state/thread-sort";

/**
 * Legacy device-local arrangements, retained during migration and for older servers.
 * Current servers persist active order keys so web, desktop and mobile agree.
 */
interface SidebarThreadOrderState {
  order: readonly string[];
  migrating: boolean;
  setMigrating: (migrating: boolean) => void;
  pendingMigration: readonly { id: string; orderKey: string }[];
  setPendingMigration: (writes: readonly { id: string; orderKey: string }[]) => void;
  finishMigration: (ids: ReadonlySet<string>) => void;
  setOrder: (order: readonly string[]) => void;
  clearOrder: () => void;
}

/** Stored arrangements older than this many entries are trimmed on write. */
const MAX_TRACKED_THREADS = 200;

export const useSidebarThreadOrderStore = create<SidebarThreadOrderState>()(
  persist(
    (set) => ({
      order: [],
      migrating: false,
      setMigrating: (migrating) => set({ migrating }),
      pendingMigration: [],
      setPendingMigration: (pendingMigration) => set({ pendingMigration }),
      finishMigration: (ids) =>
        set((state) => ({
          order: state.order.filter((id) => !ids.has(id)),
          pendingMigration: state.pendingMigration.filter((write) => !ids.has(write.id)),
        })),
      setOrder: (order) => set({ order: order.slice(0, MAX_TRACKED_THREADS) }),
      clearOrder: () => set({ order: [] }),
    }),
    {
      name: "t3code:sidebar-thread-order:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ order: state.order, pendingMigration: state.pendingMigration }),
    },
  ),
);

/** Preserve pre-sync arrangements once; existing server order wins on other devices. */
export function planLegacySidebarOrderMigration(input: {
  items: readonly { id: string; activeOrderKey?: string | null }[];
  order: readonly string[];
  reservedKeys: ReadonlySet<string>;
}): { ids: Set<string>; writes: { id: string; orderKey: string }[] } {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const ids = new Set(input.order.filter((id) => byId.has(id)));
  if (ids.size < 2 || input.items.some((item) => item.activeOrderKey != null)) {
    return { ids, writes: [] };
  }
  const keys = generateSpreadPinOrderKeys(ids.size + input.reservedKeys.size).filter(
    (key) => !input.reservedKeys.has(key),
  );
  return {
    ids,
    writes: [...ids].map((id, index) => ({ id, orderKey: keys[index]! })),
  };
}

/**
 * Rearranges the threads the user has dragged while leaving every other thread where the ordinary
 * sort put it. Arranged threads take the slots they collectively occupy in the natural order, so a
 * brand new thread still surfaces at the top instead of sinking below a stale arrangement.
 */
export function applySidebarThreadOrder<TItem>(input: {
  items: readonly TItem[];
  order: readonly string[];
  getId: (item: TItem) => string;
}): TItem[] {
  const { getId, items, order } = input;
  if (order.length === 0 || items.length === 0) return [...items];

  const rankById = new Map(order.map((id, index) => [id, index] as const));
  const slots: number[] = [];
  const arranged: TItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!rankById.has(getId(item))) continue;
    slots.push(index);
    arranged.push(item);
  }
  if (arranged.length < 2) return [...items];

  arranged.sort((left, right) => rankById.get(getId(left))! - rankById.get(getId(right))!);
  const result = [...items];
  for (const [position, slot] of slots.entries()) {
    result[slot] = arranged[position]!;
  }
  return result;
}
