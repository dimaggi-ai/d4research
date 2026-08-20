/**
 * REAL provider handoff matrix: every ordered pair of enabled providers runs
 * one thread through the full server composition with the REAL CLI — real
 * adapter, real spawn, real model — on the cheapest model each provider
 * offers. Turn one runs on provider A, turn two hands the same thread to
 * provider B. Success is receipt-based: each turn must reach
 * `turn.processing.quiesced` through the live pipeline, which is exactly the
 * signal that was silently lost in the 2026-08-14/15 codex outages.
 *
 * Opt-in (spends real provider usage):
 *   T3_REAL_HANDOFF=1 vp test run apps/server/integration/providerHandoffMatrix.real.integration.test.ts
 * Provider set (default all installed): T3_REAL_HANDOFF_PROVIDERS=claudeAgent,codex,agy
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  defaultInstanceIdForDriver,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
  type RealProviderName,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import { appendProviderHandoffContext } from "@t3tools/shared/providerHandoffPrompt";

const ENABLED = process.env.T3_REAL_HANDOFF === "1";
const PROVIDERS: ReadonlyArray<RealProviderName> = (
  process.env.T3_REAL_HANDOFF_PROVIDERS ?? "claudeAgent,codex,agy,opencode,grok"
)
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is RealProviderName =>
    ["claudeAgent", "codex", "agy", "opencode", "grok"].includes(name),
  );

const CHEAP_MODEL: Record<RealProviderName, string> = {
  claudeAgent: "claude-haiku-4-5",
  codex: "gpt-5.4-mini",
  agy: "gemini-3.6-flash-low",
  opencode: "ollama/gemma4:e4b-it-qat",
  grok: "grok-4.6",
};

const TURN_TIMEOUT_MS = 180_000;
const nowIso = () => "2026-08-15T00:00:00.000Z";

const selection = (provider: RealProviderName): ModelSelection => ({
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(provider)),
  model: CHEAP_MODEL[provider],
});

const PROJECT_ID = ProjectId.make("handoff-project");
const THREAD_ID = ThreadId.make("handoff-thread");

const startRealTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly n: number;
  readonly provider: RealProviderName;
  readonly text: string;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-real-turn-${input.n}`),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(`msg-real-${input.n}`),
      role: "user",
      text: input.text,
      attachments: [],
    },
    modelSelection: selection(input.provider),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: nowIso(),
  });

const waitQuiesced = (harness: OrchestrationIntegrationHarness, count: number) =>
  harness.waitForReceipt(
    (receipt): receipt is TurnProcessingQuiescedReceipt =>
      receipt.type === "turn.processing.quiesced" &&
      receipt.threadId === THREAD_ID &&
      receipt.checkpointTurnCount === count,
    TURN_TIMEOUT_MS,
  );

const pairs: Array<[RealProviderName, RealProviderName]> = [];
for (const a of PROVIDERS) {
  for (const b of PROVIDERS) {
    if (a !== b) pairs.push([a, b]);
  }
}

describe.skipIf(!ENABLED)("real provider handoff matrix", () => {
  for (const [from, to] of pairs) {
    it.live(
      `hands off ${from} (${CHEAP_MODEL[from]}) -> ${to} (${CHEAP_MODEL[to]})`,
      () =>
        Effect.acquireUseRelease(
          makeOrchestrationIntegrationHarness({
            provider: ProviderDriverKind.make(from),
            realProviders: [from, to],
          }),
          (harness) =>
            Effect.gen(function* () {
              yield* harness.engine.dispatch({
                type: "project.create",
                commandId: CommandId.make("cmd-real-project"),
                projectId: PROJECT_ID,
                title: "Real Handoff Project",
                workspaceRoot: harness.workspaceDir,
                defaultModelSelection: selection(from),
                createdAt: nowIso(),
              });
              yield* harness.engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make("cmd-real-thread"),
                threadId: THREAD_ID,
                projectId: PROJECT_ID,
                title: "Real Handoff Thread",
                modelSelection: selection(from),
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "full-access",
                branch: null,
                worktreePath: harness.workspaceDir,
                createdAt: nowIso(),
              });

              // Turn 1 plants a fact only the carried context can deliver to
              // the receiving provider: the engine dispatch below attaches the
              // same <handoff_context> block the web client sends, so a correct
              // recall on turn 2 is end-to-end proof the handoff carries.
              const phrase = `zephyr-${from}-${to}-742`;
              yield* startRealTurn({
                harness,
                n: 1,
                provider: from,
                text: `Remember this code phrase: "${phrase}". Reply with exactly: stored. Do not use any tools.`,
              });
              const first = yield* waitQuiesced(harness, 1);
              assert.equal(first.type, "turn.processing.quiesced");

              const beforeHandoff = yield* harness.waitForThread(String(THREAD_ID), (thread) =>
                thread.messages.some((message) => message.role === "assistant"),
              );
              const transcript = beforeHandoff.messages
                .map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`)
                .join("\n\n");
              const handoffText = appendProviderHandoffContext(
                "What is the code phrase? Reply with exactly the code phrase and nothing else. Do not use any tools.",
                {
                  sourceThreadId: String(THREAD_ID),
                  sourceThreadTitle: "Real Handoff Thread",
                  summary: transcript,
                  targetInstanceId: String(selection(to).instanceId),
                  targetModel: selection(to).model,
                  targetLabel: to,
                },
              );

              // The handoff: same thread, next turn on the other provider.
              yield* startRealTurn({ harness, n: 2, provider: to, text: handoffText });
              const second = yield* waitQuiesced(harness, 2);
              assert.equal(second.type, "turn.processing.quiesced");
              assert.equal(second.checkpointTurnCount, 2);

              const afterHandoff = yield* harness.waitForThread(
                String(THREAD_ID),
                (thread) =>
                  thread.messages.filter((message) => message.role === "assistant").length >= 2,
              );
              const reply = afterHandoff.messages
                .filter((message) => message.role === "assistant")
                .at(-1)!
                .text.toLowerCase();
              assert.include(
                reply,
                phrase.toLowerCase(),
                `receiving provider did not recall the carried code phrase; reply: ${reply.slice(0, 200)}`,
              );
            }),
          (harness) => harness.dispose,
        ).pipe(Effect.provide(NodeServices.layer)),
      TURN_TIMEOUT_MS * 2 + 60_000,
    );
  }
});
