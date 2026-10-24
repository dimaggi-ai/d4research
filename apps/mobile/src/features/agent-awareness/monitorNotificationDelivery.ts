import type { EnvironmentId, ThreadId } from "@d4research/contracts";

export async function deliverMonitorNotification(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reportKey: string;
  readonly isEnabled: () => boolean;
  readonly hasPermission: () => Promise<boolean>;
  readonly claim: () => Promise<boolean | null>;
  readonly notify: (content: {
    readonly title: string;
    readonly body: string;
    readonly data: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  }) => Promise<unknown>;
}): Promise<boolean> {
  if (!input.isEnabled() || !(await input.hasPermission()) || !input.isEnabled()) return false;
  const claimed = await input.claim();
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
