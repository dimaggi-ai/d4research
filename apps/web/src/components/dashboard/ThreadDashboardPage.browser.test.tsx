import "~/index.css";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";
import { DEFAULT_CLIENT_SETTINGS, type DashboardLayout } from "@d4research/contracts/settings";
import { ThreadId } from "@d4research/contracts";
import {
  dashboardProjects,
  dashboardThread,
  DASHBOARD_NOW,
  LOCAL,
  REMOTE,
} from "./dashboard.test-fixtures";

const state = vi.hoisted(() => ({
  threads: [] as EnvironmentThreadShell[],
  layout: "board" as DashboardLayout,
  listeners: new Set<() => void>(),
}));
vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShells: () =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.threads,
    ),
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, dashboardLayout: state.layout };
    return selector ? selector(settings) : settings;
  }) as typeof import("../../hooks/useSettings").useClientSettings,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: [
      { environmentId: LOCAL, label: "Local Mac", connection: { phase: "connected" } },
      { environmentId: REMOTE, label: "Mac mini", connection: { phase: "disconnected" } },
    ],
  })) as never,
  useEnvironmentProviders: () => new Map(),
}));
vi.mock(import("../sidebar/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () => ({ projectGroups: dashboardProjects(), orderedProjectKeys: [] }),
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-10-24T21:00" }));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => <span data-testid="project-icon">🚀</span>,
}));
import { ThreadDashboardPage } from "./ThreadDashboardPage";

function setup(layout: DashboardLayout = "board") {
  state.layout = layout;
  state.threads = [
    dashboardThread(),
    dashboardThread({
      environmentId: REMOTE,
      id: ThreadId.make("remote-result"),
      title: "Check the CDC suite",
    }),
  ];
  const keys = ["t3code:thread-dashboard-filters:v1", "t3code:sidebar-project-scope:v1"];
  const saved = keys.map((key) => [key, localStorage.getItem(key)] as const);
  keys.forEach((key) => localStorage.removeItem(key));
  return {
    [Symbol.dispose]() {
      for (const [key, value] of saved) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}
const dashboard = () => (
  <SidebarProvider>
    <ThreadDashboardPage />
  </SidebarProvider>
);

it("uses custom environment and icon-bearing project menus and combines their filters", async () => {
  using _state = setup();
  await using screen = await render(dashboard());
  await expect.element(screen.getByRole("heading", { name: "On deck", exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("[data-dashboard-card]")).toHaveLength(2);
  await userEvent.click(screen.getByRole("combobox", { name: "Environment filter" }));
  await expect.element(page.getByRole("option", { name: "Mac mini · Offline" })).toBeVisible();
  await userEvent.click(page.getByRole("option", { name: "Mac mini · Offline" }));
  expect(screen.container.querySelectorAll("[data-dashboard-card]")).toHaveLength(1);
  await userEvent.click(screen.getByRole("combobox", { name: "Project filter" }));
  const options = document.querySelectorAll(
    '[data-slot="select-item"] [data-testid="project-icon"]',
  );
  expect(options.length).toBeGreaterThan(0);
  await userEvent.click(page.getByRole("option", { name: "All projects", exact: true }));
  await userEvent.type(screen.getByRole("searchbox", { name: "Find a thread" }), "no such thread");
  expect(screen.container.querySelectorAll("[data-dashboard-card]")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.container.querySelectorAll("[data-dashboard-card]")).toHaveLength(2);
});

it("opens the scoped remote thread and selects its real project without changing read state early", async () => {
  using _state = setup();
  await using screen = await render(dashboard());
  const card = screen.getByRole("link", { name: /Open Check the CDC suite/ });
  await userEvent.click(card);
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/remote/remote-result"),
  );
  expect(localStorage.getItem("t3code:sidebar-project-scope:v1")).toBe(
    JSON.stringify(
      dashboardProjects().find((project) =>
        project.memberProjects.some((member) => member.environmentId === REMOTE),
      )!.projectKey,
    ),
  );
  expect(state.threads[1]?.lastVisitedAt).toBeNull();
});

it("renders project lanes from the Appearance choice and responds to a real visit watermark", async () => {
  using _state = setup("projects");
  function Harness() {
    return (
      <SidebarProvider>
        <button
          onClick={() => {
            state.threads = state.threads.map((thread) => ({
              ...thread,
              lastVisitedAt: DASHBOARD_NOW,
            }));
            state.listeners.forEach((listener) => listener());
          }}
        >
          Server visit received
        </button>
        <ThreadDashboardPage />
      </SidebarProvider>
    );
  }
  await using screen = await render(<Harness />);
  expect(screen.container.querySelector('[data-layout="projects"]')).not.toBeNull();
  await expect.element(screen.getByRole("group", { name: "Projects by status" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Server visit received" }));
  expect(
    screen.container.querySelectorAll('[data-dashboard-card][data-state="ready"]'),
  ).toHaveLength(0);
  await userEvent.click(screen.getByRole("checkbox", { name: "Recently reviewed" }));
  expect(
    screen.container.querySelectorAll("[data-dashboard-reviewed] [data-dashboard-card]"),
  ).toHaveLength(2);
});
