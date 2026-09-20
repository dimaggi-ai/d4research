import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type ProviderInstanceId, ThreadId } from "@d4research/contracts";

import {
  askLocalJudge,
  DEFAULT_LOCAL_JUDGE_BASE_URL,
  LOCAL_JUDGE_CONCURRENCY,
  type LocalJudgeError,
  type LocalJudgeQuestion,
} from "./localJudge.ts";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";

export const DEFAULT_COMPRESSION_PROMPT = `Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, commands, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
When the transcript is marked as omitted parts, summarize only those parts; the essential messages already travel verbatim.
Output only the compressed summary, no preamble.`;

/** bonsai2 gateway (Ollama-compatible) for the summary call. */
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const LOCAL_COMPRESSION_TIMEOUT_MILLIS = 60_000;
// The resident bonsai2 slots hold 100K tokens; this cap only bounds the
// estimate sent as num_ctx so a huge input budget stays a deliberate choice.
const LOCAL_SUMMARY_MAX_NUM_CTX = 32_768;
// Below this many messages there is nothing to rank: a two-message exchange is
// either kept whole (when it fits) or summarized whole.
const MIN_UNITS_FOR_JUDGMENT = 3;
// Provider CLIs cold-start and stream, so they get more room than the local
// daemon — but a hung provider must never hold a handoff open forever.
const PROVIDER_COMPRESSION_TIMEOUT_MILLIS = 120_000;
const SESSION_STOP_TIMEOUT_MILLIS = 10_000;
// The whole provider-compression attempt behind /api/handoff/prepare. The
// switch triggered the handoff, so the attempt is bounded well inside the
// client's patience and can never depend on the quota of the provider being
// left. On expiry the handoff falls back to deterministic truncation.
export const PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS = 30_000;

// Compression sessions are hidden provider sessions, not durable threads. A
// wall-clock-only id lets two handoff requests started in the same millisecond
// stop or steer one another, so keep a process-local monotonic suffix as well.
let handoffCompressionSequence = 0;

/**
 * Deterministic, model-free fallback: keeps the head (task statement) and the
 * most recent tail of the transcript within the character budget. Used whenever
 * model-based compression is unavailable or fails — handoff must never block.
 */
export function truncateHandoffTranscript(transcript: string, maxCharacters: number): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= maxCharacters) return trimmed;
  const marker = "\n\n[... middle of conversation omitted ...]\n\n";
  // A budget smaller than the marker would still emit the marker and land
  // over budget; below that point the freshest tail is worth more than a
  // truncation notice.
  if (maxCharacters <= marker.length) {
    return trimmed.slice(trimmed.length - maxCharacters);
  }
  const budget = Math.max(0, maxCharacters - marker.length);
  const headLength = Math.floor(budget * 0.3);
  const tailLength = budget - headLength;
  return `${trimmed.slice(0, headLength)}${marker}${trimmed.slice(trimmed.length - tailLength)}`;
}

export class LocalHandoffCompressionError extends Data.TaggedError("LocalHandoffCompressionError")<{
  readonly detail: string;
}> {}

export interface CompressHandoffContextLocalInput {
  readonly transcript: string;
  readonly model: string;
  readonly maxInputCharacters: number;
  readonly maxOutputCharacters: number;
  readonly customPrompt: string;
  /** Ollama-compatible base URL for the summary call (`/api/chat`). */
  readonly baseUrl?: string;
  /** OpenAI-compatible base URL for the judge (`/v1/chat/completions` with logprobs). */
  readonly judgeBaseUrl?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
  readonly judgeTimeoutMillis?: number;
}

export type HandoffUnitRole = "task" | "marker" | "user" | "assistant" | "other";

export interface HandoffUnit {
  readonly index: number;
  readonly role: HandoffUnitRole;
  readonly text: string;
}

// Structured transcripts (see buildStructuredHandoffTranscript in the web
// client) join `ROLE: text` sections with blank lines; a message body may hold
// blank lines of its own, so only a paragraph that opens with a role label or
// the client's omission marker starts a new unit.
const EARLIER_OMISSION_MARKER = "[... earlier conversation compressed/omitted ...]";
const UNIT_BOUNDARY =
  /\n\n(?=(?:USER|ASSISTANT|SYSTEM)(?: \([^)\n]*\))?: |\[\.\.\. earlier conversation compressed\/omitted \.\.\.\])/;

