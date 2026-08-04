import { describe, expect, it, vi } from "vite-plus/test";

import { startSystemMonitorPolling, SYSTEM_MONITOR_POLL_INTERVAL_MS } from "./SystemPanel";

describe("SystemPanel", () => {
  it("refreshes automatically every two seconds", () => {
    const refresh = vi.fn();
    const cancel = vi.fn();
    let scheduledRefresh: () => void = () => undefined;
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      scheduledRefresh = callback;
      expect(intervalMs).toBe(2_000);
      return 42;
    });

    const stop = startSystemMonitorPolling(refresh, schedule, cancel);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(SYSTEM_MONITOR_POLL_INTERVAL_MS).toBe(2_000);
    scheduledRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
