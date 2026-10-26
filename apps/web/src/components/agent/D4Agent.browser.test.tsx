import type { Editor } from "@tiptap/core";
import { serializeEditorDoc } from "../../composer-rich-text-doc";
import { ThreadRouteView } from "../ThreadRouteView";
import { D4AgentChat, D4AgentRoute } from "./D4AgentChat";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { D4AgentEntry, D4AgentPanel } from "./D4Agent";
import { D4AgentSessions } from "./D4AgentSessions";
import * as Cause from "effect/Cause";
import {
  D4AgentError,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ModelSelection,
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
  send: vi.fn(async () => ({ _tag: "Success", value: { threadId: "agent-thread" as ThreadId } })),
  undo: vi.fn(async () => ({ _tag: "Success" })),
  closeSession: vi.fn(async () => ({ _tag: "Success" })),
  resolveProposal: vi.fn(async () => ({ _tag: "Success" })),
  routeProjectId: undefined as ProjectId | undefined,
  projects: [] as Array<{ id: ProjectId; title: string; environmentId: EnvironmentId }>,
  projectContexts: {} as D4AgentSettings["projectContexts"],
  refresh: vi.fn(),
  threadShells: vi.fn(),
  stateQuery: vi.fn(),
  detail: null as D4AgentActionRecord | null,
  identityMissing: false,
  routeShellMissing: false,
  stateUnavailable: false,
  statePending: false,
  nativeRoute: vi.fn(),
  providers: [] as ServerProvider[],
  modelSelection: null as ModelSelection | null,
  updateSettings: vi.fn(async () => ({ _tag: "Success" })),
  running: false,
  allowed: true,
  enabled: true,
  configLoaded: true,
  connectionPhase: "connected",
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
  stateListeners: new Set<() => void>(),
  stateValue: null as D4AgentState | null,
  // Nia's panel is compiler-memoized; like the real atom, a state change must notify readers.
  get state() {
    return this.stateValue;
  },
  set state(value) {
    this.stateValue = value;
    for (const listener of this.stateListeners) listener();
  },
}));
vi.mock("@d4research/client-runtime/state/server", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<object>()),
    waitForD4AgentThreadShell: () => Effect.succeed(true),
  };
});
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (selector: (store: { uploadsByImageId: object }) => unknown) =>
    selector({ uploadsByImageId: {} }),
  startAttachmentUpload: vi.fn(),
  retryAttachmentUpload: vi.fn(),
  releaseDraftAttachments: vi.fn(),
  awaitAttachmentUploads: async () => undefined,
  getUploadedAttachments: ({
    images,
  }: {
    images: Array<{ id: string; type: string; name: string; mimeType: string; sizeBytes: number }>;
  }) =>
    images.map(({ id, type, name, mimeType, sizeBytes }) => ({
      id,
      type,
      name,
      mimeType,
      sizeBytes,
    })),
}));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: vi.fn(),
  useAssetUrlRefresh: vi.fn(),
  resolveAssetUrl: vi.fn(),
  useAssetUrl: (environmentId: string, asset: { attachmentId: string }) =>
    `/${environmentId}/attachments/${asset.attachmentId}`,
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: vi.fn(),
  ensureClientSettingsHydrated: vi.fn(),
  useEnvironmentIdentificationMode: () => "none",
  useMergedSettings: (settings: object) => ({ ...DEFAULT_CLIENT_SETTINGS, ...settings }),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => vi.fn(),
  useUpdateEnvironmentSettings: () => vi.fn(),
  useEnvironmentModelPreferences: () => ({ favorites: [], hiddenModels: [] }),
  useToggleEnvironmentModelFavorite: () => vi.fn(),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: string) =>
    value === "config"
      ? mocks.configLoaded
        ? {
            environment: {
              capabilities: {
                attachmentUploads: true,
                fileAttachments: { maxUploadBytes: 10000000 },
              },
            },
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              d4Agent: {
                ...DEFAULT_SERVER_SETTINGS.d4Agent,
                enabled: mocks.enabled,
                modelSelection: mocks.modelSelection,
                projectContexts: mocks.projectContexts,
              },
              agentMonitor: { enabled: mocks.monitorEnabled },
            },
          }
        : null
      : mocks.allowed,
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: vi.fn(),
  EMPTY_SERVER_PROVIDERS: [],
  primaryServerKeybindingsAtom: "keybindings",
  primaryServerConfigAtom: "config",
  serverEnvironment: {
    updateSettings: { permissionAtom: () => "permission", kind: "settings" },
    configValueAtom: () => "config",
    d4AgentState: () => "state",
    d4AgentIdentity: () => "identity",
    d4AgentAction: () => "detail",
    ensureD4AgentThread: { permissionAtom: () => "permission" },
    sendD4AgentMessage: { permissionAtom: () => "permission", kind: "send" },
    undoD4AgentArchive: { permissionAtom: () => "permission", kind: "undo-archive" },
    closeD4AgentSession: { permissionAtom: () => "permission", kind: "close-session" },
    newD4AgentSession: { permissionAtom: () => "permission", kind: "new-session" },
    resolveD4AgentMemoryProposal: { permissionAtom: () => "permission", kind: "proposal" },
    switchD4AgentContext: { permissionAtom: () => "permission", kind: "switch" },
    resolveD4AgentAction: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind?: string }) =>
    command.kind === "settings"
      ? mocks.updateSettings
      : command.kind === "undo-archive"
        ? mocks.undo
        : command.kind === "send"
          ? mocks.send
          : command.kind === "close-session"
            ? mocks.closeSession
            : command.kind === "switch"
              ? mocks.switchContext
              : command.kind === "new-session"
                ? mocks.newSession
                : command.kind === "proposal"
                  ? mocks.resolveProposal
                  : mocks.resolve,
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: vi.fn(),
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === "identity"
        ? mocks.identityMissing
          ? null
          : { threadId: mocks.state?.threadId, projectId: mocks.state?.projectId }
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
  useEnvironmentSupportsServerBrowser: vi.fn(),
  readEnvironmentSupportsServerBrowser: vi.fn(),
  useEnvironmentThreadRefs: () => [],
  useThreadRefs: () => [],
  useQuietThreadShell: () => null,
  useThreadShell: () =>
    mocks.routeShellMissing
      ? null
      : {
          projectId: mocks.routeProjectId ?? mocks.state?.projectId,
          runtime: mocks.running ? { status: "running" } : null,
        },
  useProjects: () => mocks.projects,
  useProject: (ref: { projectId: string } | null) =>
    mocks.projects.find((project) => project.id === ref?.projectId) ?? null,
  useThreadShells: () => {
    mocks.threadShells();
    return mocks.threads;
  },
}));
vi.mock("./useD4AgentState", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useD4AgentState: (_environmentId: EnvironmentId, enabled = true) => {
      mocks.stateQuery(enabled);
      const state = useSyncExternalStore(
        (listener) => {
          mocks.stateListeners.add(listener);
          return () => mocks.stateListeners.delete(listener);
        },
        () => mocks.state,
      );
      return {
        data: enabled && !mocks.statePending && !mocks.stateUnavailable ? state : null,
        refresh: mocks.refresh,
        isPending: mocks.statePending,
        error: null,
      };
    },
  };
});
vi.mock("../ui/sidebar", () => ({
  useSidebarVisibility: () => true,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ChatView", () => ({ default: () => <button>Initialize Git</button> }));
vi.mock("../ChatMarkdown", () => ({
  MarkdownCodeBlockFrame: vi.fn(),
  default: ({ text }: { text: string }) => <div className="chat-markdown">{text}</div>,
}));
vi.mock("../ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => false,
}));
vi.mock("../chat/draftHeroTransition", () => ({
  waitForDraftHeroTransition: async () => undefined,
}));
vi.mock("../../composerDraftStore", async () => ({
  composerFileNeedsReattach: vi.fn(),
  DraftId: (await import("effect/Schema")).String.pipe(
    (await import("effect/Schema")).brand("DraftId"),
  ),
  useComposerDraftStore: (
    selector: (store: { setProviderModelOptions: ReturnType<typeof vi.fn> }) => unknown,
  ) => {
    if (mocks.providers.length) return selector({ setProviderModelOptions: vi.fn() });
    mocks.nativeRoute();
    throw new Error("Archived agent route reached native draft/missing guard");
  },
  finalizePromotedDraftThreadByRef: vi.fn(),
  markPromotedDraftThreadByRef: vi.fn(),
  useBackgroundDraftSubmissionPending: () => false,
  clearComposerDraftsEnvironment: vi.fn(),
}));
vi.mock("../../sidebarPendingFileDropStore", () => ({ useSidebarPendingFileDropStore: {} }));
vi.mock("../../state/shell", () => ({
  environmentSnapshotAtom: vi.fn(),
  useEnvironmentShellStatus: () => "live",
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: vi.fn(),
  useEnvironmentProviders: () => new Map([[environmentId, mocks.providers]]),
  useEnvironment: () => ({ connection: { phase: mocks.connectionPhase } }),
  useEnvironments: () => ({
    environments: [{ environmentId: "test-environment", label: "Local" }],
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    children: React.ReactNode;
    params?: { environmentId: string; threadId: string };
  }) => (
    <a href={params ? `/${params.environmentId}/${params.threadId}` : "/settings/general"}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
}));
function niaEditor() {
  const input = container.querySelector<HTMLElement & { editor: Editor }>(
    '[data-testid="composer-editor"][aria-label="Message Nia"]',
  );
  if (!input) throw new Error("Nia editor is missing");
  return input;
}
function writeNiaDraft(text: string) {
  niaEditor().editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
  });
}
function niaDraftText() {
  return serializeEditorDoc(niaEditor().editor.state.doc).value;
}
function niaSubmit() {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-chat-composer-actions="right"] button[type="submit"]',
  );
  if (!button) throw new Error("Nia submit button is missing");
  return button;
}
let root: Root;
let container: HTMLDivElement;
const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("agent-thread");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.resolve.mockClear();
  mocks.connectionPhase = "connected";
  mocks.send.mockClear();
  mocks.undo.mockClear();
  mocks.switchContext.mockClear();
  mocks.newSession.mockClear();
  mocks.closeSession.mockClear();
  mocks.resolveProposal.mockClear();
  mocks.projects = [];
  mocks.projectContexts = {};
  mocks.routeProjectId = undefined;
  mocks.refresh.mockClear();
  mocks.threadShells.mockClear();
  mocks.stateQuery.mockClear();
  mocks.detail = null;
  mocks.identityMissing = false;
  mocks.routeShellMissing = false;
  mocks.stateUnavailable = false;
  mocks.statePending = false;
  mocks.nativeRoute.mockClear();
  mocks.providers = [];
  mocks.modelSelection = null;
  mocks.updateSettings.mockClear();
  mocks.running = false;
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
    (button) => button.textContent === "Send",
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

