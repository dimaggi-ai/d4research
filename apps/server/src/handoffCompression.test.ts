import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@d4research/contracts";

import type { ProviderAdapterError } from "./provider/Errors.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";
import {
  assembleHandoffCompaction,
  compressHandoffContext,
  compressHandoffContextLocal,
  compressHandoffContextWithFallback,
  HandoffCompressionError,
  planHandoffCompaction,
  PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS,
  splitHandoffTranscript,
  truncateHandoffTranscript,
} from "./handoffCompression.ts";

const MOCK_PROVIDER = ProviderDriverKind.make("mock");
const MOCK_INSTANCE = ProviderInstanceId.make("mock-compressor");

function makeMockAdapter(
  responseText: string,
  options?: { readonly failStart?: boolean; readonly hangTurn?: boolean },
) {
  const sessions = new Map<string, { turns: Array<{ id: string; items: unknown[] }> }>();
  const stopCalls: string[] = [];
  return {
    provider: MOCK_PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" as const },
    startSession: (input: { threadId: unknown }) =>
      options?.failStart
        ? Effect.fail({ detail: "startup failed" } as never)
        : Effect.sync(() => {
            sessions.set(String(input.threadId), { turns: [] });
            return {
              provider: MOCK_PROVIDER,
              providerInstanceId: MOCK_INSTANCE,
              threadId: input.threadId as ReturnType<typeof ThreadId.make>,
              cwd: "/tmp",
              runtimeMode: "approval-required" as const,
              status: "ready" as const,
              model: "test-model",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            };
          }),
    sendTurn: (input: { threadId: unknown; input?: string }) =>
      options?.hangTurn
        ? Effect.never
        : Effect.sync(() => {
            const session = sessions.get(String(input.threadId));
            if (session) {
              session.turns.push({
                id: "turn-1",
                items: [{ text: responseText }],
              });
            }
            return {
              threadId: input.threadId as ReturnType<typeof ThreadId.make>,
              turnId: TurnId.make("turn-1"),
            };
          }),
    readThread: (threadId: unknown) =>
      Effect.sync(() => {
        const session = sessions.get(String(threadId));
        return {
          threadId: threadId as ReturnType<typeof ThreadId.make>,
          turns: (session?.turns ?? []).map((t) => ({
            id: TurnId.make(t.id),
            items: t.items,
          })),
        };
      }),
    stopSession: (threadId: unknown) =>
      Effect.sync(() => {
        stopCalls.push(String(threadId));
        sessions.delete(String(threadId));
      }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    rollbackThread: () => Effect.void,
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
    stopCalls,
  };
}

function registryLayer(responseText: string) {
  const adapter = makeMockAdapter(responseText);
  return Layer.succeed(ProviderAdapterRegistry, {
    getByInstance: (instanceId: ProviderInstanceId) =>
      instanceId === MOCK_INSTANCE
        ? Effect.succeed(adapter as unknown as ProviderAdapterShape<ProviderAdapterError>)
        : Effect.fail({
            _tag: "ProviderUnsupportedError" as const,
            message: `No instance: ${instanceId}`,
          } as never),
    getInstanceInfo: () => Effect.die("not implemented"),
    listInstances: () => Effect.succeed([MOCK_INSTANCE]),
    listProviders: () => Effect.succeed([MOCK_PROVIDER]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("not implemented"),
  });
}

function singleAdapterRegistryLayer(adapter: ReturnType<typeof makeMockAdapter>) {
  return Layer.succeed(ProviderAdapterRegistry, {
    getByInstance: () =>
      Effect.succeed(adapter as unknown as ProviderAdapterShape<ProviderAdapterError>),
    getInstanceInfo: () => Effect.die("not implemented"),
    listInstances: () => Effect.succeed([MOCK_INSTANCE]),
    listProviders: () => Effect.succeed([MOCK_PROVIDER]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("not implemented"),
  });
}

describe("compressHandoffContext", () => {
  it.effect("attempts cleanup when compression-session startup fails", () => {
    const adapter = makeMockAdapter("unused", { failStart: true });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(
        compressHandoffContext({
          transcript: "test",
          instanceId: MOCK_INSTANCE,
          model: "test-model",
          maxOutputCharacters: 5000,
          customPrompt: "",
          cwd: "/tmp",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(adapter.stopCalls).toHaveLength(1);
      expect(adapter.stopCalls[0]).toMatch(/^handoff-compress-/);
    }).pipe(
      Effect.provide(
        Layer.succeed(ProviderAdapterRegistry, {
          getByInstance: () =>
            Effect.succeed(adapter as unknown as ProviderAdapterShape<ProviderAdapterError>),
          getInstanceInfo: () => Effect.die("not implemented"),
          listInstances: () => Effect.succeed([MOCK_INSTANCE]),
          listProviders: () => Effect.succeed([MOCK_PROVIDER]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("not implemented"),
        }),
      ),
    );
  });

  it.effect("uses distinct temporary sessions for concurrent handoffs", () => {
    const adapter = makeMockAdapter("Compressed context summary.");
    return Effect.gen(function* () {
      const results = yield* Effect.all(
        [1, 2].map(() =>
          compressHandoffContext({
            transcript: "test",
            instanceId: MOCK_INSTANCE,
            model: "test-model",
            maxOutputCharacters: 5000,
            customPrompt: "",
            cwd: "/tmp",
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(results).toEqual(["Compressed context summary.", "Compressed context summary."]);
      expect(new Set(adapter.stopCalls).size).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.succeed(ProviderAdapterRegistry, {
          getByInstance: () =>
            Effect.succeed(adapter as unknown as ProviderAdapterShape<ProviderAdapterError>),
          getInstanceInfo: () => Effect.die("not implemented"),
          listInstances: () => Effect.succeed([MOCK_INSTANCE]),
          listProviders: () => Effect.succeed([MOCK_PROVIDER]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("not implemented"),
        }),
      ),
    );
  });

  it.effect("compresses transcript through a mock adapter", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContext({
        transcript: "USER: What is 2+2?\nASSISTANT: The answer is 4.",
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      });
      expect(result).toBe("Compressed context summary.");
    }).pipe(Effect.provide(registryLayer("Compressed context summary."))),
  );

  it.effect("truncates output to maxOutputCharacters", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContext({
        transcript: "long transcript",
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 10,
        customPrompt: "",
        cwd: "/tmp",
      });
      expect(result.length).toBe(10);
    }).pipe(Effect.provide(registryLayer("A".repeat(100)))),
  );

  it.effect("uses custom prompt when provided", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContext({
        transcript: "test",
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "Custom summarization instruction.",
        cwd: "/tmp",
      });
      expect(result).toBe("custom result");
    }).pipe(Effect.provide(registryLayer("custom result"))),
  );

  it.effect("fails with HandoffCompressionError on empty response", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContext({
        transcript: "test",
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      }).pipe(Effect.flip);
      expect(result).toBeInstanceOf(HandoffCompressionError);
      expect(result.detail).toContain("Empty response");
    }).pipe(Effect.provide(registryLayer(""))),
  );

  it.effect("fails when provider instance is not registered", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContext({
        transcript: "test",
        instanceId: ProviderInstanceId.make("nonexistent"),
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      }).pipe(Effect.flip);
      expect(result).toBeInstanceOf(HandoffCompressionError);
      expect(result.detail).toContain("unavailable");
    }).pipe(Effect.provide(registryLayer("anything"))),
  );
});

