import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { deliverMonitorNotification } from "./monitorNotificationDelivery";

const setup = () => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  reportKey: "run:wedged",
  notificationEligible: true,
  loadClientId: vi.fn(async (): Promise<string | null> => "mobile-installation"),
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

  it("requires an eligible report before loading identity or consuming a claim", async () => {
    const input = setup();
    expect(await deliverMonitorNotification({ ...input, notificationEligible: false })).toBe(false);
    expect(input.loadClientId).not.toHaveBeenCalled();
    expect(input.claim).not.toHaveBeenCalled();
  });

  it("requires a stable installation identity and scopes the claim to it", async () => {
    const input = setup();
    input.loadClientId.mockResolvedValueOnce(null);
    expect(await deliverMonitorNotification(input)).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
    expect(await deliverMonitorNotification(input)).toBe(true);
    expect(input.claim).toHaveBeenCalledExactlyOnceWith("mobile-installation");
  });

  it("respects a claim already consumed by another tab on this installation", async () => {
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

  it("rechecks opt-in after identity resolves", async () => {
    const input = setup();
    let enabled = true;
    input.loadClientId.mockImplementation(async () => {
      enabled = false;
      return "mobile-installation";
    });
    expect(await deliverMonitorNotification({ ...input, isEnabled: () => enabled })).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
  });

  it("rejects an oversized installation identity", async () => {
    const input = setup();
    input.loadClientId.mockResolvedValue("x".repeat(129));
    expect(await deliverMonitorNotification(input)).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
  });

  it("does not mark RPC failures checked", async () => {
    const input = setup();
    input.claim.mockResolvedValue(null);
    expect(await deliverMonitorNotification(input)).toBe(false);
    expect(input.notify).not.toHaveBeenCalled();
  });
});
