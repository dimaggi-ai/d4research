import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Local System One judge: a TypeSafe-shaped question API (Choice, Noul, Score)
 * answered by the resident Bonsai 2 model instead of the hosted `jev` model.
 *
 * Each question becomes one single-token completion whose options are lettered
 * A, B, C… The first-token `top_logprobs` over those letters, renormalised, is
 * the answer distribution. Nothing is generated or explained, so a question
 * costs one prompt evaluation and one token, and answers are probabilities the
 * caller can threshold in code. When the endpoint returns no logprobs (plain
 * Ollama, or the bonsai2 gateway on :11434 which rebuilds replies from the
 * stream) the emitted letter becomes a one-hot answer instead.
 */

/** llama.cpp server behind `bonsai2.service`; the only local endpoint that returns logprobs. */
export const DEFAULT_LOCAL_JUDGE_BASE_URL = "http://127.0.0.1:8094";
export const DEFAULT_LOCAL_JUDGE_MODEL = "bonsai2-27b:latest";
/** The bonsai2 server exposes three slots; more in flight only queues. */
export const LOCAL_JUDGE_CONCURRENCY = 3;
const LOCAL_JUDGE_TIMEOUT_MILLIS = 20_000;
const MAX_OPTIONS = 26;

const JUDGE_SYSTEM_PROMPT =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation.";

export type LocalJudgeInstructions = string | Record<string, unknown> | ReadonlyArray<unknown>;

export type LocalJudgeQuestion =
  | {
      readonly type: "choice";
      readonly instructions: LocalJudgeInstructions;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: LocalJudgeInstructions;
      readonly criteria?: { readonly true?: string; readonly false?: string };
    }
  | {
      readonly type: "score";
      readonly instructions: LocalJudgeInstructions;
      readonly criteria: ReadonlyArray<string>;
    };

export type LocalJudgeAnswer =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "score";
      readonly score: number;
      readonly legend: Readonly<Record<string, string>>;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

export interface LocalJudgeResult<Q extends Record<string, LocalJudgeQuestion>> {
  readonly answers: { readonly [K in keyof Q]: Extract<LocalJudgeAnswer, { type: Q[K]["type"] }> };
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly model: string;
}

export class LocalJudgeError extends Data.TaggedError("LocalJudgeError")<{
  readonly detail: string;
}> {}

export interface AskLocalJudgeInput<Q extends Record<string, LocalJudgeQuestion>> {
  readonly state: unknown;
  readonly questions: Q;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
}

interface LetterOption {
  readonly letter: string;
  readonly key: string;
  readonly description: string;
}

function optionsFor(question: LocalJudgeQuestion): ReadonlyArray<LetterOption> {
  const entries: Array<readonly [string, string]> =
    question.type === "choice"
      ? Object.entries(question.criteria).map(([key, description]) => [key, description ?? key])
      : question.type === "noul"
        ? [
            ["yes", question.criteria?.true ?? "yes"],
            ["no", question.criteria?.false ?? "no"],
          ]
        : question.criteria.map((description, index) => [String(index), description]);
  if (entries.length < 2 || entries.length > MAX_OPTIONS) {
    throw new LocalJudgeError({
      detail: `A ${question.type} question needs between 2 and ${MAX_OPTIONS} options, got ${entries.length}.`,
    });
  }
  return entries.map(([key, description], index) => ({
    letter: String.fromCharCode(65 + index),
    key,
    description,
  }));
}

/** Confidence as the margin between the winning option and its runner-up. */
function confidenceOf(probabilities: ReadonlyArray<number>): number {
  const sorted = [...probabilities].sort((a, b) => b - a);
  return Math.max(0, Math.min(1, (sorted[0] ?? 0) - (sorted[1] ?? 0)));
}

interface CompletionPayload {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown };
    readonly logprobs?: {
      readonly content?: ReadonlyArray<{
        readonly top_logprobs?: ReadonlyArray<{
          readonly token?: unknown;
          readonly logprob?: unknown;
        }>;
      }>;
    } | null;
  }>;
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
  readonly model?: unknown;
}

/**
 * Letter probabilities from one completion. Logprobs win when present; a bare
 * letter reply is one-hot. Anything else (the model answered off-menu) fails
 * so the caller can fall back rather than act on a made-up distribution.
 */
function letterProbabilities(
  payload: CompletionPayload,
  options: ReadonlyArray<LetterOption>,
): ReadonlyArray<number> {
  const choice = payload.choices?.[0];
  const top = choice?.logprobs?.content?.[0]?.top_logprobs;
  const mass = new Map<string, number>();
  if (top && top.length > 0) {
    for (const entry of top) {
      const token = typeof entry.token === "string" ? entry.token.trim().toUpperCase() : "";
      const logprob = typeof entry.logprob === "number" ? entry.logprob : Number.NEGATIVE_INFINITY;
      if (token.length === 1 && options.some((option) => option.letter === token)) {
        mass.set(token, (mass.get(token) ?? 0) + Math.exp(logprob));
      }
    }
  } else {
    const content =
      typeof choice?.message?.content === "string"
        ? choice.message.content.trim().toUpperCase()
        : "";
    const letter = content.slice(0, 1);
    if (options.some((option) => option.letter === letter)) mass.set(letter, 1);
  }
  const total = [...mass.values()].reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    throw new LocalJudgeError({ detail: "Judge reply did not name any listed option." });
  }
  return options.map((option) => (mass.get(option.letter) ?? 0) / total);
}

