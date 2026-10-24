import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { requestCompletion } from "./http.ts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
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
} from "@d4research/contracts";
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
const open = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const adapter = yield* DeepSeekAdapterV2Driver.create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config,
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("deepseek-session"),
      modelSelection: selection,
      runtimePolicy: policy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection,
      runtimePolicy: policy,
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
        runtimePolicy: policy,
      });
    const takeTurn = runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    return { runtime, providerThread, start, takeTurn };
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
