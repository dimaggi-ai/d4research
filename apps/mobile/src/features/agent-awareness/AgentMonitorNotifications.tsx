import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { deliverMonitorNotification } from "./monitorNotificationDelivery";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@d4research/contracts";
import * as Option from "effect/Option";
import * as Notifications from "expo-notifications";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { Platform } from "react-native";
import { useEnvironments } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function AgentMonitorNotifications() {
  const { environments } = useEnvironments();
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => (
      <EnvironmentMonitorNotifications
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}

function EnvironmentMonitorNotifications({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(
    serverEnvironment.claimMonitorAttention.permissionAtom(environmentId),
  );
  const claim = useAtomCommand(serverEnvironment.claimMonitorAttention, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const checked = useRef(new Map<string, string>());
  const available = useRef(false);
  const enabled =
    config?.settings.agentMonitor?.enabled === true &&
    config.settings.agentMonitor.notificationsEnabled;
  useLayoutEffect(() => {
    available.current = Boolean(enabled && allowed && shell.status === "live");
    return () => {
      available.current = false;
    };
  }, [allowed, enabled, shell.status]);
  const reportAvailable = useEffectEvent((threadId: string, reportKey: string) => {
    if (!available.current || shell.status !== "live") return false;
    const thread = Option.getOrNull(shell.snapshot)?.threads.find(
      (thread) => thread.id === threadId,
    );
    return (
      thread?.lineage.relationshipToParent !== "subagent" &&
      thread?.agentMonitor?.notificationEligible === true &&
      thread.agentMonitor.attentionRequired &&
      thread.agentMonitor.reportKey === reportKey &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    );
  });
  useEffect(() => {
    if (
      !enabled ||
      !allowed ||
      shell.status !== "live" ||
      (Platform.OS !== "ios" && Platform.OS !== "android")
    )
      return;
    const snapshot = Option.getOrNull(shell.snapshot);
    if (!snapshot) return;
    for (const thread of snapshot.threads) {
      const report = thread.agentMonitor;
      if (
        thread.lineage.relationshipToParent === "subagent" ||
        !report?.notificationEligible ||
        !report.attentionRequired ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      )
        continue;
      const key = `${thread.id}:${report.reportKey}`;
      if (pending.current.has(key) || checked.current.get(thread.id) === report.reportKey) continue;
      pending.current.add(key);
      void deliverMonitorNotification({
        environmentId,
        threadId: thread.id,
        reportKey: report.reportKey,
        notificationEligible: report.notificationEligible,
        loadClientId: async () => `mobile-${await loadOrCreateAgentAwarenessDeviceId()}`,
        isEnabled: () => reportAvailable(thread.id, report.reportKey),
        hasPermission: async () => {
          const permission = await Notifications.getPermissionsAsync();
          return (
            permission.granted ||
            permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
          );
        },
        claim: async (clientId) => {
          const result = await claim({
            environmentId,
            input: { threadId: thread.id, reportKey: report.reportKey, clientId },
          });
          return result._tag === "Success" ? result.value.claimed : null;
        },
        notify: (content) =>
          Notifications.scheduleNotificationAsync({
            identifier: `monitor:${environmentId}:${key}`,
            content,
            trigger: Platform.OS === "android" ? { channelId: "agent-alerts" } : null,
          }),
      })
        .then((checkedReport) => {
          if (checkedReport) checked.current.set(thread.id, report.reportKey);
        })
        .catch(() => {
          // Notification delivery must not interrupt shell synchronization.
        })
        .finally(() => pending.current.delete(key));
    }
  }, [allowed, claim, enabled, environmentId, shell]);
  return null;
}
