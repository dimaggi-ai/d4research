import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { D4AgentEntry, D4AgentPanel } from "./D4Agent";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  type D4AgentSettings,
  type D4AgentActionRecord,
  type D4AgentState,
} from "@d4research/contracts";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({
    _tag: "Success",
    value: { threadId: "agent-thread" as ThreadId },
  })),
  switchContext: vi.fn(async () => ({
    _tag: "Success",
    value: { threadId: "new-agent-thread" as ThreadId },
  })),
  newSession: vi.fn(async () => ({
    _tag: "Success",
    value: { threadId: "fresh-agent-thread" as ThreadId },
  })),
  resolveProposal: vi.fn(async () => ({ _tag: "Success" })),
  projectContexts: {} as D4AgentSettings["projectContexts"],
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
    projectId: ProjectId;
    title: string;
    environmentId: EnvironmentId;
    archivedAt: null;
    deletedAt: null;
    source: { agentMonitor: { attentionRequired: boolean; classification: string } };
  }>,
  navigate: vi.fn(async () => undefined),
  state: null as D4AgentState | null,
}));
vi.mock("@d4research/client-runtime/state/server", async () => {
  const Effect = await import("effect/Effect");
  return { waitForD4AgentThreadShell: () => Effect.succeed(true) };
});
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: string) =>
    value === "config"
      ? mocks.configLoaded
        ? {
            settings: {
              d4Agent: { enabled: mocks.enabled, projectContexts: mocks.projectContexts },
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
    newD4AgentSession: { permissionAtom: () => "permission", kind: "new-session" },
    resolveD4AgentMemoryProposal: { permissionAtom: () => "permission", kind: "proposal" },
    switchD4AgentContext: { permissionAtom: () => "permission", kind: "switch" },
    resolveD4AgentAction: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind?: string }) =>
    command.kind === "switch"
      ? mocks.switchContext
      : command.kind === "new-session"
        ? mocks.newSession
        : command.kind === "proposal"
          ? mocks.resolveProposal
          : mocks.resolve,
}));
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
  mocks.switchContext.mockClear();
  mocks.newSession.mockClear();
  mocks.resolveProposal.mockClear();
  mocks.projectContexts = {};
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
    brainContext: "Global",
    brainIndexes: [],
    contextChangedAt: null,
    sessionChangeReason: null,
    memoryProposals: [],
    otherContextProposalCounts: [],
    ctoAskInFlight: false,
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
    context: "Global",
    sessionId: threadId,
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
      projectId: ProjectId.make("old-project"),
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
  expect(mocks.resolve).toHaveBeenCalledWith({ environmentId, input: {} });
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
    context: "Global",
    sessionId: threadId,
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

it("switches context through the destination command and navigates to the new session", async () => {
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const selector = container.querySelector<HTMLSelectElement>(
    "select[aria-label='Agent context']",
  )!;
  expect(selector.value).toBe("Global");
  await act(async () => {
    selector.value = "YB";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.switchContext).toHaveBeenCalledWith({ environmentId, input: { context: "YB" } });
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "new-agent-thread" },
  });
});
it("restricts attention to mapped work projects and marks the new session", async () => {
  const ybProject = ProjectId.make("yb-project");
  const otherProject = ProjectId.make("other-project");
  mocks.projectContexts = { [ybProject]: "YB", [otherProject]: "Dimaggi" };
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    contextChangedAt: "2026-10-24T00:00:00.000Z",
    sessionChangeReason: "context",
  };
  mocks.threads = [
    {
      id: ThreadId.make("yb-thread"),
      projectId: ybProject,
      title: "YB attention",
      environmentId,
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: true, classification: "wedged" } },
    },
    {
      id: ThreadId.make("other-thread"),
      projectId: otherProject,
      title: "Other attention",
      environmentId,
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: true, classification: "wedged" } },
    },
    {
      id: ThreadId.make("unmapped-thread"),
      projectId: ProjectId.make("unmapped-project"),
      title: "Unmapped attention",
      environmentId,
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: true, classification: "wedged" } },
    },
  ];
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("YB attention");
  expect(container.textContent).not.toContain("Other attention");
  expect(container.textContent).not.toContain("Unmapped attention");
  expect(container.textContent).toContain("Context changed to YB. New session.");
});
it("shows the complete CTO request and persisted result when reviewed", async () => {
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "cto-result",
        type: "cto-ask",
        targetId: "YB",
        preview: "Review request",
        status: "executed",
        createdAt: "2026-10-24T00:00:00.000Z",
        resolvedAt: "2026-10-24T00:00:01.000Z",
      },
    ],
  };
  mocks.detail = {
    id: "cto-result",
    context: "YB",
    sessionId: threadId,
    action: { type: "cto-ask", context: "YB", text: "Review complete context request" },
    result: { answer: "Persisted CTO answer" },
    status: "executed",
    createdAt: "2026-10-24T00:00:00.000Z",
    resolvedAt: "2026-10-24T00:00:01.000Z",
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  await act(async () => container.querySelector("summary")!.click());
  const review = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Review action",
  )!;
  await act(async () => review.click());
  expect(container.textContent).toContain("Review complete context request");
  expect(container.textContent).toContain("Persisted CTO answer");
});