it("waits for a connection before opening Nia with cached configuration", async () => {
  mocks.state = { ...mocks.state!, threadId: null, projectId: null };
  mocks.connectionPhase = "connecting";
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();

  mocks.connectionPhase = "connected";
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} label={null} />));
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.resolve).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  });
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
it("keeps monitor reports and session banners out of the chat header", async () => {
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    modelAvailable: true,
    sessionChangeReason: "context",
    ctoAskInFlight: true,
  };
  mocks.threads = [
    {
      id: ThreadId.make("stuck-thread"),
      projectId: ProjectId.make("yb-project"),
      title: "Stuck report",
      environmentId,
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: true, classification: "wedged" } },
    },
  ];
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).not.toContain("Stuck report");
  expect(container.textContent).not.toContain("need attention");
  expect(container.textContent).not.toContain("New session.");
  expect(container.querySelector('[aria-label="Waiting for you"]')).toBeNull();
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
    memoryProposalCount: 60,
    otherContextProposalCounts: [{ context: "Dimaggi", count: 1 }],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("Keep this scoped note.");
  expect(container.textContent).toContain("Memory proposals · 60 pending");
  expect(container.textContent).toContain("Showing the oldest 1. Review them to see the rest.");
  expect(container.textContent).toContain("2026-10-24T12:00:00.000Z");
  expect(container.textContent).toContain("Pending memory proposals · Dimaggi: 1");
  expect(container.textContent).not.toContain("Other context private text");
  for (const [label, approve] of [
    ["Approve", true],
    ["Reject", false],
  ] as const) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
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
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
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

