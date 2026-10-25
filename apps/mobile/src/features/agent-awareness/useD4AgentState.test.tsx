// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useD4AgentState, useD4AgentSystemHealth } from "./useD4AgentState";
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  focused: true,
  currentState: "active",
  selected: null as unknown,
  listener: null as ((state: string) => void) | null,
  agentData: { brainContext: "Global" } as { brainContext: string } | null,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return mocks.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listener = listener;
      return {
        remove: () => {
          mocks.listener = null;
        },
      };
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    d4AgentState: () => "agent-state",
    d4AgentSystemHealth: () => "system-health",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    mocks.selected = atom;
    return { refresh: mocks.refresh, data: atom === "agent-state" ? mocks.agentData : null };
  },
}));
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
  mocks.focused = true;
  mocks.currentState = "active";
  mocks.refresh.mockClear();
  mocks.agentData = { brainContext: "Global" };
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("stops the query and interval under another screen or while the app is inactive", () => {
  act(() => root.render(<Probe />));
  expect(mocks.selected).toBe("agent-state");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  mocks.focused = false;
  act(() => root.render(<Probe />));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  mocks.focused = true;
  act(() => root.render(<Probe />));
  act(() => mocks.listener!("background"));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  act(() => mocks.listener!("active"));
  expect(mocks.selected).toBe("agent-state");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

it("polls global system health without screen focus and suspends it when inactive", () => {
  mocks.focused = false;
  act(() => root.render(<HealthProbe />));
  expect(mocks.selected).toBe("system-health");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  act(() => mocks.listener!("inactive"));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  act(() => mocks.listener!("background"));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  act(() => mocks.listener!("active"));
  expect(mocks.selected).toBe("system-health");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  expect(mocks.listener).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  root = createRoot(document.createElement("div"));
});

it("does not subscribe to system health when initially backgrounded", () => {
  mocks.currentState = "background";
  act(() => root.render(<HealthProbe />));
  expect(mocks.selected).toBeNull();
  act(() => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).not.toHaveBeenCalled();
  act(() => mocks.listener!("active"));
  expect(mocks.selected).toBe("system-health");
  act(() => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

let container: HTMLDivElement;
const shown = () => container.textContent;
function StateProbe({ environmentId }: { environmentId: string }) {
  return <span>{JSON.stringify(useD4AgentState(environmentId as never).data)}</span>;
}

it("keeps the last state for the same environment while unfocused or backgrounded", () => {
  act(() => root.render(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  act(() => mocks.listener!("background"));
  expect(mocks.selected).toBeNull();
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  act(() => mocks.listener!("active"));
  mocks.focused = false;
  act(() => root.render(<StateProbe environmentId="env" />));
  expect(mocks.selected).toBeNull();
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  act(() => root.render(<StateProbe environmentId="other-env" />));
  expect(shown()).toBe("null");
});

it("keeps the last state after resuming until the resumed query has data", () => {
  act(() => root.render(<StateProbe environmentId="env" />));
  const before = JSON.stringify(mocks.agentData);
  act(() => mocks.listener!("background"));
  // The state cache drops the detached node, so the resumed subscription starts empty.
  mocks.agentData = null;
  act(() => mocks.listener!("active"));
  expect(mocks.selected).toBe("agent-state");
  expect(shown()).toBe(before);
  mocks.agentData = { brainContext: "YB" };
  act(() => root.render(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify({ brainContext: "YB" }));
});
