import type { EnvironmentId } from "@d4research/contracts";
import { useEffect, useState } from "react";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

function useDocumentVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

// Pausing detaches the subscription but keeps the last state, so the chat and its draft stay
// mounted while the page is hidden or the app is in the background.
function useRetainedWhilePaused<T extends { readonly data: unknown }>(
  query: T,
  environmentId: EnvironmentId | null,
  paused: boolean,
): T {
  const [last, setLast] = useState<{ environmentId: EnvironmentId; data: T["data"] } | null>(null);
  if (
    !paused &&
    environmentId !== null &&
    query.data != null &&
    (last?.environmentId !== environmentId || last.data !== query.data)
  )
    setLast({ environmentId, data: query.data });
  return paused && last !== null && last.environmentId === environmentId
    ? { ...query, data: last.data }
    : query;
}

export function useD4AgentState(environmentId: EnvironmentId | null, enabled = true) {
  const visible = useDocumentVisible();
  const query = useEnvironmentQuery(
    enabled && visible && environmentId !== null
      ? serverEnvironment.d4AgentState({ environmentId, input: {} })
      : null,
  );
  useLiveRefresh(query.refresh, {
    enabled: enabled && visible,
    key: `d4-agent:${environmentId}`,
    intervalMs: 15_000,
  });
  return useRetainedWhilePaused(query, environmentId, enabled && !visible);
}

export function useD4AgentSystemHealth(environmentId: EnvironmentId) {
  const visible = useDocumentVisible();
  const query = useEnvironmentQuery(
    visible ? serverEnvironment.d4AgentSystemHealth({ environmentId, input: {} }) : null,
  );
  useLiveRefresh(query.refresh, {
    enabled: visible,
    key: `d4-agent-system-health:${environmentId}`,
    intervalMs: 15_000,
  });
  return query;
}
