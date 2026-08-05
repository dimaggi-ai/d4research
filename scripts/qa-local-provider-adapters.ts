// @effect-diagnostics nodeBuiltinImport:off, globalConsoleInEffect:off, globalConsole:off, globalDateInEffect:off, schemaSyncInEffect:off, outdatedApi:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgySettings,
  JunieSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../apps/server/src/config.ts";
import { makeAgyAdapter } from "../apps/server/src/provider/Layers/AgyAdapter.ts";
import { makeJunieAdapter } from "../apps/server/src/provider/Layers/JunieAdapter.ts";

const provider = process.argv[2];
const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: `t3code-${provider ?? "provider"}-qa-`,
}).pipe(Layer.provideMerge(NodeServices.layer));

const runAgy = Effect.gen(function* () {
  const adapter = yield* makeAgyAdapter(Schema.decodeSync(AgySettings)({ binaryPath: "agy" }));
  const threadId = ThreadId.make(`qa-agy-${Date.now()}`);
  console.log("qa: agy adapter ready");
  yield* adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("agy"),
    cwd: process.cwd(),
    runtimeMode: "full-access",
    modelSelection: {
      instanceId: ProviderInstanceId.make("agy"),
      model: "gemini-3.6-flash-medium",
    },
  });
  console.log("qa: agy session ready");
  yield* adapter.sendTurn({ threadId, input: "Reply with exactly T3_OK.", attachments: [] });
  console.log("qa: agy turn complete");
  yield* adapter.stopSession(threadId);
});

const runJunie = Effect.gen(function* () {
  const adapter = yield* makeJunieAdapter(
    Schema.decodeSync(JunieSettings)({
      binaryPath: process.env.JUNIE_BINARY ?? "junie",
      defaultModel: process.env.JUNIE_MODEL ?? "custom:t3-local-ollama",
    }),
  );
  const threadId = ThreadId.make(`qa-junie-${Date.now()}`);
  console.log("qa: junie adapter ready");
  yield* adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("junie"),
    cwd: process.cwd(),
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("junie"), model: "default" },
  });
  console.log("qa: junie session ready");
  yield* adapter.sendTurn({ threadId, input: "Reply with exactly T3_OK.", attachments: [] });
  console.log("qa: junie turn complete");
  yield* adapter.stopSession(threadId);
});

const program =
  provider === "agy"
    ? runAgy
    : provider === "junie"
      ? runJunie
      : Effect.die(new Error("Usage: qa-local-provider-adapters.ts <agy|junie>"));

Effect.runPromise(
  program.pipe(Effect.scoped, Effect.timeout("45 seconds"), Effect.provide(layer)),
).catch((error) => {
  console.error(`qa: ${provider ?? "provider"} failed`, error);
  process.exitCode = 1;
});
