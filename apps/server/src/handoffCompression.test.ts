import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";

import type { ProviderAdapterError } from "./provider/Errors.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";
import { compressHandoffContext, HandoffCompressionError } from "./handoffCompression.ts";

const MOCK_PROVIDER = ProviderDriverKind.make("mock");
const MOCK_INSTANCE = ProviderInstanceId.make("mock-compressor");

function makeMockAdapter(responseText: string) {
  const sessions = new Map<string, { turns: Array<{ id: string; items: unknown[] }> }>();
  return {
    provider: MOCK_PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" as const },
    startSession: (input: { threadId: unknown }) =>
      Effect.sync(() => {
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
      Effect.sync(() => {
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
    stopSession: () => Effect.void,
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    rollbackThread: () => Effect.void,
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
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

describe("compressHandoffContext", () => {
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
