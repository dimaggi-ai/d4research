import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { D4AgentEntry, D4AgentPanel } from "./D4Agent";
import { EnvironmentId, ThreadId, type D4AgentState } from "@d4research/contracts";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(),
  allowed: true,
  enabled: true,
  configLoaded: true,
  monitorEnabled: true,
  threads: [] as Array<{
    id: ThreadId;
    title: string;
    environmentId: EnvironmentId;
    archivedAt: null;
    deletedAt: null;
    source: { agentMonitor: { attentionRequired: boolean; classification: string } };
  }>,
  navigate: vi.fn(async () => undefined),
  state: null as D4AgentState | null,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: string) =>
    value === "config"
      ? mocks.configLoaded
        ? {
            settings: {
              d4Agent: { enabled: mocks.enabled },
              agentMonitor: { enabled: mocks.monitorEnabled },
            },
          }
        : null
      : mocks.allowed,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    d4AgentState: () => "state",
    ensureD4AgentThread: { permissionAtom: () => "permission" },
    resolveD4AgentAction: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.resolve }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.state,
    refresh: mocks.refresh,
    isPending: false,
    error: null,
  }),
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => mocks.threads }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useNavigate: () => mocks.navigate,
}));
let root: Root;
let container: HTMLDivElement;
const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("agent-thread");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.resolve.mockClear();
  mocks.refresh.mockClear();
  mocks.allowed = true;
  mocks.enabled = true;
  mocks.configLoaded = true;
  mocks.monitorEnabled = true;
  mocks.threads = [];
  mocks.navigate.mockClear();
  mocks.state = {
    threadId,
    projectId: null,
    modelAvailable: false,
    unavailableReason: "model-unavailable",
    pendingActions: [],
    actionLog: [],
    systemHealth: [],
    usage: [],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows an unavailable model without sending a request or selecting a fallback", async () => {
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("The selected model is unavailable.");
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it("shows the proposed message before approving its action and refreshes the log", async () => {
  mocks.state = {
    ...mocks.state!,
    pendingActions: [
      {
        id: "action-1",
        action: {
          type: "send",
          threadId: ThreadId.make("target-thread"),
          text: "Run the focused regression tests.",
        },
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
        resolvedAt: null,
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("target-thread");
  expect(container.textContent).toContain("Run the focused regression tests.");
  const approve = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Approve",
  )!;
  await act(async () => approve.click());
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { actionId: "action-1", decision: "approve" },
  });
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("keeps action approval unavailable for a client without operate permission", async () => {
  mocks.allowed = false;
  mocks.state = {
    ...mocks.state!,
    pendingActions: [
      {
        id: "action-2",
        action: { type: "interrupt", threadId: ThreadId.make("target-thread") },
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
        resolvedAt: null,
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const approve = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Approve",
  )!;
  await act(async () => approve.click());
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it("opens the existing agent thread for a client without operate permission", async () => {
  mocks.allowed = false;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it("opens settings when agent chat is disabled", async () => {
  mocks.enabled = false;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/general" });
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it("hides cached attention reports after monitoring is disabled", async () => {
  mocks.monitorEnabled = false;
  mocks.threads = [
    {
      id: ThreadId.make("old-thread"),
      title: "Old stuck report",
      environmentId,
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: true, classification: "wedged" } },
    },
  ];
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).not.toContain("Old stuck report");
  expect(container.textContent).toContain("No threads need attention.");
});

it("waits for configuration before allowing the first pinned-entry click", async () => {
  mocks.configLoaded = false;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  const pending = container.querySelector("button")!;
  expect(pending.disabled).toBe(true);
  await act(async () => pending.click());
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
  mocks.configLoaded = true;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  const loaded = container.querySelector("button")!;
  expect(loaded.disabled).toBe(false);
  await act(async () => loaded.click());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
