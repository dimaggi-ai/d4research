import { act, render as renderComponent, type Screen } from "../../../test/render";
import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@d4research/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, toggle: vi.fn(), run: vi.fn() }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({ data: { tasks: [task] }, error: null })) as never,
}));

import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
} as ScheduledTask;
let root: Screen;
let container: HTMLDivElement;
async function setupFixture() {
  state.allowed = true;
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

async function renderPanel() {
  await act(
    async () =>
      await root.rerender(
        <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
      ),
  );
}

const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  await using _fixture = await setupFixture();
  state.allowed = allowed;
  await renderPanel();
  await act(async () => byLabel("Run Daily review now").click());
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await using _fixture = await setupFixture();
  await renderPanel();
  state.allowed = false;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).not.toHaveBeenCalled();

  state.allowed = true;
  await act(async () => byLabel("Pause Daily review").click());
  expect(state.toggle).toHaveBeenCalledOnce();
});
