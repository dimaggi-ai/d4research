import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "unexpected-native-id" }));
vi.mock("../lib/uuid", () => {
  let sequence = 0;
  return { uuidv4: () => `installation-${++sequence}` };
});

import * as MobileStorage from "./mobile-storage";
import * as MobileSecureStorage from "./mobile-secure-storage";

describe("mobile installation identity", () => {
  it.effect("shares the persisted identity across concurrent first-install callers", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => import("../lib/uuid"));
      const values = new Map<string, string>();
      let writes = 0;
      const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
        getItem: (key) => Effect.promise(async () => values.get(key) ?? null),
        setItem: (key, value) =>
          Effect.sync(() => {
            writes += 1;
            values.set(key, value);
          }),
        removeItem: (key) =>
          Effect.sync(() => {
            values.delete(key);
          }),
      });
      const storage = yield* MobileStorage.make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, secureStorage),
      );
      const identities = yield* Effect.all(
        [
          storage.loadOrCreateAgentAwarenessDeviceId,
          storage.loadOrCreateAgentAwarenessDeviceId,
          storage.loadOrCreateAgentAwarenessDeviceId,
        ],
        { concurrency: "unbounded" },
      );
      expect(new Set(identities).size).toBe(1);
      expect(writes).toBe(1);
      expect(yield* storage.loadAgentAwarenessDeviceId).toBe(identities[0]);
    }),
  );
});
