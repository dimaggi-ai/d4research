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
const fetches = vi.hoisted(() => ({
  pending: [] as Array<(value: { brainContext: string }) => void>,
}));
const stateAtom = Atom.make(
  Effect.promise(
    () => new Promise<{ brainContext: string }>((resolve) => fetches.pending.push(resolve)),
  ),
);
vi.mock("../../state/server", () => ({
  serverEnvironment: { d4AgentState: () => stateAtom },
}));

let visibility: DocumentVisibilityState;
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
const setVisibility = (next: DocumentVisibilityState) =>
  act(() => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fetches.pending = [];
  registry = AtomRegistry.make();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
  vi.restoreAllMocks();
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
  expect(fetches.pending).toHaveLength(1);
  await act(async () => fetches.pending[0]!({ brainContext: "Global" }));
  await settle();
  const draft = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="draft"]')!;
  draft.value = "Unsent request";

  setVisibility("hidden");
  await settle();
  setVisibility("visible");
  await settle();
  // The atom was disposed while hidden, so foregrounding starts a fresh fetch with no data yet.
  expect(fetches.pending).toHaveLength(2);
  expect(container.textContent).not.toContain("Loading");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent request");

  await act(async () => fetches.pending[1]!({ brainContext: "YB" }));
  await settle();
  expect(container.textContent).toContain("YB");
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent request");
});