it("keeps one visible transcript across isolated context routes and hides provider history", async () => {
  const oldThreadId = ThreadId.make("old-global-session");
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    chatThreadIds: [oldThreadId, threadId],
    transcript: [
      {
        id: "first",
        role: "user",
        context: "Global",
        text: "What needs me?",
        createdAt: "2026-10-24T12:00:00.000Z",
        links: [],
      },
      {
        id: "divider",
        role: "system",
        context: "YB",
        text: "Context changed to YB. New session.",
        createdAt: "2026-10-24T12:01:00.000Z",
        links: [],
      },
      {
        id: "reply",
        role: "assistant",
        context: "YB",
        text: "Review this thread.",
        createdAt: "2026-10-24T12:02:00.000Z",
        links: [
          { label: "Validated target", threadId: ThreadId.make("valid-target"), projectId: null },
          { label: "Other context label", threadId: null, projectId: null },
        ],
      },
    ],
  };
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={oldThreadId}>
        <p>Private provider history</p>
      </D4AgentRoute>,
    ),
  );
  expect(container.textContent).toContain("What needs me?");
  expect(container.textContent).toContain("Context changed to YB. New session.");
  expect(container.textContent).toContain("Review this thread.");
  expect(container.textContent).not.toContain("Private provider history");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="/test-environment/valid-target"]')?.textContent).toBe(
    "Validated target",
  );
  expect(
    [...container.querySelectorAll("a")].some((item) => item.textContent === "Other context label"),
  ).toBe(false);
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={threadId}>
        <p>Private YB provider history</p>
      </D4AgentRoute>,
    ),
  );
  expect(container.textContent).toContain("What needs me?");
  expect(container.textContent).not.toContain("Private YB provider history");
});

