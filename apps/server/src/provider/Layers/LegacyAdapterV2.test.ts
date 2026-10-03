import { describe, expect, it } from "vite-plus/test";
import { DateTime, Effect, Stream } from "effect";
import {
  EventId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
} from "@d4research/contracts";
import { makeLegacyAdapterV2, makeLegacyTurnTranslator } from "./LegacyAdapterV2.ts";

const driver = ProviderDriverKind.make("muse");
const threadId = ThreadId.make("thread");
const at = "2026-10-02T00:00:00.000Z";
const context = {
  threadId,
  runId: RunId.make("run"),
  attemptId: RunAttemptId.make("attempt"),
  rootNodeId: NodeId.make("root"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  providerThread: {
    id: ProviderThreadId.make("provider-thread"),
    driver,
    providerInstanceId: ProviderInstanceId.make("muse"),
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(at),
    updatedAt: DateTime.makeUnsafe(at),
  },
};
const base = { eventId: EventId.make("event"), provider: driver, threadId, createdAt: at };

describe("custom-provider V2 event bridge", () => {
  for (const kind of ["agy", "muse", "junie"]) {
    it(`rejects unsupported read-only ${kind} sessions before native launch`, async () => {
      let starts = 0;
      const unsupported = () => Effect.die("Unexpected native operation");
      const adapter = makeLegacyAdapterV2(
        {
          provider: ProviderDriverKind.make(kind),
          capabilities: { sessionModelSwitch: "unsupported" },
          startSession: () => {
            starts++;
            return unsupported();
          },
          sendTurn: unsupported,
          interruptTurn: unsupported,
          respondToRequest: unsupported,
          respondToUserInput: unsupported,
          stopSession: () => Effect.void,
          listSessions: () => Effect.succeed([]),
          hasSession: () => Effect.succeed(false),
          readThread: unsupported,
          rollbackThread: unsupported,
          stopAll: () => Effect.void,
          streamEvents: Stream.never,
        },
        ProviderInstanceId.make(kind),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const modelSelection = { instanceId: ProviderInstanceId.make(kind), model: "model" };
            const runtimePolicy = {
              cwd: null,
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              sandboxPolicy: { type: "readOnly" },
            };
            const runtime = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("session"),
              modelSelection,
              runtimePolicy,
            });
            const error = yield* runtime
              .ensureThread({ threadId, modelSelection, runtimePolicy })
              .pipe(Effect.flip);
            expect(error._tag).toBe("ProviderAdapterEnsureThreadError");
            expect(starts).toBe(0);
          }),
        ),
      );
    });
  }

  it("persists streamed assistant text and closes it before the terminal receipt", () => {
    const translator = makeLegacyTurnTranslator(context, driver);
    const delta = (text: string): ProviderRuntimeEvent => ({
      ...base,
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: text },
    });
    translator.convert(delta("Hello"));
    const more = translator.convert(delta(" world"));
    expect(more).toContainEqual(
      expect.objectContaining({
        type: "message.updated",
        message: expect.objectContaining({ text: "Hello world", streaming: true }),
      }),
    );
    const terminal = translator.convert({
      ...base,
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(terminal[0]).toMatchObject({
      type: "message.updated",
      message: { text: "Hello world", streaming: false },
    });
    expect(terminal.at(-1)).toMatchObject({
      type: "turn.terminal",
      status: "completed",
      failure: null,
    });
    expect(translator.convert(delta("stale"))).toEqual([]);
  });

  it("preserves approval options and resolves the same live request", () => {
    const translator = makeLegacyTurnTranslator(context, driver);
    const requestId = RuntimeRequestId.make("approval");
    const opened = translator.convert({
      ...base,
      requestId,
      type: "request.opened",
      payload: { requestType: "file_read_approval", detail: "Read file?", appName: "Native app" },
    });
    expect(opened[0]).toMatchObject({
      type: "runtime_request.updated",
      runtimeRequest: {
        id: requestId,
        kind: "file-read",
        responseCapability: { type: "live", providerSessionId: "session" },
      },
    });
    expect(opened[1]).toMatchObject({
      type: "turn_item.updated",
      turnItem: { type: "approval_request", appName: "Native app", prompt: "Read file?" },
    });
    const resolved = translator.convert({
      ...base,
      requestId,
      type: "request.resolved",
      payload: { requestType: "file_read_approval", decision: "accept" },
    });
    expect(resolved[0]).toMatchObject({
      type: "runtime_request.updated",
      runtimeRequest: { id: requestId, status: "resolved" },
    });
  });

  it("retains a complete native message when no deltas preceded it", () => {
    const translator = makeLegacyTurnTranslator(context, driver);
    const values = translator.convert({
      ...base,
      itemId: RuntimeItemId.make("message"),
      type: "item.completed",
      payload: { itemType: "assistant_message", detail: "Final answer", status: "completed" },
    });
    expect(values[0]).toMatchObject({
      type: "message.updated",
      message: { text: "Final answer", streaming: false },
    });
  });

  it("keeps failures distinct from interruption and carries native usage", () => {
    for (const state of ["failed", "interrupted"] as const) {
      const translator = makeLegacyTurnTranslator(context, driver);
      const result = translator.convert({
        ...base,
        type: "turn.completed",
        payload: {
          state,
          errorMessage: "Native failure",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 10,
            outputTokens: 2,
            hasSubagents: false,
          },
        },
      });
      expect(result[0]).toMatchObject({
        type: "provider_turn.updated",
        providerTurn: { status: state, turnTokenUsage: { inputTokens: 10, outputTokens: 2 } },
      });
      expect(result.at(-1)).toMatchObject({
        type: "turn.terminal",
        status: state,
        failure: state === "failed" ? { message: "Native failure" } : null,
      });
    }
  });

  it("maps native plan progress without invalid V2 statuses", () => {
    const translator = makeLegacyTurnTranslator(context, driver);
    expect(
      translator.convert({
        ...base,
        type: "turn.plan.updated",
        payload: { plan: [{ step: "Inspect", status: "inProgress" }] },
      })[0],
    ).toMatchObject({
      type: "turn_item.updated",
      turnItem: { type: "todo_list", steps: [{ id: "0", text: "Inspect", status: "running" }] },
    });
  });
});
