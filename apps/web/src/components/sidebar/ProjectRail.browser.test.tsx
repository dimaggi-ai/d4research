import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

const projectGroups = vi.hoisted(() =>
  ["alpha", "beta", "gamma"].map((name) => ({
    id: name,
    environmentId: "local",
    projectKey: `local:${name}`,
    displayName: name,
    title: name,
    workspaceRoot: `/work/${name}`,
    faviconPath: null,
    projectIcon: null,
    memberProjects: [{ id: name, environmentId: "local", physicalProjectKey: `local:${name}` }],
    memberProjectRefs: [{ environmentId: "local", projectId: name }],
  })),
);

vi.mock(import("./useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () => ({
    projectGroups: projectGroups as unknown as ReadonlyArray<SidebarProjectSnapshot>,
    orderedProjectKeys: projectGroups.map((project) => project.projectKey),
  }),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreadShells: () => [],
}));
vi.mock(import("../../hooks/useMediaQuery"), async (original) => ({
  ...(await original()),
  useIsMobile: () => false,
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => <span data-testid="favicon" />,
}));
const navigation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useRouter: (() => ({ navigate: navigation })) as never,
  useLocation: (() => "/") as never,
}));

import { ProjectRail } from "./ProjectRail";
import { useProjectRailGroupsStore } from "./projectRailGroupsStore";
import { useUiStateStore } from "../../uiStateStore";
import { dismissContextMenu } from "../../contextMenuFallback";

function setup() {
  navigation.mockClear();
  const storageKeys = [
    "t3code:project-rail-groups:v1",
    "t3code:sidebar:project-rail-layout",
    "t3code:sidebar:project-rail-visible",
    "t3code:sidebar-project-scope:v1",
  ];
  const saved = storageKeys.map((key) => [key, localStorage.getItem(key)] as const);
  const state = useProjectRailGroupsStore.getState();
  const order = useUiStateStore.getState().projectOrder;
  storageKeys.forEach((key) => localStorage.removeItem(key));
  useUiStateStore.setState({ projectOrder: projectGroups.map((project) => project.projectKey) });
  useProjectRailGroupsStore.setState({
    settledProjectKeys: [],
    groups: [
      {
        id: "rg-1",
        name: "Trading",
        color: "green",
        collapsed: false,
        members: ["local:beta", "local:gamma"],
      },
    ],
  });
  return {
    [Symbol.dispose]() {
      dismissContextMenu();
      useProjectRailGroupsStore.setState(state);
      useUiStateStore.setState({ projectOrder: order });
      for (const [key, value] of saved) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

// Router hooks are mocked; these tests exercise rail selection and saved preferences.
const renderRail = () => render(<ProjectRail />, { router: false });
const rail = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-project-rail]")!;
const groupHead = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-rail="ga-chip"], [data-rail="gc-head"]');
const project = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

async function projectMenu(button: HTMLButtonElement) {
  await act(() =>
    button.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 }),
    ),
  );
  await expect
    .element(page.getByRole("menuitem", { name: "Settle project", exact: true }))
    .toBeVisible();
}

async function settle(container: HTMLElement, name: string) {
  await projectMenu(project(container, name)!);
  await userEvent.click(page.getByRole("menuitem", { name: "Settle project", exact: true }));
  await vi.waitFor(() => expect(project(container, name)).toBeNull());
}

