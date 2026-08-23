// @effect-diagnostics nodeBuiltinImport:off, preferSchemaOverJson:off, anyUnknownInErrorContext:off
/**
 * Behavioural coverage for the agy adapter.
 *
 * Agy is the only provider driven as a spawned one-shot CLI (everything else
 * goes through an SDK or ACP), so it is the only adapter that owns process
 * lifecycle, stdin delivery, stream parsing, and exit-code interpretation
 * itself. That surface is where its bugs have actually lived, so it gets
 * direct tests rather than relying on the shared provider suites.
 *
 * Each case drives a scripted mock CLI so the real behaviour — argv, stdin,
 * stdout framing, exit codes — is exercised end to end.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AgySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@d4research/contracts";
import { makeAgyAdapter, type AgyAdapterLiveOptions } from "./AgyAdapter.ts";

const decodeSettings = Schema.decodeSync(AgySettings);

const stepUpdate = (text: string, conversationId = "conv-1") =>
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      text_delta: text,
    },
  });

const resultLine = (status: string, response?: string, conversationId = "conv-1") =>
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: conversationId,
      status,
      ...(response === undefined ? {} : { response }),
    },
  });

const initLine = (conversationId = "conv-1") =>
  JSON.stringify({ event: "init", conversation_id: conversationId });

/** Writes a node script that stands in for the agy binary. */
const writeMock = Effect.fn("writeMock")(function* (body: string) {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-behavior-")),
  );
  const file = NodePath.join(dir, "mock-agy.mjs");
  yield* Effect.promise(() => NodeFSP.writeFile(file, body, "utf8"));
  return { dir, file };
});

/** Emits the given stdout lines, then exits with `code`. */
const emitScript = (lines: ReadonlyArray<string>, code = 0) =>
  [
    // Drain stdin so the adapter's prompt write always has a reader.
    "process.stdin.resume();",
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    ...lines.map((line) => `  console.log(${JSON.stringify(line)});`),
    `  process.exit(${code});`,
    "});",
  ].join("\n");

const startAdapter = Effect.fn("startAdapter")(function* (
  mockFile: string,
  cwd: string,
  options?: AgyAdapterLiveOptions,
) {
  const adapter = yield* makeAgyAdapter(
    decodeSettings({
      binaryPath: process.execPath,
      launchArgs: mockFile,
      defaultModel: "gemini-test",
    }),
    options,
  );
  const threadId = ThreadId.make(`agy-behavior-${cwd.slice(-8)}`);
  yield* adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("agy"),
    cwd,
    runtimeMode: "full-access",
    modelSelection: {
      instanceId: ProviderInstanceId.make("agy"),
      model: "gemini-test",
    },
  });
  return { adapter, threadId };
});

const collectEvents = Effect.fn("collectEvents")(function* (
  adapter: Awaited<ReturnType<typeof makeAgyAdapter>> extends Effect.Effect<
    infer A,
    infer _E,
    infer _R
  >
    ? A
    : never,
) {
  const ref = yield* Ref.make<Array<{ type: string; payload?: unknown }>>([]);
  const fiber = yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Ref.update(ref, (events) => [
        ...events,
        { type: event.type, payload: "payload" in event ? event.payload : undefined },
      ]),
    ),
    Effect.forkChild,
  );
  // PubSub is intentionally hot. Let the subscription fiber enter the stream
  // before the test asks the adapter to publish turn events.
  for (let attempt = 0; attempt < 4; attempt += 1) yield* Effect.yieldNow;
  return { ref, fiber };
});

/** Yields enough for the adapter's forked stream fibers to drain. */
const settle = Effect.gen(function* () {
  for (let attempt = 0; attempt < 30; attempt += 1) yield* Effect.yieldNow;
});

/** Live-clock variant: also waits real time for the child process to move. */
const settleLive = Effect.gen(function* () {
  yield* Effect.sleep("150 millis");
  yield* settle;
});