describe("compressHandoffContextWithFallback", () => {
  it.effect("falls back to the transcript when the provider fails", () =>
    Effect.gen(function* () {
      // Empty provider output fails compressHandoffContext on the Fail channel;
      // the handoff must still resolve to the (short) transcript, never error.
      const transcript = "USER: ship it\nASSISTANT: done";
      const result = yield* compressHandoffContextWithFallback({
        transcript,
        clipped: transcript,
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      });
      expect(result).toBe(transcript);
    }).pipe(Effect.provide(registryLayer(""))),
  );

  it.effect("falls back to the transcript when the compression session cannot start", () => {
    const adapter = makeMockAdapter("unused", { failStart: true });
    const transcript = "keep this verbatim";
    return Effect.gen(function* () {
      const result = yield* compressHandoffContextWithFallback({
        transcript,
        clipped: transcript,
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      });
      expect(result).toBe(transcript);
    }).pipe(Effect.provide(singleAdapterRegistryLayer(adapter)));
  });

  it.effect("never blocks the handoff: a hung provider times out to the transcript", () => {
    const adapter = makeMockAdapter("unused", { hangTurn: true });
    const transcript = "hung provider transcript";
    return Effect.gen(function* () {
      const fiber = yield* compressHandoffContextWithFallback({
        transcript,
        clipped: transcript,
        instanceId: MOCK_INSTANCE,
        model: "test-model",
        maxOutputCharacters: 5000,
        customPrompt: "",
        cwd: "/tmp",
      }).pipe(Effect.forkScoped);
      // Past the handoff timeout the attempt is interrupted and the truncated
      // transcript stands in — the user is never left waiting on a wedged CLI.
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS + 1_000));
      const result = yield* Fiber.join(fiber);
      expect(result).toBe(transcript);
      // Cleanup still runs on the interrupted attempt.
      expect(adapter.stopCalls).toHaveLength(1);
    }).pipe(Effect.provide(singleAdapterRegistryLayer(adapter)));
  });
});

