import { RegistryContext } from "@effect/atom-react";
import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  selection: {
    selectedThread: { environmentId: "environment-1", id: "thread-1" } as unknown,
    selectedThreadProject: { workspaceRoot: "/repo" } as unknown,
    selectedEnvironmentRuntime: { connectionState: "connected" } as unknown,
  },
  worktree: { selectedThreadCwd: "/repo" as string | null, selectedThreadWorktreePath: null },
  refreshStatusCalls: [] as Array<unknown>,
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  connectedAtom: undefined as Atom.Writable<boolean, boolean> | undefined,
  renderCount: 0,
  onRefreshSettled: () => {},
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand:
    (command: { run?: (registry: unknown, input: unknown) => unknown }) => (input: unknown) =>
      command.run?.(harness.registry, input) ?? Promise.resolve(AsyncResult.success({})),
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: {
    refreshStatus: {
      label: "refresh status",
      run: async (_registry: unknown, input: unknown) => {
        harness.refreshStatusCalls.push(input);
        harness.onRefreshSettled();
        return AsyncResult.success({});
      },
    },
  },
  vcsActionManager: { runStackedAction: () => "runStackedAction", track: vi.fn() },
}));
vi.mock("./threads", () => ({ threadEnvironment: { updateMetadata: "updateMetadata" } }));
vi.mock("./queries", () => ({ useBranches: () => ({ data: null, refresh: () => {} }) }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("./use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => harness.connectedAtom!,
  setPendingConnectionError: () => {},
}));
vi.mock("./use-vcs-action-state", () => ({ showGitActionResult: () => {} }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => {
    harness.renderCount += 1;
    if (harness.renderCount > 50) {
      throw new Error("Consumer rerendered more than 50 times");
    }
    return harness.selection;
  },
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => harness.worktree,
}));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

let root: Root | null = null;
let rerender: () => void = () => {};

function Consumer() {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    rerender = bump;
  });
  useSelectedThreadGitActions();
  return null;
}

async function flush() {
  await act(async () => {});
}

function renderConsumer() {
  root = createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <RegistryContext.Provider value={harness.registry!}>
        <Consumer />
      </RegistryContext.Provider>,
    ),
  );
}

function setConnected(connected: boolean) {
  act(() => harness.registry!.set(harness.connectedAtom!, connected));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.selection = {
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
    selectedThreadProject: { workspaceRoot: "/repo" },
    selectedEnvironmentRuntime: { connectionState: "connected" },
  };
  harness.worktree = { selectedThreadCwd: "/repo", selectedThreadWorktreePath: null };
  harness.registry = AtomRegistry.make();
  harness.connectedAtom = Atom.make(true);
  harness.refreshStatusCalls = [];
  harness.renderCount = 0;
  harness.onRefreshSettled = () => rerender();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.registry?.dispose();
});

describe("useSelectedThreadGitActions", () => {
  it("refreshes once on mount and does not loop when refreshes rerender the consumer", async () => {
    renderConsumer();
    await flush();

    harness.selection = {
      selectedThread: { environmentId: "environment-1", id: "thread-1" },
      selectedThreadProject: { workspaceRoot: "/repo" },
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });

  it("shares the refresh between threads in one checkout and refreshes when cwd changes", async () => {
    renderConsumer();
    await flush();

    harness.selection = {
      selectedThread: { environmentId: "environment-1", id: "thread-2" },
      selectedThreadProject: { workspaceRoot: "/repo" },
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    harness.worktree = { selectedThreadCwd: "/repo/worktree", selectedThreadWorktreePath: null };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
      { environmentId: "environment-1", input: { cwd: "/repo/worktree" } },
    ]);
  });

  it("refreshes once after the environment reconnects and not while it is away", async () => {
    renderConsumer();
    await flush();

    for (const connectionState of ["reconnecting", "connecting", "offline"]) {
      harness.selection = {
        ...harness.selection,
        selectedEnvironmentRuntime: { connectionState },
      };
      setConnected(false);
      act(() => rerender());
      await flush();
    }
    expect(harness.refreshStatusCalls).toHaveLength(1);

    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    setConnected(true);
    act(() => rerender());
    await flush();
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });

  it("waits for the environment to connect before the first refresh", async () => {
    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connecting" },
    };
    setConnected(false);
    renderConsumer();
    await flush();
    expect(harness.refreshStatusCalls).toEqual([]);

    harness.selection = {
      ...harness.selection,
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    setConnected(true);
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });
});
