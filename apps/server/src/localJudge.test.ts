import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { askLocalJudge, DEFAULT_LOCAL_JUDGE_BASE_URL, LocalJudgeError } from "./localJudge.ts";

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Answers every question with the given first-token top_logprobs. */
function logprobFetch(
  top: ReadonlyArray<{ token: string; logprob: number }>,
  captured?: Array<Captured>,
): typeof globalThis.fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured?.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: "bonsai2-27b",
          choices: [
            {
              message: { content: top[0]?.token ?? "" },
              logprobs: { content: [{ top_logprobs: top }] },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof globalThis.fetch;
}

const ln = Math.log;

describe("askLocalJudge", () => {
  it.effect("turns letter logprobs into a renormalised choice distribution", () =>
    Effect.gen(function* () {
      const captured: Array<Captured> = [];
      const result = yield* askLocalJudge({
        state: { ticket: "Payouts failing for 3 days" },
        questions: {
          department: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: { billing: "Payments and refunds", technical: "Bugs", sales: null },
          },
        },
        fetchFn: logprobFetch(
          [
            { token: "A", logprob: ln(0.6) },
            { token: "B", logprob: ln(0.2) },
            { token: "No", logprob: ln(0.1) },
          ],
          captured,
        ),
      });
      expect(result.answers.department.choice).toBe("billing");
      expect(result.answers.department.probabilities.billing).toBeCloseTo(0.75, 5);
      expect(result.answers.department.probabilities.technical).toBeCloseTo(0.25, 5);
      expect(result.answers.department.probabilities.sales).toBe(0);
      expect(result.answers.department.confidence).toBeCloseTo(0.5, 5);
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 1 });
      expect(result.model).toBe("bonsai2-27b");

      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe(`${DEFAULT_LOCAL_JUDGE_BASE_URL}/v1/chat/completions`);
      expect(captured[0]!.body["max_tokens"]).toBe(1);
      expect(captured[0]!.body["logprobs"]).toBe(true);
      expect(captured[0]!.body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
      const messages = captured[0]!.body["messages"] as Array<{ role: string; content: string }>;
      // The judge's user turn is a JSON document authored for the model, not a schema.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const evidence = JSON.parse(messages[1]!.content) as {
        options: Array<{ letter: string; description: string }>;
      };
      expect(evidence.options.map((option) => option.letter)).toEqual(["A", "B", "C"]);
      // A null rubric falls back to the option key so the letter still means something.
      expect(evidence.options[2]!.description).toBe("sales");
    }),
  );

  it.effect("answers noul as the probability of yes and score as the weighted level", () =>
    Effect.gen(function* () {
      const result = yield* askLocalJudge({
        state: "ASSISTANT: fixed in apps/server/src/http.ts",
        questions: {
          urgent: { type: "noul", instructions: "Is this urgent?" },
          importance: {
            type: "score",
            instructions: "How important is this?",
            criteria: ["Skip", "Summarize", "Keep"],
          },
        },
        fetchFn: logprobFetch([
          { token: "B", logprob: ln(0.7) },
          { token: "A", logprob: ln(0.3) },
        ]),
      });
      expect(result.answers.urgent.noul).toBeCloseTo(0.3, 5);
      expect(result.answers.importance.score).toBeCloseTo(0.7, 5);
      expect(result.answers.importance.legend).toEqual({
        "0": "Skip",
        "1": "Summarize",
        "2": "Keep",
      });
      expect(result.answers.importance.probabilities["2"]).toBe(0);
      expect(result.usage.input_tokens).toBe(200);
    }),
  );

  it.effect("falls back to a one-hot answer when the endpoint returns no logprobs", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "c" } }] }), {
            status: 200,
          }),
        )) as typeof globalThis.fetch;
      const result = yield* askLocalJudge({
        state: "x",
        questions: {
          level: { type: "score", instructions: "?", criteria: ["low", "mid", "high"] },
        },
        fetchFn,
      });
      expect(result.answers.level.score).toBe(2);
      expect(result.answers.level.confidence).toBe(1);
    }),
  );

  it.effect("fails instead of guessing when the model answers off-menu", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        askLocalJudge({
          state: "x",
          questions: { yes: { type: "noul", instructions: "?" } },
          fetchFn: logprobFetch([{ token: "Maybe", logprob: 0 }]),
        }),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(
          exit.cause.reasons.some(
            (reason) => "error" in reason && reason.error instanceof LocalJudgeError,
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect("fails when the endpoint is down or answers with an error status", () =>
    Effect.gen(function* () {
      const down = yield* Effect.exit(
        askLocalJudge({
          state: "x",
          questions: { yes: { type: "noul", instructions: "?" } },
          fetchFn: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch,
        }),
      );
      expect(down._tag).toBe("Failure");
      const status = yield* Effect.exit(
        askLocalJudge({
          state: "x",
          questions: { yes: { type: "noul", instructions: "?" } },
          fetchFn: (() =>
            Promise.resolve(new Response("{}", { status: 503 }))) as typeof globalThis.fetch,
        }),
      );
      expect(status._tag).toBe("Failure");
    }),
  );
});
