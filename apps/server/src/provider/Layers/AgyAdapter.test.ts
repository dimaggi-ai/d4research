// @effect-diagnostics nodeBuiltinImport:off
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
import { makeAgyAdapter } from "./AgyAdapter.ts";

const decodeSettings = Schema.decodeSync(AgySettings);

it.layer(NodeServices.layer)("AgyAdapter", (it) => {
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
});
