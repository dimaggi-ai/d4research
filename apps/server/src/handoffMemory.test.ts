import * as Deferred from "effect/Deferred";
import type { MekoReceipt } from "@d4research/contracts/settings";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import * as HandoffMemory from "./handoffMemory.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";

const settingsLayer = ServerSettings.layerTest({ memory: { localEnabled: false } });
const layer = HandoffMemory.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      settingsLayer,
      ProjectionStore.layerMemory,
      ServerConfig.layerTest(process.cwd(), { prefix: "meko-handoff-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Path.layer,
      FetchHttpClient.layer,
    ),
  ),
);

it.effect("stops checks, saves and recall when Meko is disabled, and isolates caller scope", () =>
  Effect.gen(function* () {
    const service = yield* HandoffMemory.HandoffMemory;
    const settings = yield* ServerSettings.ServerSettingsService;
    const fetcher = vi.spyOn(globalThis, "fetch");
    yield* Effect.addFinalizer(() => Effect.sync(() => fetcher.mockRestore()));
    const reference = {
      threadId: "test-thread",
      project: "test-project",
      conversationId: "test-conversation",
      contentHash: "a".repeat(64),
    };
    expect((yield* service.check).status).toBe("ERROR_CONFIGURATION");
    expect((yield* service.read(reference)).text).toBeUndefined();
    expect((yield* service.save({ text: "checkpoint", threadId: "test-thread" })).ok).toBe(false);
    yield* settings.updateSettings({
      handoff: {
        memoryBackend: "meko",
        meko: {
          url: "https://example.test/mcp",
          tokenEnv: "",
          agentId: "test-agent",
          datapackId: "test-datapack",
        },
      },
    });
    expect((yield* service.read(reference, "other-thread")).receipt.message).toContain(
      "current thread",
    );
    expect((yield* service.read(reference, "test-thread")).receipt.message).toContain(
      "matching project",
    );
    const failed = yield* Deferred.make<MekoReceipt>();
    yield* service.schedule({ text: "checkpoint", threadId: "missing-thread" }, (receipt) =>
      Deferred.succeed(failed, receipt).pipe(Effect.asVoid),
    );
    expect((yield* Deferred.await(failed)).message).toContain("existing thread");
    yield* settings.updateSettings({ handoff: { memoryBackend: "none" } });
    expect((yield* service.status()).configured).toBe(false);
    expect((yield* service.check).status).toBe("ERROR_CONFIGURATION");
    expect((yield* service.save({ text: "checkpoint", threadId: "test-thread" })).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(settingsLayer)))),
);
