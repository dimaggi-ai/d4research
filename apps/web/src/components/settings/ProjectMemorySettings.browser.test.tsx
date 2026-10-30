import { EnvironmentId, ProjectId } from "@d4research/contracts";
import { act, render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  entries: [] as Array<{ name: string; description: string; updatedAt: string }>,
}));
vi.mock("../../state/projectMemory", () => ({
  projectMemory: { list: () => null, read: state.read, save: state.save, remove: state.remove },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.entries,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
import { ProjectMemorySettings } from "./ProjectMemorySettings";

const environmentId = EnvironmentId.make("test");
const projectId = ProjectId.make("test-project");
function setup() {
  vi.clearAllMocks();
  state.entries = [];
  const screenPromise = () =>
    render(<ProjectMemorySettings environmentId={environmentId} projectId={projectId} />);
  return { screenPromise };
}
function click(screen: { container: HTMLElement }, label: string, index = 0) {
  const target = [...screen.container.querySelectorAll("button")].filter(
    (element) => element.textContent === label,
  )[index];
  expect(target, `button ${label}`).toBeDefined();
  return act(async () => target!.click());
}
it("loads content for editing and preserves the draft when saving fails", async () => {
  const { screenPromise } = setup();
  state.entries = [{ name: "hosts", description: "Before deployment", updatedAt: "today" }];
  state.read.mockResolvedValue({
    _tag: "Success",
    value: { ...state.entries[0], content: "Inventory location" },
  });
  await using screen = await screenPromise();
  const editor = () => screen.container.querySelector("textarea");
  const alert = () => screen.container.querySelector('[role="alert"]');
  const submit = () => act(async () => screen.container.querySelector("form")!.requestSubmit());
  await click(screen, "Edit");
  expect(editor()?.value).toBe("Inventory location");
  await userEvent.clear(editor()!);
  await userEvent.type(editor()!, "Updated location");
  state.save.mockResolvedValue({ _tag: "Failure" });
  await submit();
  expect(editor()?.value).toBe("Updated location");
  expect(alert()?.textContent).toBe("Could not save memory.");
  state.save.mockResolvedValue({ _tag: "Success", value: {} });
  await submit();
  expect(state.save).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      projectId,
      name: "hosts",
      description: "Before deployment",
      content: "Updated location",
    },
  });
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(editor()).toBeNull();
});

it("requires confirmation before deleting a memory", async () => {
  const { screenPromise } = setup();
  state.entries = [{ name: "hosts", description: "Before deployment", updatedAt: "today" }];
  await using screen = await screenPromise();
  const editor = () => screen.container.querySelector("textarea");
  const alert = () => screen.container.querySelector('[role="alert"]');
  const submit = () => act(async () => screen.container.querySelector("form")!.requestSubmit());
  await click(screen, "Delete");
  expect(state.remove).not.toHaveBeenCalled();
  await click(screen, "Cancel");
  expect(state.remove).not.toHaveBeenCalled();
  await click(screen, "Delete");
  state.remove.mockResolvedValue({ _tag: "Success" });
  await click(screen, "Delete", 1);
  expect(state.remove).toHaveBeenCalledWith({ environmentId, input: { projectId, name: "hosts" } });
  expect(state.refresh).toHaveBeenCalledOnce();
});