it.layer(NodeServices.layer)("AgyAdapter behaviour", (it) => {
  it.effect("streams assistant deltas and records the turn transcript", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(
        emitScript([initLine(), stepUpdate("Hello "), stepUpdate("world."), resultLine("SUCCESS")]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const seen = yield* Ref.get(events.ref);
      const deltas = seen
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.payload as { delta: string }).delta);
      assert.deepStrictEqual(deltas, ["Hello ", "world."]);

      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(thread.turns[0]), "Hello world.");
    }).pipe(Effect.scoped),
  );

  it.effect("prefers the final result text over accumulated deltas", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(
        emitScript([stepUpdate("partial"), resultLine("SUCCESS", "the final answer")]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      const thread = yield* adapter.readThread(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(thread.turns[0]), "the final answer");
      const deltas = (yield* Ref.get(events.ref))
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.payload as { delta: string }).delta);
      assert.deepStrictEqual(
        deltas,
        ["partial"],
        "a divergent terminal response must not be appended as duplicated live text",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("streams an answer returned only in the terminal result", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS", "result-only answer")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const deltas = (yield* Ref.get(events.ref))
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.payload as { delta: string }).delta);
      assert.deepStrictEqual(deltas, ["result-only answer"]);
      const thread = yield* adapter.readThread(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(thread.turns[0]), "result-only answer");
    }).pipe(Effect.scoped),
  );

  it.effect("captures the resume cursor from the stream", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(
        emitScript([initLine("conv-resume"), resultLine("SUCCESS", "ok", "conv-resume")]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const turn = yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      assert.deepStrictEqual(turn.resumeCursor, {
        schemaVersion: 1,
        conversationId: "conv-resume",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports a non-SUCCESS result as a failed turn carrying stderr", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(
        [
          "process.stdin.resume();",
          'process.stdin.on("data", () => {});',
          'process.stdin.on("end", () => {',
          '  process.stderr.write("model quota exhausted");',
          // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a protocol fixture in mock source.
          `  console.log(${JSON.stringify(resultLine("ERROR"))});`,
          "  process.exit(1);",
          "});",
        ].join("\n"),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "hi", attachments: [] }));
      assert.isTrue(Exit.isFailure(exit), "a failed agy turn must surface as an error");
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const seen = yield* Ref.get(events.ref);
      const completed = seen.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      const payload = completed?.payload as { state: string; errorMessage?: string };
      assert.equal(payload.state, "failed");
      assert.include(payload.errorMessage ?? "", "model quota exhausted");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects SUCCESS without assistant output and emits a failed completion", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "hi", attachments: [] }));
      assert.isTrue(Exit.isFailure(exit), "empty SUCCESS must not masquerade as useful output");
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const completed = (yield* Ref.get(events.ref)).filter(
        (event) => event.type === "turn.completed",
      );
      assert.equal(completed.length, 1);
      assert.deepStrictEqual(completed[0]?.payload, {
        state: "failed",
        errorMessage: "Agy returned SUCCESS without assistant output.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("balances turn.started when command spawn fails before a process exists", () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-missing-binary-")),
      );
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: NodePath.join(cwd, "definitely-missing-agy"),
          defaultModel: "gemini-test",
        }),
      );
      const threadId = ThreadId.make("agy-spawn-failure");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
      });
      const events = yield* collectEvents(adapter);

      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "hi", attachments: [] }));
      assert.isTrue(Exit.isFailure(exit));
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const turnEvents = (yield* Ref.get(events.ref)).filter(
        (event) => event.type === "turn.started" || event.type === "turn.completed",
      );
      assert.deepStrictEqual(
        turnEvents.map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.equal((turnEvents[1]?.payload as { state?: string } | undefined)?.state, "failed");
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores malformed stdout lines instead of failing the turn", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(
        emitScript([
          "not json at all",
          '{"event":"unknown_kind"}',
          "",
          stepUpdate("still fine"),
          resultLine("SUCCESS", "still fine"),
        ]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const turn = yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      assert.isDefined(turn.turnId);
      const thread = yield* adapter.readThread(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(thread.turns[0]), "still fine");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an empty prompt without spawning", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("requires a cwd on startSession", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({ binaryPath: process.execPath, launchArgs: mock.file }),
      );
      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("agy-no-cwd"),
          provider: ProviderDriverKind.make("agy"),
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(exit), "a session without cwd must not start");
    }).pipe(Effect.scoped),
  );

  it.effect("fails a turn for an unknown thread", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({ binaryPath: process.execPath, launchArgs: mock.file }),
      );
      const exit = yield* Effect.exit(
        adapter.sendTurn({
          threadId: ThreadId.make("agy-missing"),
          input: "hi",
          attachments: [],
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("drops the session on stopSession so later turns fail loudly", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS", "ok")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const exit = yield* Effect.exit(adapter.readThread(threadId));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("lists live sessions and does not expose stopped ones", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS", "ok")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      assert.equal((yield* adapter.listSessions()).length, 1);
      yield* adapter.stopSession(threadId);
      assert.equal((yield* adapter.listSessions()).length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reports interactive callbacks as unsupported", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(emitScript([resultLine("SUCCESS", "ok")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - deliberately tests unsupported heterogeneous calls.
      for (const call of [
        adapter.respondToRequest(threadId),
        adapter.respondToUserInput(threadId),
        adapter.rollbackThread(threadId),
      ] as ReadonlyArray<Effect.Effect<unknown, unknown, never>>) {
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off - failure shape is the subject under test.
        assert.isTrue(Exit.isFailure(yield* Effect.exit(call)));
      }
    }).pipe(Effect.scoped),
  );
});

