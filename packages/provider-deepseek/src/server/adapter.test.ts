import { assert, it } from "@effect/vitest";
import { afterEach, describe, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { requestCompletion } from "./http.ts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  TurnItemId,
  ThreadId,
  ProjectId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@d4research/contracts";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import type * as Adapter from "@d4research/provider-core/server/ProviderAdapter";
import type { ProviderAdapterV2RuntimePolicy } from "@d4research/provider-core/server/ProviderAdapter";
import { D4_AGENT_PREFIX } from "@d4research/provider-core/server/d4AgentPolicy";
import { historicalMessage } from "@d4research/provider-core/server/handoffBudget";
import { DeepSeekSettings, isLoopbackEndpoint } from "../settings.ts";
import { DeepSeekAdapterV2Driver } from "./adapter.ts";
import { probeDeepSeek } from "./health.ts";

const config = Schema.decodeSync(DeepSeekSettings)({});
const instanceId = ProviderInstanceId.make("deepseek-test");
const threadId = ThreadId.make("deepseek-thread");
const selection = { instanceId, model: config.model };
const policy = {
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  cwd: "/workspace",
};
const completion = (text: string) => ({
  choices: [{ finish_reason: "stop", message: { content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
});
const reply = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
    ),
  );
const open = (
  client: HttpClient.HttpClient,
  options: {
    policy?: ProviderAdapterV2RuntimePolicy;
    config?: typeof config;
    appContext?: ReadonlyArray<{ key: string; text: string }>;
    existingProviderThread?: OrchestrationV2ProviderThread;
  } = {},
) =>
  Effect.gen(function* () {
    const adapter = yield* DeepSeekAdapterV2Driver.create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: options.config ?? config,
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("deepseek-session"),
      modelSelection: selection,
      runtimePolicy: options.policy ?? policy,
    });
    const providerThread = yield* runtime.ensureThread({
      ...(options.existingProviderThread
        ? { existingProviderThread: options.existingProviderThread }
        : {}),
      threadId,
      modelSelection: selection,
      runtimePolicy: options.policy ?? policy,
    });
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Test",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const start = (ordinal: number, text = "Hello") =>
      runtime.startTurn({
        ...(options.appContext ? { appContext: options.appContext } : {}),
        appThread,
        threadId,
        providerThread,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        message: {
          messageId: MessageId.make(`message-${ordinal}`),
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: selection,
        runtimePolicy: options.policy ?? policy,
      });
    // One long-lived consumer: a per-turn Stream run would drop events that share a pulled chunk
    // with the terminal, hiding duplicate terminals.
    const observed = yield* Queue.unbounded<Adapter.ProviderAdapterV2Event>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Queue.offer(observed, event)),
      Effect.forkScoped,
    );
    const takeTurn = Effect.gen(function* () {
      const events: Adapter.ProviderAdapterV2Event[] = [];
      while (true) {
        const event = yield* Queue.take(observed);
        events.push(event);
        if (event.type === "turn.terminal") return events;
      }
    });
    // A later turn is the ordering boundary: a duplicate terminal from an earlier turn would be
    // queued ahead of it and become the first terminal observed here.
    const expectNoLateTerminal = (nextOrdinal: number) =>
      Effect.gen(function* () {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("boundary turn");
          }),
        );
        yield* start(nextOrdinal);
        const events = yield* takeTurn;
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.type === "turn.terminal" ? terminal.providerTurnId : undefined,
          ProviderTurnId.make(`deepseek:${instanceId}:attempt-${nextOrdinal}`),
        );
      });
    return { runtime, providerThread, start, takeTurn, expectNoLateTerminal };
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));

