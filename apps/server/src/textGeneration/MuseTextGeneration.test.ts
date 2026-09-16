// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { ProviderInstanceId } from "@d4research/contracts";
import { Effect } from "effect";
import { makeMockMuse } from "../provider/msp/mspTestUtils.ts";
import { makeMuseTextGeneration } from "./MuseTextGeneration.ts";
const modelSelection = { instanceId: ProviderInstanceId.make("muse"), model: "default" };
it.layer(NodeServices.layer)("Muse text generation", (it) => {
  it.effect("collects MSP deltas and decodes structured output", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse({ T3_MSP_RESPONSE_TEXT: '{"title":"Fix Muse transport"}' });
      const service = yield* makeMuseTextGeneration(mock.settings);
      const result = yield* service.generateThreadTitle({
        cwd: mock.directory,
        modelSelection,
        message: "Fix transport",
      });
      assert.equal(result.title, "Fix Muse transport");
      assert.equal(
        (yield* mock.readRequests()).find((r) => r.method === "session/start")?.params
          ?.approvalMode,
        "denyUnmatched",
      );
    }),
  );
  it.effect("removes the durable session log under the Muse session store", () =>
    Effect.gen(function* () {
      const store = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-tg-store-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      // The mock session id is mock-muse-session, so the log must sit in the
      // directory named after it, like the real store layout.
      const sessionFile = NodePath.join(store, "sessions", "mock-muse-session", "session.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(sessionFile), { recursive: true }).then(() =>
          NodeFSP.writeFile(sessionFile, "log"),
        ),
      );
      const mock = yield* makeMockMuse({
        T3_MSP_RESPONSE_TEXT: '{"title":"Fix Muse transport"}',
        T3_MSP_MUSE_HOME: store,
        T3_MSP_SESSION_PATH: sessionFile,
      });
      const service = yield* makeMuseTextGeneration(mock.settings);
      const result = yield* service.generateThreadTitle({
        cwd: mock.directory,
        modelSelection,
        message: "Fix transport",
      });
      assert.equal(result.title, "Fix Muse transport");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.stat(sessionFile).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  );
  it.effect("keeps session logs outside the Muse session store", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-tg-outside-"))),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const sessionFile = NodePath.join(outside, "sessions", "mock-muse-session", "session.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(sessionFile), { recursive: true }).then(() =>
          NodeFSP.writeFile(sessionFile, "log"),
        ),
      );
      const mock = yield* makeMockMuse({
        T3_MSP_RESPONSE_TEXT: '{"title":"Hi"}',
        T3_MSP_MUSE_HOME: NodePath.join(outside, "other-home"),
        T3_MSP_SESSION_PATH: sessionFile,
      });
      const service = yield* makeMuseTextGeneration(mock.settings);
      const result = yield* service.generateThreadTitle({
        cwd: mock.directory,
        modelSelection,
        message: "Hi",
      });
      assert.equal(result.title, "Hi");
      assert.isTrue(
        yield* Effect.promise(() =>
          NodeFSP.stat(sessionFile).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  );
  for (const [name, env] of [
    ["invalid output", { T3_MSP_RESPONSE_TEXT: "not json" }],
    ["empty output", { T3_MSP_RESPONSE_TEXT: "" }],
    ["authentication failure", { T3_MSP_FAIL_AUTH: "1" }],
    ["process exit", { T3_MSP_EXIT_ON_TURN: "1" }],
  ] as const) {
    it.effect(`reports ${name}`, () =>
      Effect.gen(function* () {
        const mock = yield* makeMockMuse(env);
        const service = yield* makeMuseTextGeneration(mock.settings);
        const error = yield* service
          .generateThreadTitle({ cwd: mock.directory, modelSelection, message: "Title" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "TextGenerationError");
      }),
    );
  }
});