const HANGING_MOCK = [
  "process.stdin.resume();",
  'process.stdin.on("data", () => {});',
  "setInterval(() => {}, 1000);",
].join("\n");

const EXIT_WITH_OPEN_PIPE_MOCK = [
  'import { spawn } from "node:child_process";',
  "process.stdin.resume();",
  'process.stdin.on("data", () => {});',
  'process.stdin.on("end", () => {',
  // The grandchild inherits stdout/stderr for one second after its parent
  // exits. Waiting only on exitCode passes; joining the pipe readers wedges.
  '  spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: ["ignore", 1, 2] });',
  `  console.log(${JSON.stringify(resultLine("SUCCESS", "parent answered"))});`,
  "  process.exit(0);",
  "});",
].join("\n");

// These two drive a real child process against a real deadline, so they run on
// the live clock — a TestClock never advances on its own while the process is
// running, and the turn would simply hang.
describe("AgyAdapter process lifecycle", () => {
  it.live("atomically rejects a second concurrent turn on the same adapter and thread", () =>
    Effect.gen(function* () {
      const delayedSuccess = [
        "process.stdin.resume();",
        'process.stdin.on("data", () => {});',
        'process.stdin.on("end", () => {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds an exact protocol line in mock source.
        `  setTimeout(() => { console.log(${JSON.stringify(
          resultLine("SUCCESS", "winner"),
        )}); process.exit(0); }, 80);`,
        "});",
      ].join("\n");
      const mock = yield* writeMock(delayedSuccess);
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      const exits = yield* Effect.all(
        [
          Effect.exit(adapter.sendTurn({ threadId, input: "first", attachments: [] })),
          Effect.exit(adapter.sendTurn({ threadId, input: "second", attachments: [] })),
        ],
        { concurrency: 2 },
      );
      yield* settleLive;
      yield* Fiber.interrupt(events.fiber);

      assert.equal(exits.filter(Exit.isSuccess).length, 1);
      const failures = exits.filter(Exit.isFailure);
      assert.equal(failures.length, 1);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - searches a captured failure for the busy sentinel.
      assert.include(JSON.stringify(failures[0]), "already has a turn in progress");
      const seen = yield* Ref.get(events.ref);
      assert.equal(seen.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(seen.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  /**
   * Regression: a turn that blew the server-side deadline never reached its
   * teardown, so the child process leaked and `context.process` stayed set —
   * wedging the session so every later turn was refused as "already has a turn
   * in progress". A timed-out turn must leave the session reusable.
   */
  it.live("leaves the session usable after a turn times out", () =>
    Effect.gen(function* () {
      const hangingMock = yield* writeMock(HANGING_MOCK);
      const { adapter, threadId } = yield* startAdapter(hangingMock.file, hangingMock.dir, {
        turnTimeout: "150 millis",
      });

      const timedOut = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hang please", attachments: [] }),
      );
      assert.isTrue(Exit.isFailure(timedOut), "a hung turn must fail, not hang forever");

      // The session must accept another turn rather than reporting a phantom
      // in-flight turn forever.
      const second = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "are you there", attachments: [] }),
      );
      const refusedAsBusy =
        Exit.isFailure(second) &&
        // @effect-diagnostics-next-line preferSchemaOverJson:off - searches a diagnostic failure for the busy sentinel.
        JSON.stringify(second).includes("already has a turn in progress");
      assert.isFalse(refusedAsBusy, "session stayed wedged after a timeout");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("bounds stream drains when a descendant keeps the parent pipes open", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock(EXIT_WITH_OPEN_PIPE_MOCK);
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir, {
        turnTimeout: "150 millis",
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "exit with inherited pipes", attachments: [] }),
      );
      assert.isTrue(Exit.isFailure(exit), "an open inherited pipe must hit the turn deadline");

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("marks an interrupted turn cancelled rather than failed", () =>
    Effect.gen(function* () {
      const hangingMock = yield* writeMock(HANGING_MOCK);
      const { adapter, threadId } = yield* startAdapter(hangingMock.file, hangingMock.dir);
      const events = yield* collectEvents(adapter);

      // Let the child actually start before interrupting it.
      yield* settleLive;
      const turnFiber = yield* Effect.forkChild(
        Effect.exit(adapter.sendTurn({ threadId, input: "long work", attachments: [] })),
      );
      yield* settleLive;
      yield* adapter.interruptTurn(threadId, undefined as never);
      yield* Fiber.join(turnFiber);
      yield* settleLive;
      yield* Fiber.interrupt(events.fiber);

      const seen = yield* Ref.get(events.ref);
      const completed = seen.find((event) => event.type === "turn.completed");
      assert.isDefined(
        completed,
        `an interrupted turn must still complete; saw: ${seen.map((event) => event.type).join(", ")}`,
      );
      const payload = completed?.payload as { state: string } | undefined;
      assert.equal(payload?.state, "cancelled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
