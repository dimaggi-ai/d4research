import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Store from "./D4AgentStore.ts";
it.effect(
  "store survives restart and makes interrupted approved actions require confirmation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-store-" });
        const config = Config.layerTest(process.cwd(), directory);
        const acquire = Store.D4AgentStore.pipe(
          Effect.provide(Store.layer.pipe(Layer.provide(config))),
        );
        const first = yield* acquire;
        assert.equal((yield* first.get).threadId, null);
        yield* first.update((state) => ({
          ...state,
          threadId: ThreadId.make("persistent"),
          actions: [
            {
              id: "interrupted",
              action: { type: "interrupt", threadId: ThreadId.make("other") },
              status: "approved",
              createdAt: "2026-10-24T00:00:00Z",
              resolvedAt: null,
            },
          ],
        }));
        const reopened = yield* acquire;
        assert.equal((yield* reopened.get).threadId, "persistent");
        assert.equal((yield* reopened.get).actions[0]?.status, "pending");
        assert.equal(
          (yield* fs.stat(`${directory}/userdata/d4-agent/state.json`)).mode & 0o777,
          0o600,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
