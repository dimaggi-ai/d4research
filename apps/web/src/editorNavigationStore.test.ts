import { EnvironmentId } from "@d4research/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canGoBack,
  canGoForward,
  editorWorkspaceKey,
  useEditorNavigationStore,
} from "./editorNavigationStore";

const environmentId = EnvironmentId.make("local");
const cwd = "/workspace";

describe("editorNavigationStore", () => {
  beforeEach(() => {
    useEditorNavigationStore.setState({
      recentFilesByWorkspace: {},
      historyByWorkspace: {},
      navigationRequest: null,
    });
  });

  it("keeps recently opened files in most-recent-first order without duplicates", () => {
    const store = useEditorNavigationStore.getState();
    store.recordRecentFile(environmentId, cwd, "src/first.ts");
    store.recordRecentFile(environmentId, cwd, "src/second.ts");
    store.recordRecentFile(environmentId, cwd, "src/first.ts");

    expect(
      useEditorNavigationStore
        .getState()
        .recentFilesByWorkspace[editorWorkspaceKey(environmentId, cwd)]?.map((entry) => entry.path),
    ).toEqual(["src/first.ts", "src/second.ts"]);
  });

  it("records a line-targeted navigation request and promotes the target to recent", () => {
    useEditorNavigationStore.getState().navigateTo(environmentId, cwd, {
      path: "src/service.ts",
      lineNumber: 42,
      column: 7,
    });

    const state = useEditorNavigationStore.getState();
    expect(state.navigationRequest).toMatchObject({
      workspaceKey: editorWorkspaceKey(environmentId, cwd),
      path: "src/service.ts",
      lineNumber: 42,
      column: 7,
    });
    expect(state.recentFilesByWorkspace[editorWorkspaceKey(environmentId, cwd)]?.[0]?.path).toBe(
      "src/service.ts",
    );
  });

  it("walks back and forward through navigation history", () => {
    const store = useEditorNavigationStore.getState();
    store.recordActiveLocation(environmentId, cwd, { path: "src/a.ts", lineNumber: 1 });
    // Jump from a.ts:10 to b.ts:5 — the origin line should be captured for "back".
    store.navigateTo(
      environmentId,
      cwd,
      { path: "src/b.ts", lineNumber: 5, column: 2 },
      { path: "src/a.ts", lineNumber: 10, column: 0 },
    );

    expect(canGoBack(useEditorNavigationStore.getState(), environmentId, cwd)).toBe(true);
    expect(canGoForward(useEditorNavigationStore.getState(), environmentId, cwd)).toBe(false);

    useEditorNavigationStore.getState().goBack(environmentId, cwd);
    expect(useEditorNavigationStore.getState().navigationRequest).toMatchObject({
      path: "src/a.ts",
      lineNumber: 10,
    });
    expect(canGoForward(useEditorNavigationStore.getState(), environmentId, cwd)).toBe(true);

    useEditorNavigationStore.getState().goForward(environmentId, cwd);
    expect(useEditorNavigationStore.getState().navigationRequest).toMatchObject({
      path: "src/b.ts",
      lineNumber: 5,
    });
  });

  it("drops forward history when navigating after going back", () => {
    const store = useEditorNavigationStore.getState();
    store.recordActiveLocation(environmentId, cwd, { path: "src/a.ts", lineNumber: 1 });
    store.navigateTo(environmentId, cwd, { path: "src/b.ts", lineNumber: 1 });
    store.navigateTo(environmentId, cwd, { path: "src/c.ts", lineNumber: 1 });
    store.goBack(environmentId, cwd); // now at b.ts, c.ts is "forward"
    store.navigateTo(environmentId, cwd, { path: "src/d.ts", lineNumber: 1 });

    expect(canGoForward(useEditorNavigationStore.getState(), environmentId, cwd)).toBe(false);
    const key = editorWorkspaceKey(environmentId, cwd);
    expect(
      useEditorNavigationStore
        .getState()
        .historyByWorkspace[key]?.entries.map((entry) => entry.path),
    ).toEqual(["src/a.ts", "src/b.ts", "src/d.ts"]);
  });

  it("does not duplicate the current entry when re-recording the same file", () => {
    const store = useEditorNavigationStore.getState();
    store.recordActiveLocation(environmentId, cwd, { path: "src/a.ts", lineNumber: 1 });
    store.recordActiveLocation(environmentId, cwd, { path: "src/a.ts", lineNumber: 1 });
    const key = editorWorkspaceKey(environmentId, cwd);
    expect(useEditorNavigationStore.getState().historyByWorkspace[key]?.entries).toHaveLength(1);
  });
});
