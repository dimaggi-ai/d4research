import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@d4research/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { isEncryptionAvailableMock } = vi.hoisted(() => ({
  isEncryptionAvailableMock: vi.fn(),
}));

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    getSelectedStorageBackend: vi.fn(),
    isEncryptionAvailable: isEncryptionAvailableMock,
  },
}));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const makeService = (env: Readonly<Record<string, string>>) =>
  ElectronSafeStorage.make.pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(HostProcess.Platform, "darwin"),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    isEncryptionAvailableMock.mockReset();
    isEncryptionAvailableMock.mockReturnValue(true);
  });

  it.effect("does not touch the macOS keychain by default", () =>
    Effect.gen(function* () {
      const service = yield* makeService({});

      assert.isFalse(yield* service.isEncryptionAvailable);
      assert.equal(isEncryptionAvailableMock.mock.calls.length, 0);
    }),
  );

  it.effect("checks Electron safe storage after an explicit opt-in", () =>
    Effect.gen(function* () {
      const service = yield* makeService({ T3CODE_ENABLE_SAFE_STORAGE_KEYCHAIN: "true" });

      assert.isTrue(yield* service.isEncryptionAvailable);
      assert.equal(isEncryptionAvailableMock.mock.calls.length, 1);
    }),
  );
});
