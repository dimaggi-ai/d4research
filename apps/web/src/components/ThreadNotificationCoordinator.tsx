import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@d4research/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@d4research/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@d4research/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { getStableClientId } from "../lib/clientInstallationId";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const monitor = config?.settings.agentMonitor;
  const canClaim = useAtomValue(
    serverEnvironment.claimMonitorAttention.permissionAtom(environmentId),
  );
  const claimMonitorAttention = useAtomCommand(serverEnvironment.claimMonitorAttention, {
    reportFailure: false,
  });
  const monitorKeys = useRef(new Map<ThreadId, string>());
  const pendingMonitorKeys = useRef(new Set<string>());
  const notificationsMounted = useRef(false);
  useEffect(() => {
    notificationsMounted.current = true;
    return () => {
      notificationsMounted.current = false;
    };
  }, []);
  const monitorNotificationsAllowed = useEffectEvent((threadId: ThreadId, reportKey: string) => {
    const focused = document.visibilityState === "visible" && document.hasFocus();
    const thread = threads?.find((thread) => thread.id === threadId);
    const report = thread?.agentMonitor;
    const canPresent =
      hasNotificationSound(mode) ||
      (inAppNotificationsEnabled &&
        focused &&
        (activeEnvironmentId !== environmentId || activeThreadId !== threadId)) ||
      (hasDesktopNotifications(mode) &&
        !focused &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted");
    return (
      notificationsMounted.current &&
      threads !== null &&
      monitor?.enabled === true &&
      monitor.notificationsEnabled &&
      canClaim &&
      report?.notificationEligible === true &&
      report.attentionRequired &&
      thread?.archivedAt === null &&
      thread.deletedAt === null &&
      report.reportKey === reportKey &&
      canPresent
    );
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());

  const showNotification = useEffectEvent(
    ({
      threadId,
      title,
      body,
      kind,
      status,
    }: {
      threadId: ThreadId;
      title: string;
      body: string;
      kind: "input" | "completion";
      status: string;
    }) => {
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (
        inAppNotificationsEnabled &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== threadId)
      ) {
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title,
          description: body,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: threadId },
              });
            },
          },
        });
        return;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return;
      try {
        const notification = new Notification(title, {
          body: body,
          tag: `${environmentId}:${threadId}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: threadId },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    },
  );

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    for (const rawThread of threads) {
      const report = rawThread.agentMonitor;
      const focused = document.visibilityState === "visible" && document.hasFocus();
      const canPresent =
        hasNotificationSound(mode) ||
        (inAppNotificationsEnabled &&
          focused &&
          (activeEnvironmentId !== environmentId || activeThreadId !== rawThread.id)) ||
        (hasDesktopNotifications(mode) &&
          !focused &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted");
      if (
        monitor?.enabled &&
        monitor.notificationsEnabled &&
        canClaim &&
        canPresent &&
        report?.notificationEligible === true &&
        report.attentionRequired &&
        (report.classification === "wedged" || report.classification === "suspected_stuck") &&
        rawThread.archivedAt === null &&
        rawThread.deletedAt === null &&
        monitorKeys.current.get(rawThread.id) !== report.reportKey
      ) {
        const clientId = getStableClientId();
        const key = `${rawThread.id}:${report.reportKey}`;
        if (clientId && !pendingMonitorKeys.current.has(key)) {
          pendingMonitorKeys.current.add(key);
          void claimMonitorAttention({
            environmentId,
            input: { threadId: rawThread.id, reportKey: report.reportKey, clientId },
          })
            .then((result) => {
              if (result._tag !== "Success") return;
              monitorKeys.current.set(rawThread.id, report.reportKey);
              if (
                result.value.claimed &&
                monitorNotificationsAllowed(rawThread.id, report.reportKey)
              ) {
                showNotification({
                  threadId: rawThread.id,
                  title: "Thread needs attention",
                  body: "Open the thread to review its status.",
                  kind: "input",
                  status: "input",
                });
              }
            })
            .finally(() => pendingMonitorKeys.current.delete(key));
        }
      }
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, subagentRequest, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      showNotification({ threadId: thread.id, title, body: thread.title, kind, status });
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    claimMonitorAttention,
    canClaim,
    monitor,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    threads,
  ]);

  return null;
}
