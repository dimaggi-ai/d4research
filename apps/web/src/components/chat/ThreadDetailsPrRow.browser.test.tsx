import { act, render as renderComponent, type Screen } from "../../../test/render";
import { EnvironmentId, type PullRequestCheck } from "@d4research/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  perform: vi.fn(),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useServerConfigs: (() => new Map()) as never,
}));
const queryData = () => ({
  number: 1,
  title: "Test PR",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  headBranch: "feature",
  baseBranch: "main",
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  checks: [state.status, ...(state.extraStatus ? [state.extraStatus] : [])].map((status) => ({
    name: `CI-${status}`,
    status,
    description: null,
    url: null,
  })),
  capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
  viewerPermissions: { actions: ["merge"] },
  mergeCapabilities: { merge: true, squash: false, rebase: false },
});
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuerySelector: ((_atom: unknown, select: (result: unknown) => unknown) =>
    select(AsyncResult.success(queryData()))) as never,
  useEnvironmentQueryIsNewer: () => true,
  useEnvironmentQueryRefresh: () => ({ refresh: vi.fn(), isPending: () => false }),
}));
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
  usePullRequestHandoffs: () => ({ handoff: null, startAsk: vi.fn(), startHandoff: vi.fn() }),
}));

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

let root: Screen;
let container: HTMLDivElement;
async function setupFixture() {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      state.status = "success";
      state.extraStatus = null;
    },
  };
}

it("requires a new merge click after passing checks become pending and pass again", async () => {
  await using _fixture = await setupFixture();
  const render = () => (
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("environment")}
      pr={null}
      number={1}
      status={null}
      project={null}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
    />
  );
  const clickMerge = () =>
    act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Merge")!
        .click();
    });
  const dialogs = () => [...document.querySelectorAll('[role="alertdialog"]')];

  await act(async () => await root.rerender(render()));
  await clickMerge();
  expect(dialogs()).toHaveLength(1);
  await act(async () => {
    state.status = "pending";
    await root.rerender(render());
  });
  expect(dialogs()).toHaveLength(0);
  await act(async () => {
    state.status = "success";
    await root.rerender(render());
  });
  expect(dialogs()).toHaveLength(0);
  await clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});

it.each<[PullRequestCheck["status"], PullRequestCheck["status"], string]>([
  ["success", "skipped", ""],
  ["failure", "cancelled", ""],
  ["success", "action-required", "1/2"],
  ["success", "pending", "1/2"],
  ["failure", "pending", "1/2"],
])(
  "shows a completion count for incomplete checks (%s, %s)",
  async (status, extraStatus, count) => {
    await using _fixture = await setupFixture();
    state.status = status;
    state.extraStatus = extraStatus;
    await act(async () => {
      await root.rerender(
        <ThreadDetailsPrRow
          environmentId={EnvironmentId.make("environment")}
          pr={null}
          number={1}
          status={null}
          project={null}
          label="Test PR"
          openAriaLabel="Open PR"
          onOpen={vi.fn()}
        />,
      );
    });
    const counts = [...container.querySelectorAll("*")]
      .map((element) => element.textContent?.trim() ?? "")
      .flatMap((value) => /^(\d+\/\d+) checks$/.exec(value)?.[1] ?? []);
    expect(new Set(counts)).toEqual(new Set(count ? [count] : []));
  },
);
