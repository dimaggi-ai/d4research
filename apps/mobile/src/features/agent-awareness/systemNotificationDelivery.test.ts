import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import { deliverSystemNotification, systemAttentionDeepLink } from "./systemNotificationDelivery";
import { extractAgentNotificationDeepLink } from "./notificationPayload";
const setup = () => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("agent"),
  notificationEligible: true,
  isEnabled: () => true,
  hasPermission: vi.fn(async () => true),
  loadClientId: vi.fn(async () => "stable-device"),
  claim: vi.fn(async (): Promise<boolean | null> => true),
  notify: vi.fn(async () => undefined),
});
describe("system monitor notifications", () => {
  it("does not claim ineligible reports or without a presentation permission", async () => {
    const input = setup();
    expect(await deliverSystemNotification({ ...input, notificationEligible: false })).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
    input.hasPermission.mockResolvedValue(false);
    expect(await deliverSystemNotification(input)).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
  });
  it("rechecks opt-in after permission before consuming a claim", async () => {
    const input = setup();
    let enabled = true;
    input.hasPermission.mockImplementation(async () => {
      enabled = false;
      return true;
    });
    expect(await deliverSystemNotification({ ...input, isEnabled: () => enabled })).toBe(false);
    expect(input.claim).not.toHaveBeenCalled();
  });
  it("deduplicates claims per stable installation and includes no system details", async () => {
    const input = setup();
    expect(await deliverSystemNotification(input)).toBe(true);
    expect(input.claim).toHaveBeenCalledWith("stable-device");
    expect(input.notify).toHaveBeenCalledExactlyOnceWith({
      title: "System needs attention",
      body: "Open Nia to review host health.",
      data: { deepLink: "/threads/env/agent" },
    });
    input.notify.mockClear();
    input.claim.mockResolvedValue(false);
    expect(await deliverSystemNotification(input)).toBe(true);
    expect(input.notify).not.toHaveBeenCalled();
  });
  it("routes to settings when agent chat has never been created", () => {
    const deepLink = systemAttentionDeepLink(EnvironmentId.make("env"), null);
    expect(deepLink).toBe("/settings/thread-preferences");
    expect(
      extractAgentNotificationDeepLink({
        notification: { request: { content: { data: { deepLink } } } },
      }),
    ).toBe(deepLink);
    expect(
      extractAgentNotificationDeepLink({
        notification: {
          request: {
            content: { data: { deepLink: "/settings/thread-preferences?redirect=other" } },
          },
        },
      }),
    ).toBeNull();
  });
  it("does not mark a failed claim as checked", async () => {
    const input = setup();
    input.claim.mockResolvedValue(null);
    expect(await deliverSystemNotification(input)).toBe(false);
    expect(input.notify).not.toHaveBeenCalled();
  });
});
