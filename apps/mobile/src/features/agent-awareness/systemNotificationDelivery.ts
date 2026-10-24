import type { EnvironmentId, ThreadId } from "@d4research/contracts";

export function systemAttentionDeepLink(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): string {
  return threadId === null
    ? "/settings/thread-preferences"
    : `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export async function deliverSystemNotification(input: {
  readonly notificationEligible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly isEnabled: () => boolean;
  readonly hasPermission: () => Promise<boolean>;
  readonly loadClientId: () => Promise<string | null>;
  readonly claim: (clientId: string) => Promise<boolean | null>;
  readonly notify: (content: {
    title: string;
    body: string;
    data: { deepLink: string };
  }) => Promise<unknown>;
}): Promise<boolean> {
  if (
    !input.notificationEligible ||
    !input.isEnabled() ||
    !(await input.hasPermission()) ||
    !input.isEnabled()
  )
    return false;
  const clientId = await input.loadClientId();
  if (!clientId || clientId.length > 128 || !input.isEnabled()) return false;
  const claimed = await input.claim(clientId);
  if (claimed === null) return false;
  if (claimed && input.isEnabled())
    await input.notify({
      title: "System needs attention",
      body: "Open d4 Agent to review host health.",
      data: { deepLink: systemAttentionDeepLink(input.environmentId, input.threadId) },
    });
  return true;
}