/** Splits a structured handoff transcript into judgeable message units. */
export function splitHandoffTranscript(transcript: string): ReadonlyArray<HandoffUnit> {
  return transcript
    .split(UNIT_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((text, index) => {
      const role: HandoffUnitRole = text.startsWith("USER (original task):")
        ? "task"
        : text === EARLIER_OMISSION_MARKER
          ? "marker"
          : text.startsWith("USER")
            ? "user"
            : text.startsWith("ASSISTANT")
              ? "assistant"
              : "other";
      return { index, role, text };
    });
}

/** The single per-message judgment; levels double as the score legend. */
export const HANDOFF_UNIT_KEEP_QUESTION = {
  type: "score",
  instructions:
    "Another AI agent is about to take over this conversation and continue the work. Judge how much that agent needs `message`, given `original_task` and that `position` tells where it sits in the conversation.",
  criteria: [
    "Skip: a greeting, acknowledgement, pleasantry, or a repeat of information already stated elsewhere; the next agent loses nothing without it",
    "Summarize: useful background such as reasoning, exploration, or partial results whose gist matters but whose exact wording does not",
    "Keep verbatim: states a decision, a user instruction, a file path, identifier, command, error message, or an open task the next agent must act on exactly",
  ],
} as const satisfies LocalJudgeQuestion;

const SKIP_SCORE_CEILING = 0.5;
// Recency only breaks near-ties between equally judged messages; a clear
// importance margin must beat "it came later".
const RECENCY_WEIGHT = 0.1;
// Local models overshoot a stated maximum; asking for a little less keeps the
// hard clip below from cutting the summary mid-sentence in the common case.
const SUMMARY_ASK_SHARE = 0.8;
// Judging costs one prompt evaluation per unit; on very long transcripts the
// oldest units skip the judge and go straight to the summary instead.
const MAX_JUDGED_UNITS = 48;
const MAX_JUDGED_UNIT_CHARACTERS = 3_000;
const MAX_TASK_STATE_CHARACTERS = 600;
const VERBATIM_SHARE = 0.7;
const MIN_SUMMARY_BUDGET = 160;
const JUDGE_STAGE_TIMEOUT_MILLIS = 40_000;
const NOT_JUDGED_SCORE = 1;

export interface HandoffCompactionPlan {
  readonly kept: ReadonlyArray<HandoffUnit>;
  readonly omitted: ReadonlyArray<HandoffUnit>;
  readonly skipped: ReadonlyArray<HandoffUnit>;
  readonly summaryBudget: number;
}

function omissionNotice(count: number): string {
  return `[... ${count} earlier message${count === 1 ? "" : "s"} compressed into the summary below ...]`;
}

/**
 * Pure selection: given per-unit importance scores (0 skip … 2 keep verbatim),
 * decides which units travel verbatim, which are summarized, and which are
 * dropped, within `maxOutputCharacters`. The original task and the newest
 * message are always kept; the remainder is ranked by score with a small
 * recency bonus, and when not everything fits, a share of the budget is left
 * for a summary of what was omitted.
 */
export function planHandoffCompaction(
  units: ReadonlyArray<HandoffUnit>,
  scores: ReadonlyMap<number, number>,
  maxOutputCharacters: number,
): HandoffCompactionPlan {
  const separator = "\n\n";
  const contentUnits = units.filter((unit) => unit.role !== "marker");
  const newest = contentUnits[contentUnits.length - 1];
  const pinned = contentUnits.filter((unit) => unit.role === "task" || unit === newest);
  const skipped: Array<HandoffUnit> = [];
  const candidates: Array<{ unit: HandoffUnit; priority: number }> = [];
  const span = Math.max(1, contentUnits.length - 1);
  for (const unit of contentUnits) {
    if (pinned.includes(unit)) continue;
    const score = scores.get(unit.index) ?? NOT_JUDGED_SCORE;
    if (score < SKIP_SCORE_CEILING) {
      skipped.push(unit);
      continue;
    }
    candidates.push({ unit, priority: score + RECENCY_WEIGHT * (unit.index / span) });
  }
  candidates.sort((a, b) => b.priority - a.priority || b.unit.index - a.unit.index);

  const cost = (list: ReadonlyArray<HandoffUnit>) =>
    list.reduce((sum, unit) => sum + unit.text.length, 0) +
    Math.max(0, list.length - 1) * separator.length;

  const allCandidates = [...pinned, ...candidates.map((entry) => entry.unit)];
  if (cost(allCandidates) <= maxOutputCharacters) {
    return {
      kept: allCandidates.sort((a, b) => a.index - b.index),
      omitted: [],
      skipped,
      summaryBudget: 0,
    };
  }

  const notice = omissionNotice(candidates.length);
  const verbatimBudget = Math.floor(maxOutputCharacters * VERBATIM_SHARE);
  const kept: Array<HandoffUnit> = [...pinned];
  const omitted: Array<HandoffUnit> = [];
  let used = cost(kept) + notice.length + separator.length;
  for (const { unit } of candidates) {
    const extra = unit.text.length + separator.length;
    if (used + extra <= verbatimBudget) {
      kept.push(unit);
      used += extra;
    } else {
      omitted.push(unit);
    }
  }
  kept.sort((a, b) => a.index - b.index);
  omitted.sort((a, b) => a.index - b.index);
  return {
    kept,
    omitted,
    skipped,
    summaryBudget: Math.max(
      0,
      maxOutputCharacters - cost(kept) - notice.length - separator.length * 2,
    ),
  };
}

/** Assembles the plan's output: task, omission notice + summary, kept messages, in order. */
export function assembleHandoffCompaction(
  plan: HandoffCompactionPlan,
  summary: string,
  maxOutputCharacters: number,
): string {
  const sections: Array<string> = [];
  const [first, ...rest] = plan.kept;
  const openingTask = first?.role === "task" ? first : undefined;
  if (openingTask) sections.push(openingTask.text);
  if (plan.omitted.length > 0) {
    const notice = omissionNotice(plan.omitted.length);
    sections.push(summary ? `${notice}\n${summary}` : notice);
  }
  for (const unit of openingTask ? rest : plan.kept) sections.push(unit.text);
  const output = sections.join("\n\n");
  // The plan sizes verbatim units and the summary budget so this holds; the
  // slice only guards a pinned newest message larger than the whole budget.
  return output.length > maxOutputCharacters
    ? output.slice(output.length - maxOutputCharacters)
    : output;
}

const summarizeWithLocalModel = Effect.fn("summarizeWithLocalModel")(function* (input: {
  readonly text: string;
  readonly heading: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly systemPrompt: string;
  readonly maxOutputCharacters: number;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMillis: number;
}): Effect.fn.Return<string, never, never> {
  // ~4 chars/token heuristic for prompt + text + reply, rounded up to 1k and
  // clamped so a large input budget cannot blow up local VRAM use.
  const estimatedTokens =
    Math.ceil((input.text.length + input.systemPrompt.length + input.maxOutputCharacters) / 4) +
    512;
  const numCtx = Math.min(
    LOCAL_SUMMARY_MAX_NUM_CTX,
    Math.max(2_048, Math.ceil(estimatedTokens / 1_024) * 1_024),
  );
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await input.fetchFn(`${input.baseUrl}/api/chat`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        // Ollama's /api/chat body is a fixed vendor shape, not a domain schema.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: JSON.stringify({
          model: input.model,
          stream: false,
          // Handoffs cluster within a work session but rarely land twice in
          // two minutes, so a short keep_alive made nearly every handoff pay
          // the model cold-load inside the user's send. Half an hour keeps
          // the compressor warm across a session.
          keep_alive: "30m",
          options: { num_ctx: numCtx },
          messages: [
            {
              role: "system",
              content: `${input.systemPrompt}\nMaximum length: ${Math.floor(input.maxOutputCharacters * SUMMARY_ASK_SHARE)} characters.`,
            },
            { role: "user", content: `--- ${input.heading} ---\n${input.text}` },
          ],
        }),
      });
      if (!response.ok) {
        throw new LocalHandoffCompressionError({
          detail: `Local compression model responded with status ${response.status}.`,
        });
      }
      const payload = (await response.json()) as { message?: { content?: unknown } } | null;
      const content = payload?.message?.content;
      return typeof content === "string" ? content.trim() : "";
    },
    catch: (cause) =>
      cause instanceof LocalHandoffCompressionError
        ? cause
        : new LocalHandoffCompressionError({ detail: String(cause) }),
  }).pipe(
    Effect.timeout(input.timeoutMillis),
    Effect.catch((error) =>
      Effect.logWarning("handoff.compression.fallback", {
        model: input.model,
        reason: String(error),
      }).pipe(Effect.as("")),
    ),
    Effect.map((summary) =>
      summary.length > input.maxOutputCharacters
        ? summary.slice(0, input.maxOutputCharacters)
        : summary,
    ),
  );
});