it("keeps open sessions out of the chat panel", async () => {
  mocks.state = {
    ...mocks.state!,
    openSessions: [
      {
        context: "YB",
        threadId,
        providerSessionId: "native-yb",
        lastActivityAt: "2026-10-24T12:00:00.000Z",
        inputTokens: 1234,
        contextWindow: 200000,
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("New session");
  expect(container.textContent).not.toContain("Open sessions");
});

it("settings show session usage and close only the selected context after an explicit click", async () => {
  await act(() =>
    root.render(
      <D4AgentSessions
        environmentId={environmentId}
        sessions={[
          {
            context: "YB",
            threadId,
            providerSessionId: "native-yb",
            lastActivityAt: "2026-10-24T12:00:00.000Z",
            inputTokens: 1234,
            contextWindow: 200000,
          },
        ]}
        refresh={mocks.refresh}
      />,
    ),
  );
  expect(container.textContent).toContain("Open sessions · 1/4");
  expect(mocks.closeSession).not.toHaveBeenCalled();
  expect(container.textContent).toContain("1234 input tokens");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Close YB session")!
      .click(),
  );
  expect(mocks.closeSession).toHaveBeenCalledWith({ environmentId, input: { context: "YB" } });
  expect(mocks.refresh).toHaveBeenCalled();
});

it("requires explicit review before sending a rewrite and allows sending the original", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "rewrite",
        type: "send",
        targetId: "target-thread",
        preview: "Detailed rewritten request",
        status: "pending",
        createdAt,
        resolvedAt: null,
      },
    ],
  };
  mocks.detail = {
    id: "rewrite",
    context: "Global",
    sessionId: threadId,
    action: {
      type: "send",
      threadId: ThreadId.make("target-thread"),
      originalText: "Check this",
      text: "Detailed rewritten request",
    },
    status: "pending",
    createdAt,
    resolvedAt: null,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(mocks.resolve).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Review action")!
      .click(),
  );
  expect(container.textContent).toContain("Original");
  expect(container.textContent).toContain("Check this");
  expect(container.textContent).toContain("Rewritten prompt");
  expect(container.textContent).toContain("Detailed rewritten request");
  await act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Edit")!.click(),
  );
  expect(container.querySelector('textarea[aria-label="Edit rewritten prompt"]')).not.toBeNull();
  expect(mocks.resolve).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Send original")!
      .click(),
  );
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { actionId: "rewrite", decision: "approve", sendOriginal: true },
  });
});

