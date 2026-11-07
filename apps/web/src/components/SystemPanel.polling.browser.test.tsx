import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { SystemPanel } from "./SystemPanel";

vi.mock("../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `http://environment.test${path}`,
}));
vi.mock("../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "desktop-test-token",
}));

it("uses desktop credentials without restarting polling on render and stops on unmount", async () => {
  using fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 503 }));
  using _timers = fakeTimers();
  {
    await using screen = await render(<SystemPanel />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://environment.test/api/system-monitor",
      expect.objectContaining({
        credentials: "omit",
        headers: { Authorization: "Bearer desktop-test-token" },
      }),
    );
    await screen.rerender(<SystemPanel />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.container.textContent).toContain("System status is unavailable");
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("does not overlap requests while a previous refresh is pending", async () => {
  using fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  using _timers = fakeTimers();
  await using _screen = await render(<SystemPanel />);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
