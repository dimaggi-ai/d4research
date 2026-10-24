import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { D4AgentEntry, D4AgentPanel } from "./D4Agent";
import {
  EnvironmentId,
  ThreadId,
  type D4AgentActionRecord,
  type D4AgentState,
} from "@d4research/contracts";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(),
  threadShells: vi.fn(),
  stateQuery: vi.fn(),
  detail: null as D4AgentActionRecord | null,
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
    d4AgentIdentity: () => "identity",
    d4AgentAction: () => "detail",
    ensureD4AgentThread: { permissionAtom: () => "permission" },
    resolveD4AgentAction: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.resolve }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === "identity"
        ? { threadId: mocks.state?.threadId }
        : atom === "detail"
          ? mocks.detail
          : atom
            ? mocks.state
            : null,
    refresh: mocks.refresh,
    isPending: false,
    error: null,
  }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => {
    mocks.threadShells();
    return mocks.threads;
  },
}));
vi.mock("./useD4AgentState", () => ({
  useD4AgentState: () => {
    mocks.stateQuery();
    return { data: mocks.state, refresh: mocks.refresh, isPending: false, error: null };
  },
}));
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
  mocks.threadShells.mockClear();
  mocks.stateQuery.mockClear();
  mocks.detail = null;
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
    actionLog: [
      {
        id: "action-1",
        type: "send",
        targetId: "target-thread",
        preview: "Run the focused regression tests.",
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
  expect(approve.disabled).toBe(true);
  mocks.detail = {
    id: "action-1",
    action: {
      type: "send",
      threadId: ThreadId.make("target-thread"),
      text: "Run the focused regression tests. Full text.",
    },
    status: "pending",
    createdAt: "2026-10-24T12:00:00.000Z",
    resolvedAt: null,
  };
  const review = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Review action",
  )!;
  await act(async () => review.click());
  expect(container.textContent).toContain("Full text.");
  expect(approve.disabled).toBe(false);
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
    actionLog: [
      {
        id: "action-2",
        type: "interrupt",
        targetId: "target-thread",
        preview: "interrupt",
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

it("keeps ordinary threads free of agent-state and thread-shell subscriptions", async () => {
  await act(() =>
    root.render(
      <D4AgentPanel environmentId={environmentId} threadId={ThreadId.make("ordinary-thread")} />,
    ),
  );
  expect(mocks.stateQuery).not.toHaveBeenCalled();
  expect(mocks.threadShells).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
it("keeps pending approvals older than the latest twenty actions accessible", async () => {
  mocks.state = {
    ...mocks.state!,
    actionLog: Array.from({ length: 25 }, (_, index) => ({
      id: `action-${index}`,
      type: "interrupt" as const,
      targetId: `target-${index}`,
      preview: "interrupt",
      status: "pending" as const,
      createdAt: "2026-10-24T12:00:00.000Z",
      resolvedAt: null,
    })),
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(
    [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Review action",
    ),
  ).toHaveLength(25);
  expect(container.textContent).toContain("target-24");
});

it("loads full details for a completed automatic action only when reviewed", async () => {
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "completed-1",
        type: "send",
        targetId: "target-completed",
        preview: "Short preview",
        status: "executed",
        createdAt: "2026-10-24T12:00:00.000Z",
        resolvedAt: "2026-10-24T12:00:01.000Z",
      },
    ],
  };
  mocks.detail = {
    id: "completed-1",
    action: {
      type: "send",
      threadId: ThreadId.make("target-completed"),
      text: "Complete automatic message beyond the truncated preview.",
    },
    status: "executed",
    createdAt: "2026-10-24T12:00:00.000Z",
    resolvedAt: "2026-10-24T12:00:01.000Z",
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  await act(async () => container.querySelector("summary")!.click());
  expect(container.textContent).toContain("target-completed");
  expect(container.textContent).not.toContain("Complete automatic message");
  const review = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Review action",
  )!;
  await act(async () => review.click());
  expect(container.textContent).toContain(
    "Complete automatic message beyond the truncated preview.",
  );
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Approve"),
  ).toBe(false);
});
