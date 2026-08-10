/**
 * Composer skill fallback — what the `$` menu offers on providers that have
 * no native skill support.
 *
 * Claude and Codex report their own skills in the provider snapshot. Agy,
 * Cursor, Grok and OpenCode report none, so the menu falls back to the local
 * skills inventory — every root of it, since the server resolves the thread's
 * workspace and expands project skills too.
 */
import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";

import type { SkillsInventoryEntry } from "./hooks/useSkillsInventory";

export function toComposerFallbackSkills(
  entries: ReadonlyArray<SkillsInventoryEntry>,
): ReadonlyArray<ServerProviderSkill> {
  const byName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (existing && !(entry.scope === "project" && existing.scope !== "project")) {
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

/** Build an environment-scoped inventory from the server-streamed provider snapshots. */
export function providerSkillsToInventoryEntries(
  providers: ReadonlyArray<Pick<ServerProvider, "skills">>,
): ReadonlyArray<SkillsInventoryEntry> {
  const entries = new Map<string, SkillsInventoryEntry>();
  for (const provider of providers) {
    for (const skill of provider.skills) {
      if (!skill.enabled || !skill.path.trim()) continue;
      const scope = skill.scope === "project" || skill.scope === "system" ? skill.scope : "user";
      const key = `${scope}:${skill.name}:${skill.path}`;
      if (entries.has(key)) continue;
      entries.set(key, {
        name: skill.name,
        path: skill.path,
        root: scope === "project" ? "project" : "codex-user",
        kind: "skill",
        scope,
        agents: ["all"],
        isSymlinked: false,
        ...(skill.description ? { description: skill.description } : {}),
      });
    }
  }
  return [...entries.values()];
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
