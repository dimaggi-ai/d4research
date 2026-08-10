// @effect-diagnostics nodeBuiltinImport:off, preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AgySettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { AGY_PROMPT_MAX_CHARS, makeAgyAdapter, prepareAgyPrompt } from "./AgyAdapter.ts";

const decodeSettings = Schema.decodeSync(AgySettings);

it.layer(NodeServices.layer)("AgyAdapter", (it) => {
  it.effect("keeps both ends of oversized prompts with an explicit omission marker", () =>
    Effect.sync(() => {
      const input = `HEAD:${"x".repeat(300_000)}:TAIL_SENTINEL`;
      const prepared = prepareAgyPrompt(input);
      assert.equal(prepared.text.length, AGY_PROMPT_MAX_CHARS);
      assert.isAbove(prepared.omittedChars, 0);
      assert.isTrue(prepared.text.startsWith("HEAD:"));
      assert.isTrue(prepared.text.endsWith(":TAIL_SENTINEL"));
      assert.include(prepared.text, `${prepared.omittedChars} characters omitted`);
      assert.deepStrictEqual(prepareAgyPrompt("small prompt"), {
        text: "small prompt",
        omittedChars: 0,
      });
    }),
  );

  it.effect("registers AGY and streams a complete mock turn", () =>
    Effect.gen(function* () {
      assert.include(
        BUILT_IN_DRIVERS.map((driver) => driver.driverKind),
        ProviderDriverKind.make("agy"),
      );

      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-adapter-")),
      );
      const mockPath = NodePath.join(tempDir, "mock-agy.mjs");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          mockPath,
          [
            'console.log(JSON.stringify({event:"init",conversation_id:"agy-conversation-1"}));',
            'console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"agy-conversation-1",step_index:2,state:"ACTIVE",step_type:"agent_response",text_delta:"hello from agy"}}));',
            'console.log(JSON.stringify({event:"result",result:{conversation_id:"agy-conversation-1",status:"SUCCESS",response:"hello from agy"}}));',
          ].join("\n"),
          "utf8",
        ),
      );

      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mockPath,
          defaultModel: "gemini-test",
        }),
      );
      const runtimeEventsRef = yield* Ref.make<
        Array<
          typeof adapter.streamEvents extends Stream.Stream<infer Event, infer _Error, infer _Env>
            ? Event
            : never
        >
      >([]);
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(runtimeEventsRef, (events) => [...events, event])),
        Effect.forkChild,
      );
      const threadId = ThreadId.make("agy-adapter-test");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd: tempDir,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("agy"),
          model: "gemini-test",
        },
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
      });
      assert.deepStrictEqual(turn.resumeCursor, {
        schemaVersion: 1,
        conversationId: "agy-conversation-1",
      });

      for (let attempt = 0; attempt < 8; attempt += 1) yield* Effect.yieldNow;
      yield* Fiber.interrupt(runtimeEventsFiber);
      const runtimeEvents = yield* Ref.get(runtimeEventsRef);
      assert.include(
        runtimeEvents.map((event) => event.type),
        "content.delta",
      );
      assert.include(
        runtimeEvents.map((event) => event.type),
        "turn.completed",
      );
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(delta?.payload.delta, "hello from agy");
    }).pipe(Effect.scoped),
  );

  /**
   * Regression: the prompt used to ride in argv. A research delegate carries
   * shared memory context and routinely exceeds Linux's 128KB MAX_ARG_STRLEN,
   * so every delegated agy draft died with E2BIG before the model ran — the
   * silent reason agy models were never actually evaluated in a pipeline.
   */
  it.effect("sends an over-argv-limit prompt through without E2BIG", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-bigprompt-")),
      );
      const mockPath = NodePath.join(tempDir, "mock-agy.mjs");
      // Echoes back how many prompt bytes reached stdin and its tail. Agy's
      // hosted runner silently cuts oversized input, so preserving the final
      // task is as important as avoiding argv/E2BIG.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          mockPath,
          [
            'let received = "";',
            'process.stdin.on("data", (chunk) => { received += chunk.toString("utf8"); });',
            'process.stdin.on("end", () => {',
            '  console.log(JSON.stringify({event:"result",result:{conversation_id:"c1",status:"SUCCESS",response:`stdin_chars=${received.length};tail=${received.slice(-64)}`}}));',
            "});",
          ].join("\n"),
          "utf8",
        ),
      );

      const adapter = yield* makeAgyAdapter(
        decodeSettings({
          binaryPath: process.execPath,
          launchArgs: mockPath,
          defaultModel: "gemini-test",
        }),
      );
      const threadId = ThreadId.make("agy-bigprompt-test");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("agy"),
        cwd: tempDir,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("agy"),
          model: "gemini-test",
        },
      });

      const runtimeEventsRef = yield* Ref.make<ReadonlyArray<{ type: string }>>([]);
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(runtimeEventsRef, (events) => [...events, event])),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 4; attempt += 1) yield* Effect.yieldNow;

      // Comfortably past MAX_ARG_STRLEN and Agy's silent input cutoff.
      const hugePrompt = `HEAD:${"x".repeat(300_000)}:TAIL_SENTINEL`;
      const prepared = prepareAgyPrompt(hugePrompt);
      yield* adapter.sendTurn({ threadId, input: hugePrompt, attachments: [] });

      for (let attempt = 0; attempt < 40; attempt += 1) yield* Effect.yieldNow;

      const thread = yield* adapter.readThread(threadId);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - assertion-only transcript rendering.
      const serialized = JSON.stringify(thread);
      assert.include(
        serialized,
        `stdin_chars=${prepared.text.length}`,
        "the bounded prompt must reach the CLI over stdin",
      );
      assert.include(serialized, ":TAIL_SENTINEL", "the final task must survive truncation");
      yield* Fiber.interrupt(runtimeEventsFiber);
      assert.include(
        (yield* Ref.get(runtimeEventsRef)).map((event) => event.type),
        "runtime.warning",
      );
    }).pipe(Effect.scoped),
  );

  /**
   * Regression: ids were a bare in-process counter, so every server restart
   * replayed `agy-turn-1, 2, 3…`. The projector keys persisted rows by these
   * ids, so a new turn appended into a message from a long-dead conversation.
   * Two adapters in one test stand in for two server boots.
   */
  it.effect("issues turn ids that never repeat across adapter instances", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agy-ids-")),
      );
      const mockPath = NodePath.join(tempDir, "mock-agy.mjs");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          mockPath,
          'console.log(JSON.stringify({event:"result",result:{conversation_id:"c1",status:"SUCCESS",response:"ok"}}));',
          "utf8",
        ),
      );

      const settings = decodeSettings({
        binaryPath: process.execPath,
        launchArgs: mockPath,
        defaultModel: "gemini-test",
      });

      // One boot: start a session and take a turn id.
      const bootTurnId = Effect.fn("bootTurnId")(function* (threadName: string) {
        const adapter = yield* makeAgyAdapter(settings);
        const threadId = ThreadId.make(threadName);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("agy"),
          cwd: tempDir,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("agy"),
            model: "gemini-test",
          },
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "hi", attachments: [] });
        return String(turn.turnId);
      });

      const first = yield* bootTurnId("agy-ids-boot-1");
      const second = yield* bootTurnId("agy-ids-boot-2");

      assert.notEqual(
        first,
        second,
        "turn ids must not collide across adapter instances (server restarts)",
      );
    }).pipe(Effect.scoped),
  );
});