function toAnswer(
  question: LocalJudgeQuestion,
  options: ReadonlyArray<LetterOption>,
  probabilities: ReadonlyArray<number>,
): LocalJudgeAnswer {
  if (question.type === "noul") return { type: "noul", noul: probabilities[0] ?? 0 };
  const byKey: Record<string, number> = {};
  options.forEach((option, index) => {
    byKey[option.key] = probabilities[index] ?? 0;
  });
  const confidence = confidenceOf(probabilities);
  if (question.type === "choice") {
    let best = options[0]!;
    options.forEach((option, index) => {
      if ((probabilities[index] ?? 0) > (byKey[best.key] ?? 0)) best = option;
    });
    return { type: "choice", choice: best.key, probabilities: byKey, confidence };
  }
  const legend: Record<string, string> = {};
  options.forEach((option) => {
    legend[option.key] = option.description;
  });
  const score = probabilities.reduce((sum, probability, index) => sum + probability * index, 0);
  return { type: "score", score, legend, probabilities: byKey, confidence };
}

const askOne = Effect.fn("askLocalJudge.question")(function* (input: {
  readonly state: unknown;
  readonly question: LocalJudgeQuestion;
  readonly model: string;
  readonly url: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly timeoutMillis: number;
}) {
  const options = yield* Effect.try({
    try: () => optionsFor(input.question),
    catch: (cause) =>
      cause instanceof LocalJudgeError ? cause : new LocalJudgeError({ detail: String(cause) }),
  });
  const user = {
    evidence: input.state,
    criterion: input.question.instructions,
    options: options.map((option) => ({ letter: option.letter, description: option.description })),
  };
  // The judge reads the state as a JSON document inside the user turn; this is
  // prompt text for a vendor endpoint, not a domain schema.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const evidence = JSON.stringify(user);
  const payload = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await input.fetchFn(input.url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        // OpenAI-compatible completion body: a fixed vendor shape, not a domain schema.
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1,
          temperature: 0,
          logprobs: true,
          top_logprobs: 10,
          stream: false,
          // Bonsai 2 must answer from the prompt, not from a hidden reasoning
          // pass: thinking would spend the single token on "<think>".
          reasoning_effort: "none",
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: evidence },
          ],
        }),
      });
      if (!response.ok) {
        throw new LocalJudgeError({ detail: `Judge responded with status ${response.status}.` });
      }
      return (await response.json()) as CompletionPayload | null;
    },
    catch: (cause) =>
      cause instanceof LocalJudgeError ? cause : new LocalJudgeError({ detail: String(cause) }),
  }).pipe(
    Effect.timeout(input.timeoutMillis),
    Effect.mapError((cause) =>
      cause instanceof LocalJudgeError ? cause : new LocalJudgeError({ detail: String(cause) }),
    ),
  );
  if (!payload) return yield* new LocalJudgeError({ detail: "Judge returned an empty body." });
  const probabilities = yield* Effect.try({
    try: () => letterProbabilities(payload, options),
    catch: (cause) =>
      cause instanceof LocalJudgeError ? cause : new LocalJudgeError({ detail: String(cause) }),
  });
  const usage = payload.usage;
  return {
    answer: toAnswer(input.question, options, probabilities),
    inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
    model: typeof payload.model === "string" ? payload.model : input.model,
  };
});

/**
 * Asks independent typed questions over one state, in parallel, and returns
 * TypeSafe-shaped answers keyed like the questions. Fails with
 * {@link LocalJudgeError} when the endpoint is down or any reply is unusable;
 * callers decide whether that means "fall back" or "stop".
 */
export const askLocalJudge = Effect.fn("askLocalJudge")(function* <
  Q extends Record<string, LocalJudgeQuestion>,
>(input: AskLocalJudgeInput<Q>): Effect.fn.Return<LocalJudgeResult<Q>, LocalJudgeError> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const url = `${(input.baseUrl ?? DEFAULT_LOCAL_JUDGE_BASE_URL).replace(/\/$/, "")}/v1/chat/completions`;
  const model = input.model ?? DEFAULT_LOCAL_JUDGE_MODEL;
  const timeoutMillis = input.timeoutMillis ?? LOCAL_JUDGE_TIMEOUT_MILLIS;
  const entries = Object.entries(input.questions) as Array<[keyof Q & string, LocalJudgeQuestion]>;
  const results = yield* Effect.forEach(
    entries,
    ([key, question]) =>
      askOne({ state: input.state, question, model, url, fetchFn, timeoutMillis }).pipe(
        Effect.map((result) => [key, result] as const),
      ),
    { concurrency: LOCAL_JUDGE_CONCURRENCY },
  );
  const answers: Record<string, LocalJudgeAnswer> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedModel = model;
  for (const [key, result] of results) {
    answers[key] = result.answer;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    reportedModel = result.model;
  }
  return {
    answers: answers as LocalJudgeResult<Q>["answers"],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model: reportedModel,
  };
});