it("keeps Nia's literal draft bounded and permits edits after reaching the limit", async () => {
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  const draft = "x".repeat(16000);
  await act(() => writeNiaDraft(draft));
  await act(() => {
    const editor = niaEditor().editor;
    editor.commands.setTextSelection(16001);
    editor.commands.insertContent("overflow");
  });
  expect(niaDraftText()).toBe(draft);
  await act(() => writeNiaDraft("[[thread:stable-target]] **literal**"));
  expect(niaDraftText()).toBe("[[thread:stable-target]] **literal**");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("sends an agent draft only on explicit submit and preserves the single-chat route", async () => {
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={threadId}>
        <p>Native content</p>
      </D4AgentRoute>,
    ),
  );
  await act(async () => writeNiaDraft("Research the question"));
  expect(mocks.send).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find(
        (item) =>
          item.getAttribute("aria-label") === "Submit message" || item.textContent === "Send",
      )!
      .click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      attachments: [],
      followUpBehavior: "queue",
      text: "Research the question",
      expectedContext: mocks.state!.brainContext,
      expectedThreadId: mocks.state!.threadId,
    },
  });
  expect(niaDraftText()).toBe("");
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("sends the human-edited rewrite only after explicit Send", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "edited",
        type: "send",
        targetId: "target-thread",
        preview: "Draft rewrite",
        status: "pending",
        createdAt,
        resolvedAt: null,
      },
    ],
  };
  mocks.detail = {
    id: "edited",
    context: "Global",
    sessionId: threadId,
    action: {
      type: "send",
      threadId: ThreadId.make("target-thread"),
      originalText: "Check this",
      text: "Draft rewrite",
    },
    status: "pending",
    createdAt,
    resolvedAt: null,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Review action")!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Edit")!.click(),
  );
  const input = container.querySelector(
    'textarea[aria-label="Edit rewritten prompt"]',
  ) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Human-edited instruction",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find(
        (item) =>
          item.getAttribute("aria-label") === "Submit message" || item.textContent === "Send",
      )!
      .click(),
  );
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { actionId: "edited", decision: "approve", editedText: "Human-edited instruction" },
  });
});

it.each(["research", "pipeline"] as const)(
  "shows the final %s prompt, target, pipeline and model before approval",
  async (type) => {
    const createdAt = "2026-10-24T12:00:00.000Z";
    mocks.state = {
      ...mocks.state!,
      actionLog: [
        {
          id: "launch",
          type,
          targetId: "target-project",
          preview: "Research the topic",
          status: "pending",
          createdAt,
          resolvedAt: null,
        },
      ],
    };
    mocks.projects = [
      { id: ProjectId.make("target-project"), title: "Research lab", environmentId },
    ];
    mocks.detail = {
      id: "launch",
      context: "Global",
      sessionId: threadId,
      action: {
        type,
        projectId: ProjectId.make("target-project"),
        text: "Detailed approved research prompt",
        pipelineId: "research:focused",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-instance"),
          model: "gpt-test",
        },
      },
      status: "pending",
      createdAt,
      resolvedAt: null,
    };
    await act(() =>
      root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    // A pending launch shows its details without a separate review step.
    expect(container.textContent).toContain(type === "research" ? "Research" : "Pipeline");
    expect(container.textContent).toContain("Target project · Research lab");
    expect(container.textContent).toContain("Pipeline · research:focused");
    expect(container.textContent).toContain("Model · codex-instance / gpt-test");
    expect(container.textContent).toContain("Detailed approved research prompt");
    expect(mocks.resolve).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Create thread")!
        .click(),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({
      environmentId,
      input: { actionId: "launch", decision: "approve" },
    });
  },
);

it("restores an automatically archived thread only after Undo archive", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "archived",
        type: "auto-archive",
        targetId: "target-thread",
        preview: "Archived completed agent thread",
        status: "executed",
        createdAt,
        resolvedAt: createdAt,
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(mocks.undo).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Undo archive")!
      .click(),
  );
  expect(mocks.undo).toHaveBeenCalledWith({ environmentId, input: { actionId: "archived" } });
});

it("keeps ordinary threads on the native surface without polling full agent state", async () => {
  mocks.state = { ...mocks.state!, projectId: ProjectId.make("agent-project") };
  mocks.routeProjectId = ProjectId.make("user-project");
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={ThreadId.make("user-thread")}>
        <p>Ordinary thread transcript</p>
      </D4AgentRoute>,
    ),
  );
  expect(container.textContent).toContain("Ordinary thread transcript");
  expect(container.textContent).not.toContain("Message Nia");
  expect(mocks.stateQuery).toHaveBeenLastCalledWith(false);
});

it("removes project-only actions when entering the dedicated agent chat", async () => {
  await act(() =>
    root.render(
      <ThreadRouteView target={{ kind: "server", threadRef: { environmentId, threadId } }} />,
    ),
  );
  expect(container.textContent).toContain("Nia");
  for (const label of ["Initialize Git", "Add project script", "Open in Files"])
    expect(container.textContent).not.toContain(label);
});