function jsonFetch(payload: unknown, status = 200): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
}

/**
 * Routes judge calls (`/v1/chat/completions`) and summary calls (`/api/chat`)
 * to separate handlers so a test can script each stage of the compaction.
 */
interface StackCall {
  readonly kind: "judge" | "summary";
  readonly body: Record<string, unknown>;
}

function stackFetch(handlers: {
  readonly judge?: (evidence: { message: string; position: string }) => number | Error;
  readonly summary?: (text: string) => string | Error;
  readonly calls?: Array<StackCall>;
}): typeof globalThis.fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    if (String(url).endsWith("/v1/chat/completions")) {
      handlers.calls?.push({ kind: "judge", body });
      const evidence = JSON.parse(messages[1]!.content) as {
        evidence: { message: string; position: string };
      };
      const level = handlers.judge?.(evidence.evidence) ?? 2;
      if (level instanceof Error) return Promise.reject(level);
      const letter = String.fromCharCode(65 + level);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: letter },
                logprobs: { content: [{ top_logprobs: [{ token: letter, logprob: 0 }] }] },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    handlers.calls?.push({ kind: "summary", body });
    const text = messages[1]!.content;
    const summary = handlers.summary?.(text) ?? "SUMMARY";
    if (summary instanceof Error) return Promise.reject(summary);
    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: summary } }), { status: 200 }),
    );
  }) as typeof globalThis.fetch;
}

const LONG_TRANSCRIPT = [
  "USER (original task): Fix the login redirect loop in apps/web/src/auth.ts",
  "[... earlier conversation compressed/omitted ...]",
  "ASSISTANT: Hi! Happy to help with that.",
  `ASSISTANT: I explored the router setup for a while. ${"Details of the exploration. ".repeat(20)}`,
  "USER: Do not touch the session cookie name; it is shared with the mobile app.",
  "ASSISTANT: Root cause: auth.ts line 42 redirects before the token refresh resolves. Error: TypeError: token is undefined.",
  "USER: Ok, fix it and run the auth tests.",
].join("\n\n");

describe("splitHandoffTranscript", () => {
  it("splits on role labels only, keeping blank lines inside a message", () => {
    const units = splitHandoffTranscript(
      "USER (original task): do it\n\n[... earlier conversation compressed/omitted ...]\n\nASSISTANT: first paragraph\n\nsecond paragraph\n\nUSER: thanks",
    );
    expect(units.map((unit) => unit.role)).toEqual(["task", "marker", "assistant", "user"]);
    expect(units[2]!.text).toBe("ASSISTANT: first paragraph\n\nsecond paragraph");
  });
});

