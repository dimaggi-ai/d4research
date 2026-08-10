import {
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  ENABLED_SKILL_SESSION_MAX_COUNT,
} from "@t3tools/contracts";

/**
 * Wire format for skills the user chose to keep active on every turn.
 *
 * The server appends this block after all client-authored context. Clients use
 * this same parser to hide the transport markup and render an honest badge.
 * Keeping both ends here prevents a permissive test fixture from drifting away
 * from the production format.
 */

export type EnabledSkillScope = "global" | "session";

export interface EnabledSkillReference {
  readonly name: string;
  readonly path: string;
  readonly description?: string | undefined;
  readonly scope?: EnabledSkillScope | undefined;
}

export interface ExtractedEnabledSkillsContext {
  readonly promptText: string;
  /** Effective names, retained for consumers that do not need scope labels. */
  readonly skills: ReadonlyArray<string>;
  readonly globalSkills: ReadonlyArray<string>;
  readonly sessionSkills: ReadonlyArray<string>;
}

export type EnabledSkillsByThread = Readonly<Record<string, ReadonlyArray<string>>>;

const TRAILING_ENABLED_SKILLS_PATTERN =
  /\n*<enabled_skills version="([12])" names="([^"]+)"(?: session-names="([^"]+)")?>\n[\s\S]*?\n<\/enabled_skills>\s*$/u;

function uniqueNames(names: ReadonlyArray<string>): Array<string> {
  const unique: Array<string> = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function decodeNames(encoded: string | undefined): Array<string> | null {
  if (encoded === undefined) return [];
  try {
    const decoded = JSON.parse(decodeURIComponent(encoded)) as unknown;
    if (!Array.isArray(decoded) || decoded.some((name) => typeof name !== "string")) return null;
    return uniqueNames(decoded);
  } catch {
    return null;
  }
}

/** Global names win duplicates; the total context tax remains bounded. */
export function mergeEnabledSkillNames(
  globalNames: ReadonlyArray<string>,
  sessionNames: ReadonlyArray<string>,
): Array<string> {
  return uniqueNames([...globalNames, ...sessionNames]).slice(
    0,
    ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  );
}

/**
 * Replace one chat's additive selection while keeping settings schema-safe.
 * Empty chats disappear, and the oldest configured chat is evicted only when
 * adding a 257th entry.
 */
export function setEnabledSkillsForThread(
  configured: EnabledSkillsByThread,
  threadId: string,
  names: ReadonlyArray<string>,
): Record<string, Array<string>> {
  const next = Object.fromEntries(
    Object.entries(configured).map(([id, configuredNames]) => [id, [...configuredNames]]),
  );
  const normalized = uniqueNames(names).slice(0, ENABLED_BY_DEFAULT_SKILL_MAX_COUNT);
  if (normalized.length === 0) {
    delete next[threadId];
    return next;
  }
  if (!(threadId in next) && Object.keys(next).length >= ENABLED_SKILL_SESSION_MAX_COUNT) {
    const oldestThreadId = Object.keys(next)[0];
    if (oldestThreadId !== undefined) delete next[oldestThreadId];
  }
  next[threadId] = normalized;
  return next;
}

/** Atomically add/remove one chat skill without replacing another client's choices. */
export function updateEnabledSkillForThread(
  configured: EnabledSkillsByThread,
  threadId: string,
  name: string,
  enabled: boolean,
): Record<string, Array<string>> {
  const current = configured[threadId] ?? [];
  const next = enabled
    ? [...new Set([...current, name])]
    : current.filter((candidate) => candidate !== name);
  return setEnabledSkillsForThread(configured, threadId, next);
}

/** Read and remove only a valid, anchored block emitted by the server. */
export function extractTrailingEnabledSkillsContext(prompt: string): ExtractedEnabledSkillsContext {
  const match = TRAILING_ENABLED_SKILLS_PATTERN.exec(prompt);
  const empty = { promptText: prompt, skills: [], globalSkills: [], sessionSkills: [] };
  if (!match || match.index === undefined) return empty;

  const names = decodeNames(match[2]);
  const sessionNames = decodeNames(match[3]);
  if (names === null || sessionNames === null) return empty;

  const effectiveSessionNames = sessionNames.filter((name) => names.includes(name));
  const sessionSet = new Set(effectiveSessionNames);
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/u, ""),
    skills: names,
    globalSkills: names.filter((name) => !sessionSet.has(name)),
    sessionSkills: effectiveSessionNames,
  };
}

/**
 * Append (or replace) the active-skill block. Paths are JSON-quoted so spaces,
 * punctuation, and newlines cannot make one reference look like another.
 */
export function appendEnabledSkillsContext(
  prompt: string,
  skills: ReadonlyArray<EnabledSkillReference>,
): string {
  const existing = extractTrailingEnabledSkillsContext(prompt);
  if (skills.length === 0) return existing.promptText;

  const unique = new Map<string, EnabledSkillReference>();
  for (const skill of skills) {
    const name = skill.name.trim();
    if (!name || unique.has(name)) continue;
    unique.set(name, { ...skill, name });
  }
  if (unique.size === 0) return existing.promptText;

  const references = [...unique.values()].slice(0, ENABLED_BY_DEFAULT_SKILL_MAX_COUNT);
  const names = references.map((skill) => skill.name);
  const sessionNames = references
    .filter((skill) => skill.scope === "session")
    .map((skill) => skill.name);
  const encodedNames = encodeURIComponent(JSON.stringify(names));
  const encodedSessionNames = encodeURIComponent(JSON.stringify(sessionNames));
  const lines = [
    `<enabled_skills version="2" names="${encodedNames}" session-names="${encodedSessionNames}">`,
    "These skills were enabled by the user for this turn.",
    "Read every listed SKILL.md before acting and apply its instructions throughout this turn.",
  ];
  for (const skill of references) {
    const scope = skill.scope === "session" ? "this chat" : "all chats";
    lines.push("");
    lines.push(
      `- ${JSON.stringify(skill.name)} (${scope})${skill.description ? ` — ${skill.description}` : ""}`,
    );
    lines.push(`  Instructions: ${JSON.stringify(skill.path)}`);
  }
  lines.push("</enabled_skills>");

  const separator = existing.promptText.endsWith("\n") ? "\n" : "\n\n";
  return `${existing.promptText}${separator}${lines.join("\n")}`;
}
