import { environmentProjects } from "../../state/projects";
import { AtomRegistry } from "effect/reactivity";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { makeThreadShellFixture } from "../../test-fixtures";
import { HomeScreen } from "../home/HomeScreen";
import { D4AgentChat, D4AgentRoute } from "./D4AgentChat";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { D4AgentHomeHeader, D4AgentPanel } from "./D4Agent";
import * as Cause from "effect/Cause";
import {
  D4AgentError,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
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
  copy: vi.fn(async (_text: string) => undefined),
  newSession: vi.fn(async () => ({
    _tag: "Success",
    value: { threadId: "fresh-agent-thread" as ThreadId },
  })),
  send: vi.fn(async () => ({ _tag: "Success", value: { threadId: "agent-thread" as ThreadId } })),
  undo: vi.fn(async () => ({ _tag: "Success" })),
  closeSession: vi.fn(async () => ({ _tag: "Success" })),
  resolveProposal: vi.fn(async () => ({ _tag: "Success" })),
  navigationProjects: [] as Array<{ id: ProjectId; title: string }>,
  identityAtom: null as unknown,
  configAtom: null as unknown,
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
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: string) =>
    value === "list-environments"
      ? {
          providersByEnvironmentId: new Map(),
          machineByEnvironmentId: new Map(),
          settlementEnvironmentIds: new Set(),
          snoozeEnvironmentIds: new Set(),
          pinningEnvironmentIds: new Set(),
          autoSettleOptOutEnvironmentIds: new Set(),
          pinReorderEnvironmentIds: new Set(),
          activeReorderEnvironmentIds: new Set(),
          titleRegenerationEnvironmentIds: new Set(),
        }
      : value === mocks.configAtom
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
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  mocks.identityAtom = Atom.make(
    AsyncResult.success({ projectId: "agent-project", threadId: "agent-thread" }),
  );
  mocks.configAtom = Atom.make(null);
  return {
    threadListEnvironmentsAtom: "list-environments",
    serverEnvironment: {
      configValueAtom: () => mocks.configAtom,
      d4AgentState: () => "state",
      d4AgentIdentity: () => mocks.identityAtom,
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
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind?: string }) =>
    command.kind === "undo-archive"
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
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === mocks.identityAtom
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
  useThreadShell: () => (mocks.routeShellMissing ? null : { projectId: mocks.state?.projectId }),
  useProjects: () => mocks.projects,
  useThreadShells: () => mocks.threads,
  useEnvironmentServerConfig: () => ({
    settings: {
      d4Agent: { enabled: mocks.enabled, projectContexts: mocks.projectContexts },
      agentMonitor: { enabled: mocks.monitorEnabled },
    },
  }),
}));
vi.mock("./useD4AgentState", () => ({
  useD4AgentState: (_environmentId: EnvironmentId, enabled = true) => ({
    data: enabled && !mocks.statePending && !mocks.stateUnavailable ? mocks.state : null,
    refresh: mocks.refresh,
    isPending: mocks.statePending,
    error: null,
  }),
}));
vi.mock("@react-navigation/native", () => ({
  useLinkTo: () => mocks.navigate,
  useFocusEffect: () => undefined,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: (text: string) => mocks.copy(text) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
    editable = true,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
    editable?: boolean;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      disabled={!editable}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Modal: ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    ListHeaderComponent: React.ReactNode;
    ListEmptyComponent: React.ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {ListEmptyComponent}
    </div>
  ),
}));
vi.mock("react-native-screens", () => ({ ScrollViewMarker: () => null }));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  useNativeGesture: () => ({}),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../../native/v5-workspace-context", async () => ({
  NativePrimaryColumnContext: (await import("react")).createContext(null),
}));
vi.mock("../../native/scrollEdgeEffects", () => ({ nativeHeaderScrollEdgeEffects: {} }));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
  useNativeLayoutMetrics: () => null,
}));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../state/queries", () => ({
  useThreadSearch: () => ({ matches: [], isPending: false }),
}));
vi.mock("../keyboard/threadKeyboardShortcuts", () => ({ useThreadJumpShortcuts: () => undefined }));
vi.mock("../../state/thread-order", () => ({ usePendingThreadOrder: () => null }));
vi.mock("../../state/use-thread-outbox", () => ({ useQueuedThreadKeys: () => new Set() }));
vi.mock("../threads/thread-list-v2-items", () => ({
  ThreadListV2PendingRow: () => null,
  ThreadListV2Row: () => null,
  ThreadListV2SettledShelfHeader: () => null,
  ThreadListV2ShowMoreRow: () => null,
  ThreadListV2SnoozedShelfHeader: () => null,
  ThreadListV2WorkingShelfHeader: () => null,
}));
vi.mock("../threads/thread-provider-instance", () => ({
  useThreadRowProviderInstanceResolver: () => () => null,
}));
vi.mock("../threads/use-open-thread-pull-requests", () => ({
  useOpenThreadPullRequests: () => () => undefined,
}));
vi.mock("../threads/use-thread-list-v2-shelf-preferences", () => ({
  useThreadListV2ShelfPreferences: () => ({
    loaded: true,
    settledShelfExpanded: false,
    snoozedShelfExpanded: false,
    workingShelfEnabled: false,
    workingShelfExpanded: false,
  }),
}));
vi.mock("../home/thread-swipe-actions", () => ({
  SwipeableScrollGateProvider: ({ children }: { children: React.ReactNode }) => children,
  useSwipeableScrollGate: () => ({ swipeEnabled: false, scrollGateHandlers: {} }),
}));
vi.mock("../home/FabScrollContext", () => ({ useFabScroll: () => null }));
vi.mock("../workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ getScrollOffset: () => 0, state: { tabs: { threads: {} } } }),
}));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: ({ label, actions }: { label: string; actions: Array<{ title: string }> }) => (
    <div>
      <button>{label}</button>
      {actions.map((action) => (
        <span key={action.title}>{action.title}</span>
      ))}
    </div>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("../../components/ui/FloatingActionButton", () => ({ FloatingActionButton: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabClearance: 0 }),
}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: vi.fn() }));
vi.mock("../../lib/commandMetadata", () => ({ makeTurnCommandMetadata: vi.fn() }));
vi.mock("../../lib/projectThreadStartTurn", () => ({ buildProjectThreadStartTurnInput: vi.fn() }));
vi.mock("../threads/use-worktree-setup", () => ({ useWorktreeSetup: vi.fn() }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: vi.fn() }));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => {
    mocks.nativeRoute();
    throw new Error("Agent route reached ordinary native controls");
  },
}));
vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    useEnvironmentShellReadiness: vi.fn(),
    environmentSnapshotAtom: Atom.family(() =>
      Atom.make({
        projects: mocks.navigationProjects.map((project) => ({
          ...project,
          workspaceRoot: `/synthetic/${project.id}`,
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-24T00:00:00Z",
          updatedAt: "2026-10-24T00:00:00Z",
        })),
      }),
    ),
  };
});
vi.mock("../../connection/catalog", async () => ({
  environmentCatalog: {
    catalogValueAtom: (await import("effect/reactivity")).Atom.make({
      isReady: true,
      entries: new Map([["test-environment", { enabled: true }]]),
    }),
  },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@d4research/client-runtime/state/projects", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createProjectEnvironmentAtoms: () => ({}),
}));
vi.mock("../../state/new-task-draft-key", () => ({ restoredNewTaskDraftKey: vi.fn() }));
vi.mock("../../state/pending-thread-creation", () => ({
  clearPendingThreadCreationOutcome: vi.fn(),
}));
vi.mock("../../state/recover-failed-thread-draft", () => ({ recoverFailedThreadDraft: vi.fn() }));
vi.mock("../../state/use-vcs-action-state", () => ({
  dismissGitActionResult: vi.fn(),
  useGitActionProgress: vi.fn(),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: vi.fn() }));