it("starts a fresh session in the current context and navigates only after the thread is available", async () => {
  mocks.state = { ...mocks.state!, brainContext: "YB" };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "New session",
  )!;
  await act(async () => button.click());
  expect(mocks.newSession).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(mocks.switchContext).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "fresh-agent-thread" },
  });
});
it("shows a same-context session divider and an in-flight CTO request", async () => {
  mocks.state = {
    ...mocks.state!,
    brainContext: "Dimaggi",
    sessionChangeReason: "new-session",
    ctoAskInFlight: true,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("New session.");
  expect(container.textContent).not.toContain("Context changed to");
  expect(container.textContent).toContain("CTO question in progress.");
});
it("reviews only current-context memory proposals and shows other-context counts", async () => {
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    memoryProposals: [
      {
        id: "yb-proposal",
        context: "YB",
        text: "Keep this scoped note.",
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
      {
        id: "other-proposal",
        context: "Dimaggi",
        text: "Other context private text",
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ],
    otherContextProposalCounts: [{ context: "Dimaggi", count: 1 }],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("Keep this scoped note.");
  expect(container.textContent).toContain("2026-10-24T12:00:00.000Z");
  expect(container.textContent).toContain("Pending memory proposals · Dimaggi: 1");
  expect(container.textContent).not.toContain("Other context private text");
  for (const [label, approve] of [
    ["Approve", true],
    ["Reject", false],
  ] as const) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    )!;
    await act(async () => button.click());
    expect(mocks.resolveProposal).toHaveBeenLastCalledWith({
      environmentId,
      input: { proposalId: "yb-proposal", approve },
    });
  }
});
it("copies approved memory text for manual vault entry", async () => {
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    memoryProposals: [
      {
        id: "approved",
        context: "YB",
        text: "Approved note to copy.",
        status: "approved",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Copy text",
  )!;
  await act(async () => button.click());
  expect(copy).toHaveBeenCalledWith("Approved note to copy.");
  expect(mocks.resolveProposal).not.toHaveBeenCalled();
});
it("requires operate permission for session reset and proposal review", async () => {
  mocks.allowed = false;
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    memoryProposals: [
      {
        id: "pending",
        context: "YB",
        text: "Pending note",
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  for (const label of ["New session", "Approve", "Reject"]) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    )!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
  }
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.resolveProposal).not.toHaveBeenCalled();
});

it("refreshes an open CTO result after completion without collapsing its details", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    brainContext: "Dimaggi",
    ctoAskInFlight: true,
    actionLog: [
      {
        id: "slow-cto",
        type: "cto-ask",
        targetId: "Dimaggi",
        preview: "Review slow question",
        status: "executed",
        createdAt,
        resolvedAt: createdAt,
      },
    ],
  };
  mocks.detail = {
    id: "slow-cto",
    context: "Dimaggi",
    sessionId: threadId,
    action: { type: "cto-ask", context: "Dimaggi", text: "Review slow question" },
    status: "executed",
    createdAt,
    resolvedAt: createdAt,
    result: "Asked, answer will be posted.",
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  await act(async () => container.querySelector("summary")!.click());
  const review = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Review action",
  )!;
  await act(async () => review.click());
  expect(container.textContent).toContain("Asked, answer will be posted.");
  mocks.refresh.mockClear();
  const completedAt = "2026-10-24T12:00:20.000Z";
  mocks.state = {
    ...mocks.state!,
    ctoAskInFlight: false,
    actionLog: mocks.state!.actionLog.map((record) => ({ ...record, resolvedAt: completedAt })),
  };
  mocks.detail = {
    ...mocks.detail!,
    resolvedAt: completedAt,
    result: "Action log only: First line\nSecond line",
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Hide action details");
  expect(container.textContent).toContain("Action log only: First line\nSecond line");
  expect(container.textContent).not.toContain("First line\\nSecond line");
  expect(container.textContent).toContain("Review slow question");
});
