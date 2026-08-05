import { useCallback, useEffect, useState } from "react";

export type ToolGuardLifecycleAction = "install" | "enable" | "disable" | "uninstall";

export async function requestToolGuardLifecycleAction(
  action: ToolGuardLifecycleAction,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const response = await fetcher("/api/tool-guard/status", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const payload = (await response.json()) as { message?: unknown };
  return {
    ok: response.ok,
    message: typeof payload.message === "string" ? payload.message : "Tool Guard action failed.",
  };
}

export interface ToolGuardStatusState {
  readonly state: "loading" | "ready" | "degraded";
  readonly integration: "managed" | "disabled" | "external" | "available" | "unavailable" | null;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly canInstall: boolean;
  readonly canManage: boolean;
  readonly message: string;
  readonly action: ToolGuardLifecycleAction | null;
  readonly runAction: (action: ToolGuardLifecycleAction) => Promise<boolean>;
  readonly refresh: () => void;
}

const INITIAL_STATUS = {
  state: "loading",
  integration: null,
  installed: false,
  enabled: false,
  canInstall: false,
  canManage: false,
  message: "Checking local Tool Guard Core…",
} as const;

export function useToolGuardStatus(): ToolGuardStatusState {
  const [status, setStatus] =
    useState<Omit<ToolGuardStatusState, "action" | "runAction" | "refresh">>(INITIAL_STATUS);
  const [action, setAction] = useState<ToolGuardLifecycleAction | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/tool-guard/status", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload = (await response.json()) as Record<string, unknown>;
        const integration =
          payload.integration === "managed" ||
          payload.integration === "disabled" ||
          payload.integration === "external" ||
          payload.integration === "available" ||
          payload.integration === "unavailable"
            ? payload.integration
            : "unavailable";
        setStatus({
          state: payload.available === true || payload.installed === true ? "ready" : "degraded",
          integration,
          installed: payload.installed === true,
          enabled: payload.enabled === true,
          canInstall: payload.canInstall === true,
          canManage: payload.canManage === true,
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Tool Guard status is unavailable.",
        });
      } catch {
        if (controller.signal.aborted) return;
        setStatus({
          ...INITIAL_STATUS,
          state: "degraded",
          integration: "unavailable",
          message: "Could not read local Tool Guard status.",
        });
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshSequence]);

  const runAction = useCallback(async (nextAction: ToolGuardLifecycleAction) => {
    setAction(nextAction);
    try {
      const result = await requestToolGuardLifecycleAction(nextAction);
      setStatus((current) => ({ ...current, message: result.message }));
      if (result.ok) setRefreshSequence((value) => value + 1);
      return result.ok;
    } catch {
      setStatus((current) => ({ ...current, message: "Could not update Tool Guard." }));
      return false;
    } finally {
      setAction(null);
    }
  }, []);

  return { ...status, action, runAction, refresh };
}
