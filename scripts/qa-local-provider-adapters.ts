// @effect-diagnostics nodeBuiltinImport:off, globalConsoleInEffect:off, globalConsole:off, globalDateInEffect:off, schemaSyncInEffect:off, outdatedApi:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgySettings,
  JunieSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../apps/server/src/config.ts";
import { makeAgyAdapter } from "../apps/server/src/provider/Layers/AgyAdapter.ts";
import { makeJunieAdapter } from "../apps/server/src/provider/Layers/JunieAdapter.ts";

const decodeAgySettings = Schema.decodeSync(AgySettings);
const decodeJunieSettings = Schema.decodeSync(JunieSettings);
const provider = process.argv[2];
const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: `t3code-${provider ?? "provider"}-qa-`,
}).pipe(Layer.provideMerge(NodeServices.layer));

// The models a research pipeline actually routes to. Override with
// AGY_MODELS="a,b" to probe others.
const AGY_MODELS = (process.env.AGY_MODELS ?? "gemini-3.6-flash-medium,gemini-3.6-flash-high")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model.length > 0);
const JUNIE_MODELS = (
  process.env.JUNIE_MODELS ?? "claude-opus-4-8,gpt-5.6-sol,gemini-3.1-pro-preview,grok-4.5"
)
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model.length > 0);

/**
 * Run one adapter turn and return only assistant deltas observed before the
 * matching terminal event. Searching a serialized thread is invalid here: the
 * user's prompt contains the sentinel and would make a resultless model pass.
 */
function captureAssistantOutput<E>(
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
    readonly sendTurn: (input: ProviderSendTurnInput) => Effect.Effect<unknown, E>;
  },
  input: ProviderSendTurnInput,
) {
  return Effect.gen(function* () {
    const deltas = yield* Ref.make<ReadonlyArray<string>>([]);
    const completed =
      yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
      if (String(event.threadId) !== String(input.threadId)) return Effect.void;
      if (event.type === "content.delta") {
        return Ref.update(deltas, (current) => [...current, event.payload.delta]);
      }
      if (event.type === "turn.completed") {
        return Deferred.succeed(completed, event).pipe(Effect.asVoid);
      }
      return Effect.void;
    }).pipe(Effect.forkChild);
    for (let subscribeYield = 0; subscribeYield < 4; subscribeYield += 1) {
      yield* Effect.yieldNow;
    }

    yield* adapter.sendTurn(input);
    const terminal = yield* Deferred.await(completed).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(eventsFiber);
    if (terminal.payload.state !== "completed") {
      return yield* Effect.die(
        new Error(
          `provider turn ended as ${terminal.payload.state}: ${terminal.payload.errorMessage ?? "no error"}`,
        ),
      );
    }
    return (yield* Ref.get(deltas)).join("");
  });
}

const runAgy = Effect.gen(function* () {
  const adapter = yield* makeAgyAdapter(decodeAgySettings({ binaryPath: "agy" }));
  console.log(`qa: agy adapter ready — probing models: ${AGY_MODELS.join(", ")}`);

  // Every model gets both a plain turn and an over-argv-limit turn, so both the
  // normal path and the stdin (E2BIG) path are exercised per model.
  const filler = "This is filler research context that must not change the answer.\n".repeat(3_000);
  for (const model of AGY_MODELS) {
    const modelSelection = { instanceId: ProviderInstanceId.make("agy"), model };

    const smallThread = ThreadId.make(`qa-agy-${model}-${Date.now()}`);
    yield* adapter.startSession({
      threadId: smallThread,
      provider: ProviderDriverKind.make("agy"),
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection,
    });
    const smallOutput = yield* captureAssistantOutput(adapter, {
      threadId: smallThread,
      input: "Reply with exactly T3_OK.",
      attachments: [],
    });
    if (smallOutput.trim() !== "T3_OK") {
      return yield* Effect.die(
        new Error(`agy ${model} returned ${JSON.stringify(smallOutput.trim())}, expected T3_OK`),
      );
    }
    yield* adapter.stopSession(smallThread);
    console.log(`qa: agy [${model}] plain turn complete`);

    const bigThread = ThreadId.make(`qa-agy-big-${model}-${Date.now()}`);
    yield* adapter.startSession({
      threadId: bigThread,
      provider: ProviderDriverKind.make("agy"),
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection,
    });
    const bigOutput = yield* captureAssistantOutput(adapter, {
      threadId: bigThread,
      input: `${filler}\n\nIgnore all filler above. Reply with exactly T3_BIG_OK.`,
      attachments: [],
    });
    if (bigOutput.trim() !== "T3_BIG_OK") {
      return yield* Effect.die(
        new Error(
          `agy ${model} oversized turn returned ${JSON.stringify(bigOutput.trim())}, expected T3_BIG_OK`,
        ),
      );
    }
    yield* adapter.stopSession(bigThread);
    console.log(`qa: agy [${model}] oversized turn complete (${filler.length} filler chars)`);
  }
});

const runJunie = Effect.gen(function* () {
  const adapter = yield* makeJunieAdapter(
    decodeJunieSettings({
      binaryPath: process.env.JUNIE_BINARY ?? "junie",
      // Match the product default. A stale local-model filename here made the
      // probe spawn Junie on an unrelated custom model before switching to the
      // requested hosted target, and every otherwise healthy turn ended as
      // cancelled.
      defaultModel: process.env.JUNIE_MODEL ?? "gpt-5.6-terra",
    }),
  );
  console.log(`qa: junie adapter ready — probing models: ${JUNIE_MODELS.join(", ")}`);
  for (const [index, model] of JUNIE_MODELS.entries()) {
    const sentinel = `T3_MODEL_${index}_OK`;
    const threadId = ThreadId.make(`qa-junie-${index}-${Date.now()}`);
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("junie"),
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      modelSelection: { instanceId: ProviderInstanceId.make("junie"), model },
    });
    const output = yield* captureAssistantOutput(adapter, {
      threadId,
      input: `Return exactly this token and no prose: ${sentinel}`,
      attachments: [],
    });
    if (output.trim() !== sentinel) {
      return yield* Effect.die(
        new Error(`junie ${model} returned ${JSON.stringify(output.trim())}, expected ${sentinel}`),
      );
    }
    yield* adapter.stopSession(threadId);
    console.log(`qa: junie [${model}] exact-output turn complete`);
  }
});

const program =
  provider === "agy"
    ? runAgy
    : provider === "junie"
      ? runJunie
      : Effect.die(new Error("Usage: qa-local-provider-adapters.ts <agy|junie>"));

Effect.runPromise(
  program.pipe(Effect.scoped, Effect.timeout("90 seconds"), Effect.provide(layer)),
).catch((error) => {
  console.error(`qa: ${provider ?? "provider"} failed`, error);
  process.exitCode = 1;
});
