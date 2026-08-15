import { ThreadId, type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { preparedEnvironmentFetchAuthorization } from "@t3tools/client-runtime/state/skills";
import { extractTrailingEnabledSkillsContext } from "@t3tools/shared/enabledSkillsContext";
import { buildProviderHandoffPromptText } from "@t3tools/shared/providerHandoffPrompt";

import { runtime } from "./lib/runtime";

export interface ProviderHandoffMessage {
  readonly role: string;
  readonly text: string;
}

export interface SameThreadProviderHandoffTransition<Prepared> {
  /** Must durably persist context before returning. */
  readonly prepare: () => Promise<Prepared>;
  /** One server command persists the target model, message, and turn intent. */
  readonly startReceivingTurn: (prepared: Prepared) => Promise<void>;
}

/**
 * Durable preparation finishes before one atomic turn-start command changes
 * the model and starts the receiving provider. There is no client-side
 * stop/update rollback window for another device to interleave with.
 */
export async function runSameThreadProviderHandoffTransition<Prepared>(
  input: SameThreadProviderHandoffTransition<Prepared>,
): Promise<void> {
  const prepared = await input.prepare();
  await input.startReceivingTurn(prepared);
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
  const normalizedMessages = messages.map((message) => ({
    ...message,
    text:
      message.role === "user"
        ? extractTrailingEnabledSkillsContext(message.text).promptText
        : message.text,
  }));
  const sections = normalizedMessages
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
    normalizedMessages.find((message) => message.role === "user" && message.text.trim().length > 0)
      ?.text ?? "";
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

export const EMPTY_PROVIDER_HANDOFF_TRANSCRIPT =
  "No prior conversation messages were available for this context handoff.";

/**
 * A provider switch always carries context, but it is never itself a request to
 * resume work. In particular, an empty transcript must not manufacture a
 * continuation task for the receiving agent.
 */
export function buildProviderHandoffTranscript(
  messages: ReadonlyArray<ProviderHandoffMessage>,
  maxCharacters = 6_000,
): string {
  return (
    buildStructuredHandoffTranscript(messages, maxCharacters).trim() ||
    EMPTY_PROVIDER_HANDOFF_TRANSCRIPT
  );
}

export function buildProviderHandoffPrompt(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly target: ModelSelection;
  readonly project?: string | undefined;
  readonly targetLabel?: string | undefined;
  readonly enabledSkills?: ReadonlyArray<string> | undefined;
}): string {
  // The format lives in @t3tools/shared/providerHandoffPrompt next to its
  // parser, so the compact timeline rendering can never drift from this text.
  return buildProviderHandoffPromptText({
    sourceThreadId: input.sourceThreadId,
    sourceThreadTitle: input.sourceThreadTitle,
    summary: input.summary,
    targetInstanceId: String(input.target.instanceId),
    targetModel: input.target.model,
    project: input.project,
    targetLabel: input.targetLabel,
    enabledSkills: input.enabledSkills,
  });
}

export function buildProviderHandoffMemory(input: {
  readonly sourceThreadId: ThreadId;
  readonly sourceThreadTitle: string;
  readonly summary: string;
  readonly target: ModelSelection;
  readonly enabledSkills?: ReadonlyArray<string> | undefined;
}): string {
  const enabledSkills = [...new Set(input.enabledSkills ?? [])].filter(
    (name) => name.trim().length > 0,
  );
  return [
    `d4research provider handoff from thread ${input.sourceThreadTitle} (${input.sourceThreadId}).`,
    `Receiving agent: ${input.target.instanceId} / ${input.target.model}.`,
    ...(enabledSkills.length > 0
      ? [`Configured global and chat skills to preserve: ${enabledSkills.join(", ")}.`]
      : []),
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
  readonly enabledSkills?: ReadonlyArray<string> | undefined;
  /**
   * Skip compression server-side and hand the transcript over as-is.
   * Research handoffs set this: pipeline evidence must survive verbatim.
   */
  readonly bypassCompression?: boolean | undefined;
  /** Connected environment that owns this thread and its local Memo. */
  readonly preparedConnection?: PreparedConnection | undefined;
}

function environmentApiUrl(path: string, prepared?: PreparedConnection): string | null {
  return prepared ? new URL(path, prepared.httpBaseUrl).toString() : null;
}

async function authorizedEnvironmentPost(input: {
  readonly prepared: PreparedConnection;
  readonly endpoint: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
}): Promise<Response> {
  const auth = await runtime.runPromise(
    preparedEnvironmentFetchAuthorization(input.prepared, "POST", input.endpoint),
  );
  return fetch(input.endpoint, {
    method: "POST",
    cache: "no-store",
    ...(auth.credentials ? { credentials: auth.credentials } : {}),
    headers: { "content-type": "application/json", ...auth.headers },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
}

/**
 * Single round-trip handoff preparation: the server compresses the transcript
 * per the handoff settings AND persists the compressed summary to local Memo.
 * Returns the compressed summary, or null when preparation failed (callers
 * fall back to the structured transcript — handoff never blocks on this).
 */
// Compression is bounded server-side (60 s local, 120 s provider), so a
// request outliving both is stuck, not slow. The fallback path is free.
const PREPARE_TIMEOUT_MS = 150_000;
export const PROVIDER_HANDOFF_MEMORY_TIMEOUT_MS = 15_000;

export async function prepareProviderHandoff(
  input: PrepareProviderHandoffInput,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS);
  try {
    const { preparedConnection, ...body } = input;
    const endpoint = environmentApiUrl("/api/handoff/prepare", preparedConnection);
    if (endpoint === null || preparedConnection === undefined) return null;
    const response = await authorizedEnvironmentPost({
      prepared: preparedConnection,
      endpoint,
      body,
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: unknown;
      compressed?: unknown;
      memoryPersisted?: unknown;
    } | null;
    if (
      result?.ok === true &&
      result.memoryPersisted === true &&
      typeof result.compressed === "string" &&
      result.compressed.trim()
    ) {
      return result.compressed;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepares a provider handoff and proves that its context reached local Memo.
 *
 * INVARIANT: a provider handoff may replace the provider-native session, but
 * it must never replace the d4research thread. The receiving turn starts on
 * the existing thread only after this durable local-memory bridge succeeds.
 */
export async function prepareDurableProviderHandoff(
  input: PrepareProviderHandoffInput & {
    readonly sourceThreadId: string;
    readonly sourceThreadTitle: string;
    readonly target: ModelSelection;
  },
): Promise<string> {
  const prepared = await prepareProviderHandoff(input);
  if (prepared !== null) return prepared;

  const stored = await persistProviderHandoffMemoryFallback({
    text: buildProviderHandoffMemory({
      sourceThreadId: ThreadId.make(input.sourceThreadId),
      sourceThreadTitle: input.sourceThreadTitle,
      summary: input.transcript,
      target: input.target,
      enabledSkills: input.enabledSkills,
    }),
    project: input.project,
    preparedConnection: input.preparedConnection,
  });
  if (!stored) {
    throw new Error("Local Memo could not store the provider handoff context.");
  }
  return input.transcript;
}

/**
 * Memo write for the prepare-failure path. The durable handoff boundary awaits
 * this result and blocks the provider switch when it fails, so a receiving
 * native session is never started without recoverable local context.
 */
export async function persistProviderHandoffMemoryFallback(input: {
  readonly text: string;
  readonly project?: string | undefined;
  readonly preparedConnection?: PreparedConnection | undefined;
}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_HANDOFF_MEMORY_TIMEOUT_MS);
  try {
    const { preparedConnection, ...body } = input;
    const endpoint = environmentApiUrl("/api/memory/handoff", preparedConnection);
    if (endpoint === null || preparedConnection === undefined) return false;
    const response = await authorizedEnvironmentPost({
      prepared: preparedConnection,
      endpoint,
      body,
      signal: controller.signal,
    });
    const result = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return response.ok && result?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
