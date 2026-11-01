import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { useSidebarThreadOrderStore } from "../sidebarThreadOrderStore";
import { useSidebarOrderMigration } from "./useSidebarOrderMigration";

const fixture = vi.hoisted(() => ({
  ready: true,
  liveSnapshotsReady: true,
  supported: true,
  threads: [] as {
    id: string;
    environmentId: string;
    archivedAt: null;
    pinnedAt: null;
    settledOverride: null;
    snoozedUntil: null;
    activeOrderKey: string | null;
  }[],
  write: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => fixture.threads,
  useServerConfigs: () =>
    new Map([
      ["env", { environment: { capabilities: { threadActiveReorder: fixture.supported } } }],
    ]),
  useAllEnvironmentShellsBootstrapped: () => fixture.ready,
  useAllEnvironmentProjectSnapshotsReady: () => fixture.liveSnapshotsReady,
  readThreadShell: (ref: { threadId: string }) =>
    fixture.threads.find((thread) => thread.id === ref.threadId),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: fixture.toast } }));

function Probe() {
  useSidebarOrderMigration(fixture.write);
  return null;
}
function mount() {
  return render(<Probe />);
}
function setup() {
  fixture.ready = true;
  fixture.liveSnapshotsReady = true;
  fixture.supported = true;
  fixture.threads = ["a", "b"].map((id) => ({
    id,
    environmentId: "env",
    archivedAt: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    activeOrderKey: null,
  }));
  fixture.write.mockReset().mockImplementation(async (ref: { threadId: string }, key: string) => {
    fixture.threads.find((thread) => thread.id === ref.threadId)!.activeOrderKey = key;
    return { _tag: "Success" };
  });
  fixture.toast.mockReset();
  useSidebarThreadOrderStore.setState({
    order: ["env:b", "env:a"],
    pendingMigration: [],
    migrating: false,
  });
}

it("shares a saved order once and no longer overlays it on server updates", async () => {
  setup();
  await using screen1 = await mount();
  expect(fixture.write).toHaveBeenCalledTimes(2);
  expect(fixture.threads[1]!.activeOrderKey! < fixture.threads[0]!.activeOrderKey!).toBe(true);
  expect(useSidebarThreadOrderStore.getState().order).toEqual([]);
  await screen1.unmount();
  await using screen2 = await mount();
  expect(fixture.write).toHaveBeenCalledTimes(2);
});
it("retains a failed plan and resumes it after the drawer remounts", async () => {
  setup();
  fixture.write.mockResolvedValueOnce({ _tag: "Failure" });
  await using screen1 = await mount();
  const pending = useSidebarThreadOrderStore.getState().pendingMigration;
  expect(pending).toHaveLength(2);
  expect(useSidebarThreadOrderStore.getState().order).toEqual(["env:b", "env:a"]);
  expect(useSidebarThreadOrderStore.getState().migrating).toBe(false);
  await screen1.unmount();
  await using screen2 = await mount();
  expect(useSidebarThreadOrderStore.getState().pendingMigration).toEqual([]);
  expect(fixture.threads[1]!.activeOrderKey).toBe(pending[0]!.orderKey);
});
it("waits for snapshots and leaves older servers' arrangements intact", async () => {
  setup();
  fixture.ready = false;
  await using screen1 = await mount();
  expect(fixture.write).not.toHaveBeenCalled();
  fixture.ready = true;
  fixture.liveSnapshotsReady = false;
  await screen1.rerender(<Probe />);
  expect(fixture.write).not.toHaveBeenCalled();
  fixture.liveSnapshotsReady = true;
  fixture.supported = false;
  await screen1.rerender(<Probe />);
  expect(fixture.write).not.toHaveBeenCalled();
  expect(useSidebarThreadOrderStore.getState().order).toEqual(["env:b", "env:a"]);
});

it("resumes a partially written plan without reordering a thread changed elsewhere", async () => {
  setup();
  fixture.write
    .mockImplementationOnce(async (ref: { threadId: string }, key: string) => {
      fixture.threads.find((thread) => thread.id === ref.threadId)!.activeOrderKey = key;
      return { _tag: "Success" };
    })
    .mockResolvedValueOnce({ _tag: "Failure" });
  await using screen1 = await mount();
  expect(useSidebarThreadOrderStore.getState().pendingMigration).toHaveLength(2);
  fixture.threads[1]!.activeOrderKey = "z";
  await screen1.unmount();
  await using screen2 = await mount();
  expect(fixture.threads[1]!.activeOrderKey).toBe("z");
  expect(fixture.threads[0]!.activeOrderKey).not.toBeNull();
  expect(useSidebarThreadOrderStore.getState().pendingMigration).toEqual([]);
});