describe("planHandoffCompaction", () => {
  const units = splitHandoffTranscript(LONG_TRANSCRIPT);
  const scores = new Map<number, number>([
    [2, 0.1], // greeting
    [3, 1.0], // exploration
    [4, 1.9], // constraint from the user
    [5, 2.0], // root cause
  ]);

  it("keeps every non-filler unit verbatim when they fit and drops filler", () => {
    const plan = planHandoffCompaction(units, scores, 10_000);
    expect(plan.kept.map((unit) => unit.index)).toEqual([0, 3, 4, 5, 6]);
    expect(plan.omitted).toEqual([]);
    expect(plan.skipped.map((unit) => unit.index)).toEqual([2]);
    expect(plan.summaryBudget).toBe(0);
  });

  it("pins the task and newest message, ranks the rest by score, and reserves a summary budget", () => {
    const plan = planHandoffCompaction(units, scores, 600);
    expect(plan.kept[0]!.role).toBe("task");
    expect(plan.kept[plan.kept.length - 1]!.index).toBe(6);
    expect(plan.kept.map((unit) => unit.index)).toEqual([0, 4, 5, 6]);
    expect(plan.omitted.map((unit) => unit.index)).toEqual([3]);
    expect(plan.summaryBudget).toBeGreaterThan(100);
    const output = assembleHandoffCompaction(plan, "S".repeat(plan.summaryBudget), 600);
    expect(output.length).toBeLessThanOrEqual(600);
    expect(output).toContain("1 earlier message compressed");
    expect(output.indexOf("[... 1 earlier")).toBeLessThan(output.indexOf("USER: Do not touch"));
  });

  it("never exceeds the budget even when the newest message alone is larger", () => {
    const plan = planHandoffCompaction(units, scores, 20);
    expect(assembleHandoffCompaction(plan, "", 20).length).toBeLessThanOrEqual(20);
  });
});

