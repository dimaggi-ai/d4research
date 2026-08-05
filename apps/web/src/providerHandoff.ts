import type { ModelSelection, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface ProviderHandoffMessage {
  readonly role: string;
  readonly text: string;
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

export function buildProviderHandoffTranscript(
  messages: ReadonlyArray<ProviderHandoffMessage>,
  maxCharacters = 6_000,
): string {
  const sections = messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`);
  const transcript = sections.join("\n\n");
  if (transcript.length <= maxCharacters) return transcript;
  return `[Earlier messages omitted]\n\n${transcript.slice(-maxCharacters)}`;
}

export function buildProviderHandoffPrompt(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly target: ModelSelection;
  readonly project?: string | undefined;
}): string {
  const project = input.project?.trim();
  return [
    "Continue work from a linked T3Research provider handoff.",
    "",
    `Source thread: ${input.sourceThreadTitle} (${input.sourceThreadId})`,
    `Target model: ${input.target.instanceId} / ${input.target.model}`,
    "The source thread remains unchanged and is the authoritative original conversation.",
    "",
    'First, call memory_remember with connector="local" and store the handoff summary below',
    project ? `using project=\"${project}\".` : "for the current project.",
    'Then use memory_search with connector="local" whenever more shared context is needed.',
    "Do not claim the memory write succeeded unless the tool returns success.",
    "",
    "Handoff summary:",
    input.summary.trim(),
  ].join("\n");
}

export function buildProviderHandoffTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim() || "Untitled thread";
  return `Handoff: ${trimmed}`;
}