it("keeps a disabled historical agent route on the special chat surface with sending disabled", async () => {
  mocks.enabled = false;
  mocks.state = {
    ...mocks.state!,
    projectId: ProjectId.make("agent-project"),
    threadId: null,
    chatThreadIds: [threadId],
  };
  await act(() =>
    root.render(
      <ThreadRouteView target={{ kind: "server", threadRef: { environmentId, threadId } }} />,
    ),
  );
  expect(container.textContent).toContain("Nia");
  for (const label of ["Initialize Git", "Add project script", "Open in Files"])
    expect(container.textContent).not.toContain(label);
  expect(niaEditor().getAttribute("contenteditable")).toBe("false");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("reloads an idle-closed archived agent chat without mounting the native missing-thread fallback", async () => {
  mocks.identityMissing = true;
  mocks.routeShellMissing = true;
  mocks.stateUnavailable = true;
  mocks.statePending = false;
  mocks.state = {
    ...mocks.state!,
    projectId: ProjectId.make("agent-project"),
    threadId: null,
    chatThreadIds: [threadId],
    openSessions: [],
    transcript: [
      {
        id: "closed",
        role: "assistant",
        context: "Global",
        text: "Retained conversation",
        createdAt: "2026-10-24T12:00:00.000Z",
        links: [],
      },
    ],
  };
  function NativeMissingRoute() {
    mocks.nativeRoute();
    return <button>Initialize Git</button>;
  }
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={threadId}>
        <NativeMissingRoute />
      </D4AgentRoute>,
    ),
  );
  expect(mocks.nativeRoute).not.toHaveBeenCalled();
  mocks.stateUnavailable = false;
  mocks.statePending = false;
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={threadId}>
        <NativeMissingRoute />
      </D4AgentRoute>,
    ),
  );
  expect(container.textContent).toContain("Retained conversation");
  expect(container.textContent).not.toContain("Initialize Git");
  expect(mocks.nativeRoute).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("keeps the actual web route on an archived idle-closed agent conversation after reload", async () => {
  mocks.routeShellMissing = true;
  mocks.state = {
    ...mocks.state!,
    projectId: ProjectId.make("agent-project"),
    threadId: null,
    chatThreadIds: [threadId],
    openSessions: [],
    transcript: [
      {
        id: "closed",
        role: "assistant",
        context: "Global",
        text: "Retained conversation",
        createdAt: "2026-10-24T12:00:00.000Z",
        links: [],
      },
    ],
  };
  await act(() =>
    root.render(
      <ThreadRouteView target={{ kind: "server", threadRef: { environmentId, threadId } }} />,
    ),
  );
  expect(container.textContent).toContain("Retained conversation");
  expect(container.textContent).not.toContain("Initialize Git");
  expect(mocks.nativeRoute).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("inserts a scoped stable mention and sends its id after the target is renamed", async () => {
  const targetProject = ProjectId.make("yb-project");
  const otherProject = ProjectId.make("other-project");
  mocks.projectContexts = { [targetProject]: "YB", [otherProject]: "Dimaggi" };
  mocks.projects = [
    { id: targetProject, title: "YB work", environmentId },
    { id: otherProject, title: "Hidden project", environmentId },
  ];
  mocks.threads = [
    {
      id: ThreadId.make("stable-target"),
      projectId: targetProject,
      environmentId,
      title: "Original title",
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: false, classification: "working" } },
    },
    {
      id: ThreadId.make("secret-target"),
      projectId: otherProject,
      environmentId,
      title: "Hidden title",
      archivedAt: null,
      deletedAt: null,
      source: { agentMonitor: { attentionRequired: false, classification: "working" } },
    },
  ];
  mocks.state = { ...mocks.state!, brainContext: "YB" };
  const renderChat = () =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    );
  await act(renderChat);
  await act(() => writeNiaDraft("@"));
  expect(container.textContent).toContain("Original title");
  expect(container.textContent).not.toContain("Hidden title");
  expect(container.innerHTML).not.toContain("secret-target");
  expect(container.textContent).not.toContain("Hidden project");
  await act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "thread · Original title")!
      .click(),
  );
  expect(niaDraftText()).toBe("[[thread:stable-target]] ");
  mocks.threads[0] = { ...mocks.threads[0]!, title: "Renamed target" };
  await act(renderChat);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find(
        (button) =>
          button.getAttribute("aria-label") === "Submit message" || button.textContent === "Send",
      )!
      .click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      attachments: [],
      followUpBehavior: "queue",
      text: "[[thread:stable-target]]",
      expectedContext: "YB",
      expectedThreadId: mocks.state!.threadId,
    },
  });
});

