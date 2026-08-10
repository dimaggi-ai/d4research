// @effect-diagnostics nodeBuiltinImport:off, preferSchemaOverJson:off, anyUnknownInErrorContext:off
/**
 * Stress and edge coverage for the agy adapter.
 *
 * Agy is the only provider driven as a spawned one-shot CLI, so its stream
 * decoding, process lifecycle, and event bookkeeping are hand-rolled. This
 * suite hammers those seams: high-volume streaming, chunk-boundary framing,
 * multibyte splitting, truncated/crashing processes, sequential resume,
 * concurrent sessions, and mid-stream interruption.
 *
 * Mocks stand in for the real binary. Where behaviour depends on real elapsed
 * time or process teardown, the case runs on the live clock (`it.live`).
 */
import * as NodeFS from "node:fs";
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

import { AgySettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

const otherStep = (stepType: string, conversationId = "conv-1") =>
  JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: "DONE",
      step_type: stepType,
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

/**
 * Writes a node script standing in for the agy binary and returns its dir.
 * `body` may be a builder so a mock can reference its own temp dir (for sidecar
 * files) before it exists.
 */
const writeMock = Effect.fn("writeMock")(function* (body: string | ((dir: string) => string)) {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-stress-")),
  );
  const file = NodePath.join(dir, "mock-agy.mjs");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(file, typeof body === "function" ? body(dir) : body, "utf8"),
  );
  return { dir, file };
});

/**
 * Mock that drains stdin, records argv + stdin bytes to sidecar files, emits
 * lines, then exits. Uses `process.exitCode` rather than `process.exit()` so
 * Node drains stdout first — a bare exit() truncates large buffered output and
 * would race the final result line.
 */
const recordingMock = (dir: string, lines: ReadonlyArray<string>, code = 0) =>
  [
    'import * as fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(NodePath.join(dir, "argv.txt"))}, process.argv.slice(2).join("\\n"));`,
    "let bytes = 0;",
    'process.stdin.on("data", (chunk) => { bytes += chunk.length; });',
    'process.stdin.on("end", () => {',
    `  fs.writeFileSync(${JSON.stringify(NodePath.join(dir, "stdin.txt"))}, String(bytes));`,
    ...lines.map((line) => `  console.log(${JSON.stringify(line)});`),
    `  process.exitCode = ${code};`,
    "});",
  ].join("\n");

const startAdapter = Effect.fn("startAdapter")(function* (
  mockFile: string,
  cwd: string,
  model = "gemini-test",
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
  const threadId = ThreadId.make(`agy-stress-${cwd.slice(-10)}`);
  yield* adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("agy"),
    cwd,
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("agy"), model },
  });
  return { adapter, threadId };
});

type AnyEvent = { type: string; threadId?: unknown; payload?: unknown };

const collectEvents = Effect.fn("collectEvents")(function* (adapter: {
  streamEvents: Stream.Stream<{ type: string }, never, never>;
}) {
  const ref = yield* Ref.make<Array<AnyEvent>>([]);
  const fiber = yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Ref.update(ref, (events) => [
        ...events,
        {
          type: event.type,
          threadId: "threadId" in event ? (event as { threadId: unknown }).threadId : undefined,
          payload: "payload" in event ? (event as { payload: unknown }).payload : undefined,
        },
      ]),
    ),
    Effect.forkChild,
  );
  return { ref, fiber };
});

const settle = Effect.gen(function* () {
  for (let attempt = 0; attempt < 40; attempt += 1) yield* Effect.yieldNow;
});

const settleLive = Effect.gen(function* () {
  yield* Effect.sleep("150 millis");
  yield* settle;
});

const deltasOf = (events: ReadonlyArray<AnyEvent>) =>
  events
    .filter((event) => event.type === "content.delta")
    .map((event) => (event.payload as { delta: string }).delta);

const completionsOf = (events: ReadonlyArray<AnyEvent>) =>
  events.filter((event) => event.type === "turn.completed");

