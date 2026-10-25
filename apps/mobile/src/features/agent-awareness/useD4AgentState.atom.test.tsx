// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useD4AgentState } from "./useD4AgentState";

// The real query atom and hook, with only the network fetch replaced: every subscription after a
// disposal starts a new fetch that stays pending until the test resolves it.
const app = vi.hoisted(() => ({
  pending: [] as Array<(value: { brainContext: string }) => void>,
  currentState: "active",
  listener: null as ((state: string) => void) | null,
}));
const stateAtom = Atom.make(
  Effect.promise(
    () => new Promise<{ brainContext: string }>((resolve) => app.pending.push(resolve)),
  ),
);
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return app.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      app.listener = listener;
      return { remove: () => (app.listener = null) };
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { d4AgentState: () => stateAtom },
}));

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
function Chat() {
  const state = useD4AgentState("env" as never);
  // Like the chat route: without data it shows a loading view, which unmounts the draft.
  return state.data ? (
    <div>
      <span>{state.data.brainContext}</span>
      <textarea aria-label="draft" />
    </div>
  ) : (
    <p>Loading</p>
  );
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const setAppState = (next: string) =>
  act(() => {
    app.currentState = next;
    app.listener?.(next);
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  app.pending = [];
  app.currentState = "active";
  registry = AtomRegistry.make();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("keeps the chat and its draft through a full background and foreground cycle", async () => {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Chat />
      </RegistryContext.Provider>,
    ),
  );
  expect(app.pending).toHaveLength(1);
  await act(async () => app.pending[0]!({ brainContext: "Global" }));
  await settle();
  const draft = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="draft"]')!;
  draft.value = "Unsent request";

  setAppState("background");
  await settle();
  setAppState("active");
  await settle();
  // The atom was disposed in the background, so foregrounding starts a fresh fetch with no data.
  expect(app.pending).toHaveLength(2);
  expect(container.textContent).not.toContain("Loading");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent request");

  await act(async () => app.pending[1]!({ brainContext: "YB" }));
  await settle();
  expect(container.textContent).toContain("YB");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent request");
});
