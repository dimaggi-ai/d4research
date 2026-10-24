import type { EnvironmentId } from "@d4research/contracts";
import { useEffect, useState } from "react";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useD4AgentState(environmentId: EnvironmentId, enabled = true) {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
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