/**
 * Scores every judgeable unit with the local judge. Fails as a whole when the
 * judge is unavailable or any answer is unusable — a partially judged plan
 * would silently rank unjudged messages against judged ones.
 */
const judgeHandoffUnits = Effect.fn("judgeHandoffUnits")(function* (input: {
  readonly units: ReadonlyArray<HandoffUnit>;
  readonly model: string;
  readonly judgeBaseUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMillis: number;
}): Effect.fn.Return<ReadonlyMap<number, number>, LocalJudgeError> {
  const task = input.units.find((unit) => unit.role === "task");
  const content = input.units.filter((unit) => unit.role !== "marker");
  const originalTask = (task ?? content[0])?.text.slice(0, MAX_TASK_STATE_CHARACTERS) ?? "";
  const judgeable = content.filter((unit) => unit.role !== "task").slice(-MAX_JUDGED_UNITS);
  const scores = new Map<number, number>();
  const results = yield* Effect.forEach(
    judgeable,
    (unit) =>
      askLocalJudge({
        state: {
          original_task: originalTask,
          position: `${unit.index + 1} of ${input.units.length}`,
          message: unit.text.slice(0, MAX_JUDGED_UNIT_CHARACTERS),
        },
        questions: { keep: HANDOFF_UNIT_KEEP_QUESTION },
        model: input.model,
        baseUrl: input.judgeBaseUrl,
        fetchFn: input.fetchFn,
        timeoutMillis: input.timeoutMillis,
      }).pipe(Effect.map((result) => [unit.index, result.answers.keep.score] as const)),
    { concurrency: LOCAL_JUDGE_CONCURRENCY },
  );
  for (const [index, score] of results) scores.set(index, score);
  return scores;
});

