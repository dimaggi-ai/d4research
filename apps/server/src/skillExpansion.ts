/**
 * skillExpansion — make `$skill` attachments meaningful on providers that have
 * no native skill support.
 *
 * Claude and Codex resolve `$name` themselves. Every other provider we drive
 * (Agy, Cursor, Grok, Junie, OpenCode) receives the token as a meaningless
 * string. For those, the server appends a compact reference block naming the
 * skill, its description, and the absolute SKILL.md path — progressive
 * disclosure, not the body. Every provider here is a local CLI with file-read
 * tools, so the agent fetches the instructions itself.
 *
 * The block is deliberately honest: it says the skill is attached for
 * reference. It never implies the skill ran.
 *
 * This module is pure. Filesystem and provider lookups happen in the caller
 * (the Normalizer), which passes the resolved inventory in.
 *
 * @module skillExpansion
 */

export interface SkillTokenMatch {
  readonly name: string;
  /** Offset of the `$` in the original text. */
  readonly index: number;
}

/** One candidate skill the expansion may reference. */
export interface ExpandableSkill {
  readonly name: string;
  readonly description?: string | undefined;
  /** Absolute path to SKILL.md (or the command markdown file). */
  readonly path: string;
  /**
   * False when the file no longer resolves — a share symlink broken since the
   * inventory scan. Defaults to true.
   */
  readonly available?: boolean | undefined;
}

export interface ExpandSkillTokensInput {
  readonly text: string;
  readonly workspaceSkills: ReadonlyArray<ExpandableSkill>;
  /** Skill names the target provider already resolves on its own. */
  readonly nativeSkillNames?: ReadonlyArray<string> | undefined;
}

export interface ExpandSkillTokensResult {
  readonly text: string;
  readonly expanded: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

const TOKEN_PATTERN = /(^|[^\p{L}\p{N}_$])\$([A-Za-z0-9][A-Za-z0-9._-]{0,63})/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const TRAILING_PUNCTUATION = /[._-]+$/;

/**
 * Blank out code regions so their contents keep their offsets but stop
 * matching. Fenced blocks first — an inline span inside a fence is already
 * masked by the time the inline pass runs.
 */
function maskCodeRegions(text: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return text.replace(FENCED_CODE_PATTERN, blank).replace(INLINE_CODE_PATTERN, blank);
}

/**
 * Find `$name` attachment tokens at a word boundary, ignoring anything inside
 * inline code spans or fenced code blocks and skipping `$$` (shell/latex).
 */
export function findSkillTokens(text: string): ReadonlyArray<SkillTokenMatch> {
  if (!text.includes("$")) {
    return [];
  }
  const masked = maskCodeRegions(text);
  const matches: Array<SkillTokenMatch> = [];
  for (const match of masked.matchAll(TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const raw = match[2];
    if (raw === undefined || match.index === undefined) {
      continue;
    }
    // Trailing separators belong to the sentence, not the skill name.
    const name = raw.replace(TRAILING_PUNCTUATION, "");
    if (!name) {
      continue;
    }
    matches.push({ name, index: match.index + prefix.length });
  }
  return matches;
}

/**
 * Render the compact reference block appended after the user's message. One
 * entry per attached skill: name, description, absolute path, and the single
 * instruction to read that file first.
 */
export function buildSkillReferenceBlock(skills: ReadonlyArray<ExpandableSkill>): string {
  if (skills.length === 0) {
    return "";
  }
  const lines: Array<string> = [
    "Attached skills (reference material — attaching a skill does not run it):",
  ];
  for (const skill of skills) {
    const available = skill.available !== false;
    lines.push("");
    lines.push(`- $${skill.name}${skill.description ? ` — ${skill.description}` : ""}`);
    if (available) {
      lines.push(`  Instructions: ${skill.path}`);
      lines.push("  Read that file before applying this skill.");
    } else {
      lines.push(`  Instructions: ${skill.path} (skill file missing)`);
      lines.push("  The instructions could not be found, so apply your own judgement instead.");
    }
  }
  return lines.join("\n");
}

/**
 * Append a reference block for every `$name` token that names a known
 * workspace skill the target provider cannot resolve natively.
 *
 * The original token stays in place — it is the user's visible attachment —
 * and a provider that already resolves the token is skipped so the skill is
 * never delivered twice.
 */
export function expandSkillTokens(input: ExpandSkillTokensInput): ExpandSkillTokensResult {
  const tokens = findSkillTokens(input.text);
  if (tokens.length === 0) {
    return { text: input.text, expanded: [], missing: [] };
  }

  const byName = new Map<string, ExpandableSkill>();
  for (const skill of input.workspaceSkills) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  const native = new Set(input.nativeSkillNames ?? []);

  const attached: Array<ExpandableSkill> = [];
  const expanded: Array<string> = [];
  const missing: Array<string> = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (seen.has(token.name) || native.has(token.name)) {
      continue;
    }
    const skill = byName.get(token.name);
    if (!skill) {
      continue;
    }
    seen.add(token.name);
    attached.push(skill);
    if (skill.available === false) {
      missing.push(skill.name);
    } else {
      expanded.push(skill.name);
    }
  }

  if (attached.length === 0) {
    return { text: input.text, expanded: [], missing: [] };
  }

  const block = buildSkillReferenceBlock(attached);
  const separator = input.text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${input.text}${separator}${block}`, expanded, missing };
}
