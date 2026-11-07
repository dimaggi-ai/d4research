// Keep builders and parsers together so compact display matches sent context.
// The full message stays authoritative. Retain legacy context-only parsing
// for threads created before combined instruction-and-context turns.

export interface ProviderHandoffPromptInput {
  readonly sourceThreadId: string;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly targetInstanceId: string;
  readonly targetModel: string;
  readonly project?: string | undefined;
  readonly targetLabel?: string | undefined;
  readonly enabledSkills?: ReadonlyArray<string> | undefined;
}

export interface ParsedProviderHandoffPrompt {
  /** Display headline, e.g. `Claude Code / claude-sonnet-5`. */
  readonly target: string;
  /** Source thread line content, e.g. `My thread (thread-id)`. */
  readonly sourceThread: string;
  /** The carried context summary, verbatim. */
  readonly summary: string;
}

export interface ProviderHandoffContext {
  /** Display headline, e.g. `Claude Code / claude-sonnet-5`. */
  readonly target: string;
  /** The carried context summary, verbatim. */
  readonly summary: string;
}

export interface ExtractedProviderHandoffContext {
  /** The user's instruction with the trailing block removed. */
  readonly promptText: string;
  readonly handoff: ProviderHandoffContext | null;
}

const HEADLINE_PREFIX = "Handoff to ";
const CONTEXT_ATTACHED_LINE = "📎 Context attached: local Memo (shared agent memory).";
const SAME_CHAT_LINE = "This provider handoff stays in the same d4research chat.";
const SOURCE_THREAD_PREFIX = "Source thread: ";
const TARGET_MODEL_PREFIX = "Target model: ";
const SUMMARY_HEADER_LINE = "Handoff context (reference only):";
const TRAILER_LINES = [
  "This is context synchronization only, not a request to continue or resume any prior job or task.",
  "Do not edit files, run tools, or advance prior work because of this handoff.",
  "Acknowledge briefly that the context is loaded, then wait for the user's next instruction.",
] as const;

export function buildProviderHandoffPromptText(input: ProviderHandoffPromptInput): string {
  const project = input.project?.trim();
  const targetLabel = input.targetLabel?.trim() || input.targetInstanceId;
  const enabledSkills = [...new Set(input.enabledSkills ?? [])].filter(
    (name) => name.trim().length > 0,
  );
  return [
    `${HEADLINE_PREFIX}${targetLabel} / ${input.targetModel}.`,
    CONTEXT_ATTACHED_LINE,
    SAME_CHAT_LINE,
    "",
    `${SOURCE_THREAD_PREFIX}${input.sourceThreadTitle} (${input.sourceThreadId})`,
    `${TARGET_MODEL_PREFIX}${input.targetInstanceId} / ${input.targetModel}`,
    "The transcript above remains the authoritative conversation history.",
    "",
    'Use memory_search with connector="local" whenever more shared context is needed',
    project ? `using project="${project}".` : "for the current project.",
    ...(enabledSkills.length > 0
      ? [
          "",
          `Configured global and chat skills: ${enabledSkills.join(", ")}.`,
          "Keep these preferences after the handoff; available SKILL.md references are attached to each turn.",
        ]
      : []),
    "",
    SUMMARY_HEADER_LINE,
    input.summary.trim(),
    "",
    ...TRAILER_LINES,
  ].join("\n");
}

// Anchor on the fixed head and tail: summaries may quote handoff markers.
// Nonmatching messages must render unchanged.
export function parseProviderHandoffPrompt(text: string): ParsedProviderHandoffPrompt | null {
  if (!text.startsWith(HEADLINE_PREFIX)) return null;
  const lines = text.split("\n");
  // Head: headline, two fixed marker lines, blank, source thread, target model.
  if (lines.length < 12) return null;
  const headline = lines[0]!;
  if (!headline.endsWith(".") || headline.length <= HEADLINE_PREFIX.length + 1) return null;
  if (lines[1] !== CONTEXT_ATTACHED_LINE || lines[2] !== SAME_CHAT_LINE) return null;
  if (lines[3] !== "") return null;
  const sourceThreadLine = lines[4]!;
  const targetModelLine = lines[5]!;
  if (!sourceThreadLine.startsWith(SOURCE_THREAD_PREFIX)) return null;
  if (!targetModelLine.startsWith(TARGET_MODEL_PREFIX)) return null;

  // Tail: blank line, then the three fixed context-sync sentences.
  const trailerStart = lines.length - TRAILER_LINES.length;
  for (let index = 0; index < TRAILER_LINES.length; index += 1) {
    if (lines[trailerStart + index] !== TRAILER_LINES[index]) return null;
  }
  if (lines[trailerStart - 1] !== "") return null;

  const summaryHeaderIndex = lines.indexOf(SUMMARY_HEADER_LINE, 6);
  if (summaryHeaderIndex < 0 || summaryHeaderIndex >= trailerStart - 1) return null;

  return {
    target: headline.slice(HEADLINE_PREFIX.length, -1),
    sourceThread: sourceThreadLine.slice(SOURCE_THREAD_PREFIX.length),
    summary: lines
      .slice(summaryHeaderIndex + 1, trailerStart - 1)
      .join("\n")
      .trim(),
  };
}

