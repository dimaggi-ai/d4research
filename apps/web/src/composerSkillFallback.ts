/**
 * Composer skill fallback — what the `$` menu offers on providers that have
 * no native skill support.
 *
 * Claude and Codex report their own skills in the provider snapshot. Agy,
 * Cursor, Grok and OpenCode report none, so the menu falls back to the local
 * skills inventory. The server expands those tokens into a reference block on
 * the way out, but only for user-level roots — so the menu offers exactly
 * that set and never suggests something that will not resolve.
 */
import type { ServerProviderSkill } from "@t3tools/contracts";

import type { SkillsInventoryEntry } from "./hooks/useSkillsInventory";

/** Roots the server can expand: the inventory scan runs without a workspace. */
const EXPANDABLE_ROOTS: ReadonlySet<SkillsInventoryEntry["root"]> = new Set([
  "claude-user",
  "codex-user",
  "junie-user",
]);

export function toComposerFallbackSkills(
  entries: ReadonlyArray<SkillsInventoryEntry>,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (!EXPANDABLE_ROOTS.has(entry.root) || byName.has(entry.name)) {
      continue;
    }
    byName.set(entry.name, {
      name: entry.name,
      path: entry.path,
      enabled: true,
      scope: entry.scope,
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return [...byName.values()];
}

/**
 * Menu copy for a fallback skill. These are attached to the message as
 * reference instructions — the provider does not execute them — and the
 * label has to say so.
 */
export function describeComposerFallbackSkill(skill: ServerProviderSkill): string {
  const detail = skill.shortDescription ?? skill.description;
  return detail ? `Attach as instructions — ${detail}` : "Attach as instructions";
}
