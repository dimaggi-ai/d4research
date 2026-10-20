import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@d4research/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@d4research/contracts/settings";
import { derivePhysicalProjectKey } from "./logicalProject";

const state = vi.hoisted(() => ({ current: null as unknown, queue: Promise.resolve() }));
vi.mock("./hooks/useSettings", () => ({
  persistClientSettingsUpdate: (update: (current: unknown) => unknown) => {
    const write = state.queue.then(() => {
      state.current = update(state.current);
      return state.current;
    });
    state.queue = write.then(() => undefined);
    return write;
  },
}));
import { linkProjects } from "./projectLinks";

const project = (id: string, isScratch = false) => ({
  environmentId: EnvironmentId.make("local"),
  id: ProjectId.make(id),
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: null,
  ...(isScratch ? { isScratch: true as const } : {}),
});
beforeEach(() => {
  state.current = { ...DEFAULT_CLIENT_SETTINGS, sidebarProjectLinks: {} };
  state.queue = Promise.resolve();
});
describe("linkProjects", () => {
  it("preserves concurrent attachments and detaches only the selected checkout", async () => {
    const first = project("first");
    const second = project("second");
    await Promise.all([linkProjects([first], "target"), linkProjects([second], "target")]);
    expect(state.current).toMatchObject({
      sidebarProjectLinks: {
        [derivePhysicalProjectKey(first)]: "target",
        [derivePhysicalProjectKey(second)]: "target",
      },
    });
    await linkProjects([first], null);
    expect(state.current).toMatchObject({
      sidebarProjectLinks: { [derivePhysicalProjectKey(second)]: "target" },
    });
    expect(
      (state.current as typeof DEFAULT_CLIENT_SETTINGS).sidebarProjectLinks[
        derivePhysicalProjectKey(first)
      ],
    ).toBeUndefined();
  });
  it("excludes scratch folders from a multi-folder attachment", async () => {
    const scratch = project("scratch", true);
    const normal = project("normal");
    await linkProjects([scratch, normal], "target");
    expect((state.current as typeof DEFAULT_CLIENT_SETTINGS).sidebarProjectLinks).toEqual({
      [derivePhysicalProjectKey(normal)]: "target",
    });
  });
});
