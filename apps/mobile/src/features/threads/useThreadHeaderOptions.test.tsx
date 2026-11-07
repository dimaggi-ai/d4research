// @vitest-environment jsdom
import { VcsStatusResult } from "@d4research/contracts";
import { act } from "react";
import * as Schema from "effect/Schema";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  renderedMenus: [] as ReadonlyArray<AppBarMenu>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
  };
  return {
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: import("../../components/ui/AppBar.types").AppBarProps) => {
    harness.renderedMenus = props.menus ?? [];
    return null;
  },
}));
vi.mock("../../components/ui/ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => () => {},
}));
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return Schema.decodeSync(VcsStatusResult)({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  });
}

function Header(props: { readonly gitStatus: VcsStatusResult | null; readonly title?: string }) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedGitMenuItems() {
  return harness.renderedMenus.find((menu) => menu.title === "Git controls")?.items ?? [];
}

function renderedGitStatusDescription() {
  const status = renderedGitMenuItems()[0];
  return status && "subtitle" in status ? status.subtitle : undefined;
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.renderedMenus = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("updates the menu status when Git status changes", () => {
    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");

    render(<Header gitStatus={status(["audit.txt"])} />);
    expect(renderedGitStatusDescription()).toBe("1 changed");

    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");
  });

  it("preserves the menu status and available actions for equivalent header content", () => {
    render(<Header gitStatus={status([])} />);
    const before = renderedGitMenuItems().map(({ id, title }) => ({ id, title }));

    for (let index = 0; index < 20; index += 1) {
      render(<Header gitStatus={status([])} />);
    }
    expect(renderedGitStatusDescription()).toBe("Clean");
    expect(renderedGitMenuItems().map(({ id, title }) => ({ id, title }))).toEqual(before);
  });

  it("updates menu actions when the default ref changes behind the same label", async () => {
    const pushable = (isDefaultRef: boolean) =>
      status([], {
        isDefaultRef,
        aheadCount: 1,
        hasPrimaryRemote: true,
        pr: {
          state: "open",
          number: 1,
          title: "Change",
          url: "https://example.com/pr/1",
          baseRef: "master",
          headRef: "feature",
        },
      });
    render(<Header gitStatus={pushable(false)} />);
    expect(renderedGitMenuItems()[1]?.title).toBe("Push");

    render(<Header gitStatus={pushable(true)} />);
    expect(renderedGitMenuItems()[1]?.title).toBe("Push");
    const quickAction = renderedGitMenuItems()[1];
    if (!quickAction || !("onPress" in quickAction)) throw new Error("Missing quick action");
    await act(async () => quickAction.onPress());
    expect(harness.navigatedRoutes).toEqual(["GitConfirm"]);
  });
});
