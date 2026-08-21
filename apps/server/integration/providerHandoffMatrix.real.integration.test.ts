/**
 * REAL provider handoff matrix: every ordered pair of enabled providers runs
 * one thread through the full server composition with the REAL CLI — real
 * adapter, real spawn, real model — on the cheapest model each provider
 * offers. Turn one runs on provider A, turn two hands the same thread to
 * provider B. Success is receipt-based: each turn must reach
 * `turn.processing.quiesced` through the live pipeline, which is exactly the
 * signal that was silently lost in the 2026-08-14/15 codex outages. The test
 * supplies the same serialized handoff block as the client, but deliberately
 * does not exercise the browser's HTTP preparation and Memo-mirroring path;
 * those deterministic contracts are covered by focused web/server tests.
 *
 * Opt-in (spends real provider usage):
 *   T3_REAL_HANDOFF=1 vp test run apps/server/integration/providerHandoffMatrix.real.integration.test.ts
 * Provider subset example: T3_REAL_HANDOFF_PROVIDERS=claudeAgent,codex,agy
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
import { assert, describe, test } from "vite-plus/test";

import {
  makeOrchestrationIntegrationHarness,
  REAL_PROVIDER_TEST_MODELS,
  type OrchestrationIntegrationHarness,
  type RealProviderName,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import { appendProviderHandoffContext } from "@t3tools/shared/providerHandoffPrompt";

const ENABLED = process.env.T3_REAL_HANDOFF === "1";
const ALL_PROVIDERS = ["claudeAgent", "codex", "agy", "opencode", "grok"] as const;

export function parseRealHandoffProviders(
  raw: string | undefined,
): ReadonlyArray<RealProviderName> {
  const providers = (raw ?? ALL_PROVIDERS.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const invalid = providers.filter((name) => !ALL_PROVIDERS.includes(name as RealProviderName));
  const duplicates = providers.filter((name, index) => providers.indexOf(name) !== index);
  if (invalid.length > 0 || duplicates.length > 0) {
    throw new Error(
      `Invalid T3_REAL_HANDOFF_PROVIDERS: unknown=[${invalid.join(", ")}], duplicates=[${duplicates.join(", ")}]`,
    );
  }
  if (providers.length < 2) {
    throw new Error("T3_REAL_HANDOFF_PROVIDERS must contain at least two unique providers.");
  }
  return providers as ReadonlyArray<RealProviderName>;
}

export function makeOrderedProviderPairs(
  providers: ReadonlyArray<RealProviderName>,
): ReadonlyArray<readonly [RealProviderName, RealProviderName]> {
  return providers.flatMap((from) =>
    providers.filter((to) => from !== to).map((to) => [from, to] as const),
  );
}

describe("real handoff matrix configuration", () => {
  test("builds all 20 unique ordered pairs by default", () => {
    const providers = parseRealHandoffProviders(undefined);
    const pairs = makeOrderedProviderPairs(providers);
    assert.equal(providers.length, 5);
    assert.equal(pairs.length, 20);
    assert.equal(new Set(pairs.map(([from, to]) => `${from}->${to}`)).size, 20);
  });

  test("supports an explicit provider subset", () => {
    assert.deepEqual(parseRealHandoffProviders(" codex, grok "), ["codex", "grok"]);
    assert.deepEqual(makeOrderedProviderPairs(["codex", "grok"]), [
      ["codex", "grok"],
      ["grok", "codex"],
    ]);
  });

  test("rejects empty, single, unknown, and duplicate provider sets", () => {
    for (const raw of ["", "codex", "codex,wat", "codex,codex"]) {
      assert.throws(() => parseRealHandoffProviders(raw));
    }
  });
});

const PROVIDERS = ENABLED
  ? parseRealHandoffProviders(process.env.T3_REAL_HANDOFF_PROVIDERS)
  : parseRealHandoffProviders(undefined);

const CHEAP_MODEL = REAL_PROVIDER_TEST_MODELS;

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

const pairs = makeOrderedProviderPairs(PROVIDERS);

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
              // the receiving provider. This proves the real provider/session
              // transition carries the client-shaped block; preparation and
              // Memo mirroring are intentionally tested separately.
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
              const sourceReply = beforeHandoff.messages.findLast(
                (message) => message.role === "assistant",
              );
              assert.equal(
                sourceReply?.text.trim().toLowerCase(),
                "stored",
                `${from} did not complete the source turn exactly as requested`,
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
                  String(thread.session?.providerInstanceId) === String(selection(to).instanceId) &&
                  thread.messages.filter((message) => message.role === "assistant").length >= 2,
              );
              assert.equal(
                String(afterHandoff.session?.providerInstanceId),
                String(selection(to).instanceId),
                `${to} did not become the projected provider for the handed-off thread`,
              );
              assert.equal(
                afterHandoff.modelSelection?.model,
                selection(to).model,
                `${to} did not project the requested target model ${selection(to).model}`,
              );
              // The projection mirrors the command payload; the adapter
              // inventory is the independent proof that the native session
              // accepted the same model rather than merely echoing it.
              const nativeTargetSession = (yield* harness.providerService.listSessions()).find(
                (session) =>
                  session.threadId === THREAD_ID &&
                  String(session.providerInstanceId) === String(selection(to).instanceId),
              );
              assert.equal(
                nativeTargetSession?.model,
                selection(to).model,
                `${to} native session did not retain requested model ${selection(to).model}`,
              );
              const reply = afterHandoff.messages
                .findLast((message) => message.role === "assistant")!
                .text.trim()
                .toLowerCase();
              assert.equal(
                reply,
                phrase.toLowerCase(),
                `receiving provider did not return exactly the carried code phrase; reply: ${reply.slice(0, 200)}`,
              );
            }),
          (harness) => harness.dispose,
        ).pipe(Effect.provide(NodeServices.layer)),
      TURN_TIMEOUT_MS * 2 + 60_000,
    );
  }
});
