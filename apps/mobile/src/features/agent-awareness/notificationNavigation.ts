import { useEffect, useLayoutEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

export function useAgentNotificationNavigation(pathname: string): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());
  const deepLinkOnScreen = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep Android notification suppression aligned with the thread currently shown by navigation.
  useLayoutEffect(() => {
    const thread = threadDeepLinkOnScreen(pathname);
    deepLinkOnScreen.current = thread;
    setAndroidThreadOnScreen(thread);
  }, [pathname]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Install the native foreground-notification handler for this mounted navigator.
  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: (notification) =>
        Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen.current)),
    });
    return () => {
      Notifications.setNotificationHandler(null);
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Route native notification responses and remove the listener when the navigator unmounts.
  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}
