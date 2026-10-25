// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useD4AgentState, useD4AgentSystemHealth } from "./useD4AgentState";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  query: vi.fn(),
  selected: null as unknown,
  agentData: { brainContext: "Global" } as { brainContext: string } | null,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    d4AgentState: () => "agent-state",
    d4AgentSystemHealth: () => "system-health",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.query(atom);
    mocks.selected = atom;
    return { refresh: mocks.refresh, data: atom === "agent-state" ? mocks.agentData : null };
  },
}));
let visibility: DocumentVisibilityState;
let root: Root;
function HealthProbe() {
  useD4AgentSystemHealth("env" as never);
  return null;
}
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
  mocks.agentData = { brainContext: "Global" };
  mocks.query.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
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

it("detaches system health while hidden and resumes its polling when visible", () => {
  visibility = "hidden";
  act(() => root.render(<HealthProbe />));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).not.toHaveBeenCalled();
  visibility = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("system-health");
  const resumed = mocks.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(resumed + 1);
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  const hidden = mocks.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(hidden);
  visibility = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("system-health");
  const resumedAgain = mocks.refresh.mock.calls.length;
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(resumedAgain + 1);
});

let container: HTMLDivElement;
const shown = () => container.textContent;
function StateProbe({ environmentId }: { environmentId: string }) {
  return <span>{JSON.stringify(useD4AgentState(environmentId as never).data)}</span>;
}

it("keeps the last state for the same environment while hidden so the chat draft survives", () => {
  act(() => root.render(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  act(() => root.render(<StateProbe environmentId="other-env" />));
  expect(shown()).toBe("null");
});

it("keeps the last state after showing again until the resumed query has data", () => {
  act(() => root.render(<StateProbe environmentId="env" />));
  const before = JSON.stringify(mocks.agentData);
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  // The state cache drops the detached node, so the resumed subscription starts empty.
  mocks.agentData = null;
  visibility = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("agent-state");
  expect(shown()).toBe(before);
  mocks.agentData = { brainContext: "YB" };
  act(() => root.render(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify({ brainContext: "YB" }));
});
