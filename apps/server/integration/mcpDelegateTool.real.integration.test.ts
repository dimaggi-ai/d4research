/**
 * REAL t3-code MCP tool call through the full composition: a real codex CLI
 * session receives an MCP credential minted by the live session registry,
 * connects back to the harness-served /mcp endpoint, and calls a tool
 * mid-turn. Success is receipt-based (`turn.processing.quiesced`) plus two
 * pieces of evidence the 2026-08-15 "hung t3-code MCP tool call" reopen
 * demanded and the no-tools handoff matrix could not provide: the endpoint
 * actually served requests, and the tool call surfaced in the thread's
 * domain events.
 *
 * Opt-in (spends real provider usage):
 *   T3_REAL_MCP=1 vp test run apps/server/integration/mcpDelegateTool.real.integration.test.ts
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
import * as Fiber from "effect/Fiber";
import { assert, describe } from "vite-plus/test";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";

const ENABLED = process.env.T3_REAL_MCP === "1";
const TURN_TIMEOUT_MS = 240_000;
const nowIso = () => "2026-08-15T00:00:00.000Z";

const PROJECT_ID = ProjectId.make("mcp-tool-project");
const THREAD_ID = ThreadId.make("mcp-tool-thread");
const CODEX_SELECTION: ModelSelection = {
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  model: "gpt-5.4-mini",
};

describe.skipIf(!ENABLED)("real t3-code MCP tool call", () => {
  it.live(
    "codex calls memory_status over the harness-served /mcp and the turn quiesces",
    () =>
      Effect.acquireUseRelease(
        makeOrchestrationIntegrationHarness({
          provider: ProviderDriverKind.make("codex"),
          realProviders: ["codex"],
          mcp: true,
        }),
        (harness) =>
          Effect.gen(function* () {
            assert.isNotNull(harness.mcpEndpoint, "harness must serve a real /mcp endpoint");

            yield* harness.engine.dispatch({
              type: "project.create",
              commandId: CommandId.make("cmd-mcp-project"),
              projectId: PROJECT_ID,
              title: "MCP Tool Project",
              workspaceRoot: harness.workspaceDir,
              defaultModelSelection: CODEX_SELECTION,
              createdAt: nowIso(),
            });
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("cmd-mcp-thread"),
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              title: "MCP Tool Thread",
              modelSelection: CODEX_SELECTION,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "full-access",
              branch: null,
              worktreePath: harness.workspaceDir,
              createdAt: nowIso(),
            });

            // The domain-event watcher must be armed before the turn: the
            // tool-call activity lands mid-turn, and waitForDomainEvent
            // replays nothing.
            const toolCallSeen = yield* harness
              .waitForDomainEvent(
                (event) => JSON.stringify(event).includes("memory_status"),
                TURN_TIMEOUT_MS,
              )
              .pipe(Effect.forkChild);

            yield* harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-mcp-turn-1"),
              threadId: THREAD_ID,
              message: {
                messageId: MessageId.make("msg-mcp-1"),
                role: "user",
                text: "Use the t3-code MCP server: call its memory_status tool with no arguments. After the call returns, reply with exactly: done.",
                attachments: [],
              },
              modelSelection: CODEX_SELECTION,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "full-access",
              createdAt: nowIso(),
            });

            const receipt = yield* harness.waitForReceipt(
              (candidate): candidate is TurnProcessingQuiescedReceipt =>
                candidate.type === "turn.processing.quiesced" &&
                candidate.threadId === THREAD_ID &&
                candidate.checkpointTurnCount === 1,
              TURN_TIMEOUT_MS,
            );
            assert.equal(receipt.type, "turn.processing.quiesced");

            // Evidence 1: the CLI reached OUR endpoint (not a stale config).
            assert.isAbove(
              harness.mcpRequestCount(),
              0,
              "codex never connected to the harness /mcp endpoint",
            );
            // Evidence 2: the tool call itself surfaced in the thread's
            // domain events — a connected-but-toolless run must fail here.
            const events = yield* Fiber.join(toolCallSeen);
            assert.isAbove(events.length, 0, "no domain event mentioned memory_status");
          }),
        (harness) => harness.dispose,
      ).pipe(Effect.provide(NodeServices.layer)),
    TURN_TIMEOUT_MS + 120_000,
  );
});
