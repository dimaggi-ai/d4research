import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { select, queries, pages, refresh } = vi.hoisted(() => ({
  select: vi.fn(),
  queries: vi.fn(),
  pages: new Map(),
  refresh: vi.fn(),
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { workspaceSelect: {} } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { listRefs: ({ input }: { input: unknown }) => input },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => select }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (input: { cwd: string; cursor?: number }) => {
    queries(input);
    return {
      data: pages.get(`${input.cwd}:${input.cursor ?? 0}`),
      refresh,
      isPending: false,
      error: null,
    };
  },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
import { FileWorktreeToolbar } from "./FileWorktreeToolbar";

const environmentId = EnvironmentId.make("selectors");
const threadRef = { environmentId, threadId: ThreadId.make("multi-repo") };
const root = (name: string) => ({
  path: `/${name}`,
  workspaceRoot: `/${name}`,
  label: name,
  branch: "main",
  primary: name === "frontend",
});
async function openMenu(name: string) {
  await userEvent.click(
    document.querySelector<HTMLElement>(`[aria-label="Select checkout for ${name}"]`)!,
  );
}
async function findMenuItem(role: string, text: string) {
  return vi.waitFor(() => {
    const item = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((element) =>
      element.textContent?.includes(text),
    );
    if (!item) throw new Error(`Missing ${role} ${text}`);
    return item;
  });
}

function setup() {
  select.mockReset().mockResolvedValue({ _tag: "Success", value: { cwd: "/backend/task" } });
  queries.mockClear();
  pages.clear();
  for (const name of ["frontend", "backend"])
    pages.set(`/${name}:0`, {
      isRepo: true,
      refs: [
        { name: "main", current: true, worktreePath: `/${name}` },
        { name: "task", current: false, worktreePath: `/${name}/task` },
      ],
      nextCursor: null,
    });
}

describe("repository checkout controls", () => {
  it("allows recovering from a deleted selected checkout using the configured repository", async () => {
    setup();
    pages.set("/backend/deleted:0", { isRepo: false, refs: [], nextCursor: null });
    await using screen = await render(
      <FileWorktreeToolbar
        environmentId={environmentId}
        threadRef={threadRef}
        root={{ ...root("backend"), path: "/backend/deleted" }}
      />,
    );
    expect(screen.container.textContent).toContain("deleted");
    await openMenu("backend");
    await userEvent.click(await findMenuItem("menuitemradio", "/backend/task"));
    expect(select).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: threadRef.threadId, workspaceRoot: "/backend", path: "/backend/task" },
    });
  });
  it("sends the selected repository identity and leaves the primary control unchanged", async () => {
    setup();
    await using screen = await render(
      <>
        <FileWorktreeToolbar
          environmentId={environmentId}
          threadRef={threadRef}
          root={root("frontend")}
        />
        <FileWorktreeToolbar
          environmentId={environmentId}
          threadRef={threadRef}
          root={root("backend")}
        />
      </>,
    );
    await openMenu("backend");
    const task = await findMenuItem("menuitemradio", "/backend/task");
    await userEvent.click(task);
    expect(select).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: threadRef.threadId, workspaceRoot: "/backend", path: "/backend/task" },
    });
    expect(
      screen.container.querySelector('[data-file-worktree-selector="/frontend"]')?.textContent,
    ).not.toContain("task");
    expect(queries).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/backend" }));
    expect(document.body.textContent).not.toContain("Multiwork");
  });
  it("loads additional branch pages and selects a branch by repository", async () => {
    setup();
    pages.set("/backend:0", { ...pages.get("/backend:0"), nextCursor: 200 });
    pages.set("/backend:200", {
      isRepo: true,
      refs: [{ name: "older", current: false, worktreePath: null }],
      nextCursor: null,
    });
    await using screen = await render(
      <FileWorktreeToolbar
        environmentId={environmentId}
        threadRef={threadRef}
        root={root("backend")}
      />,
    );
    await openMenu("backend");
    await userEvent.click(await findMenuItem("menuitem", "Load more branches"));
    expect(queries).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/backend", cursor: 200 }));
    await userEvent.click(await findMenuItem("menuitem", "older"));
    expect(select).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: threadRef.threadId, workspaceRoot: "/backend", branch: "older" },
    });
  });
});
