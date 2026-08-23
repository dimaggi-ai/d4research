// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  JunieSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { acpPromptRequestFailedMessage } from "./GrokAdapter.ts";
import { makeJunieAdapter, resolveJunieModelSelection } from "./JunieAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeJunieSettings = Schema.decodeSync(JunieSettings);

async function makeMockJunieWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "junie-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-junie.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const junieAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-junie-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("resolveJunieModelSelection", () => {
  it("does not send the synthetic default model to Junie", () => {
    expect(
      resolveJunieModelSelection({
        instanceId: ProviderInstanceId.make("junie"),
        model: "default",
      }),
    ).toBeUndefined();
  });

  it("preserves a real model advertised by Junie", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("junie"),
      model: "anthropic-claude-sonnet",
    };
    expect(resolveJunieModelSelection(selection)).toEqual(selection);
  });
});

it.layer(junieAdapterTestLayer)("JunieAdapterLive", (it) => {
  it.effect("uses the Junie display name for ready and failed-turn events", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockJunieWrapper());
      const adapter = yield* makeJunieAdapter(decodeJunieSettings({ binaryPath: wrapperPath }));
      const threadId = ThreadId.make("junie-provider-identity");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("junie"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const ready = runtimeEvents.find(
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      );

      assert.equal(ready?.type, "session.state.changed");
      if (ready?.type === "session.state.changed") {
        assert.equal(ready.payload.reason, "Junie ACP session ready");
      }
      assert.equal(acpPromptRequestFailedMessage("Junie"), "Junie prompt request failed.");
      assert.isTrue(runtimeEvents.every((event) => event.provider === "junie"));

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
