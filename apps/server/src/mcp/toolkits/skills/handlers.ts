import * as Effect from "effect/Effect";

import { readSkillsInventory, type SkillsInventoryEntry } from "../../../skillsInventory.ts";
import { SkillsToolkit, type SkillsSearchResult } from "./tools.ts";

/**
 * Rank a live inventory against one substring query: name hits before
 * description hits, then alphabetical. An empty query lists everything.
 */
export function searchSkillsInventory(
  entries: ReadonlyArray<SkillsInventoryEntry>,
  query: string,
  limit: number,
): ReadonlyArray<SkillsSearchResult> {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ entry: SkillsInventoryEntry; rank: number }> = [];
  for (const entry of entries) {
    if (!needle) {
      scored.push({ entry, rank: 2 });
      continue;
    }
    if (entry.name.toLowerCase().includes(needle)) {
      scored.push({ entry, rank: 0 });
      continue;
    }
    if (entry.description?.toLowerCase().includes(needle)) {
      scored.push({ entry, rank: 1 });
    }
  }
  return scored
    .sort(
      (left, right) => left.rank - right.rank || left.entry.name.localeCompare(right.entry.name),
    )
    .slice(0, limit)
    .map(({ entry }) => ({
      name: entry.name,
      path: entry.path,
      root: entry.root,
      kind: entry.kind,
      scope: entry.scope,
      agents: entry.agents,
      ...(entry.description ? { description: entry.description } : {}),
    }));
}

const handlers = {
  // Scanned per call rather than indexed: skills change on disk behind the
  // app's back, and a live scan can never hand back a deleted skill.
  skills_search: (input) =>
    Effect.gen(function* () {
      const entries = yield* readSkillsInventory();
      const results = searchSkillsInventory(entries, input.query, input.limit);
      return { results, count: results.length };
    }),
} satisfies Parameters<typeof SkillsToolkit.toLayer>[0];

export const SkillsToolkitHandlersLive = SkillsToolkit.toLayer(handlers);