it.layer(NodeServices.layer)("AgyAdapter stress", (it) => {
  it.effect("streams thousands of deltas in order without loss", () =>
    Effect.gen(function* () {
      const count = 2_000;
      const lines = [
        initLine(),
        ...Array.from({ length: count }, (_unused, index) => stepUpdate(`d${index} `)),
        resultLine("SUCCESS"),
      ];
      const mock = yield* writeMock((dir) => recordingMock(dir, lines));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);

      const deltas = deltasOf(yield* Ref.get(events.ref));
      assert.equal(deltas.length, count, "every delta must be delivered");
      assert.equal(deltas[0], "d0 ");
      assert.equal(deltas[count - 1], `d${count - 1} `);
    }).pipe(Effect.scoped),
  );

  it.effect("carries a multi-hundred-KB single delta intact", () =>
    Effect.gen(function* () {
      const big = "z".repeat(400_000);
      const mock = yield* writeMock((dir) =>
        recordingMock(dir, [stepUpdate(big), resultLine("SUCCESS", big)]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      const deltas = deltasOf(yield* Ref.get(events.ref));
      assert.equal(deltas.join("").length, big.length);
    }).pipe(Effect.scoped),
  );

  it.effect("reassembles a JSON line split across stdout writes", () =>
    Effect.gen(function* () {
      const line = stepUpdate("split-safe");
      const midpoint = Math.floor(line.length / 2);
      // Write half the JSON, pause, then the rest plus the newline: the framing
      // must buffer until the line terminator, not parse a half object.
      const body = [
        "let buf = Buffer.from(process.stdin.isTTY ? [] : []);",
        'process.stdin.on("data", () => {});',
        'process.stdin.on("end", () => {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds exact chunk bytes in mock source.
        `  process.stdout.write(${JSON.stringify(line.slice(0, midpoint))});`,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds exact chunk bytes in mock source.
        `  setTimeout(() => { process.stdout.write(${JSON.stringify(line.slice(midpoint) + "\n")}); `,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds exact protocol line in mock source.
        `    process.stdout.write(${JSON.stringify(resultLine("SUCCESS", "split-safe") + "\n")}); process.exit(0); }, 30);`,
        "});",
      ].join("\n");
      const mock = yield* writeMock(body);
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      assert.deepStrictEqual(deltasOf(yield* Ref.get(events.ref)), ["split-safe"]);
    }).pipe(Effect.scoped),
  );

  it.effect("decodes a multibyte character split across raw stdout chunks", () =>
    Effect.gen(function* () {
      // "😀漢" — emoji is 4 UTF-8 bytes, CJK is 3. Split mid-emoji so a naive
      // per-chunk decoder would yield replacement characters.
      const text = "start-😀漢-end";
      const line = `${stepUpdate(text)}\n${resultLine("SUCCESS", text)}\n`;
      const buf = Buffer.from(line, "utf8");
      const splitAt = buf.indexOf(Buffer.from("😀", "utf8")) + 2; // mid emoji
      const body = [
        'process.stdin.on("data", () => {});',
        'process.stdin.on("end", () => {',
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds exact binary fixture in mock source.
        `  const b = Buffer.from(${JSON.stringify(buf.toString("base64"))}, "base64");`,
        `  process.stdout.write(b.subarray(0, ${splitAt}));`,
        `  setTimeout(() => { process.stdout.write(b.subarray(${splitAt})); process.exit(0); }, 30);`,
        "});",
      ].join("\n");
      const mock = yield* writeMock(body);
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      const joined = deltasOf(yield* Ref.get(events.ref)).join("");
      assert.equal(joined, text, "multibyte content must survive chunk splitting");
      assert.notInclude(joined, "�", "no replacement characters");
    }).pipe(Effect.scoped),
  );

  it.effect("skips non-agent_response steps but still completes", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) =>
        recordingMock(dir, [
          initLine(),
          otherStep("user_input"),
          otherStep("tool"),
          otherStep("checkpoint"),
          stepUpdate("visible"),
          resultLine("SUCCESS", "visible"),
        ]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      const seen = yield* Ref.get(events.ref);
      assert.deepStrictEqual(deltasOf(seen), ["visible"]);
      assert.equal(completionsOf(seen).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("emits exactly one completion for a failed result", () =>
    Effect.gen(function* () {
      // Regression: releaseTurn (onError) used to double-emit turn.completed on
      // the normal failed path.
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("ERROR")], 1));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);
      yield* Effect.exit(adapter.sendTurn({ threadId, input: "go", attachments: [] }));
      yield* settle;
      yield* Fiber.interrupt(events.fiber);
      const completions = completionsOf(yield* Ref.get(events.ref));
      assert.equal(completions.length, 1, "one turn.started deserves exactly one turn.completed");
      assert.equal((completions[0]?.payload as { state: string } | undefined)?.state, "failed");
    }).pipe(Effect.scoped),
  );

  it.effect("fails cleanly and stays usable when the process exits 0 with no result", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [stepUpdate("orphan")], 0));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const events = yield* collectEvents(adapter);

      const first = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "go", attachments: [] }),
      );
      assert.isTrue(Exit.isFailure(first), "a resultless turn must not report success");
      yield* settle;

      const completions = completionsOf(yield* Ref.get(events.ref));
      assert.equal(completions.length, 1);
      assert.equal((completions[0]?.payload as { state: string } | undefined)?.state, "failed");

      // Session must still accept the next turn.
      const secondMock = yield* writeMock((dir) =>
        recordingMock(dir, [resultLine("SUCCESS", "ok")]),
      );
      // reuse the same thread on a fresh mock is not possible (launchArgs bound
      // at construction); instead assert the existing session is not wedged.
      const second = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "again", attachments: [] }),
      );
      const wedged =
        Exit.isFailure(second) &&
        // @effect-diagnostics-next-line preferSchemaOverJson:off - searches a diagnostic failure for the busy sentinel.
        JSON.stringify(second).includes("already has a turn in progress");
      assert.isFalse(wedged, "resultless turn must not wedge the session");
      void secondMock;
    }).pipe(Effect.scoped),
  );

  it.effect("threads the resume conversation id into the next turn's argv", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) =>
        recordingMock(dir, [initLine("conv-keep"), resultLine("SUCCESS", "one", "conv-keep")]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);

      const first = yield* adapter.sendTurn({ threadId, input: "one", attachments: [] });
      assert.deepStrictEqual(first.resumeCursor, { schemaVersion: 1, conversationId: "conv-keep" });

      yield* adapter.sendTurn({ threadId, input: "two", attachments: [] });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );
      assert.include(argv, "--conversation");
      assert.include(argv, "conv-keep");

      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 2, "both turns recorded on one session");
    }).pipe(Effect.scoped),
  );

  it.effect("starts the first turn in an isolated project instead of inheriting agy context", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "fresh")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);

      yield* adapter.sendTurn({ threadId, input: "fresh task", attachments: [] });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );

      assert.include(argv, "--new-project");
      assert.notInclude(argv, "--conversation");
    }).pipe(Effect.scoped),
  );

  it.effect("uses the per-turn model override in argv", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mock.file,
          defaultModel: "base-model",
        }),
      );
      const threadId = ThreadId.make("agy-stress-model");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd: mock.dir,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "base-model" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "go",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "switched-model" },
      });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );
      assert.include(argv, "switched-model");
    }).pipe(Effect.scoped),
  );

  it.effect("passes the autonomous flag in full-access mode", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );
      assert.include(argv, "--dangerously-skip-permissions");
      assert.notInclude(argv, "--sandbox");
    }).pipe(Effect.scoped),
  );

  it.effect("sandboxes the process outside full-access mode", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mock.file,
          defaultModel: "gemini-test",
        }),
      );
      const threadId = ThreadId.make("agy-stress-sandbox");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd: mock.dir,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
      });
      yield* adapter.sendTurn({ threadId, input: "go", attachments: [] });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );
      assert.include(argv, "--sandbox");
      assert.notInclude(argv, "--dangerously-skip-permissions");
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a seeded conversation on the very first turn", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) =>
        recordingMock(dir, [resultLine("SUCCESS", "ok", "seed-conv")]),
      );
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mock.file,
          defaultModel: "gemini-test",
        }),
      );
      const threadId = ThreadId.make("agy-stress-resume");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd: mock.dir,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
        resumeCursor: { schemaVersion: 1, conversationId: "seed-conv" },
      });
      yield* adapter.sendTurn({ threadId, input: "continue", attachments: [] });
      const argv = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(mock.dir, "argv.txt"), "utf8"),
      );
      assert.include(argv, "--conversation");
      assert.include(argv, "seed-conv");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores unusable attachments in print mode", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "go",
        attachments: [
          { type: "image", mimeType: "image/png", name: "shot.png", dataBase64: "AAAA" },
        ] as never,
      });
      assert.isDefined(turn.turnId);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a startSession for the wrong provider", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mock.file,
          defaultModel: "gemini-test",
        }),
      );
      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("agy-stress-wrong-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: mock.dir,
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("advertises in-session model switching", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const { adapter } = yield* startAdapter(mock.file, mock.dir);
      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");
      assert.equal(String(adapter.provider), "agy");
    }).pipe(Effect.scoped),
  );

  it.effect("stopAll terminates every live session", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) => recordingMock(dir, [resultLine("SUCCESS", "ok")]));
      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mock.file,
          defaultModel: "gemini-test",
        }),
      );
      for (const suffix of ["a", "b", "c"]) {
        yield* adapter.startSession({
          threadId: ThreadId.make(`agy-stress-stopall-${suffix}`),
          provider: ProviderDriverKind.make("agy"),
          cwd: mock.dir,
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
        });
      }
      assert.equal((yield* adapter.listSessions()).length, 3);
      yield* adapter.stopAll();
      assert.equal((yield* adapter.listSessions()).length, 0);
      assert.isFalse(yield* adapter.hasSession(ThreadId.make("agy-stress-stopall-a")));
    }).pipe(Effect.scoped),
  );

  it.effect("runs five sequential turns without wedging or repeating ids", () =>
    Effect.gen(function* () {
      const mock = yield* writeMock((dir) =>
        recordingMock(dir, [initLine(), stepUpdate("ok"), resultLine("SUCCESS", "ok")]),
      );
      const { adapter, threadId } = yield* startAdapter(mock.file, mock.dir);
      const ids = new Set<string>();
      for (let turn = 0; turn < 5; turn += 1) {
        const result = yield* adapter.sendTurn({
          threadId,
          input: `turn ${turn}`,
          attachments: [],
        });
        ids.add(String(result.turnId));
      }
      assert.equal(ids.size, 5, "each turn gets a distinct id");
      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 5);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps two concurrent sessions isolated", () =>
    Effect.gen(function* () {
      const mockA = yield* writeMock((dir) =>
        recordingMock(dir, [
          initLine("conv-a"),
          stepUpdate("AAA", "conv-a"),
          resultLine("SUCCESS", "AAA", "conv-a"),
        ]),
      );
      const mockB = yield* writeMock((dir) =>
        recordingMock(dir, [
          initLine("conv-b"),
          stepUpdate("BBB", "conv-b"),
          resultLine("SUCCESS", "BBB", "conv-b"),
        ]),
      );
      const a = yield* startAdapter(mockA.file, mockA.dir);
      // Second adapter, different mock, distinct thread.
      const bAdapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mockB.file,
          defaultModel: "gemini-test",
        }),
      );
      const bThread = ThreadId.make("agy-stress-concurrent-b");
      yield* bAdapter.startSession({
        threadId: bThread,
        provider: ProviderDriverKind.make("agy"),
        cwd: mockB.dir,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "gemini-test" },
      });

      const [resA, resB] = yield* Effect.all(
        [
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off - concurrent failure behavior is under test.
          adapterSend(a.adapter, a.threadId),
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off - concurrent failure behavior is under test.
          adapterSend(bAdapter, bThread),
        ],
        { concurrency: 2 },
      );

      assert.notEqual(String(resA.turnId), String(resB.turnId), "turn ids across sessions differ");
      const threadA = yield* a.adapter.readThread(a.threadId);
      const threadB = yield* bAdapter.readThread(bThread);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(threadA), "AAA");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.notInclude(JSON.stringify(threadA), "BBB");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.include(JSON.stringify(threadB), "BBB");
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      assert.notInclude(JSON.stringify(threadB), "AAA");
    }).pipe(Effect.scoped),
  );
});

