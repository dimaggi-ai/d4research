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
        { ...candidate, quote: "[REDACTED] token" },
      ],
    }),
    (job) =>
      Effect.gen(function* () {
        expect(yield* (yield* Capture.SecondBrainCapture).process(job)).toEqual([]);
        expect(yield* (yield* Brain.SecondBrainService).listProposals({})).toEqual([]);
      }),
  ),
);

it.effect("rejects short quotes and drops content unrelated to its evidence", () =>
  scenario(JSON.stringify({ candidates: [{ ...candidate, quote: "I" }] }), (job) =>
    Effect.gen(function* () {
      expect(
        (yield* (yield* Capture.SecondBrainCapture).process(job).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ).pipe(
    Effect.andThen(
      scenario(
        JSON.stringify({
          candidates: [{ ...candidate, content: "Always deploy PostgreSQL clusters overnight." }],
        }),
        (job) =>
          Effect.gen(function* () {
            expect(yield* (yield* Capture.SecondBrainCapture).process(job)).toEqual([]);
          }),
      ),
    ),
  ),
);

it.effect("deduplicates paraphrased candidates against pending proposals at the same path", () =>
  scenario(
    JSON.stringify({
      candidates: [
        candidate,
        { ...candidate, content: "Concise answers are what the user prefers." },
      ],
    }),
    (job) =>
      Effect.gen(function* () {
        const capture = yield* Capture.SecondBrainCapture;
        const brain = yield* Brain.SecondBrainService;
        expect(yield* capture.process(job)).toHaveLength(1);
        expect(yield* capture.process({ ...job, id: "next-job", runTo: 3 })).toEqual([]);
        expect(yield* brain.listProposals({})).toHaveLength(1);
      }),
  ),
);

it.effect(
  "keeps partial proposal ids on failure and bounds retries to three attempts with status counts",
  () =>
    scenario(
      JSON.stringify({
        candidates: [
          candidate,
          { ...candidate, title: "Short replies", content: "Concise answers save time." },
        ],
      }),
      (job, requests) =>
        Effect.gen(function* () {
          const brain = yield* Brain.SecondBrainService;
          const capture = yield* Capture.SecondBrainCapture;
          const index = yield* Index.SecondBrainIndex;
          expect((yield* brain.status()).captureJobs).toEqual({ pending: 1, failed: 0 });
          const original = brain.propose;
          const spy = vi
            .spyOn(brain, "propose")
            .mockImplementation((input, actor) =>
              input.path === "notes/short-replies.md"
                ? Effect.fail(new SecondBrainError({ code: "unavailable" }))
                : original(input, actor),
            );
          yield* Effect.gen(function* () {
            expect((yield* capture.process(job).pipe(Effect.result))._tag).toBe("Failure");
            const failed = yield* index.enqueueCapture(job);
            expect(failed.proposalIds).toHaveLength(1);
            expect(failed.attempts).toBe(1);
            expect((yield* brain.status()).captureJobs).toEqual({ pending: 0, failed: 1 });
            expect(yield* index.pendingCaptures()).toHaveLength(1);
            yield* capture.process(job).pipe(Effect.result);
            yield* capture.process(job).pipe(Effect.result);
            expect(yield* capture.process(job)).toEqual(failed.proposalIds);
            expect(requests).toHaveLength(3);
            expect(yield* index.pendingCaptures()).toEqual([]);
            expect((yield* index.enqueueCapture(job)).proposalIds).toEqual(failed.proposalIds);
          }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        }),
    ),
);

it.effect("captures only runs after the last completed capture for the thread and vault", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const index = yield* Index.SecondBrainIndex;
      yield* index.enqueueCapture({
        id: "previous",
        vault: root,
        threadId: "thread",
        runFrom: 1,
        runTo: 2,
        transcriptHash: "hash",
        version: "capture-v1",
        messages: [],
        state: "completed",
        proposalIds: [],
      });
      const requested: string[][] = [];
      yield* Effect.gen(function* () {
        const capture = yield* Capture.SecondBrainCapture;
        const job = yield* capture.enqueue(ThreadId.make("thread"), 3);
        expect(job.runFrom).toBe(3);
        expect(job.runTo).toBe(3);
        expect(requested).toEqual([["run-3"]]);
        expect(job.messages.map((m) => m.text)).toEqual(["Only the new run's durable fact."]);
      }).pipe(
        Effect.provide(
          Capture.layer.pipe(
            Layer.provide(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadRecords: () =>
                  Effect.succeed({
                    runs: [1, 2, 3, 4].map((ordinal) => ({
                      id: `run-${ordinal}`,
                      ordinal,
                      status: "completed",
                    })),
                    attempts: [],
                  } as never),
                getTurnStartHistory: (_thread, ids) => {
                  requested.push([...(ids ?? [])]);
                  return Effect.succeed([
                    {
                      type: "user_message",
                      id: "new",
                      messageId: "new",
                      runId: "run-3",
                      text: "Only the new run's durable fact.",
                    },
                  ] as unknown as OrchestrationV2TurnItem[]);
                },
              }),
            ),
          ),
        ),
      );
    }),
  ),
);
