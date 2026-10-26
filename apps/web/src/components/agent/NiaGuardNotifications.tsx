import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@d4research/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentIds } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { actionHeading, guardNotice } from "./d4AgentPresentation";
import { useD4AgentState } from "./useD4AgentState";

export function NiaGuardNotifications() {
  const ids = useEnvironmentIds();
  return ids.map((environmentId) => (
    <EnvironmentGuardNotifications key={environmentId} environmentId={environmentId} />
  ));
}
function EnvironmentGuardNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const enabled =
    config?.settings.d4Agent.enabled === true && config.settings.d4Agent.toolGuardUrl !== null;
  return enabled ? <EnabledGuardNotifications environmentId={environmentId} /> : null;
}
function EnabledGuardNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useD4AgentState(environmentId);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  // Verdicts already in the first state predate this page and were seen elsewhere.
  const seen = useRef<Set<string> | null>(null);
  const show = useEffectEvent((title: string, body: string, tone: "warning" | "info") => {
    const open = () => {
      const threadId = query.data?.threadId;
      if (threadId)
        void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    };
    if (hasNotificationSound(mode))
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (inApp && focused) {
      const id = toastManager.add({
        type: tone,
        title,
        description: body,
        data: { hideCopyButton: true },
        actionProps: {
          children: "Open Nia",
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
      const notification = new Notification(title, { body, silent: true });
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
    const log = query.data?.actionLog;
    if (log === undefined) return;
    if (seen.current === null) {
      seen.current = new Set(log.map((record) => record.id));
      return;
    }
    for (const record of log) {
      if (seen.current.has(record.id)) continue;
      seen.current.add(record.id);
      const notice = guardNotice(record.guard);
      if (notice === null) continue;
      const heading = actionHeading(record);
      show(
        notice.title,
        `${heading.title}${heading.detail ? `: ${heading.detail}` : ""}`.slice(0, 200),
        notice.tone,
      );
    }
  }, [query.data]);
  return null;
}
