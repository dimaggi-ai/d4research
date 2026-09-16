import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@d4research/contracts";
import { Effect, Layer, Queue, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeMockMuse } from "../msp/mspTestUtils.ts";
import { makeMuseAdapter } from "./MuseAdapter.ts";

interface LoggedT3CodeMcpServer {
  readonly transport?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly mode?: string;
}

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "muse-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.fn("setup")(function* (
  env: Record<string, string> = {},
  options: { readonly argvLog?: boolean } = {},
) {
  const mock = yield* makeMockMuse(env, options);
  const adapter = yield* makeMuseAdapter(mock.settings);
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const events: ProviderRuntimeEvent[] = [];
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => {
      events.push(event);
      return Queue.offer(queue, event);
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  const wait = <T extends ProviderRuntimeEvent["type"]>(
    type: T,
  ): Effect.Effect<Extract<ProviderRuntimeEvent, { type: T }>> =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
      }
    });
  const threadId = ThreadId.make("muse-test");
  const next = Queue.take(queue);
  return {
    ...mock,
    adapter,
    events,
    wait,
    next,
    threadId,
    start: (runtimeMode: "full-access" | "approval-required" = "approval-required") =>
      adapter.startSession({ threadId, cwd: mock.directory, runtimeMode }),
  };
});
it.layer(layer)("MuseAdapter", (it) => {
  it.effect("streams turn content, tool patches and unknown items with UUIDv7 commands", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_REASONING: "1", T3_MSP_EMIT_TOOL: "1" });
      yield* f.start();
      const sent = yield* f.adapter.sendTurn({ threadId: f.threadId, input: "Hello" });
      assert.equal(sent.turnId[14], "7");
      const completed = yield* f.wait("turn.completed");
      assert.equal(completed.payload.state, "completed");
      assert.isTrue(
        f.events.some((e) => e.type === "content.delta" && e.payload.delta === "Hello from Muse"),
      );
      assert.isTrue(
        f.events.some((e) => e.type === "item.completed" && e.payload.itemType === "file_change"),
      );
      assert.isTrue(
        f.events.some((e) => e.type === "item.completed" && e.payload.itemType === "unknown"),
      );
      assert.deepEqual((yield* f.adapter.readThread(f.threadId)).turns, []);
      assert.equal(
        (yield* f.adapter.rollbackThread(f.threadId, 1).pipe(Effect.flip))._tag,
        "ProviderAdapterRequestError",
      );
      const sessions = yield* f.adapter.listSessions();
      assert.notDeepEqual(sessions[0]?.resumeCursor, sent.resumeCursor);
      yield* f.adapter.stopAll();
    }),
  );
  for (const decision of ["accept", "decline"] as const)
    it.effect(`round-trips ${decision} approval with required feedback`, () =>
      Effect.gen(function* () {
        const f = yield* setup({ T3_MSP_EMIT_APPROVAL: "1" });
        yield* f.start();
        yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
        const opened = yield* f.wait("request.opened");
        yield* f.adapter.respondToRequest(
          f.threadId,
          ApprovalRequestId.make(opened.requestId!),
          decision,
        );
        yield* f.wait("turn.completed");
        assert.equal(f.events.filter((e) => e.type === "request.resolved").length, 1);
        const requests = yield* f.readRequests();
        assert.equal(
          requests.find((r) => r.method === "approval/decide")?.params?.choiceId,
          decision === "accept" ? "allow" : "deny",
        );
      }),
    );
  it.effect("auto-decides full-access approvals", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_APPROVAL: "1" });
      yield* f.start("full-access");
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
      yield* f.wait("turn.completed");
      assert.isFalse(f.events.some((e) => e.type === "request.opened"));
    }),
  );
  for (const multi of [false, true])
    it.effect(`answers ${multi ? "multiple" : "single"} choice user input once`, () =>
      Effect.gen(function* () {
        const f = yield* setup({
          T3_MSP_EMIT_USER_INPUT: "1",
          T3_MSP_MULTISELECT: multi ? "1" : "0",
        });
        yield* f.start();
        yield* f.adapter.sendTurn({ threadId: f.threadId, input: "ask" });
        const opened = yield* f.wait("user-input.requested");
        yield* f.adapter.respondToUserInput(f.threadId, ApprovalRequestId.make(opened.requestId!), {
          q: multi ? ["Blue", "Green"] : "Blue",
        });
        yield* f.wait("turn.completed");
        assert.equal(f.events.filter((e) => e.type === "user-input.resolved").length, 1);
        const request = (yield* f.readRequests()).find((r) => r.method === "userInput/answer");
        assert.deepEqual(request?.params?.answers, [
          {
            questionId: "q",
            ...(multi ? { selectedLabels: ["Blue", "Green"] } : { selectedLabel: "Blue" }),
          },
        ]);
      }),
    );
  it.effect("cancels unknown user answers", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_USER_INPUT: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "ask" });
      const opened = yield* f.wait("user-input.requested");
      yield* f.adapter.respondToUserInput(f.threadId, ApprovalRequestId.make(opened.requestId!), {
        q: "Orange",
      });
      yield* f.wait("turn.completed");
      assert.isTrue((yield* f.readRequests()).some((r) => r.method === "userInput/cancel"));
    }),
  );
  it.effect("interrupts only through a cancelled terminal", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_HANG_TURN: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
      yield* f.wait("turn.started");
      yield* f.adapter.interruptTurn(f.threadId);
      assert.equal((yield* f.wait("turn.completed")).payload.state, "cancelled");
      assert.isFalse(f.events.some((e) => e.type === "turn.aborted"));
    }),
  );
  it.effect("resumes with its latest cursor and applies approval mode", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
      yield* f.wait("turn.completed");
      const resumeCursor = (yield* f.adapter.listSessions())[0]!.resumeCursor;
      yield* f.adapter.stopSession(f.threadId);
      yield* f.adapter.startSession({
        threadId: f.threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        resumeCursor,
      });
      const requests = yield* f.readRequests();
      assert.isTrue(
        requests.some((r) => r.method === "session/resume" && r.params?.excludeItems === true),
      );
      assert.isTrue(
        requests.some(
          (r) => r.method === "session/setApprovalMode" && r.params?.mode === "allowAll",
        ),
      );
    }),
  );
  it.effect("retries approval ceilings with the host default", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_APPROVAL_CEILING: "1" });
      yield* f.start();
      assert.include((yield* f.wait("runtime.warning")).payload.message, "host default");
      const starts = (yield* f.readRequests()).filter((r) => r.method === "session/start");
      assert.equal(starts.length, 2);
      assert.equal(starts[1]?.params?.approvalMode, null);
    }),
  );
  it.effect("injects the per-thread t3-code MCP server on start and resume", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId: f.threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("muse"),
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer test",
        capabilities: new Set(["preview", "research", "pull-requests"]),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(f.threadId)),
      );
      yield* f.start();
      const resumeCursor = (yield* f.adapter.listSessions())[0]!.resumeCursor;
      yield* f.adapter.stopSession(f.threadId);
      yield* f.adapter.startSession({
        threadId: f.threadId,
        cwd: f.directory,
        runtimeMode: "approval-required",
        resumeCursor,
      });
      const requests = yield* f.readRequests();
      const lifecycle = requests.filter(
        (r) => r.method === "session/start" || r.method === "session/resume",
      );
      assert.equal(lifecycle.length, 2);
      for (const request of lifecycle) {
        const servers = (
          request.params?.config as { mcpServers?: Record<string, LoggedT3CodeMcpServer> }
        )?.mcpServers;
        assert.equal(servers?.["t3-code"]?.transport, "streamableHttp");
        assert.equal(servers?.["t3-code"]?.url, "http://127.0.0.1:1/mcp");
        assert.equal(servers?.["t3-code"]?.headers?.Authorization, "Bearer test");
        assert.equal(servers?.["t3-code"]?.mode, "optional");
      }
      yield* f.adapter.stopSession(f.threadId);
    }),
  );
  it.effect("starts without MCP config and warns when the host denies sessionMcp", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_DENY_SESSION_MCP: "1" });
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId: f.threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("muse"),
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer [REDACTED]",
        capabilities: new Set(["preview", "research", "pull-requests"]),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(f.threadId)),
      );
      yield* f.start();
      assert.equal(
        (yield* f.wait("runtime.warning")).payload.message,
        "Muse host did not grant the sessionMcp capability; d4research MCP tools are unavailable in this session",
      );
      const starts = (yield* f.readRequests()).filter((r) => r.method === "session/start");
      assert.equal(starts.length, 1);
      assert.isUndefined(starts[0]?.params?.config);
      assert.equal((yield* f.adapter.listSessions()).length, 1);
      yield* f.adapter.stopSession(f.threadId);
    }),
  );
  it.effect("reports process exit and rejects the pending turn", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EXIT_ON_TURN: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" }).pipe(Effect.flip);
      assert.equal((yield* f.wait("session.exited")).payload.exitKind, "error");
      assert.isFalse(yield* f.adapter.hasSession(f.threadId));
    }),
  );
  it.effect("switches model before starting a turn and emits native compaction", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.start();
      yield* f.adapter.sendTurn({
        threadId: f.threadId,
        input: "run",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "other",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* f.wait("turn.completed");
      const requests = yield* f.readRequests();
      assert.isTrue(
        requests.findIndex((r) => r.method === "session/setModel") <
          requests.findIndex((r) => r.method === "turn/start"),
      );
      assert.equal(
        requests.find((r) => r.method === "turn/start")?.params?.reasoningEffort,
        "high",
      );
      yield* f.adapter.compaction.start(f.threadId);
      assert.equal((yield* f.wait("thread.state.changed")).payload.state, "compacted");
    }),
  );
  it.effect("drops stale approvals with a warning", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_APPROVAL: "1", T3_MSP_STALE_APPROVAL: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
      const opened = yield* f.wait("request.opened");
      yield* f.adapter.respondToRequest(
        f.threadId,
        ApprovalRequestId.make(opened.requestId!),
        "accept",
      );
      assert.include((yield* f.wait("runtime.warning")).payload.message, "requirements changed");
      assert.equal((yield* f.wait("request.resolved")).payload.decision, "cancel");
    }),
  );
  it.effect("does not auto-approve protected writes in full access", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_APPROVAL: "1", T3_MSP_PROTECTED_WRITE: "1" });
      yield* f.start("full-access");
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "run" });
      const opened = yield* f.wait("request.opened");
      yield* f.adapter.stopSession(f.threadId);
      assert.equal((yield* f.wait("request.resolved")).requestId, opened.requestId);
    }),
  );
  it.effect("reports a no-op compaction", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_COMPACT_NOOP: "1" });
      yield* f.start();
      yield* f.adapter.compaction.start(f.threadId);
      assert.equal((yield* f.wait("runtime.warning")).payload.message, "Nothing to compact");
    }),
  );
  it.effect("emits unified diffs for edit tool calls", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_TOOL: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "edit" });
      // The patch fetch races the turn completion, so accept either order.
      let completed = false;
      let diffed = false;
      while (!completed || !diffed) {
        const event = yield* f.next;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.diff.updated") diffed = true;
      }
      const diff = f.events.find((event) => event.type === "turn.diff.updated");
      assert.equal(
        diff?.type === "turn.diff.updated" ? diff.payload.unifiedDiff : undefined,
        "--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
      );
      assert.isTrue((yield* f.readRequests()).some((r) => r.method === "item/readOutput"));
      yield* f.adapter.stopAll();
    }),
  );
  it.effect("warns instead of diffing when the patch body is unavailable", () =>
    Effect.gen(function* () {
      const f = yield* setup({ T3_MSP_EMIT_TOOL: "1", T3_MSP_READOUTPUT_FAIL: "1" });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "edit" });
      let completed = false;
      let warned = false;
      while (!completed || !warned) {
        const event = yield* f.next;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "runtime.warning") warned = true;
      }
      const warning = f.events.find(
        (event) => event.type === "runtime.warning" && event.payload.message.includes("patch"),
      );
      assert.isDefined(warning);
      assert.isFalse(f.events.some((event) => event.type === "turn.diff.updated"));
      yield* f.adapter.stopAll();
    }),
  );
  it.effect("respawns the host with read-only flags for plan mode", () =>
    Effect.gen(function* () {
      const f = yield* setup({}, { argvLog: true });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "one" });
      yield* f.wait("turn.completed");
      assert.equal((yield* f.readArgv()).length, 1);
      assert.notInclude((yield* f.readArgv())[0]!, "--disable-write");
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "two", interactionMode: "plan" });
      yield* f.wait("turn.completed");
      // The retired host's last gasp must not surface or stop the session.
      assert.isFalse(f.events.some((event) => event.type === "session.exited"));
      assert.equal((yield* f.readArgv()).length, 2);
      assert.include((yield* f.readArgv())[1]!, "--disable-write");
      assert.include((yield* f.readArgv())[1]!, "--disable-shell");
      assert.include((yield* f.readArgv())[1]!, "--trust-workspace");
      assert.isTrue((yield* f.readRequests()).some((r) => r.method === "session/resume"));
      // Leaving plan mode respawns again without the read-only flags.
      yield* f.adapter.sendTurn({
        threadId: f.threadId,
        input: "three",
        interactionMode: "default",
      });
      yield* f.wait("turn.completed");
      assert.equal((yield* f.readArgv()).length, 3);
      assert.notInclude((yield* f.readArgv())[2]!, "--disable-write");
      yield* f.adapter.stopAll();
    }),
  );
  it.effect("keeps the host when the mode does not change", () =>
    Effect.gen(function* () {
      const f = yield* setup({}, { argvLog: true });
      yield* f.start();
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "one" });
      yield* f.wait("turn.completed");
      yield* f.adapter.sendTurn({ threadId: f.threadId, input: "two" });
      yield* f.wait("turn.completed");
      assert.equal((yield* f.readArgv()).length, 1);
      yield* f.adapter.stopAll();
    }),
  );
});
