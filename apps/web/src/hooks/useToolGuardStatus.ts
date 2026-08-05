import { useEffect, useState } from "react";

export interface ToolGuardStatusState {
  readonly state: "loading" | "ready" | "degraded";
  readonly integration: "managed" | "external" | "available" | "unavailable" | null;
  readonly message: string;
}

const INITIAL_STATUS: ToolGuardStatusState = {
  state: "loading",
  integration: null,
  message: "Checking local Tool Guard Core…",
};

export function useToolGuardStatus(): ToolGuardStatusState {
  const [status, setStatus] = useState(INITIAL_STATUS);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/tool-guard/status", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload = (await response.json()) as {
          available?: unknown;
          integration?: unknown;
          message?: unknown;
        };
        const integration =
          payload.integration === "managed" ||
          payload.integration === "external" ||
          payload.integration === "available" ||
          payload.integration === "unavailable"
            ? payload.integration
            : "unavailable";
        setStatus({
          state: payload.available === true ? "ready" : "degraded",
          integration,
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Tool Guard status is unavailable.",
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({
          state: "degraded",
          integration: "unavailable",
          message: "Could not read local Tool Guard status.",
        });
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  return status;
}
