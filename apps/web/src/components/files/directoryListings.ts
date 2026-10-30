import type { ProjectEntry } from "@d4research/contracts";

/** Only merge reachable, expanded levels; stale children cannot resurrect a deleted folder. */
export function mergeDirectoryListings(
  root: readonly ProjectEntry[],
  listings: ReadonlyMap<string, readonly ProjectEntry[]>,
  expanded: readonly string[],
): ProjectEntry[] {
  const open = new Set(expanded);
  const result: ProjectEntry[] = [];
  const pending = [...root];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    result.push(entry);
    if (entry.kind === "directory" && open.has(entry.path)) {
      for (const child of listings.get(entry.path) ?? []) {
        if (child.path.slice(0, child.path.lastIndexOf("/")) === entry.path) pending.push(child);
      }
    }
  }
  return result;
}
