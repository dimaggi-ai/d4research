import type { ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface ProviderHandoffMessage {
  readonly role: string;
  readonly text: string;
}

export function shouldHandoffModelSelection(input: {
  readonly hasStartedSession: boolean;
  readonly currentInstanceId: ProviderInstanceId;
  readonly nextInstanceId: ProviderInstanceId;
  readonly modelChangeRequiresNewThread: boolean;
  readonly providerChanged: boolean;
}): boolean {
  return (
    input.hasStartedSession &&
    (input.currentInstanceId !== input.nextInstanceId ||
      input.modelChangeRequiresNewThread ||
      input.providerChanged)
  );
}

export function isProviderHandoffCandidate(
  entry: {
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly status: string;
    readonly models: ReadonlyArray<unknown>;
  },
  sourceInstanceId: ProviderInstanceId,
): boolean {
  return (
    entry.instanceId !== sourceInstanceId &&
    entry.enabled &&
    entry.isAvailable &&
    entry.status === "ready" &&
    entry.models.length > 0
  );
}

const HANDOFF_TASK_HEADER_MAX_CHARACTERS = 1_200;
const HANDOFF_OMISSION_MARKER = "[... earlier conversation compressed/omitted ...]";
const SECTION_SEPARATOR = "\n\n";

/**
 * Builds a handoff transcript that stays context-valid on long threads:
 * the first non-empty user message (the original task) is kept verbatim as a
 * header, then as many of the MOST RECENT messages as fit the remaining
 * budget. Tail-only truncation dropped the task statement first — this never
 * does.
 */
export function buildStructuredHandoffTranscript(
  messages: ReadonlyArray<ProviderHandoffMessage>,
  maxCharacters = 6_000,
): string {
  const sections = messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`);
  const transcript = sections.join(SECTION_SEPARATOR);
  if (transcript.length <= maxCharacters) return transcript;
  // Degenerate budget: not even the omission marker fits, so structure is
  // meaningless — keep the newest slice.
  if (maxCharacters <= HANDOFF_OMISSION_MARKER.length * 2) {
    return transcript.slice(transcript.length - maxCharacters);
  }

  const firstUserText =
    messages.find((message) => message.role === "user" && message.text.trim().length > 0)?.text ??
    "";
  // The header may never eat the whole budget: cap it so at least half of the
  // budget stays available for the most recent messages.
  const headerBudget = Math.max(
    0,
    Math.min(
      HANDOFF_TASK_HEADER_MAX_CHARACTERS,
      Math.floor(maxCharacters / 2) - HANDOFF_OMISSION_MARKER.length - SECTION_SEPARATOR.length * 2,
    ),
  );
  const taskHeader =
    firstUserText.trim() && headerBudget > 0
      ? `USER (original task): ${firstUserText.trim()}`.slice(0, headerBudget)
      : "";

  const headerParts = taskHeader
    ? [taskHeader, HANDOFF_OMISSION_MARKER]
    : [HANDOFF_OMISSION_MARKER];
  const headerLength = headerParts.join(SECTION_SEPARATOR).length + SECTION_SEPARATOR.length;
  let remaining = Math.max(0, maxCharacters - headerLength);

  const tailSections: Array<string> = [];
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]!;
    const cost = section.length + (tailSections.length > 0 ? SECTION_SEPARATOR.length : 0);
    if (cost > remaining) break;
    tailSections.unshift(section);
    remaining -= cost;
  }
  if (tailSections.length === 0) {
    // Even the newest message alone exceeds the budget: keep its newest slice.
    const newest = sections[sections.length - 1] ?? "";
    tailSections.push(newest.slice(Math.max(0, newest.length - remaining)));
  }
  return [...headerParts, tailSections.join(SECTION_SEPARATOR)].join(SECTION_SEPARATOR);
}

export function buildProviderHandoffPrompt(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly target: ModelSelection;
  readonly project?: string | undefined;
  readonly targetLabel?: string | undefined;
}): string {
  const project = input.project?.trim();
  const targetLabel = input.targetLabel?.trim() || String(input.target.instanceId);
  return [
    `Handoff to ${targetLabel} / ${input.target.model}.`,
    "📎 Context attached: local Memo (shared agent memory).",
    "This provider handoff continues in the same d4research chat.",
    "",
    `Source thread: ${input.sourceThreadTitle} (${input.sourceThreadId})`,
    `Target model: ${input.target.instanceId} / ${input.target.model}`,
    "The transcript above remains the authoritative conversation history.",
    "",
    'Use memory_search with connector="local" whenever more shared context is needed',
    project ? `using project="${project}".` : "for the current project.",
    "",
    "Handoff summary:",
    input.summary.trim(),
  ].join("\n");
}

export function buildProviderHandoffMemory(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly target: ModelSelection;
}): string {
  return [
    `d4research provider handoff from thread ${input.sourceThreadTitle} (${input.sourceThreadId}).`,
    `Receiving agent: ${input.target.instanceId} / ${input.target.model}.`,
    "Shared context:",
    input.summary.trim(),
  ].join("\n");
}

export interface PrepareProviderHandoffInput {
  readonly transcript: string;
  readonly project?: string | undefined;
  readonly sourceThreadId?: string | undefined;
  readonly sourceThreadTitle?: string | undefined;
  readonly target?: { readonly instanceId: string; readonly model: string } | undefined;
}

/**
 * Single round-trip handoff preparation: the server compresses the transcript
 * per the handoff settings AND persists the compressed summary to local Memo.
 * Returns the compressed summary, or null when preparation failed (callers
 * fall back to the structured transcript — handoff never blocks on this).
 */
export async function prepareProviderHandoff(
  input: PrepareProviderHandoffInput,
): Promise<string | null> {
  try {
    const response = await fetch("/api/handoff/prepare", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: unknown;
      compressed?: unknown;
    } | null;
    if (result?.ok === true && typeof result.compressed === "string" && result.compressed.trim()) {
      return result.compressed;
    }
    return null;
  } catch {
    return null;
  }
}