describe("local DeepSeek adapter", () => {
  it.effect("completes text turns with usage and preserves conversation context", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        if (request.body._tag === "Uint8Array")
          requests.push(new TextDecoder().decode(request.body.body));
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(completion("answer")))),
        );
      });
      const test = yield* open(client);
      yield* test.start(1);
      const events = yield* test.takeTurn;
      assert.equal(events.at(-1)?.type, "turn.terminal");
      assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "completed");
      const turn = events.find(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.equal(
        turn?.type === "provider_turn.updated" && turn.providerTurn.tokenUsage?.usedTokens,
        13,
      );
      yield* test.start(2, "follow up");
      yield* test.takeTurn;
      const second = JSON.parse(requests[1] ?? "{}");
      assert.deepStrictEqual(second.messages.slice(-3), [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" },
      ]);
      assert.equal(second.tools, undefined);
      assert.equal(second.model, config.model);
      const item = events.find((event) => event.type === "turn_item.updated");
      assert.equal(item?.type === "turn_item.updated" && item.turnItem.type, "assistant_message");
      assert.equal(item?.type === "turn_item.updated" && item.turnItem.ordinal, 1);
      const assistant = events.find((event) => event.type === "message.updated");
      assert.equal(
        item?.type === "turn_item.updated" &&
          item.turnItem.type === "assistant_message" &&
          item.turnItem.messageId,
        assistant?.type === "message.updated" && assistant.message.id,
      );
      assert.ok(item?.type === "turn_item.updated");
      const restored = historicalMessage(item.turnItem);
      assert.ok(restored);
      const restarted = yield* open(client);
      yield* restarted.runtime.injectHistory!({
        providerThread: restarted.providerThread,
        context: "",
        messages: [restored],
      });
      yield* restarted.start(3, "after restart");
      yield* restarted.takeTurn;
      assert.deepStrictEqual(JSON.parse(requests[2] ?? "{}").messages.slice(-2), [
        { role: "assistant", content: "answer" },
        { role: "user", content: "after restart" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["HTTP failure", {}, 503, "transport"],
    [
      "tool calls",
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: { content: null, tool_calls: [{ id: "unsafe" }] },
          },
        ],
      },
      200,
      "tools",
    ],
    [
      "unknown function calls",
      { choices: [{ finish_reason: "stop", message: { content: "fake", function_call: {} } }] },
      200,
      "tools",
    ],
    [
      "incomplete response",
      { choices: [{ finish_reason: "length", message: { content: "partial" } }] },
      200,
      "protocol",
    ],
  ] as const)("fails closed on %s", ([_label, body, status, code]) =>
    Effect.gen(function* () {
      const test = yield* open(reply(body, status));
      yield* test.start(1);
      const events = yield* test.takeTurn;
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.code, code);
      assert.equal(
        events.some((event) => event.type === "message.updated"),
        false,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts the HTTP fiber and emits one interrupted terminal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
        ),
      );
      const test = yield* open(client);
      yield* test.start(1);
      yield* Deferred.await(started);
      yield* test.runtime.interruptTurn({
        providerThread: test.providerThread,
        providerTurnId: ProviderTurnId.make("deepseek:deepseek-test:attempt-1"),
      });
      yield* Deferred.await(cancelled);
      const events = yield* test.takeTurn;
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "interrupted");
    }).pipe(Effect.scoped),
  );

  it.effect("injects authoritative app history before the new user message", () =>
    Effect.gen(function* () {
      let body = "";
      const client = HttpClient.make((request) => {
        if (request.body._tag === "Uint8Array") body = new TextDecoder().decode(request.body.body);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(completion("answer")))),
        );
      });
      const test = yield* open(client);
      yield* test.runtime.injectHistory!({
        providerThread: test.providerThread,
        context: "verified context",
        messages: [
          {
            role: "user",
            text: "earlier",
            threadId,
            runId: null,
            itemId: TurnItemId.make("item"),
            providerThreadId: null,
            status: "completed",
            kind: "message",
          },
        ],
      });
      yield* test.start(1, "continue");
      yield* test.takeTurn;
      const sent = JSON.parse(body).messages;
      assert.equal(sent[1].content, "verified context");
      assert.deepStrictEqual(sent.slice(-2), [
        { role: "user", content: "earlier" },
        { role: "user", content: "continue" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("checks only local model health with redirects disabled", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          assert.equal(request.method, "GET");
          assert.equal(request.url, `${config.endpoint}/models`);
          assert.equal(
            Context.getOrUndefined(yield* Effect.context<never>(), FetchHttpClient.RequestInit)
              ?.redirect,
            "error",
          );
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: [{ id: config.model }] })),
          );
        }),
      );
      assert.equal(
        yield* probeDeepSeek(config).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        true,
      );
      assert.equal(
        yield* probeDeepSeek({ ...config, endpoint: "https://hosted.example/v1" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
        false,
      );
      assert.equal(isLoopbackEndpoint("http://localhost:8094/v1"), false);
      assert.equal(isLoopbackEndpoint("http://127.0.0.1:8094/v1?token=x"), false);
    }),
  );
  it.effect("times out stalled requests with a distinct safe failure code", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const test = yield* open(client);
      yield* test.start(1);
      yield* Deferred.await(started);
      yield* TestClock.adjust(config.requestTimeoutMs);
      const events = yield* test.takeTurn;
      assert.equal(
        events.find((event) => event.type === "turn.terminal")?.failure?.code,
        "timeout",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "defaults to disabled text-only capability and never contacts a service when disabled",
    () =>
      Effect.gen(function* () {
        assert.equal(config.enabled, false);
        assert.equal(config.smartRouting, false);
        assert.equal(config.taskMode, "text");
        const adapter = yield* DeepSeekAdapterV2Driver.create({
          instanceId,
          displayName: undefined,
          environment: [],
          enabled: false,
          config,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected network request")),
          ),
        );
        const capabilities = yield* adapter.getCapabilities();
        assert.equal(capabilities.tools.supportsMcpTools, false);
        assert.equal(capabilities.approvals.supportsCommandApproval, false);
        assert.equal(capabilities.checkpointing.providerCanRollbackConversation, false);
        assert.equal(capabilities.threads.canForkThread, false);
        const result = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("disabled"),
            modelSelection: selection,
            runtimePolicy: policy,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }).pipe(Effect.scoped),
  );

  it.effect("rejects remote endpoints and context overflow without a network request", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.die("Unexpected network request"));
      const remote = yield* requestCompletion(
        client,
        { ...config, endpoint: "https://hosted.example/v1" },
        [],
      ).pipe(Effect.result);
      assert.equal(remote._tag === "Failure" && remote.failure.category, "configuration");
      const large = yield* requestCompletion(client, config, [
        { role: "user", content: "x".repeat(config.contextWindowTokens) },
      ]).pipe(Effect.result);
      assert.equal(large._tag === "Failure" && large.failure.category, "context");
    }),
  );
});

