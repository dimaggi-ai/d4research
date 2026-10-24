import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@d4research/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { getStableClientId } from "../../lib/clientInstallationId";
import { useEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";

export function SystemMonitorNotifications() {
  const ids = useEnvironmentIds();
  return ids.map((environmentId) => (
    <EnvironmentSystemNotifications key={environmentId} environmentId={environmentId} />
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
  const query = useEnvironmentQuery(serverEnvironment.d4AgentState({ environmentId, input: {} }));
  const claim = useAtomCommand(serverEnvironment.claimD4AgentSystemAttention, {
    reportFailure: false,
  });
  const allowed = useAtomValue(
    serverEnvironment.claimD4AgentSystemAttention.permissionAtom(environmentId),
  );
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  const pending = useRef(new Set<string>());
  const checked = useRef(new Set<string>());
  const mounted = useRef(true);
  const notifications = useRef(new Set<Notification>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const notification of notifications.current) notification.close();
      notifications.current.clear();
    };
  }, []);
  const canPresent = useEffectEvent(() => {
    const focused = document.visibilityState === "visible" && document.hasFocus();
    return (
      hasNotificationSound(mode) ||
      (inApp && focused) ||
      (hasDesktopNotifications(mode) &&
        !focused &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted")
    );
  });
  const available = useEffectEvent(
    (reportKey: string) =>
      mounted.current &&
      allowed &&
      canPresent() &&
      query.data?.systemHealth.some(
        (check) =>
          check.status === "attention" &&
          check.notificationEligible &&
          check.reportKey === reportKey,
      ) === true,
  );
  const show = useEffectEvent(() => {
    const open = () => {
      const threadId = query.data?.threadId;
      if (threadId)
        void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      else void navigate({ to: "/settings/general" });
    };
    if (hasNotificationSound(mode))
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (inApp && focused) {
      const id = toastManager.add({
        type: "warning",
        title: "System needs attention",
        description: "Open d4 Agent to review host health.",
        data: { hideCopyButton: true },
        actionProps: {
          children: "Review",
          onClick: () => {
            toastManager.close(id);
            open();
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      focused ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification("System needs attention", {
        body: "Open d4 Agent to review host health.",
        tag: `d4-system:${environmentId}`,
        silent: true,
      });
      notifications.current.add(notification);
      notification.addEventListener("close", () => notifications.current.delete(notification));
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        open();
      });
    } catch {
      /* The browser can reject notification presentation after permission changes. */
    }
  });
  useEffect(() => {
    if (!allowed || !canPresent()) return;
    for (const check of query.data?.systemHealth ?? []) {
      if (
        check.status !== "attention" ||
        !check.notificationEligible ||
        pending.current.has(check.reportKey) ||
        checked.current.has(check.reportKey)
      )
        continue;
      const clientId = getStableClientId();
      if (!clientId) return;
      pending.current.add(check.reportKey);
      void claim({ environmentId, input: { reportKey: check.reportKey, clientId } })
        .then((result) => {
          if (result._tag !== "Success") return;
          checked.current.add(check.reportKey);
          if (result.value.claimed && available(check.reportKey)) show();
        })
        .finally(() => pending.current.delete(check.reportKey));
    }
  }, [allowed, claim, environmentId, query.data]);
  return null;
}
