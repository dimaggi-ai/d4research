import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@d4research/contracts";
import * as Notifications from "expo-notifications";
import { useEffect, useEffectEvent, useRef } from "react";
import { Platform } from "react-native";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { deliverSystemNotification } from "./systemNotificationDelivery";
import { useD4AgentSystemHealth } from "./useD4AgentState";

export function SystemMonitorNotifications() {
  const { environments } = useEnvironments();
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => (
      <EnvironmentSystemNotifications
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}
function EnvironmentSystemNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const enabled =
    config?.settings.agentMonitor.enabled === true &&
    config.settings.agentMonitor.notificationsEnabled &&
    config.settings.agentMonitor.notifyClasses.includes("system") &&
    config.settings.d4Agent.systemProbeEnabled;
  return enabled ? <EnabledSystemNotifications environmentId={environmentId} /> : null;
}
function EnabledSystemNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const state = useD4AgentSystemHealth(environmentId);
  const allowed = useAtomValue(
    serverEnvironment.claimD4AgentSystemAttention.permissionAtom(environmentId),
  );
  const claim = useAtomCommand(serverEnvironment.claimD4AgentSystemAttention, {
    reportFailure: false,
  });
  const pending = useRef(new Set<string>());
  const checked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = useEffectEvent(
    (reportKey: string) =>
      mounted.current &&
      allowed &&
      state.data?.systemHealth.some(
        (check) =>
          check.status === "attention" &&
          check.notificationEligible &&
          check.reportKey === reportKey,
      ) === true,
  );
  useEffect(() => {
    if (!allowed || (Platform.OS !== "ios" && Platform.OS !== "android")) return;
    for (const check of state.data?.systemHealth ?? []) {
      if (
        check.status !== "attention" ||
        !check.notificationEligible ||
        pending.current.has(check.reportKey) ||
        checked.current.has(check.reportKey)
      )
        continue;
      pending.current.add(check.reportKey);
      void deliverSystemNotification({
        environmentId,
        threadId: state.data?.threadId ?? null,
        notificationEligible: check.notificationEligible,
        isEnabled: () => available(check.reportKey),
        hasPermission: async () => {
          const permission = await Notifications.getPermissionsAsync();
          return (
            permission.granted ||
            permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
          );
        },
        loadClientId: async () => `mobile-${await loadOrCreateAgentAwarenessDeviceId()}`,
        claim: async (clientId) => {
          const result = await claim({
            environmentId,
            input: { reportKey: check.reportKey, clientId },
          });
          return result._tag === "Success" ? result.value.claimed : null;
        },
        notify: (content) =>
          Notifications.scheduleNotificationAsync({
            identifier: `system:${environmentId}:${check.reportKey}`,
            content,
            trigger: Platform.OS === "android" ? { channelId: "agent-alerts" } : null,
          }),
      })
        .then((done) => {
          if (done) checked.current.add(check.reportKey);
        })
        .catch(() => undefined)
        .finally(() => pending.current.delete(check.reportKey));
    }
  }, [allowed, claim, environmentId, state.data]);
  return null;
}
