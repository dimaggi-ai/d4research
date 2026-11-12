import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { summarizeForSpeech } from "./voiceSummary.ts";

function completionFetch(
  content: unknown,
  captured?: Array<Record<string, unknown>>,
  status = 200,
): typeof globalThis.fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    captured?.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }),
    );
  }) as typeof globalThis.fetch;
}

describe("summarizeForSpeech", () => {
  it.effect("asks Gemma without a hidden reasoning pass and returns plain speech", () =>
    Effect.gen(function* () {
      const captured: Array<Record<string, unknown>> = [];
      const summary = yield* summarizeForSpeech({
        text: "## Done\n\n```ts\nconst a = 1;\n```",
        fetchFn: completionFetch("<think>x</think>**I fixed** the `orchestrator` bug.", captured),
      });
      expect(summary).toBe("I fixed the orchestrator bug.");
      expect(captured[0]!["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    }),
  );

  it.effect("fails when the model spends its budget without answering", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        summarizeForSpeech({ text: "Long reply", fetchFn: completionFetch("") }),
      );
      expect(error._tag).toBe("VoiceSummaryError");
    }),
  );

  it.effect("ends a clipped summary on a sentence boundary", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeForSpeech({
        text: "Long reply",
        fetchFn: completionFetch(`First sentence. ${"word ".repeat(200)}`),
      });
      expect(summary).toBe("First sentence.");
    }),
  );
});
