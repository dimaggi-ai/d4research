import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ shell: null as { id: string } | null }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => state.shell },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => ({}) },
}));

import { waitForThreadShell } from "./threadForkNavigation";

const ref = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("fork-1"),
};

afterEach(() => {
  state.shell = null;
  vi.useRealTimers();
});

describe("waitForThreadShell", () => {
  it("returns true when the forked thread shell arrives before the deadline", async () => {
    vi.useFakeTimers();
    const ready = waitForThreadShell(ref);
    await vi.advanceTimersByTimeAsync(40);
    state.shell = { id: ref.threadId };
    await vi.advanceTimersByTimeAsync(40);

    expect(await ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns false instead of navigating when the shell never arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ready = waitForThreadShell(ref);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await ready).toBe(false);
    expect(vi.getMockedSystemTime()?.getTime()).toBe(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
