import type { EnvironmentId, ThreadId } from "@d4research/contracts";

export async function deliverMonitorNotification(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reportKey: string;
  readonly notificationEligible: boolean;
  readonly loadClientId: () => Promise<string | null>;
  readonly isEnabled: () => boolean;
  readonly hasPermission: () => Promise<boolean>;
  readonly claim: (clientId: string) => Promise<boolean | null>;
  readonly notify: (content: {
    readonly title: string;
    readonly body: string;
    readonly data: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
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
  if (claimed && input.isEnabled()) {
    await input.notify({
      title: "Thread needs attention",
      body: "Open the thread to review its status.",
      data: { environmentId: input.environmentId, threadId: input.threadId },
    });
  }
  return true;
}