it("folds a group from its label and keeps folded projects out of reach", async () => {
  using _state = setup();
  await using screen = await renderRail();
  expect(rail(screen.container).dataset.groupStyle).toBe("edge");
  expect(groupHead(screen.container)?.textContent).toContain("Trading");
  expect(groupHead(screen.container)?.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(groupHead(screen.container)!);
  expect(groupHead(screen.container)?.getAttribute("aria-expanded")).toBe("false");
  expect(useProjectRailGroupsStore.getState().groups[0]?.collapsed).toBe(true);
  expect(screen.container.querySelector('[data-rail="ga-inner"]')?.hasAttribute("inert")).toBe(
    true,
  );
  expect(groupHead(screen.container)?.textContent).toContain("2");
});

it("switches between the short and the named rail", async () => {
  using _state = setup();
  await using screen = await renderRail();
  expect(rail(screen.container).dataset.named).toBe("false");
  await userEvent.click(screen.getByRole("button", { name: "Project actions", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Show names", exact: true }));
  expect(rail(screen.container).dataset.named).toBe("true");
  expect(
    [...screen.container.querySelectorAll('[data-rail="row"]')].map((row) => row.textContent),
  ).toEqual(["alpha", "beta", "gamma"]);
  expect(groupHead(screen.container)?.dataset.rail).toBe("gc-head");
});

it("keeps project grouping and settings available in the project menu", async () => {
  using _state = setup();
  await using screen = await renderRail();
  await projectMenu(project(screen.container, "alpha")!);
  await expect
    .element(page.getByRole("menuitem", { name: "Add to group", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("menuitem", { name: "Project settings", exact: true }))
    .toBeVisible();
});

it("settles the selected project without changing its selection or manual order, then rehydrates it", async () => {
  using _state = setup();
  await using screen = await renderRail();
  await userEvent.click(project(screen.container, "alpha")!);
  const order = useUiStateStore.getState().projectOrder;
  await settle(screen.container, "alpha");
  expect(JSON.parse(localStorage.getItem("t3code:sidebar-project-scope:v1")!)).toBe("local:alpha");
  expect(useUiStateStore.getState().projectOrder).toEqual(order);
  expect(project(screen.container, "beta")).not.toBeNull();
  const saved = localStorage.getItem("t3code:project-rail-groups:v1")!;
  await screen.unmount();
  useProjectRailGroupsStore.setState({ settledProjectKeys: [] });
  localStorage.setItem("t3code:project-rail-groups:v1", saved);
  await useProjectRailGroupsStore.persist.rehydrate();
  await using remounted = await renderRail();
  expect(project(remounted.container, "alpha")).toBeNull();
  await userEvent.click(remounted.getByRole("button", { name: "Project actions", exact: true }));
  await expect
    .element(page.getByRole("menuitem", { name: "Settled projects", exact: true }))
    .toBeVisible();
});

it("opens a settled project without restoring it, and restores it explicitly from the menu", async () => {
  using _state = setup();
  await using screen = await renderRail();
  await settle(screen.container, "beta");
  const groups = useProjectRailGroupsStore.getState().groups;
  await userEvent.click(screen.getByRole("button", { name: "Project actions", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Settled projects", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "beta", exact: true }));
  await vi.waitFor(() =>
    expect(JSON.parse(localStorage.getItem("t3code:sidebar-project-scope:v1")!)).toBe("local:beta"),
  );
  expect(project(screen.container, "beta")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Project actions", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Settled projects", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Unsettle project", exact: true }));
  await userEvent.click(
    page
      .elementLocator(document.querySelector('[data-level="2"]')!)
      .getByRole("menuitem", { name: "beta", exact: true }),
  );
  await vi.waitFor(() => expect(project(screen.container, "beta")).not.toBeNull());
  expect(useProjectRailGroupsStore.getState().groups).toEqual(groups);
  expect(project(screen.container, "beta")?.getAttribute("aria-current")).toBe("true");
});

it("keeps the rail and restore menu usable when every project is settled", async () => {
  using _state = setup();
  await using screen = await renderRail();
  for (const name of ["alpha", "beta", "gamma"]) await settle(screen.container, name);
  expect(groupHead(screen.container)).toBeNull();
  expect(rail(screen.container)).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Project actions", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Settled projects", exact: true }));
  for (const name of ["alpha", "beta", "gamma"])
    await expect.element(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
});

it("moves visible projects past settled ones while preserving their group membership", async () => {
  using _state = setup();
  useProjectRailGroupsStore.setState({
    groups: [
      {
        id: "rg-1",
        name: "Trading",
        color: "green",
        collapsed: false,
        members: ["local:alpha", "local:beta", "local:gamma"],
      },
    ],
  });
  await using screen = await renderRail();
  await settle(screen.container, "beta");
  await act(() =>
    project(screen.container, "gamma")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(useProjectRailGroupsStore.getState().groups[0]?.members).toEqual([
    "local:gamma",
    "local:alpha",
    "local:beta",
  ]);
  expect(
    [...screen.container.querySelectorAll('[data-rail="item"]')].map((button) =>
      button.getAttribute("aria-label"),
    ),
  ).toEqual(["gamma", "alpha"]);
});

it("places Dashboard above All projects and opens its route", async () => {
  using _state = setup();
  await using screen = await renderRail();
  const dashboard = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Dashboard"]',
  )!;
  const all = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="All projects"]',
  )!;
  expect(dashboard.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Dashboard", exact: true }));
  expect(navigation).toHaveBeenCalledWith({ to: "/dashboard" });
});
