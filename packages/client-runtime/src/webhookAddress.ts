import type { ScheduledTaskWebhookEndpoint } from "@d4research/contracts";
import { isLocalLoopbackHost } from "@d4research/shared/hostClassification";

/**
 * Where a sender can call a webhook task, as a client shows it. A supplied
 * URL takes precedence; otherwise the path is resolved against the address
 * this client uses to reach the environment.
 */
export interface WebhookAddress {
  /** The URL to give a sender, or the bare path when no address is known. */
  readonly address: string;
  /** Whether `address` is a full URL a sender can call. */
  readonly copyable: boolean;
  /** One line on who can reach `address`; null for a server-supplied URL. */
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Connect to this environment to resolve its webhook address.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Use a reachable HTTPS proxy for cloud services."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy.",
  };
}
