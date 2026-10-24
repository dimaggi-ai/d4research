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

export function useD4AgentState(environmentId: EnvironmentId, enabled = true) {
  const visible = useDocumentVisible();
  const query = useEnvironmentQuery(
    enabled && visible ? serverEnvironment.d4AgentState({ environmentId, input: {} }) : null,
  );
  useLiveRefresh(query.refresh, {
    enabled: enabled && visible,
    key: `d4-agent:${environmentId}`,
    intervalMs: 15_000,
  });
  return query;
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