/**
 * Compacts a handoff transcript with the local model stack. The judge scores
 * each message for the next agent; essential messages travel verbatim, useful
 * background is summarized into the remaining budget, filler is dropped. Total
 * by design: a judge failure degrades to a whole-transcript summary, and a
 * summary failure degrades to plain structured truncation, so a handoff never
 * blocks on the local model.
 */
export const compressHandoffContextLocal = Effect.fn("compressHandoffContextLocal")(function* (
  input: CompressHandoffContextLocalInput,
): Effect.fn.Return<string, never, never> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const baseUrl = (input.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const transcript = input.transcript.slice(0, input.maxInputCharacters).trim();
  const systemPrompt = input.customPrompt.trim() || DEFAULT_COMPRESSION_PROMPT;
  const timeoutMillis = input.timeoutMillis ?? LOCAL_COMPRESSION_TIMEOUT_MILLIS;
  const judgeTimeoutMillis = input.judgeTimeoutMillis ?? JUDGE_STAGE_TIMEOUT_MILLIS;
  // Nothing beats the real words when they fit.
  if (transcript.length <= input.maxOutputCharacters) return transcript;

  const units = splitHandoffTranscript(transcript);
  const judgeable = units.filter((unit) => unit.role !== "marker" && unit.role !== "task");
  const scores =
    judgeable.length >= MIN_UNITS_FOR_JUDGMENT
      ? yield* judgeHandoffUnits({
          units,
          model: input.model,
          judgeBaseUrl: (input.judgeBaseUrl ?? DEFAULT_LOCAL_JUDGE_BASE_URL).replace(/\/$/, ""),
          fetchFn,
          timeoutMillis: judgeTimeoutMillis,
        }).pipe(
          Effect.timeout(judgeTimeoutMillis),
          Effect.catch((error) =>
            Effect.logWarning("handoff.compression.judge.fallback", {
              model: input.model,
              reason: String(error),
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;

  if (scores) {
    const plan = planHandoffCompaction(units, scores, input.maxOutputCharacters);
    const summary =
      plan.omitted.length > 0 && plan.summaryBudget >= MIN_SUMMARY_BUDGET
        ? yield* summarizeWithLocalModel({
            text: plan.omitted.map((unit) => unit.text).join("\n\n"),
            heading: "OMITTED TRANSCRIPT PARTS (the essential messages travel verbatim elsewhere)",
            model: input.model,
            baseUrl,
            systemPrompt,
            maxOutputCharacters: plan.summaryBudget,
            fetchFn,
            timeoutMillis,
          })
        : "";
    return assembleHandoffCompaction(plan, summary, input.maxOutputCharacters);
  }

  const compressed = yield* summarizeWithLocalModel({
    text: transcript,
    heading: "TRANSCRIPT",
    model: input.model,
    baseUrl,
    systemPrompt,
    maxOutputCharacters: input.maxOutputCharacters,
    fetchFn,
    timeoutMillis,
  });
  return compressed || truncateHandoffTranscript(transcript, input.maxOutputCharacters);
});

export interface CompressHandoffContextInput {
  readonly transcript: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly maxOutputCharacters: number;
  readonly customPrompt: string;
  readonly cwd: string;
}

export class HandoffCompressionError extends Data.TaggedError("HandoffCompressionError")<{
  readonly detail: string;
}> {}

export const compressHandoffContext = Effect.fn("compressHandoffContext")(function* (
  input: CompressHandoffContextInput,
) {
  const registry = yield* ProviderAdapterRegistry;
  const adapter = yield* registry.getByInstance(input.instanceId).pipe(
    Effect.mapError(
      (cause) =>
        new HandoffCompressionError({
          detail: `Provider '${input.instanceId}' unavailable: ${cause.message}`,
        }),
    ),
  );

  const systemPrompt = input.customPrompt.trim() || DEFAULT_COMPRESSION_PROMPT;
  const turnInput = [
    systemPrompt,
    `Maximum length: ${input.maxOutputCharacters} characters.`,
    "",
    "--- TRANSCRIPT ---",
    input.transcript,
  ].join("\n");

  const sequence = yield* Effect.sync(() => {
    handoffCompressionSequence += 1;
    return handoffCompressionSequence;
  });
  const threadId = ThreadId.make(`handoff-compress-${yield* Clock.currentTimeMillis}-${sequence}`);

  const compressed = yield* Effect.gen(function* () {
    yield* adapter
      .startSession({
        threadId,
        provider: adapter.provider,
        cwd: input.cwd,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: input.instanceId, model: input.model },
      })
      .pipe(
        // The turn timeout below cannot help if the startup handshake itself
        // hangs — bound it separately so a wedged provider CLI cannot hold
        // /api/handoff/prepare open forever.
        Effect.timeout(PROVIDER_COMPRESSION_TIMEOUT_MILLIS),
        Effect.mapError(
          (cause) =>
            new HandoffCompressionError({
              detail: `Failed to start compression session: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );

    return yield* adapter
      .sendTurn({
        threadId,
        input: turnInput,
        attachments: [],
        modelSelection: { instanceId: input.instanceId, model: input.model },
      })
      .pipe(
        Effect.flatMap(() => adapter.readThread(threadId)),
        Effect.map((thread) => {
          const lastTurn = thread.turns[thread.turns.length - 1];
          if (!lastTurn) return "";
          return lastTurn.items
            .map((item) => {
              if (typeof item === "string") return item;
              if (typeof item === "object" && item !== null && "text" in item) {
                return String((item as { text: unknown }).text);
              }
              return "";
            })
            .join("")
            .trim();
        }),
        Effect.timeout(PROVIDER_COMPRESSION_TIMEOUT_MILLIS),
        Effect.mapError(
          (cause) =>
            new HandoffCompressionError({
              detail: `Compression turn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
  }).pipe(
    // Cleanup covers startup failures and startup timeouts as well as turn
    // failures. A timed-out CLI handshake may have spawned a process before
    // its promise was interrupted.
    Effect.ensuring(
      adapter
        .stopSession(threadId)
        .pipe(Effect.timeout(SESSION_STOP_TIMEOUT_MILLIS), Effect.ignore),
    ),
  );

  if (!compressed) {
    return yield* new HandoffCompressionError({
      detail: "Empty response from compression provider.",
    });
  }

  return compressed.length > input.maxOutputCharacters
    ? compressed.slice(0, input.maxOutputCharacters)
    : compressed;
});

/**
 * Provider-session compression that can never make a handoff fail: it bounds
 * {@link compressHandoffContext} by {@link PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS},
 * logs the failure cause, and on any recoverable failure — a provider error or
 * a timeout, both of which surface on the Fail channel — resolves to a
 * deterministic truncation of `clipped`. A defect (Die) still propagates: the
 * only known source is malformed adapter output, which every adapter's typed
 * `readThread` snapshot rules out. `clipped` is the already-input-clipped
 * transcript so the fallback honours the same input budget as compression.
 */
export const compressHandoffContextWithFallback = (
  input: CompressHandoffContextInput & { readonly clipped: string },
): Effect.Effect<string, never, ProviderAdapterRegistry> =>
  compressHandoffContext(input).pipe(
    Effect.timeout(PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS),
    Effect.tapCause((cause) =>
      Effect.logWarning("Provider handoff compression failed; using transcript fallback", {
        instanceId: input.instanceId,
        reasonTags: cause.reasons.map((reason) =>
          Cause.isFailReason(reason) ? "Fail" : Cause.isDieReason(reason) ? "Die" : "Interrupt",
        ),
      }),
    ),
    Effect.orElseSucceed(() => truncateHandoffTranscript(input.clipped, input.maxOutputCharacters)),
  );
