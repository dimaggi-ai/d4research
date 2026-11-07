import { act, render as renderComponent, fakeTimers, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
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
let root: Screen;
function HealthProbe() {
  useD4AgentSystemHealth("env" as never);
  return null;
}
function Probe() {
  useD4AgentState("env" as never);
  return null;
}
async function setupFixture() {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  mocks.refresh.mockClear();
  mocks.agentData = { brainContext: "Global" };
  mocks.query.mockClear();
  container = document.createElement("div");
  root = await renderComponent(null, { container: container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

it("detaches the state subscriber and stops polling while the document is hidden", async () => {
  using _timers = fakeTimers();
  await using _fixture = await setupFixture();
  await act(async () => await root.rerender(<Probe />));
  expect(mocks.selected).toBe("agent-state");
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  const count = mocks.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(count);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("agent-state");
});
it("does not subscribe or poll when initially hidden", async () => {
  using _timers = fakeTimers();
  await using _fixture = await setupFixture();
  visibility = "hidden";
  await act(async () => await root.rerender(<Probe />));
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(mocks.selected).toBeNull();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("detaches system health while hidden and resumes its polling when visible", async () => {
  using _timers = fakeTimers();
  await using _fixture = await setupFixture();
  visibility = "hidden";
  await act(async () => await root.rerender(<HealthProbe />));
  expect(mocks.selected).toBeNull();
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).not.toHaveBeenCalled();
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("system-health");
  const resumed = mocks.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(resumed + 1);
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  const hidden = mocks.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(45_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(hidden);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("system-health");
  const resumedAgain = mocks.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(resumedAgain + 1);
});

let container: HTMLDivElement;
const shown = () => container.textContent;
function StateProbe({ environmentId }: { environmentId: string }) {
  return <span>{JSON.stringify(useD4AgentState(environmentId as never).data)}</span>;
}

it("keeps the last state for the same environment while hidden so the chat draft survives", async () => {
  using _timers = fakeTimers();
  await using _fixture = await setupFixture();
  await act(async () => await root.rerender(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBeNull();
  expect(shown()).toBe(JSON.stringify(mocks.agentData));
  await act(async () => await root.rerender(<StateProbe environmentId="other-env" />));
  expect(shown()).toBe("null");
});

it("keeps the last state after showing again until the resumed query has data", async () => {
  using _timers = fakeTimers();
  await using _fixture = await setupFixture();
  await act(async () => await root.rerender(<StateProbe environmentId="env" />));
  const before = JSON.stringify(mocks.agentData);
  visibility = "hidden";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  // The state cache drops the detached node, so the resumed subscription starts empty.
  mocks.agentData = null;
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.selected).toBe("agent-state");
  expect(shown()).toBe(before);
  mocks.agentData = { brainContext: "YB" };
  await act(async () => await root.rerender(<StateProbe environmentId="env" />));
  expect(shown()).toBe(JSON.stringify({ brainContext: "YB" }));
});
