import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
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
  compressHandoffContext,
  compressHandoffContextLocal,
  compressHandoffContextWithFallback,
  DEFAULT_OLLAMA_BASE_URL,
  HandoffCompressionError,
  PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS,
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

describe("compressHandoffContextLocal", () => {
  it.effect("returns the local model's summary on success", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return Promise.resolve(
          new Response(JSON.stringify({ message: { content: "  dense local summary  " } }), {
            status: 200,
          }),
        );
      }) as typeof globalThis.fetch;

      const result = yield* compressHandoffContextLocal({
        transcript: "USER: do the thing\nASSISTANT: done",
        model: "gemma4:e4b-it-qat",
        maxInputCharacters: 6_000,
        maxOutputCharacters: 2_000,
        customPrompt: "",
        fetchFn,
      });

      expect(result).toBe("dense local summary");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
      expect(requests[0]!.body["model"]).toBe("gemma4:e4b-it-qat");
      expect(requests[0]!.body["stream"]).toBe(false);
      // 30m: handoffs cluster within a session but rarely within two minutes,
      // so the short keep_alive made nearly every handoff pay the cold load.
      expect(requests[0]!.body["keep_alive"]).toBe("30m");
      expect((requests[0]!.body["options"] as { num_ctx: number }).num_ctx).toBeGreaterThan(1_024);
    }),
  );

  it.effect("clamps an over-long local summary to maxOutputCharacters", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContextLocal({
        transcript: "anything",
        model: "gemma4:e4b-it-qat",
        maxInputCharacters: 6_000,
        maxOutputCharacters: 20,
        customPrompt: "",
        fetchFn: jsonFetch({ message: { content: "S".repeat(500) } }),
      });
      expect(result.length).toBe(20);
    }),
  );

  it.effect("falls back to structured truncation when the daemon is unreachable", () =>
    Effect.gen(function* () {
      const transcript = `USER: original task statement\n${"filler ".repeat(500)}\nASSISTANT: final answer`;
      const result = yield* compressHandoffContextLocal({
        transcript,
        model: "gemma4:e4b-it-qat",
        maxInputCharacters: 6_000,
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

  it.effect("falls back when the daemon answers with an error status", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContextLocal({
        transcript: "USER: short task",
        model: "missing-model",
        maxInputCharacters: 6_000,
        maxOutputCharacters: 500,
        customPrompt: "",
        fetchFn: jsonFetch({ error: "model not found" }, 404),
      });
      expect(result).toBe("USER: short task");
    }),
  );

  it.effect("falls back when the daemon returns an empty message", () =>
    Effect.gen(function* () {
      const result = yield* compressHandoffContextLocal({
        transcript: "USER: short task",
        model: "gemma4:e4b-it-qat",
        maxInputCharacters: 6_000,
        maxOutputCharacters: 500,
        customPrompt: "",
        fetchFn: jsonFetch({ message: { content: "   " } }),
      });
      expect(result).toBe("USER: short task");
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