it("keeps the draft and says why when another client changed Nia's context first", async () => {
  mocks.refresh.mockClear();
  mocks.send.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new D4AgentError({ reason: "stale" })),
  } as never);
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  await act(() => writeNiaDraft("Global-only draft"));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find(
        (button) =>
          button.getAttribute("aria-label") === "Submit message" || button.textContent === "Send",
      )!
      .click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      attachments: [],
      followUpBehavior: "queue",
      text: "Global-only draft",
      expectedContext: "Global",
      expectedThreadId: threadId,
    },
  });
  expect(niaDraftText()).toBe("Global-only draft");
  expect(container.textContent).toContain("Nia's context or session changed");
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("keeps a draft bound to its context until the user reassigns it", async () => {
  const render = (state: typeof mocks.state) =>
    act(() =>
      root.render(
        <D4AgentChat environmentId={environmentId} state={state!} refresh={mocks.refresh} />,
      ),
    );
  await render(mocks.state);
  await act(() => writeNiaDraft("Global-only draft"));
  const moved = {
    ...mocks.state!,
    brainContext: "Dimaggi" as const,
    threadId: ThreadId.make("dimaggi-session"),
  };
  await render(moved);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    )!;
  expect(niaDraftText()).toBe("Global-only draft");
  expect(container.textContent).toContain(
    "You wrote this draft while Nia was in Global. Nia is now in Dimaggi.",
  );
  expect(niaSubmit().disabled).toBe(true);
  await act(async () => button("Use in Dimaggi").click());
  await act(async () => niaSubmit().click());
  expect(mocks.send).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      attachments: [],
      followUpBehavior: "queue",
      text: "Global-only draft",
      expectedContext: "Dimaggi",
      expectedThreadId: "dimaggi-session",
    },
  });
});

it("does not invent an original message for a heartbeat action", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "rewrite",
        type: "send",
        targetId: "target-thread",
        preview: "Detailed rewritten request",
        status: "pending",
        createdAt,
        resolvedAt: null,
      },
    ],
  };
  mocks.detail = {
    id: "rewrite",
    context: "Global",
    sessionId: threadId,
    action: {
      type: "send",
      threadId: ThreadId.make("target-thread"),
      text: "Detailed rewritten request",
    },
    status: "pending",
    createdAt,
    resolvedAt: null,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(mocks.resolve).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Review action")!
      .click(),
  );
  expect(container.textContent).not.toContain("Original");
  expect(container.textContent).not.toContain("Send original");
  expect(container.textContent).toContain("Detailed rewritten request");
  expect(mocks.resolve).not.toHaveBeenCalled();
});

it("shows the request a pending context switch will resend without expanding the card", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        id: "switch",
        type: "switch-context",
        targetId: "target-thread",
        preview: "Switch to Dimaggi: [Private](https://example.test)",
        status: "pending",
        createdAt,
        resolvedAt: null,
      },
    ],
  };
  mocks.detail = {
    id: "switch",
    context: "Global",
    sessionId: threadId,
    action: {
      type: "switch-context",
      threadId: ThreadId.make("target-thread"),
      targetContext: "Dimaggi",
      title: "[Private](https://example.test)",
      originalText: "Add local DeepSeek to the CTO provider list",
    },
    status: "pending",
    createdAt,
    resolvedAt: null,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("Request to resend in Dimaggi");
  expect(container.textContent).toContain("Add local DeepSeek to the CTO provider list");
  expect(container.textContent).toContain("Switch to Dimaggi: [Private](https://example.test)");
  expect(container.querySelector('a[href="https://example.test"]')).toBeNull();
  expect(container.textContent).not.toContain("Review action");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Switch")!
      .click(),
  );
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { actionId: "switch", decision: "approve" },
  });
});

