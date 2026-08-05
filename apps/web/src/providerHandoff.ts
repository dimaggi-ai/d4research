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
  readonly targetLabel?: string | undefined;
}): string {
  const project = input.project?.trim();
  const targetLabel = input.targetLabel?.trim() || String(input.target.instanceId);
  return [
    `Handoff to ${targetLabel} / ${input.target.model}.`,
    "Shared context was saved to local Memo before this agent started.",
    "",
    `Source thread: ${input.sourceThreadTitle} (${input.sourceThreadId})`,
    `Target model: ${input.target.instanceId} / ${input.target.model}`,
    "The source thread remains unchanged and is the authoritative original conversation.",
    "",
    'Use memory_search with connector="local" whenever more shared context is needed',
    project ? `using project=\"${project}\".` : "for the current project.",
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
    `T3Research provider handoff from thread ${input.sourceThreadTitle} (${input.sourceThreadId}).`,
    `Receiving agent: ${input.target.instanceId} / ${input.target.model}.`,
    "Shared context:",
    input.summary.trim(),
  ].join("\n");
}

export async function persistProviderHandoffMemory(input: {
  readonly text: string;
  readonly project?: string | undefined;
}): Promise<void> {
  const response = await fetch("/api/memory/handoff", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = (await response.json().catch(() => null)) as {
    ok?: unknown;
    message?: unknown;
  } | null;
  if (!response.ok || result?.ok !== true) {
    throw new Error(
      typeof result?.message === "string"
        ? result.message
        : "Local Memo could not store the handoff context.",
    );
  }
}

export function buildProviderHandoffTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim() || "Untitled thread";
  return `Handoff: ${trimmed}`;
}