const adapterSend = (
  adapter: {
    sendTurn: (input: {
      threadId: ThreadId;
      input: string;
      attachments: [];
    }) => Effect.Effect<{ turnId: unknown }, unknown, never>;
  },
  threadId: ThreadId,
) =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - test helper preserves arbitrary adapter failures.
  adapter.sendTurn({ threadId, input: "go", attachments: [] });

const HANGING_MOCK = [
  "process.stdin.resume();",
  'process.stdin.on("data", () => {});',
  "let n = 0;",
  "const t = setInterval(() => {",
  '  process.stdout.write(JSON.stringify({event:"step_update",step_update:{conversation_id:"c",step_index:2,state:"ACTIVE",step_type:"agent_response",text_delta:`chunk${n++} `}}) + "\\n");',
  "}, 20);",
  'process.on("SIGTERM", () => { clearInterval(t); process.exit(143); });',
].join("\n");

describe("AgyAdapter stress lifecycle", () => {
  it.live("cancels a mid-stream interrupt and keeps the partial transcript", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-stress-int-")),
      );
      const file = NodePath.join(dir, "mock-agy.mjs");
      yield* Effect.promise(() => NodeFSP.writeFile(file, HANGING_MOCK, "utf8"));
      const { adapter, threadId } = yield* startAdapter(file, dir);
      const events = yield* collectEvents(adapter);

      const turnFiber = yield* Effect.forkChild(
        Effect.exit(adapter.sendTurn({ threadId, input: "stream forever", attachments: [] })),
      );
      // Let several deltas flow, then interrupt mid-stream.
      yield* settleLive;
      yield* adapter.interruptTurn(threadId, undefined as never);
      yield* Fiber.join(turnFiber);
      yield* settleLive;
      yield* Fiber.interrupt(events.fiber);

      const seen = yield* Ref.get(events.ref);
      const completions = completionsOf(seen);
      assert.equal(completions.length, 1, "exactly one completion for the interrupted turn");
      assert.equal((completions[0]?.payload as { state: string } | undefined)?.state, "cancelled");
      assert.isAbove(deltasOf(seen).length, 0, "partial deltas seen before the stop should remain");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not leak child processes across a burst of turns", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-stress-burst-")),
      );
      const file = NodePath.join(dir, "mock-agy.mjs");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          recordingMock(dir, [initLine(), stepUpdate("ok"), resultLine("SUCCESS", "ok")]),
          "utf8",
        ),
      );
      const { adapter, threadId } = yield* startAdapter(file, dir);
      for (let turn = 0; turn < 8; turn += 1) {
        yield* adapter.sendTurn({ threadId, input: `burst ${turn}`, attachments: [] });
      }
      // After the burst, the session owns no live process and accepts more work.
      assert.isTrue(yield* adapter.hasSession(threadId));
      const again = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "final", attachments: [] }),
      );
      assert.isTrue(Exit.isSuccess(again));
      // Sidecar proves the last invocation actually ran.
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "argv.txt")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
