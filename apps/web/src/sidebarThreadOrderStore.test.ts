import { describe, expect, it } from "vite-plus/test";

import {
  applySidebarThreadOrder,
  planLegacySidebarOrderMigration,
} from "./sidebarThreadOrderStore";
import { sortActiveThreadsByOrderKey } from "@d4research/client-runtime/state/thread-sort";

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const items = (...values: string[]) => values.map((id) => ({ id }));
const getId = (item: { id: string }) => item.id;

describe("legacy order migration", () => {
  it("materializes the saved arrangement into the same order on a second client", () => {
    const threads = items("a", "b", "c").map((item) => ({
      ...item,
      createdAt: "2026-09-17T00:00:00Z",
    }));
    const plan = planLegacySidebarOrderMigration({
      items: threads,
      order: ["c", "a", "b"],
      reservedKeys: new Set(),
    });
    const keys = new Map(plan.writes.map((write) => [write.id, write.orderKey]));
    expect(
      ids(
        sortActiveThreadsByOrderKey(
          threads.map((thread) => ({ ...thread, activeOrderKey: keys.get(thread.id) })),
        ),
      ),
    ).toEqual(["c", "a", "b"]);
  });
  it("never overwrites an existing server arrangement with a stale local one", () => {
    const plan = planLegacySidebarOrderMigration({
      items: [
        { id: "a", activeOrderKey: "n" },
        { id: "b", activeOrderKey: "t" },
      ],
      order: ["b", "a"],
      reservedKeys: new Set(),
    });
    expect(plan.writes).toEqual([]);
    expect([...plan.ids]).toEqual(["b", "a"]);
  });
  it("leaves unavailable/unsupported threads alone and avoids retained keys", () => {
    const reservedKeys = new Set(["ir", "ri"]);
    const plan = planLegacySidebarOrderMigration({
      items: items("a", "b"),
      order: ["missing", "b", "a"],
      reservedKeys,
    });
    expect(plan.writes.map((write) => write.id)).toEqual(["b", "a"]);
    expect(plan.writes.every((write) => !reservedKeys.has(write.orderKey))).toBe(true);
    expect(plan.ids.has("missing")).toBe(false);
  });
});

describe("applySidebarThreadOrder", () => {
  it("returns the natural order when nothing has been arranged", () => {
    expect(ids(applySidebarThreadOrder({ items: items("a", "b", "c"), order: [], getId }))).toEqual(
      ["a", "b", "c"],
    );
  });

  it("rearranges the threads the user dragged", () => {
    const result = applySidebarThreadOrder({
      items: items("a", "b", "c"),
      order: ["c", "a", "b"],
      getId,
    });
    expect(ids(result)).toEqual(["c", "a", "b"]);
  });

  it("keeps a thread the arrangement has never seen in its natural slot", () => {
    const result = applySidebarThreadOrder({
      items: items("new", "a", "b", "c"),
      order: ["c", "b", "a"],
      getId,
    });
    expect(ids(result)).toEqual(["new", "c", "b", "a"]);
  });

  it("leaves gaps where arranged threads have disappeared", () => {
    const result = applySidebarThreadOrder({
      items: items("a", "new", "c"),
      order: ["c", "b", "a"],
      getId,
    });
    expect(ids(result)).toEqual(["c", "new", "a"]);
  });

  it("ignores an arrangement that covers fewer than two visible threads", () => {
    const result = applySidebarThreadOrder({
      items: items("a", "b"),
      order: ["b"],
      getId,
    });
    expect(ids(result)).toEqual(["a", "b"]);
  });
});