const niaPolicy = { ...policy, toolPolicy: "d4-agent" as const };
const toolName = "d4_agent_environment";
const mcpEndpoint = "http://127.0.0.1:3000/mcp";
const niaRegistration = {
  environmentId: EnvironmentId.make("test-env"),
  threadId,
  providerInstanceId: instanceId,
  providerSessionId: "deepseek-session",
  endpoint: mcpEndpoint,
  authorizationHeader: "Bearer test-secret",
  browserToolsAvailable: false,
};
const mcpService = (present = true) =>
  McpProviderSessions.McpProviderSessions.of({
    set: () => Effect.void,
    clear: () => Effect.void,
    read: () => Effect.succeed(present ? niaRegistration : undefined),
  });
const sse = (toolCall: boolean) =>
  new Response(
    [
      {
        choices: [
          {
            index: 0,
            delta: toolCall
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: toolName, arguments: '{"scope":"current"}' },
                    },
                  ],
                }
              : { content: "Verified answer" },
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
const mockNiaFetch = (
  options: { failAfterTool?: boolean; stallTool?: (signal: AbortSignal) => Promise<Response> } = {},
) => {
  const modelRequests: { messages: unknown[]; tools: unknown[] }[] = [];
  const toolCalls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/chat/completions")) {
        assert.equal(new Headers(init?.headers).has("Authorization"), false);
        modelRequests.push(body);
        if (options.failAfterTool && modelRequests.length > 1)
          return new Response(null, { status: 503 });
        return sse(modelRequests.length === 1);
      }
      assert.equal(String(url), mcpEndpoint);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-secret");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        toolCalls.push(body.params);
        if (options.stallTool) return options.stallTool(init!.signal!);
      }
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : body.method === "tools/list"
            ? {
                tools: [
                  { name: toolName, inputSchema: { type: "object" } },
                  { name: "shell", inputSchema: { type: "object" } },
                ],
              }
            : { content: [{ type: "text", text: "Observed result" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return { modelRequests, toolCalls };
};
afterEach(() => vi.unstubAllGlobals());

describe("Nia DeepSeek adapter", () => {
  it.effect(
    "persists tool protocol history, exposes tool events and configured usage, and resumes after restart",
    () =>
      Effect.gen(function* () {
        const server = mockNiaFetch();
        const test = yield* open(reply(completion("unused")), {
          policy: niaPolicy,
          config: { ...config, contextWindowTokens: 250000 },
          appContext: [{ key: "project", text: "EXCLUDED APP CONTEXT" }],
        });
        assert.equal(test.runtime.providerSession.capabilities.tools.supportsMcpTools, true);
        yield* test.runtime.injectHistory!({
          providerThread: test.providerThread,
          context: "EXCLUDED APP INSTRUCTIONS",
          messages: [],
        });
        yield* test.start(1);
        const events = yield* test.takeTurn;
        assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
        assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "completed");
        assert.deepStrictEqual(server.toolCalls, [
          { name: toolName, arguments: { scope: "current" } },
        ]);
        assert.deepStrictEqual(server.modelRequests[0]?.messages, [
          { role: "system", content: D4_AGENT_PREFIX },
          { role: "user", content: "Hello" },
        ]);
        const toolItems = events
          .filter((event) => event.type === "turn_item.updated")
          .filter((event) => event.turnItem.type === "dynamic_tool");
        assert.equal(toolItems.length, 2);
        assert.equal(toolItems[0]?.turnItem.id, toolItems[1]?.turnItem.id);
        assert.equal(toolItems[0]?.turnItem.status, "running");
        assert.equal(toolItems[1]?.turnItem.status, "completed");
        assert.ok(toolItems[1]?.turnItem.type === "dynamic_tool");
        assert.deepStrictEqual(toolItems[1].turnItem.input, { scope: "current" });
        assert.match(String(toolItems[1].turnItem.output), /Observed result/);
        assert.deepStrictEqual(
          events.filter((event) => event.type === "node.updated").map((event) => event.node.status),
          ["running", "completed"],
        );
        const completed = events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.ok(completed?.type === "provider_turn.updated");
        assert.equal(completed.providerTurn.tokenUsage?.maxTokens, 250000);
        assert.equal(completed.providerTurn.tokenUsage?.usedTokens, 13);
        const saved = events.findLast((event) => event.type === "provider_thread.updated")!;
        assert.ok(saved.type === "provider_thread.updated");
        assert.equal(
          JSON.stringify(saved.providerThread.nativeMetadata).includes("test-secret"),
          false,
        );
        const restarted = yield* open(reply(completion("unused")), {
          policy: niaPolicy,
          existingProviderThread: saved.providerThread,
        });
        yield* restarted.runtime.injectHistory!({
          providerThread: restarted.providerThread,
          context: "EXCLUDED",
          messages: [],
        });
        yield* restarted.start(2, "After restart");
        yield* restarted.takeTurn;
        const history = server.modelRequests[2]?.messages as {
          role: string;
          tool_call_id?: string;
        }[];
        assert.deepStrictEqual(
          history.map((message) => message.role),
          ["system", "user", "assistant", "tool", "assistant", "user"],
        );
        assert.equal(history[3]?.tool_call_id, "call-1");
        yield* test.expectNoLateTerminal(2);
      }).pipe(
        Effect.provideService(McpProviderSessions.McpProviderSessions, mcpService()),
        Effect.scoped,
      ),
  );

  it.effect.each([false, true])(
    "fails closed without a registered Nia MCP session (service present: %s)",
    (servicePresent) =>
      Effect.gen(function* () {
        const fetch = vi.fn(() => Promise.reject(new Error("Unexpected request")));
        vi.stubGlobal("fetch", fetch);
        const effect = open(reply(completion("unused")), { policy: niaPolicy });
        const test = yield* servicePresent
          ? effect.pipe(
              Effect.provideService(McpProviderSessions.McpProviderSessions, mcpService(false)),
            )
          : effect;
        yield* test.start(1);
        const events = yield* test.takeTurn;
        assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "failed");
        assert.equal(
          events.find((event) => event.type === "turn.terminal")?.failure?.code,
          "configuration",
        );
        assert.equal(fetch.mock.calls.length, 0);
        const saved = events.findLast((event) => event.type === "provider_thread.updated");
        assert.ok(saved?.type === "provider_thread.updated");
        assert.deepStrictEqual(saved.providerThread.nativeMetadata?.deepSeekNiaHistory, [
          { role: "user", content: "Hello" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("retains completed tool history when subsequent generation fails", () =>
    Effect.gen(function* () {
      mockNiaFetch({ failAfterTool: true });
      const test = yield* open(reply(completion("unused")), { policy: niaPolicy });
      yield* test.start(1);
      const events = yield* test.takeTurn;
      assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "failed");
      const saved = events.findLast((event) => event.type === "provider_thread.updated");
      assert.ok(saved?.type === "provider_thread.updated");
      assert.deepStrictEqual(
        saved.providerThread.nativeMetadata?.deepSeekNiaHistory?.map((message) => message.role),
        ["user", "assistant", "tool"],
      );
      // The tool result must be committed before generation continues, not only at turn end.
      const committed = events.findIndex(
        (event) =>
          event.type === "provider_thread.updated" &&
          JSON.stringify(event.providerThread.nativeMetadata).includes("Observed result"),
      );
      const toolCompleted = events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed",
      );
      assert.ok(committed !== -1 && committed < toolCompleted);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      yield* test.expectNoLateTerminal(2);
      const failed = events.find(
        (event) => event.type === "provider_turn.updated" && event.providerTurn.status === "failed",
      );
      assert.ok(failed?.type === "provider_turn.updated");
      assert.equal(failed.providerTurn.tokenUsage?.usedTokens, 13);
      assert.equal(failed.providerTurn.tokenUsage?.maxTokens, config.contextWindowTokens);
    }).pipe(
      Effect.provideService(McpProviderSessions.McpProviderSessions, mcpService()),
      Effect.scoped,
    ),
  );

  it.effect("aborts a pending Nia tool request and closes its tool node with one terminal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let requestSignal: AbortSignal | undefined;
      mockNiaFetch({
        stallTool: (signal) => {
          requestSignal = signal;
          Deferred.doneUnsafe(started, Effect.void);
          return new Promise<Response>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      });
      const test = yield* open(reply(completion("unused")), { policy: niaPolicy });
      yield* test.start(1);
      yield* Deferred.await(started);
      yield* test.runtime.interruptTurn({
        providerThread: test.providerThread,
        providerTurnId: ProviderTurnId.make("deepseek:deepseek-test:attempt-1"),
      });
      const events = yield* test.takeTurn;
      assert.equal(requestSignal?.aborted, true);
      // The admitted request is committed before any model or tool work can be lost to a crash.
      const firstCommit = events.find(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.deepSeekNiaHistory !== undefined,
      );
      assert.ok(firstCommit?.type === "provider_thread.updated");
      assert.deepStrictEqual(firstCommit.providerThread.nativeMetadata?.deepSeekNiaHistory, [
        { role: "user", content: "Hello" },
      ]);
      assert.equal(events.filter((event) => event.type === "turn.terminal").length, 1);
      yield* test.expectNoLateTerminal(2);
      assert.equal(events.find((event) => event.type === "turn.terminal")?.status, "interrupted");
      assert.equal(
        events.findLast((event) => event.type === "node.updated")?.node.status,
        "interrupted",
      );
      const saved = events.findLast((event) => event.type === "provider_thread.updated");
      assert.ok(saved?.type === "provider_thread.updated");
      const history = saved.providerThread.nativeMetadata?.deepSeekNiaHistory;
      assert.deepStrictEqual(
        history?.map((message) => message.role),
        ["user", "assistant", "tool"],
      );
      assert.equal(history?.at(-1)?.tool_call_id, "call-1");
      assert.match(history?.at(-1)?.content ?? "", /completionVerified/);
    }).pipe(
      Effect.provideService(McpProviderSessions.McpProviderSessions, mcpService()),
      Effect.scoped,
    ),
  );
});