it("keeps an attachment-only draft bound to its context and sends it only after reassignment", async () => {
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  const upload = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer();
  transfer.items.add(new File(["research notes"], "notes.txt", { type: "text/plain" }));
  await act(async () => {
    upload.files = transfer.files;
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("notes.txt");
  mocks.state = {
    ...mocks.state!,
    brainContext: "Dimaggi",
    threadId: ThreadId.make("dimaggi-session"),
  };
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  expect(container.textContent).toContain("You wrote this draft while Nia was in Global.");
  const send = niaSubmit;
  expect(send().disabled).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use in Dimaggi")!
      .click(),
  );
  await act(async () => send().click());
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      text: "",
      expectedContext: "Dimaggi",
      expectedThreadId: "dimaggi-session",
      followUpBehavior: "queue",
      attachments: [
        {
          type: "file",
          id: expect.any(String),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 14,
        },
      ],
    },
  });
  expect(container.textContent).not.toContain("notes.txt");
});

it("sends the selected active-turn queue and steer behavior and preserves rejected attachments", async () => {
  mocks.running = true;
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  const write = async (text: string) => act(async () => writeNiaDraft(text));
  await write("Queue this");
  await act(async () => niaSubmit().click());
  expect(mocks.send).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      text: "Queue this",
      attachments: [],
      expectedContext: "Global",
      expectedThreadId: threadId,
      followUpBehavior: "queue",
    },
  });
  await write("Steer this");
  await act(async () =>
    niaSubmit().dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    ),
  );
  expect(mocks.send).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      text: "Steer this",
      attachments: [],
      expectedContext: "Global",
      expectedThreadId: threadId,
      followUpBehavior: "steer",
    },
  });
  const upload = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer();
  transfer.items.add(new File(["content"], "keep.txt", { type: "text/plain" }));
  await act(async () => {
    upload.files = transfer.files;
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  });
  mocks.send.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new D4AgentError({ reason: "stale" })),
  } as never);
  await act(async () => niaSubmit().click());
  expect(container.textContent).toContain("keep.txt");
  expect(container.textContent).toContain("Your draft is preserved.");
});

it("persists Nia effort in the environment's Nia model selection", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  mocks.modelSelection = {
    instanceId,
    model: "nia-model",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  mocks.providers = [
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-26T00:00:00.000Z",
      models: [
        {
          slug: "nia-model",
          name: "Nia model",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                currentValue: "low",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  const effort = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Low",
  )!;
  expect(effort).toBeDefined();
  await act(async () => effort.click());
  const high = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes("High"),
  )!;
  expect(high).toBeDefined();
  await act(async () => high.click());
  expect(mocks.updateSettings).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: {
        d4Agent: expect.objectContaining({
          modelSelection: {
            instanceId,
            model: "nia-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      },
    },
  });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("asks before creating a thread and then links the thread it created", async () => {
  const createdAt = "2026-10-24T12:00:00.000Z";
  const card = {
    id: "start-1",
    type: "start" as const,
    targetId: "target-project",
    preview: "Fix the flaky login test",
    createdAt,
  };
  mocks.projects = [{ id: ProjectId.make("target-project"), title: "Web app", environmentId }];
  mocks.state = {
    ...mocks.state!,
    actionLog: [{ ...card, status: "pending", resolvedAt: null }],
  };
  mocks.detail = {
    id: "start-1",
    context: "Global",
    sessionId: threadId,
    action: {
      type: "start",
      projectId: ProjectId.make("target-project"),
      text: "Fix the flaky login test",
      modelSelection: { instanceId: ProviderInstanceId.make("codex-instance"), model: "gpt-test" },
    },
    status: "pending",
    createdAt,
    resolvedAt: null,
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("New thread");
  expect(container.textContent).toContain("Web app");
  expect(container.textContent).not.toContain("Open thread");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Create thread")!
      .click(),
  );
  expect(mocks.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { actionId: "start-1", decision: "approve" },
  });
  mocks.state = {
    ...mocks.state!,
    actionLog: [
      {
        ...card,
        status: "executed",
        resolvedAt: createdAt,
        threadId: ThreadId.make("d4-action:start-1"),
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const history = [...container.querySelectorAll("summary")].find(
    (item) => item.textContent === "History",
  )!;
  await act(async () => history.click());
  const link = [...container.querySelectorAll("a")].find(
    (item) => item.textContent === "Open thread",
  );
  expect(link?.getAttribute("href")).toBe(`/${environmentId}/d4-action:start-1`);
});
