/**
 * Composer skill fallback — what the `$` menu offers on providers that have
 * no native skill support.
 *
 * Claude and Codex report their own skills in the provider snapshot. Agy,
 * Cursor, Grok and OpenCode report none, so the menu falls back to the local
 * skills inventory — every root of it, since the server resolves the thread's
 * workspace and expands project skills too.
 */
import type { ServerProviderSkill } from "@t3tools/contracts";

import type { SkillsInventoryEntry } from "./hooks/useSkillsInventory";

export function toComposerFallbackSkills(
  entries: ReadonlyArray<SkillsInventoryEntry>,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
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