vi.mock("../../components/LoadingScreen", () => ({ LoadingScreen: vi.fn() }));
vi.mock("../connection/connectionTone", () => ({ connectionTone: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnections: vi.fn(),
  useRemoteConnectionStatus: vi.fn(),
  useRemoteEnvironmentRuntime: vi.fn(),
}));
vi.mock("../../state/use-terminal-session", () => ({ useKnownTerminalSessions: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: vi.fn() }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: vi.fn(),
  useEnvironmentScope: vi.fn(),
}));
vi.mock("../../state/use-thread-detail", () => ({ useSelectedThreadDetailState: vi.fn() }));
vi.mock("../../state/use-thread-selection", () => ({ useThreadSelection: vi.fn() }));
vi.mock("../threads/GitActionProgressOverlay", () => ({ GitActionProgressOverlay: vi.fn() }));
vi.mock("../terminal/terminalMenu", () => ({
  buildTerminalMenuSessions: vi.fn(),
  nextOpenTerminalId: vi.fn(),
  resolveProjectScriptTerminalId: vi.fn(),
}));
vi.mock("../terminal/terminalLaunchContext", () => ({
  resolvePreferredThreadWorktreePath: vi.fn(),
  stagePendingTerminalLaunch: vi.fn(),
}));
vi.mock("../terminal/terminalDebugLog", () => ({ terminalDebugLog: vi.fn() }));
vi.mock("../threads/ThreadDetailScreen", () => ({ ThreadDetailScreen: vi.fn() }));
vi.mock("../threads/git/GitOverviewSheet", () => ({ GitOverviewSheet: vi.fn() }));
vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: vi.fn(),
}));
vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: vi.fn(),
}));
vi.mock("../../state/use-selected-thread-requests", () => ({ useSelectedThreadRequests: vi.fn() }));
vi.mock("../../state/use-selected-thread-worktree", () => ({ useSelectedThreadWorktree: vi.fn() }));
vi.mock("../../state/use-thread-composer-state", () => ({ useThreadComposerState: vi.fn() }));
vi.mock("../threads/threadContentPresentation", () => ({
  projectThreadContentPresentation: vi.fn(),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: vi.fn(),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: vi.fn(),
  useAdaptiveWorkspacePaneRole: vi.fn(),
  useRegisterWorkspaceInspector: vi.fn(),
}));
vi.mock("../files/thread-file-navigator-pane", () => ({ ThreadFileNavigatorPane: vi.fn() }));
vi.mock("../threads/thread-inspector-content-stack", () => ({
  ThreadInspectorContentStack: vi.fn(),
}));
vi.mock("../threads/thread-route-hydration", () => ({ threadRouteIsHydrating: vi.fn() }));
vi.mock("../prompt-links/useThreadPromptLink", () => ({ useThreadPromptLink: vi.fn() }));
vi.mock("../threads/ThreadHeader", () => ({ ThreadHeader: vi.fn() }));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: vi.fn(),
  useWorkspaceListNavigation: vi.fn(),
}));
let root: Root;
let container: HTMLDivElement;
const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("agent-thread");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.resolve.mockClear();
  mocks.send.mockClear();
  mocks.undo.mockClear();
  mocks.switchContext.mockClear();
  mocks.newSession.mockClear();
  mocks.closeSession.mockClear();
  mocks.resolveProposal.mockClear();
  mocks.copy.mockClear();
  mocks.projects = [];
  mocks.projectContexts = {};
  mocks.refresh.mockClear();
  mocks.threadShells.mockClear();
  mocks.stateQuery.mockClear();
  mocks.detail = null;
  mocks.identityMissing = false;
  mocks.routeShellMissing = false;
  mocks.stateUnavailable = false;
  mocks.statePending = false;
  mocks.nativeRoute.mockClear();
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