const HANDOFF_CONTEXT_TAG = "handoff_context";
const CONTEXT_SUMMARY_HEADER_LINE = "Context summary (reference only):";
const CONTEXT_TRAILER_LINE = [
  "This provider handoff stays in the same d4research thread; the visible transcript remains authoritative.",
  "The user's message above this block is the current instruction: act on it.",
  'Use memory_search with connector="local" for more shared context.',
  "Do not resume other prior work beyond the user's instruction.",
].join(" ");
// Persisted handoff blocks used an em dash before the current colon separator.
const LEGACY_CONTEXT_TRAILER_LINE = CONTEXT_TRAILER_LINE.replace(
  "instruction: act",
  `instruction ${String.fromCodePoint(0x2014)} act`,
);
const SKILLS_PREFIX = "Configured global and chat skills: ";
const PROJECT_PREFIX = "Project: ";
const OPEN_TAG = `<${HANDOFF_CONTEXT_TAG}>`;
const CLOSE_TAG = `</${HANDOFF_CONTEXT_TAG}>`;

/**
 * The head fields occupy one line each and the parser reads them by position, so
 * a thread title or project name containing a newline would silently destroy the
 * block's structure. Collapse whitespace instead of trusting the caller.
 */
function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Appends the carried context to the user's instruction. This is the outermost
 * client-authored layer: the composer's own context blocks are already part of
 * `promptText` when this runs, and only the server's enabled-skills block is
 * appended after it.
 */
export function appendProviderHandoffContext(
  promptText: string,
  input: ProviderHandoffPromptInput,
): string {
  const project = singleLine(input.project ?? "");
  const targetInstanceId = singleLine(input.targetInstanceId);
  const targetModel = singleLine(input.targetModel);
  const targetLabel = singleLine(input.targetLabel ?? "") || targetInstanceId;
  const enabledSkills = [...new Set((input.enabledSkills ?? []).map(singleLine))].filter(
    (name) => name.length > 0,
  );
  const block = [
    OPEN_TAG,
    `${HEADLINE_PREFIX}${targetLabel} / ${targetModel}.`,
    `${SOURCE_THREAD_PREFIX}${singleLine(input.sourceThreadTitle)} (${singleLine(input.sourceThreadId)})`,
    `${TARGET_MODEL_PREFIX}${targetInstanceId} / ${targetModel}`,
    ...(enabledSkills.length > 0 ? [`${SKILLS_PREFIX}${enabledSkills.join(", ")}.`] : []),
    ...(project ? [`${PROJECT_PREFIX}${project}`] : []),
    "",
    CONTEXT_SUMMARY_HEADER_LINE,
    input.summary.trim(),
    "",
    CONTEXT_TRAILER_LINE,
    CLOSE_TAG,
  ].join("\n");
  const body = promptText.replace(/\n+$/u, "");
  return body.length > 0 ? `${body}\n\n${block}` : block;
}

/**
 * Hostile input cannot be allowed to turn a display concern into a hang. Past
 * this many candidates the block simply renders raw, which is a cosmetic
 * degradation: the persisted message is unaffected either way.
 */
const MAX_HANDOFF_BLOCK_CANDIDATES = 20;

/** Index of the `<` that opens the block closing at end-of-string, or null. */
function trailingCloseTagIndex(text: string): number | null {
  let end = text.length;
  while (end > 0 && /\s/u.test(text[end - 1]!)) end -= 1;
  const closeStart = end - CLOSE_TAG.length;
  if (closeStart <= 0 || !text.startsWith(CLOSE_TAG, closeStart)) return null;
  // The closing tag owns its own line (\r\n counts: it still ends in \n).
  return text[closeStart - 1] === "\n" ? closeStart : null;
}

/** Line-start offsets of every `tag` that owns its own line, before `limit`. */
function tagLineIndices(text: string, tag: string, limit: number): Array<number> {
  const indices: Array<number> = [];
  for (let index = text.indexOf(tag); index >= 0; index = text.indexOf(tag, index + 1)) {
    if (index >= limit) break;
    if (index !== 0 && text[index - 1] !== "\n") continue;
    const after = text[index + tag.length];
    if (after !== "\n" && !(after === "\r" && text[index + tag.length + 1] === "\n")) continue;
    indices.push(index);
  }
  return indices;
}

