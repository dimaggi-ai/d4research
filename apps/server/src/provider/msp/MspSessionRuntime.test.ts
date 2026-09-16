import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeMuseMspRuntime } from "./MspSessionRuntime.ts";
import { makeMockMuse } from "./mspTestUtils.ts";

it.layer(NodeServices.layer)("Muse MSP runtime", (it) => {
  it.effect("rejects UUIDv4 commands at the mock protocol boundary", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeMuseMspRuntime({
        settings: mock.settings,
        environment: process.env,
        spawner,
        cwd: mock.directory,
        clientInfo: { name: "t3_code", version: "0.0.1" },
      });
      const session = yield* runtime.startSession();
      const error = yield* runtime
        .startTurn({
          sessionId: session.session.sessionId,
          commandId: "00000000-0000-4000-8000-000000000000",
          input: [{ type: "text", text: "wrong UUID" }],
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MspRpcError");
      if (error._tag === "MspRpcError") assert.equal(error.data?.kind, "invalidParams");
    }),
  );
  it.effect("keeps resume failures typed for missing-session recovery", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeMuseMspRuntime({
        settings: mock.settings,
        environment: process.env,
        spawner,
        cwd: mock.directory,
        clientInfo: { name: "t3_code", version: "0.0.1" },
      });
      const error = yield* runtime
        .resumeSession({ sessionId: "missing" })
        .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }));
      assert.equal(error?._tag, "MspRpcError");
      if (error?._tag === "MspRpcError") assert.equal(error.data?.kind, "sessionNotFound");
    }),
  );
  it.effect("requests the sessionMcp capability during initialize", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeMuseMspRuntime({
        settings: mock.settings,
        environment: process.env,
        spawner,
        cwd: mock.directory,
        clientInfo: { name: "t3_code", version: "0.0.1" },
      });
      assert.deepEqual([...runtime.grantedCapabilities], ["sessionMcp"]);
      const requests = yield* mock.readRequests();
      assert.deepEqual(
        (
          requests.find((r) => r.method === "initialize")?.params?.capabilities as {
            requestedCapabilities?: unknown;
          }
        )?.requestedCapabilities,
        ["sessionMcp"],
      );
    }),
  );
  it.effect("warns on a resume approval ceiling without losing the session", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse({ T3_MSP_APPROVAL_CEILING: "1" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const warnings: string[] = [];
      const runtime = yield* makeMuseMspRuntime({
        settings: mock.settings,
        environment: process.env,
        spawner,
        cwd: mock.directory,
        clientInfo: { name: "t3_code", version: "0.0.1" },
        onWarning: (message) =>
          Effect.sync(() => {
            warnings.push(message);
          }),
      });
      const resumed = yield* runtime.resumeSession({ sessionId: "previous", cursor: "cursor-2" });
      assert.equal(resumed.session.sessionId, "previous");
      assert.equal(warnings.length, 1);
      const requests = yield* mock.readRequests();
      assert.equal(requests.find((r) => r.method === "session/resume")?.params?.cursor, "cursor-2");
    }),
  );
});
