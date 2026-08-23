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
  type OrchestrationEvent,
  type ModelSelection,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { assert, describe, test } from "vite-plus/test";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import { issueActiveMcpCredential } from "../src/mcp/McpSessionRegistry.ts";

const ENABLED = process.env.T3_REAL_MCP === "1";
const TURN_TIMEOUT_MS = 240_000;
const nowIso = () => "2026-08-15T00:00:00.000Z";

const PROJECT_ID = ProjectId.make("mcp-tool-project");
const THREAD_ID = ThreadId.make("mcp-tool-thread");
const CODEX_SELECTION: ModelSelection = {
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  model: "gpt-5.4-mini",
};

export function isMemoryStatusToolStartedEvent(
  event: OrchestrationEvent,
  threadId: ThreadId,
): boolean {
  if (event.type !== "thread.activity-appended" || event.payload.threadId !== threadId)
    return false;
  const payload = event.payload.activity.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "itemType" in payload &&
    payload.itemType === "mcp_tool_call" &&
    event.payload.activity.kind === "tool.started" &&
    event.payload.activity.summary.includes("memory_status")
  );
}

describe("MCP tool-call evidence", () => {
  const event = (input: {
    readonly type?: string;
    readonly threadId?: ThreadId;
    readonly kind?: string;
    readonly summary?: string;
    readonly itemType?: string;
  }) =>
    ({
      type: input.type ?? "thread.activity-appended",
      payload: {
        threadId: input.threadId ?? THREAD_ID,
        activity: {
          kind: input.kind ?? "tool.started",
          summary: input.summary ?? "t3-code · memory_status started",
          payload: { itemType: input.itemType ?? "mcp_tool_call" },
        },
      },
    }) as unknown as OrchestrationEvent;

  test("accepts only the expected thread's typed memory_status tool-start event", () => {
    assert.isTrue(isMemoryStatusToolStartedEvent(event({}), THREAD_ID));
    assert.isFalse(
      isMemoryStatusToolStartedEvent(
        event({ threadId: ThreadId.make("another-thread") }),
        THREAD_ID,
      ),
    );
    assert.isFalse(isMemoryStatusToolStartedEvent(event({ kind: "message.appended" }), THREAD_ID));
    assert.isFalse(
      isMemoryStatusToolStartedEvent(event({ itemType: "assistant_message" }), THREAD_ID),
    );
    assert.isFalse(
      isMemoryStatusToolStartedEvent(
        event({
          type: "thread.turn-started",
          summary: "User requested memory_status",
        }),
        THREAD_ID,
      ),
    );
  });

  it.live(
    "counts named tools/call requests and closes the endpoint on dispose",
    () =>
      Effect.acquireUseRelease(
        makeOrchestrationIntegrationHarness({ mcp: true }),
        (harness) =>
          Effect.gen(function* () {
            assert.isNotNull(harness.mcpEndpoint);
            const endpoint = harness.mcpEndpoint;
            const issued = yield* issueActiveMcpCredential({
              threadId: THREAD_ID,
              providerInstanceId: CODEX_SELECTION.instanceId,
            });
            assert.isDefined(issued);
            if (!issued) return;

            const initialize = yield* HttpClient.post(endpoint, {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: issued.config.authorizationHeader,
              },
              body: yield* HttpBody.json({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "harness-evidence-test", version: "1.0.0" },
                },
              }),
            });
            const sessionId = initialize.headers["mcp-session-id"];
            assert.equal(initialize.status, 200);
            assert.isString(sessionId);

            const initialized = yield* HttpClient.post(endpoint, {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: issued.config.authorizationHeader,
                "mcp-session-id": sessionId!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: yield* HttpBody.json({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              }),
            });
            const initializedBody = yield* initialized.text;
            assert.equal(initialized.status, 202, initializedBody);

            const toolCall = yield* HttpClient.post(endpoint, {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: issued.config.authorizationHeader,
                "mcp-session-id": sessionId!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: yield* HttpBody.json({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "memory_status", arguments: {} },
              }),
            });
            assert.equal(toolCall.status, 200);
            assert.equal(harness.mcpToolCallCount("memory_status"), 1);
            assert.equal(harness.mcpToolCallCount("memory_search"), 0);

            yield* harness.dispose;
            const afterDispose = yield* Effect.exit(
              HttpClient.get(endpoint).pipe(Effect.timeout(2_000)),
            );
            assert.equal(
              afterDispose._tag,
              "Failure",
              "disposed MCP endpoint still accepted traffic",
            );
          }),
        (harness) => harness.dispose,
      ).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
    15_000,
  );
});

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

            // Arm the watcher before the turn so it observes the tool activity
            // as it lands and can be joined after the quiescence receipt.
            const toolCallSeen = yield* harness
              .waitForDomainEvent(
                (event) => isMemoryStatusToolStartedEvent(event, THREAD_ID),
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
            // The harness counts request bodies asynchronously. Joining the
            // typed domain-event watcher first gives the observer time to
            // process the same tools/call body before asserting its counter.
            assert.isAbove(
              harness.mcpToolCallCount("memory_status"),
              0,
              "codex connected to /mcp but never issued memory_status",
            );

            const thread = yield* harness.waitForThread(String(THREAD_ID), (candidate) =>
              candidate.messages.some((message) => message.role === "assistant"),
            );
            const reply = thread.messages.findLast((message) => message.role === "assistant");
            assert.equal(reply?.text.trim().toLowerCase(), "done");
          }),
        (harness) => harness.dispose,
      ).pipe(Effect.provide(NodeServices.layer)),
    TURN_TIMEOUT_MS + 120_000,
  );
});
