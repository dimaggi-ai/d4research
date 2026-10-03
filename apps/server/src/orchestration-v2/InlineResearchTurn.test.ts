import { expect, it } from "vite-plus/test";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  ThreadId,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@d4research/contracts";
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { InlineDelegationRunner } from "../mcp/toolkits/research/inlineDelegation.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import {
  appendEnabledSkillsContext,
  extractTrailingEnabledSkillsContext,
} from "@d4research/shared/enabledSkillsContext";
import * as IdAllocator from "./IdAllocator.ts";
import { tryRunInlineResearchTurn } from "./InlineResearchTurn.ts";

const now = DateTime.makeUnsafe("2026-10-02T00:00:00Z");
const threadId = ThreadId.make("thread");
const runId = RunId.make("run");
const nodeId = NodeId.make("node");
const attemptId = RunAttemptId.make("attempt");
const providerThreadId = ProviderThreadId.make("provider-thread");
const instanceId = ProviderInstanceId.make("codex");
const messageId = MessageId.make("user-message");
const run = OrchestrationV2Run.make({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.6-sol" },
  providerThreadId,
  userMessageId: messageId,
  rootNodeId: nodeId,
  activeAttemptId: attemptId,
  status: "starting",
  requestedAt: now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const attempt = OrchestrationV2RunAttempt.make({
  id: attemptId,
  runId,
  attemptOrdinal: 1,
  rootNodeId: nodeId,
  providerInstanceId: instanceId,
  providerThreadId,
  providerTurnId: null,
  reason: "initial",
  status: "pending",
  startedAt: null,
  completedAt: null,
});
const rootNode = OrchestrationV2ExecutionNode.make({
  id: nodeId,
  threadId,
  runId,
  parentNodeId: null,
  rootNodeId: nodeId,
  kind: "root_turn",
  status: "pending",
  countsForRun: true,
  providerThreadId,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: null,
  completedAt: null,
});
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-02T00:00:00Z",
  models: [{ slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const input = (text: string) => ({
  run,
  attempt,
  rootNode,
  providers: [provider],
  shareMemoContext: false,
  nextOrdinal: 1,
  checkpointScopeId: CheckpointScopeId.make("scope"),
  message: OrchestrationV2ConversationMessage.make({
    id: messageId,
    threadId,
    runId,
    nodeId,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  }),
});
const answer = {
  requestedTarget: "codex:gpt-5.6-sol",
  resolvedTarget: "codex:gpt-5.6-sol",
  target: "codex:gpt-5.6-sol",
  substituted: false,
  step: "inline",
  visit: 1,
  remainingBudget: 0,
  durationMs: 1,
  truncated: false,
  text: "Adviser result",
};

it("leaves ordinary turns untouched", async () => {
  expect(
    await Effect.runPromise(
      tryRunInlineResearchTurn(input("Normal message")).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EventSinkV2)({}),
            Layer.mock(InlineDelegationRunner)({}),
            Layer.mock(OrchestrationEventStore)({}),
            IdAllocator.layer,
          ),
        ),
      ),
    ),
  ).toBe(false);
});

for (const rejected of [false, true]) {
  it(
    rejected
      ? "records rejected targets without invoking an adviser"
      : "records adviser completion and its structured target",
    async () => {
      const events: OrchestrationV2DomainEvent[] = [];
      const effects: PendingOrchestrationEffectV2[] = [];
      let calls = 0;
      const result = await Effect.runPromise(
        tryRunInlineResearchTurn({
          ...input(rejected ? "!missing:model Explain this" : "!codex:gpt-5.6-sol Explain this"),
          preparePrompt: (text) =>
            Effect.succeed(
              appendEnabledSkillsContext(text, [
                {
                  name: "audit",
                  path: "/isolated/skills/audit/SKILL.md",
                  description: "Audit",
                  scope: "global",
                },
              ]),
            ),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(InlineDelegationRunner)({
                run: (request) => {
                  calls++;
                  expect(extractTrailingEnabledSkillsContext(request.prompt).promptText).toBe(
                    "Explain this",
                  );
                  expect(extractTrailingEnabledSkillsContext(request.prompt).globalSkills).toEqual([
                    "audit",
                  ]);
                  return Effect.succeed(answer);
                },
              }),
              Layer.mock(OrchestrationEventStore)({ streamApplicationEvents: () => Stream.never }),
              Layer.mock(EventSinkV2)({
                writeIfRunCurrent: ({ events: next, effects: pending = [] }) => {
                  effects.push(...pending);
                  if (pending.length)
                    expect(
                      next.some(
                        (event) =>
                          event.type === "run.updated" && event.payload.status === "waiting",
                      ),
                    ).toBe(true);
                  for (const event of next)
                    expect(Schema.is(Schema.toType(OrchestrationV2DomainEvent))(event)).toBe(true);
                  events.push(...next);
                  return Effect.succeed({ committed: true, storedEvents: [] });
                },
              }),
            ),
          ),
        ),
      );
      expect(result).toBe(true);
      expect(calls).toBe(rejected ? 0 : 1);
      expect(effects).toEqual(
        rejected
          ? []
          : [
              {
                id: `effect:checkpoint.capture:${runId}`,
                commandId: `command:effect:checkpoint.capture:${runId}`,
                threadId,
                request: { type: "checkpoint.capture", runId, scopeId: "scope" },
              },
            ],
      );
      const terminal = events.filter((event) => event.type === "run.updated").at(-1);
      expect(terminal?.payload.status).toBe(rejected ? "failed" : "waiting");
      const tool = events
        .filter(
          (event) => event.type === "turn-item.updated" && event.payload.type === "dynamic_tool",
        )
        .at(-1);
      expect(tool?.payload).toMatchObject({ output: { researchDelegate: { failed: rejected } } });
    },
  );
}

it("cancels adviser scope on interruption and persists a terminal tool receipt", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const events: OrchestrationV2DomainEvent[] = [];
        const layer = Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(InlineDelegationRunner)({
            run: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
          }),
          Layer.mock(OrchestrationEventStore)({ streamApplicationEvents: () => Stream.never }),
          Layer.mock(EventSinkV2)({
            writeIfRunCurrent: ({ events: next }) => {
              events.push(...next);
              return Effect.succeed({ committed: true, storedEvents: [] });
            },
          }),
        );
        const fiber = yield* tryRunInlineResearchTurn(
          input("!codex:gpt-5.6-sol Explain this"),
        ).pipe(Effect.provide(layer), Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(stopped);
        expect(events.at(-1)?.payload).toMatchObject({
          type: "dynamic_tool",
          status: "interrupted",
        });
        expect(events.some((event) => event.type === "message.updated")).toBe(false);
      }),
    ),
  );
});
