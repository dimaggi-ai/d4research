import { expect, it, vi } from "vite-plus/test";
const values = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string | ((previous: string | null) => string)) => {
      values.set(key, typeof value === "string" ? value : value(values.get(key) ?? null));
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    values.delete(key);
  },
}));
import { emptyWorkspace } from "./workspace";
import {
  loadLocalWorkspace,
  saveLocalWorkspace,
  loadLocalApiKey,
  saveLocalApiKey,
} from "./storage";
it("persists pending proposals and prevents another screen from overwriting newer files", async () => {
  values.clear();
  const original = emptyWorkspace();
  const first = {
    ...original,
    files: { "a.js": "old" },
    pending: {
      changes: { reply: "edit", edits: [{ path: "a.js", content: "new" }] },
      base: { "a.js": "old" },
    },
  };
  await saveLocalWorkspace(first, original);
  expect(await loadLocalWorkspace()).toEqual(first);
  const newer = { ...first, files: { "a.js": "manual" } };
  await saveLocalWorkspace(newer, first);
  await expect(saveLocalWorkspace({ ...first, files: { "a.js": "stale" } }, first)).rejects.toThrow(
    "another screen",
  );
  expect((await loadLocalWorkspace()).files["a.js"]).toBe("manual");
});
it("scopes Keychain keys to their endpoint and keeps them out of workspace exports", async () => {
  values.clear();
  await saveLocalWorkspace(emptyWorkspace(), emptyWorkspace());
  await saveLocalApiKey("https://host/v1", "private-key");
  expect(await loadLocalApiKey("https://host/v1")).toBe("private-key");
  expect(await loadLocalApiKey("https://other/v1")).toBeNull();
  expect(JSON.stringify(await loadLocalWorkspace())).not.toContain("private-key");
  await saveLocalApiKey("https://host/v1", "");
  expect(await loadLocalApiKey("https://host/v1")).toBeNull();
});
