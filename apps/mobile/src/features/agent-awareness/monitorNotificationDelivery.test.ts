import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { deliverMonitorNotification } from "./monitorNotificationDelivery";

const setup = () => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  reportKey: "run:wedged",
  isEnabled: () => true,
  hasPermission: vi.fn(async () => true),
  claim: vi.fn(async (): Promise<boolean | null> => true),
  notify: vi.fn(async () => undefined),
});

describe("monitor notification delivery", () => {
  it("requires both opt-in and OS permission before consuming the server claim", async () => {
    const disabled = setup();
    expect(await deliverMonitorNotification({ ...disabled, isEnabled: () => false })).toBe(false);
    expect(disabled.hasPermission).not.toHaveBeenCalled();
    expect(disabled.claim).not.toHaveBeenCalled();
    const denied = setup();
    denied.hasPermission.mockResolvedValue(false);
    expect(await deliverMonitorNotification(denied)).toBe(false);
    expect(denied.claim).not.toHaveBeenCalled();
    expect(denied.notify).not.toHaveBeenCalled();
  });

  it("respects a claim already consumed by another client", async () => {
    const input = setup();
    input.claim.mockResolvedValue(false);
    expect(await deliverMonitorNotification(input)).toBe(true);
    expect(input.notify).not.toHaveBeenCalled();
  });

  it("contains only generic copy and thread navigation identifiers", async () => {
    const input = setup();
    expect(await deliverMonitorNotification(input)).toBe(true);
    expect(input.notify).toHaveBeenCalledExactlyOnceWith({
      title: "Thread needs attention",
      body: "Open the thread to review its status.",
      data: { environmentId: input.environmentId, threadId: input.threadId },
    });
  });

  it("rechecks opt-in after permission resolves", async () => {
    const input = setup();
    let enabled = true;
    input.hasPermission.mockImplementation(async () => {
      enabled = false;
      return true;
    });
    expect(await deliverMonitorNotification({ ...input, isEnabled: () => enabled })).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
  });

  it("does not mark RPC failures checked", async () => {
    const input = setup();
    input.claim.mockResolvedValue(null);
    expect(await deliverMonitorNotification(input)).toBe(false);
    expect(input.notify).not.toHaveBeenCalled();
  });
});