describe("compressHandoffContextLocal", () => {
  it.effect("returns the transcript untouched when it already fits the budget", () =>
    Effect.gen(function* () {
      const calls: Array<StackCall> = [];
      const result = yield* compressHandoffContextLocal({
        transcript: "USER: short task",
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 500,
        customPrompt: "",
        fetchFn: stackFetch({ calls }),
      });
      expect(result).toBe("USER: short task");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("keeps judged-essential messages verbatim and summarizes the omitted background", () =>
    Effect.gen(function* () {
      const calls: Array<StackCall> = [];
      const judged: Array<string> = [];
      const result = yield* compressHandoffContextLocal({
        transcript: LONG_TRANSCRIPT,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 600,
        customPrompt: "",
        fetchFn: stackFetch({
          calls,
          judge: (evidence) => {
            judged.push(evidence.message);
            if (evidence.message.startsWith("ASSISTANT: Hi!")) return 0;
            if (evidence.message.startsWith("ASSISTANT: I explored")) return 1;
            return 2;
          },
          summary: (text) => {
            expect(text).toContain("OMITTED TRANSCRIPT PARTS");
            expect(text).toContain("I explored the router setup");
            expect(text).not.toContain("Root cause");
            return "Explored the router setup; nothing relevant found there.";
          },
        }),
      });
      // The task header and the marker are never judged; every message is, in one call each.
      expect(judged).toHaveLength(5);
      expect(calls.filter((call) => call.kind === "judge")).toHaveLength(5);
      expect(calls.filter((call) => call.kind === "summary")).toHaveLength(1);
      const summaryCall = calls.find((call) => call.kind === "summary")!;
      expect(summaryCall.body["model"]).toBe("bonsai2-27b:latest");
      expect(summaryCall.body["keep_alive"]).toBe("30m");
      expect((summaryCall.body["options"] as { num_ctx: number }).num_ctx).toBeGreaterThanOrEqual(
        2_048,
      );

      expect(result.length).toBeLessThanOrEqual(600);
      expect(result.startsWith("USER (original task): Fix the login redirect loop")).toBe(true);
      expect(result).toContain("Do not touch the session cookie name");
      expect(result).toContain("TypeError: token is undefined");
      expect(result).toContain("USER: Ok, fix it and run the auth tests.");
      expect(result).toContain(
        "[... 1 earlier message compressed into the summary below ...]\nExplored the router setup",
      );
      expect(result).not.toContain("Happy to help");
      expect(result).not.toContain("Details of the exploration");
    }),
  );

  it.effect("skips the summary call when the kept messages already fit", () =>
    Effect.gen(function* () {
      const calls: Array<StackCall> = [];
      const result = yield* compressHandoffContextLocal({
        transcript: LONG_TRANSCRIPT,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 700,
        customPrompt: "",
        fetchFn: stackFetch({
          calls,
          judge: (evidence) =>
            evidence.message.startsWith("ASSISTANT: Hi!") ||
            evidence.message.startsWith("ASSISTANT: I explored")
              ? 0
              : 2,
        }),
      });
      expect(calls.filter((call) => call.kind === "summary")).toEqual([]);
      expect(result).not.toContain("compressed into the summary");
      expect(result).toContain("Root cause");
      expect(result).not.toContain("Happy to help");
    }),
  );

  it.effect("falls back to a whole-transcript summary when the judge is unreachable", () =>
    Effect.gen(function* () {
      const calls: Array<StackCall> = [];
      const result = yield* compressHandoffContextLocal({
        transcript: LONG_TRANSCRIPT,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 600,
        customPrompt: "",
        fetchFn: stackFetch({
          calls,
          judge: () => new Error("ECONNREFUSED"),
          summary: (text) => {
            expect(text.startsWith("--- TRANSCRIPT ---")).toBe(true);
            return "whole-transcript summary";
          },
        }),
      });
      expect(result).toBe("whole-transcript summary");
      expect(calls.filter((call) => call.kind === "summary")).toHaveLength(1);
    }),
  );

  it.effect("summarizes whole when there are too few messages to rank", () =>
    Effect.gen(function* () {
      const calls: Array<StackCall> = [];
      const result = yield* compressHandoffContextLocal({
        transcript: `USER: do the thing ${"x".repeat(100)}\n\nASSISTANT: done`,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 30,
        customPrompt: "",
        fetchFn: stackFetch({ calls, summary: () => "  dense local summary  " }),
      });
      expect(result).toBe("dense local summary");
      expect(calls.map((call) => call.kind)).toEqual(["summary"]);
    }),
  );

  it.effect("clamps an over-long summary to maxOutputCharacters", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContextLocal({
        transcript: `USER: anything at all, at length\n\nASSISTANT: reply`,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 20,
        customPrompt: "",
        fetchFn: stackFetch({ summary: () => "S".repeat(500) }),
      });
      expect(result.length).toBe(20);
    }),
  );

  it.effect("aborts the daemon request on timeout and retains fallback context", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const request: { signal: AbortSignal | null } = { signal: null };
      const transcript = `USER: preserve this context ${"y".repeat(60)}\n\nASSISTANT: reply`;
      const fiber = yield* compressHandoffContextLocal({
        transcript,
        model: "test-compressor",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 60,
        customPrompt: "",
        timeoutMillis: 1000,
        fetchFn: ((_url, init) => {
          request.signal = init?.signal ?? null;
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise<Response>(() => {});
        }) as typeof fetch,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      expect(result).toBe(truncateHandoffTranscript(transcript, 60));
      expect(request.signal?.aborted).toBe(true);
    }),
  );

  it.effect("falls back to structured truncation when the daemon is unreachable", () =>
    Effect.gen(function* () {
      const transcript = `USER: original task statement\n${"filler ".repeat(500)}\nASSISTANT: final answer`;
      const result = yield* compressHandoffContextLocal({
        transcript,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 500,
        customPrompt: "",
        fetchFn: (() =>
          Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch,
      });
      expect(result.length).toBeLessThanOrEqual(500);
      expect(result).toContain("original task statement");
      expect(result).toContain("final answer");
      expect(result).toContain("omitted");
    }),
  );

  it.effect("falls back when the daemon answers with an error status or an empty message", () =>
    Effect.gen(function* () {
      const transcript = `USER: short task ${"z".repeat(40)}\n\nASSISTANT: reply`;
      const onError = yield* compressHandoffContextLocal({
        transcript,
        model: "missing-model",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 40,
        customPrompt: "",
        fetchFn: jsonFetch({ error: "model not found" }, 404),
      });
      expect(onError).toBe(truncateHandoffTranscript(transcript, 40));
      const onEmpty = yield* compressHandoffContextLocal({
        transcript,
        model: "bonsai2-27b:latest",
        maxInputCharacters: 24_000,
        maxOutputCharacters: 40,
        customPrompt: "",
        fetchFn: jsonFetch({ message: { content: "   " } }),
      });
      expect(onEmpty).toBe(truncateHandoffTranscript(transcript, 40));
    }),
  );
});

describe("truncateHandoffTranscript", () => {
  it("passes short transcripts through", () => {
    expect(truncateHandoffTranscript("short", 100)).toBe("short");
  });

  it("keeps head and tail within budget", () => {
    const transcript = `HEAD${"x".repeat(5_000)}TAIL`;
    const result = truncateHandoffTranscript(transcript, 400);
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result.startsWith("HEAD")).toBe(true);
    expect(result.endsWith("TAIL")).toBe(true);
  });

  it("never exceeds a budget smaller than the omission marker", () => {
    const result = truncateHandoffTranscript("x".repeat(100) + "TAIL", 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith("TAIL")).toBe(true);
  });
});