it("starts a same-context session and opens the new thread", async () => {
  mocks.state = { ...mocks.state!, brainContext: "YB" };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "New session",
  )!;
  await act(async () => button.click());
  expect(mocks.newSession).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(mocks.switchContext).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledWith(`/threads/${environmentId}/fresh-agent-thread`);
});
it("keeps proposal content within the active context and supports approve and reject", async () => {
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    memoryProposals: [
      {
        id: "yb-note",
        context: "YB",
        text: "Scoped YB proposal",
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
      {
        id: "dimaggi-note",
        context: "Dimaggi",
        text: "Hidden Dimaggi proposal",
        status: "pending",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ],
    memoryProposalCount: 60,
    otherContextProposalCounts: [{ context: "Dimaggi", count: 1 }],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("Scoped YB proposal");
  expect(container.textContent).toContain("Memory proposals · 60 pending");
  expect(container.textContent).toContain("Showing the oldest 1. Review them to see the rest.");
  expect(container.textContent).toContain("2026-10-24T12:00:00.000Z");
  expect(container.textContent).toContain("Pending memory proposals · Dimaggi: 1");
  expect(container.textContent).not.toContain("Hidden Dimaggi proposal");
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
      input: { proposalId: "yb-note", approve },
    });
  }
});
it("copies approved proposal text and shows same-context reset and CTO progress", async () => {
  mocks.state = {
    ...mocks.state!,
    brainContext: "Dimaggi",
    sessionChangeReason: "new-session",
    ctoAskInFlight: true,
    memoryProposals: [
      {
        id: "approved",
        context: "Dimaggi",
        text: "Approved Dimaggi note",
        status: "approved",
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ],
  };
  await act(() => root.render(<D4AgentPanel environmentId={environmentId} threadId={threadId} />));
  expect(container.textContent).toContain("New session.");
  expect(container.textContent).not.toContain("Context changed to");
  expect(container.textContent).toContain("CTO question in progress.");
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Copy text",
  )!;
  await act(async () => button.click());
  expect(mocks.copy).toHaveBeenCalledWith("Approved Dimaggi note");
});
it("prevents session reset and proposal review without operate permission", async () => {
  mocks.allowed = false;
  mocks.state = {
    ...mocks.state!,
    brainContext: "YB",
    memoryProposals: [
      {
        id: "yb-note",
        context: "YB",
        text: "Pending proposal",
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
  const log = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith("Action log ·"),
  )!;
  await act(async () => log.click());
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
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Validated target")!
      .click(),
  );
  expect(mocks.navigate).toHaveBeenCalledWith(`/threads/${environmentId}/valid-target`);
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.textContent === "Other context label",
    ),
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

it("shows session usage and closes only the selected context after an explicit click", async () => {
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
  expect(container.textContent).toContain("Open sessions · 1/4");
  expect(mocks.closeSession).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.includes("Open sessions"))!
      .click(),
  );
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

it("sends an agent draft only on explicit submit and preserves the single-chat route", async () => {
  await act(() =>
    root.render(
      <D4AgentRoute environmentId={environmentId} threadId={threadId}>
        <p>Native content</p>
      </D4AgentRoute>,
    ),
  );
  const input = container.querySelector(
    'textarea[aria-label="Message Nia"]',
  ) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Research the question",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.send).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Send")!.click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      text: "Research the question",
      expectedContext: mocks.state!.brainContext,
      expectedThreadId: mocks.state!.threadId,
    },
  });
  expect(input.value).toBe("");
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
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Send")!.click(),
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
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Review action")!
        .click(),
    );
    expect(container.textContent).toContain("Target project · target-project");
    expect(container.textContent).toContain("Pipeline · research:focused");
    expect(container.textContent).toContain("Model · codex-instance / gpt-test");
    expect(container.textContent).toContain("Detailed approved research prompt");
    expect(mocks.resolve).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Approve")!
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
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.startsWith("Action log"))!
      .click(),
  );
  expect(mocks.undo).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Undo archive")!
      .click(),
  );
  expect(mocks.undo).toHaveBeenCalledWith({ environmentId, input: { actionId: "archived" } });
});

