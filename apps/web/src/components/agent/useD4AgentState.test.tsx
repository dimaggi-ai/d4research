// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useD4AgentState } from "./useD4AgentState";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), query: vi.fn(), selected: null as unknown }));
vi.mock("../../state/server", () => ({ serverEnvironment: { d4AgentState: () => "agent-state" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.query(atom);
    mocks.selected = atom;
    return { refresh: mocks.refresh, data: null };
  },
}));
let visibility: DocumentVisibilityState;
let root: Root;
function Probe() {
  useD4AgentState("env" as never);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  mocks.refresh.mockClear();
  mocks.query.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("detaches the state subscriber and stops polling while the document is hidden", () => {
  act(() => root.render(<Probe />));
  expect(mocks.selected).toBe("agent-state");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  const count = mocks.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(count);
  visibility = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("agent-state");
});
it("does not subscribe or poll when initially hidden", () => {
  visibility = "hidden";
  act(() => root.render(<Probe />));
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.selected).toBeNull();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
