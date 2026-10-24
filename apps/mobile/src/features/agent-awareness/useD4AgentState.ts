import type { EnvironmentId } from "@d4research/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState } from "react-native";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useD4AgentState(environmentId: EnvironmentId, enabled = true) {
  const focused = useIsFocused();
  const [active, setActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const visible = enabled && focused && active;
  const query = useEnvironmentQuery(
    visible ? serverEnvironment.d4AgentState({ environmentId, input: {} }) : null,
  );
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [visible]);
  return query;
}
