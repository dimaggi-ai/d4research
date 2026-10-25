import type { EnvironmentId } from "@d4research/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState } from "react-native";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

function useAppActive() {
  const [active, setActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

function useAgentRefresh(refreshQuery: () => void, visible: boolean) {
  const refresh = useEffectEvent(refreshQuery);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [visible]);
}

// Pausing detaches the subscription, and the state cache drops it at once (idle TTL 0). Keep the
// last state while paused and until the resumed query has data, so the chat and its draft stay
// mounted while the page is hidden or the app is in the background.
function useRetainedWhilePaused<T extends { readonly data: unknown }>(
  query: T,
  environmentId: EnvironmentId | null,
  enabled: boolean,
  paused: boolean,
): T {
  const [last, setLast] = useState<{ environmentId: EnvironmentId; data: T["data"] } | null>(null);
  if (
    enabled &&
    !paused &&
    environmentId !== null &&
    query.data != null &&
    (last?.environmentId !== environmentId || last.data !== query.data)
  )
    setLast({ environmentId, data: query.data });
  return enabled &&
    (paused || query.data == null) &&
    last !== null &&
    last.environmentId === environmentId
    ? { ...query, data: last.data }
    : query;
}

export function useD4AgentState(environmentId: EnvironmentId | null, enabled = true) {
  const focused = useIsFocused();
  const active = useAppActive();
  const visible = enabled && focused && active && environmentId !== null;
  const query = useEnvironmentQuery(
    visible && environmentId !== null
      ? serverEnvironment.d4AgentState({ environmentId, input: {} })
      : null,
  );
  useAgentRefresh(query.refresh, visible);
  return useRetainedWhilePaused(query, environmentId, enabled, !(focused && active));
}

export function useD4AgentSystemHealth(environmentId: EnvironmentId) {
  const active = useAppActive();
  const query = useEnvironmentQuery(
    active ? serverEnvironment.d4AgentSystemHealth({ environmentId, input: {} }) : null,
  );
  useAgentRefresh(query.refresh, active);
  return query;
}
