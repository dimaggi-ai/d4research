import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { MuseSettings } from "@d4research/contracts";
import { Effect, Schema } from "effect";
import { checkMuseProviderStatus } from "./MuseProvider.ts";
import { makeMockMuse } from "../msp/mspTestUtils.ts";
const decodeMuseSettings = Schema.decodeUnknownEffect(MuseSettings);
it.layer(NodeServices.layer)("Muse provider discovery", (it) => {
  it.effect("does not spawn a disabled provider", () =>
    Effect.gen(function* () {
      const settings = yield* decodeMuseSettings({
        binaryPath: "/missing/muse",
      });
      const snapshot = yield* checkMuseProviderStatus(settings);
      assert.isFalse(snapshot.enabled);
      assert.equal(snapshot.status, "disabled");
    }),
  );
  it.effect("reports a missing binary", () =>
    Effect.gen(function* () {
      const settings = yield* decodeMuseSettings({
        enabled: true,
        binaryPath: "/missing/muse",
      });
      const snapshot = yield* checkMuseProviderStatus(settings);
      assert.isFalse(snapshot.installed);
      assert.equal(snapshot.status, "error");
    }),
  );
  it.effect("reports empty model catalogs as unauthenticated", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse({ T3_MSP_MODELS: "" });
      const snapshot = yield* checkMuseProviderStatus(mock.settings);
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "muse login");
    }),
  );
  it.effect("discovers host models and reasoning options", () =>
    Effect.gen(function* () {
      const mock = yield* makeMockMuse();
      const snapshot = yield* checkMuseProviderStatus(mock.settings);
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.models[0]?.slug, "muse-spark-1.3");
      assert.isTrue(snapshot.models[0]?.isDefault);
    }),
  );
});
