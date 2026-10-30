import { afterEach, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import { createMemoryStorage } from "../../lib/storage";
import { useProjectRailGroupsStore as store } from "./projectRailGroupsStore";

const originalState = store.getState();
const originalOptions = store.persist.getOptions();
const key = "t3code:project-rail-groups:v1";
const groups = [{ id: "g", name: "Work", color: "blue", collapsed: true, members: ["local:a"] }];

afterEach(() => {
  store.persist.setOptions(originalOptions);
  store.setState(originalState, true);
});

it("keeps groups when reading older preferences and sanitizes persisted settlement", async () => {
  const storage = createMemoryStorage();
  store.persist.setOptions({ storage: createJSONStorage(() => storage) });
  storage.setItem(key, JSON.stringify({ version: 1, state: { groups } }));
  await store.persist.rehydrate();
  expect(store.getState()).toMatchObject({ groups, settledProjectKeys: [] });

  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      state: { groups, settledProjectKeys: [null, "", 42, "local:a", "local:a", "offline:b"] },
    }),
  );
  await store.persist.rehydrate();
  expect(store.getState()).toMatchObject({ groups, settledProjectKeys: ["local:a", "offline:b"] });
});

it("persists settlement and restoration without losing groups or disconnected projects", async () => {
  const storage = createMemoryStorage();
  store.persist.setOptions({ storage: createJSONStorage(() => storage) });
  storage.setItem(key, JSON.stringify({ version: 1, state: { groups, settledProjectKeys: [] } }));
  await store.persist.rehydrate();
  store.getState().setProjectSettled("local:a", true);
  store.getState().setProjectSettled("local:a", true);
  store.getState().setProjectSettled("offline:b", true);
  const saved = (await storage.getItem(key))!;
  store.setState({ groups: [], settledProjectKeys: [] });
  storage.setItem(key, saved);
  await store.persist.rehydrate();
  expect(store.getState()).toMatchObject({ groups, settledProjectKeys: ["local:a", "offline:b"] });

  store.getState().setProjectSettled("local:a", false);
  await store.persist.rehydrate();
  expect(store.getState()).toMatchObject({ groups, settledProjectKeys: ["offline:b"] });
});
