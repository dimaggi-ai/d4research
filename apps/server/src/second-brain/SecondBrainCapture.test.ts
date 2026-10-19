import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ThreadId, SecondBrainError, type OrchestrationV2TurnItem } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Capture from "./SecondBrainCapture.ts";
import * as Brain from "./SecondBrainService.ts";
import * as Index from "./SecondBrainIndex.ts";
import { withBrain } from "./testkit.ts";

const candidate = {
  title: "Concise answers",
  kind: "note",
  content: "The user prefers concise answers.",
  messageId: "user-1",
  quote: "I prefer concise answers.",
};
function scenario(
  output: string,
  verify: (
    job: Index.CaptureJob,
    requests: string[],
  ) => Effect.Effect<
    void,
    SecondBrainError,
    Capture.SecondBrainCapture | Brain.SecondBrainService | Index.SecondBrainIndex
  >,
) {
  return withBrain(() =>
    Effect.gen(function* () {
      const requests: string[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          vi.stubGlobal(
            "fetch",
            vi.fn((_url, options) => {
              requests.push(String(options.body));
              return Promise.resolve(
                new Response(JSON.stringify({ message: { content: output } })),
              );
            }),
          );
        }),
        () => Effect.sync(() => vi.unstubAllGlobals()),
      );
      return yield* Effect.gen(function* () {
        const capture = yield* Capture.SecondBrainCapture;
        const job = yield* capture.enqueue(ThreadId.make("thread"));
        expect(job.messages[0]?.text).toContain("[REDACTED]");
        expect(job.messages).toHaveLength(1);
        yield* verify(job, requests);
      }).pipe(
        Effect.provide(
          Capture.layer.pipe(
            Layer.provide(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadRecords: () =>
                  Effect.succeed({
                    runs: [
                      { id: "rolled", status: "rolled_back", ordinal: 1 },
                      { id: "cancelled", status: "cancelled", ordinal: 2 },
                    ],
                    attempts: [],
                  } as never),
                getTurnStartHistory: () =>
                  Effect.succeed([
                    {
                      type: "user_message",
                      id: "item-1",
                      messageId: "user-1",
                      runId: null,
                      text: "I prefer concise answers. API_KEY=abcdefghijklmnopqrstuvwxyz\nBearer abcdefghijklmnopqrstuvwxyz",
                    },
                    { type: "reasoning", id: "hidden", text: "Never extract hidden reasoning" },
                    {
                      type: "user_message",
                      id: "rolled-item",
                      messageId: "rolled-message",
                      runId: "rolled",
                      text: "Rolled-back fact",
                    },
                    {
                      type: "user_message",
                      id: "cancelled-item",
                      messageId: "cancelled-message",
                      runId: "cancelled",
                      inputIntent: "queued_turn",
                      text: "Cancelled input",
                    },
                  ] as unknown as OrchestrationV2TurnItem[]),
              }),
            ),
          ),
        ),
      );
    }),
  );
}
it.effect("valid local output produces validated proposals and idempotent completed jobs", () =>
  scenario(JSON.stringify({ candidates: [candidate] }), (job, requests) =>
    Effect.gen(function* () {
      const capture = yield* Capture.SecondBrainCapture;
      const brain = yield* Brain.SecondBrainService;
      const ids = yield* capture.process(job);
      expect(ids).toHaveLength(1);
      expect((yield* brain.getProposal(ids[0]!)).evidence).toEqual([
        { threadId: "thread", messageId: "user-1", quote: candidate.quote },
      ]);
      expect(yield* capture.process(job)).toEqual(ids);
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(requests[0]).toContain('"format":{"type":"object"');
      expect((yield* (yield* Index.SecondBrainIndex).enqueueCapture(job)).state).toBe("completed");
    }),
  ),
);
it.effect("malformed JSON creates no proposals and marks the durable job failed", () =>
  scenario("broken", (job) =>
    Effect.gen(function* () {
      const capture = yield* Capture.SecondBrainCapture;
      expect((yield* capture.process(job).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* (yield* Brain.SecondBrainService).listProposals({})).toEqual([]);
      expect((yield* (yield* Index.SecondBrainIndex).enqueueCapture(job)).state).toBe("failed");
    }),
  ),
);
it.effect("hallucinated or redacted evidence is dropped", () =>
  scenario(
    JSON.stringify({
      candidates: [
        { ...candidate, quote: "The user never said this." },
        { ...candidate, quote: "[REDACTED]" },
      ],
    }),
    (job) =>
      Effect.gen(function* () {
        expect(yield* (yield* Capture.SecondBrainCapture).process(job)).toEqual([]);
        expect(yield* (yield* Brain.SecondBrainService).listProposals({})).toEqual([]);
      }),
  ),
);
