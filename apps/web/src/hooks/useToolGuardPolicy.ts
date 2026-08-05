import { useCallback, useEffect, useState } from "react";
import type { ToolGuardPolicy } from "@t3tools/contracts";

export interface ToolGuardPolicyState {
  readonly state: "loading" | "ready" | "unavailable";
  readonly policy: ToolGuardPolicy | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly save: (policy: ToolGuardPolicy) => Promise<boolean>;
}

export function useToolGuardPolicy(enabled: boolean): ToolGuardPolicyState {
  const [policy, setPolicy] = useState<ToolGuardPolicy | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((v) => v + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState("unavailable");
      setPolicy(null);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      setState("loading");
      try {
        const response = await fetch("/api/tool-guard/policy", {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          setState("unavailable");
          setPolicy(null);
          return;
        }
        const payload = (await response.json()) as { ok?: boolean; policy?: ToolGuardPolicy };
        if (payload.ok && payload.policy) {
          setPolicy(payload.policy);
          setState("ready");
        } else {
          setState("unavailable");
          setPolicy(null);
        }
      } catch {
        if (controller.signal.aborted) return;
        setState("unavailable");
        setPolicy(null);
      }
    };
    void load();
    return () => controller.abort();
  }, [enabled, refreshSequence]);

  const save = useCallback(async (nextPolicy: ToolGuardPolicy) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tool-guard/policy", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: nextPolicy }),
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (payload.ok) {
        setPolicy(nextPolicy);
        return true;
      }
      setError(payload.message ?? "Failed to save policy.");
      return false;
    } catch {
      setError("Failed to save policy.");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { state, policy, saving, error, refresh, save };
}