interface ParsedHandoffBlockBody {
  readonly target: string;
  readonly summary: string;
}

/**
 * Validates one candidate block body. The headline check runs before the split
 * so a candidate opened by user prose dies without walking the rest.
 * CRLF is normalized here only: the caller's `promptText` keeps whatever line
 * endings the message was stored with.
 */
function parseHandoffBlockBody(rawBody: string): ParsedHandoffBlockBody | null {
  const body = rawBody.includes("\r") ? rawBody.replace(/\r(?=\n)|\r$/gu, "") : rawBody;
  const firstBreak = body.indexOf("\n");
  const headline = firstBreak < 0 ? body : body.slice(0, firstBreak);
  if (!headline.startsWith(HEADLINE_PREFIX) || !headline.endsWith(".")) return null;
  if (headline.length <= HEADLINE_PREFIX.length + 1) return null;

  const lines = body.split("\n");
  // Head (headline, source thread, target model), blank, summary header, at
  // least one summary line, blank, trailer.
  if (lines.length < 8) return null;
  if (!lines[1]?.startsWith(SOURCE_THREAD_PREFIX)) return null;
  if (!lines[2]?.startsWith(TARGET_MODEL_PREFIX)) return null;

  const trailerIndex = lines.length - 1;
  if (
    lines[trailerIndex] !== CONTEXT_TRAILER_LINE &&
    lines[trailerIndex] !== LEGACY_CONTEXT_TRAILER_LINE
  )
    return null;
  if (lines[trailerIndex - 1] !== "") return null;

  // `>= trailerIndex - 2` also rejects a header with an empty summary body.
  const summaryHeaderIndex = lines.indexOf(CONTEXT_SUMMARY_HEADER_LINE, 3);
  if (summaryHeaderIndex < 0 || summaryHeaderIndex >= trailerIndex - 2) return null;

  return {
    target: headline.slice(HEADLINE_PREFIX.length, -1),
    summary: lines
      .slice(summaryHeaderIndex + 1, trailerIndex - 1)
      .join("\n")
      .trim(),
  };
}

// Try trailing openers backwards to preserve complete blocks the user pasted.
// Prefer balanced candidates so quoted handoffs resolve to the outer block;
// then tolerate stray closing lines in summaries.
export function extractTrailingProviderHandoffContext(
  text: string,
): ExtractedProviderHandoffContext {
  const unchanged = { promptText: text, handoff: null };
  const closeStart = trailingCloseTagIndex(text);
  if (closeStart === null) return unchanged;

  const openers = tagLineIndices(text, OPEN_TAG, closeStart);
  const closers = tagLineIndices(text, CLOSE_TAG, closeStart);
  // Both arrays are sorted, so one backward sweep gives every candidate's tag
  // counts without rescanning the text.
  const balanced = openers.map(() => false);
  let closersBefore = closers.length;
  for (let candidate = openers.length - 1; candidate >= 0; candidate -= 1) {
    const index = openers[candidate]!;
    while (closersBefore > 0 && closers[closersBefore - 1]! > index) closersBefore -= 1;
    balanced[candidate] = openers.length - 1 - candidate === closers.length - closersBefore;
  }

  const attemptLimit = Math.max(0, openers.length - MAX_HANDOFF_BLOCK_CANDIDATES);
  const tryCandidate = (candidate: number) => {
    const index = openers[candidate]!;
    // Body spans the line after the opener up to the newline before the closer.
    const afterTag = index + OPEN_TAG.length;
    const bodyStart = text[afterTag] === "\r" ? afterTag + 2 : afterTag + 1;
    const parsed = parseHandoffBlockBody(text.slice(bodyStart, closeStart - 1));
    return parsed === null
      ? null
      : { promptText: text.slice(0, index).replace(/[\r\n]+$/u, ""), handoff: parsed };
  };

  // Pass 1, backward: the machine block is appended last, so the newest
  // balanced block wins and a complete block the user pasted stays theirs.
  for (let candidate = openers.length - 1; candidate >= attemptLimit; candidate -= 1) {
    if (!balanced[candidate]) continue;
    const found = tryCandidate(candidate);
    if (found) return found;
  }
  // Pass 2, forward: nothing balanced parsed, so the tags are malformed
  // somewhere. Prefer the OUTERMOST opener: an unbalanced decoy nested in a
  // summary would otherwise borrow the real block's trailer and win.
  for (let candidate = attemptLimit; candidate < openers.length; candidate += 1) {
    if (balanced[candidate]) continue;
    const found = tryCandidate(candidate);
    if (found) return found;
  }
  return unchanged;
}