it("pins the agent above filters in the actual mobile HomeScreen", async () => {
  const noop = vi.fn();
  mocks.navigationProjects = [
    { id: ProjectId.make("agent-project"), title: "Owned agent project" },
    { id: ProjectId.make("ordinary-project"), title: "Ordinary project" },
  ];
  const registry = AtomRegistry.make();
  const projects = registry.get(environmentProjects.normalProjectsAtom);
  expect(registry.get(environmentProjects.projectsAtom)).toHaveLength(2);
  const props = {
    projects,
    threads: [
      makeThreadShellFixture({
        id: ThreadId.make("ordinary"),
        projectId: ProjectId.make("project"),
        environmentId,
        title: "Ordinary thread",
      }),
    ],
    pendingTasks: [],
    catalogState: { hasConnections: true, hasReadyEnvironment: true },
    savedConnectionsById: {},
    environments: [{ environmentId, label: "Local", connectionState: "connected" }],
    searchQuery: "",
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    projectSortOrder: "name",
    projectGroupingMode: "none",
    onSearchQueryChange: noop,
    onEnvironmentChange: noop,
    onProjectChange: noop,
    onAddConnection: noop,
  } as unknown as React.ComponentProps<typeof HomeScreen>;
  await act(() => root.render(<HomeScreen {...props} />));
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons[0]?.textContent).toBe("Nia");
  expect(container.textContent).toContain("Ordinary project");
  expect(container.textContent).not.toContain("Owned agent project");
  registry.dispose();
  expect(buttons.map((button) => button.textContent)).toContain("All projects");
  await act(() => buttons[0]!.click());
  expect(mocks.navigate).toHaveBeenCalledWith(`/threads/${environmentId}/${threadId}`);
});

it("keeps only the selected environment agent entry at the top of mobile home", async () => {
  const other = EnvironmentId.make("other");
  await act(() =>
    root.render(
      <D4AgentHomeHeader
        environments={[
          { environmentId, label: "Local" },
          { environmentId: other, label: "Remote" },
        ]}
        selectedEnvironmentId={environmentId}
      >
        <button>Projects</button>
      </D4AgentHomeHeader>,
    ),
  );
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Nia · Local",
    "Projects",
  ]);
});

it("removes project-only actions from the dedicated mobile chat", async () => {
  await act(() =>
    root.render(<ThreadRouteScreen route={{ params: { environmentId, threadId } }} />),
  );
  expect(mocks.nativeRoute).not.toHaveBeenCalled();
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
    root.render(<ThreadRouteScreen route={{ params: { environmentId, threadId } }} />),
  );
  expect(mocks.nativeRoute).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Nia");
  for (const label of ["Initialize Git", "Add project script", "Open in Files"])
    expect(container.textContent).not.toContain(label);
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Nia"]')?.disabled,
  ).toBe(true);
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
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Nia"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(() => {
    setter.call(input, "@");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Original title");
  expect(container.textContent).not.toContain("Hidden title");
  expect(container.innerHTML).not.toContain("secret-target");
  expect(container.textContent).not.toContain("Hidden project");
  await act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "thread · Original title")!
      .click(),
  );
  expect(input.value).toBe("[[thread:stable-target]] ");
  mocks.threads[0] = { ...mocks.threads[0]!, title: "Renamed target" };
  await act(renderChat);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Send")!
      .click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: {
      text: "[[thread:stable-target]]",
      expectedContext: "YB",
      expectedThreadId: mocks.state!.threadId,
    },
  });
});

it("keeps the draft and says why when another client changed Nia's context first", async () => {
  mocks.send.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new D4AgentError({ reason: "stale" })),
  } as never);
  await act(() =>
    root.render(
      <D4AgentChat environmentId={environmentId} state={mocks.state!} refresh={mocks.refresh} />,
    ),
  );
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Nia"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(() => {
    setter.call(input, "Global-only draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Send")!
      .click(),
  );
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId,
    input: { text: "Global-only draft", expectedContext: "Global", expectedThreadId: threadId },
  });
  expect(input.value).toBe("Global-only draft");
  expect(container.textContent).toContain("Nia's context or session changed");
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
