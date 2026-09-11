import { useCallback, useEffect, useState } from "react";
import type { ToolGuardPolicy } from "@d4research/contracts";

export type ToolGuardPolicyReadResult =
  | {
      readonly ok: true;
      readonly policy: ToolGuardPolicy;
      readonly source: "managed" | "bundled";
    }
  | { readonly ok: false };

export async function requestToolGuardPolicy(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ToolGuardPolicyReadResult> {
  const response = await fetcher("/api/tool-guard/policy", {
    credentials: "include",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) return { ok: false };

  const payload = (await response.json()) as {
    ok?: unknown;
    policy?: unknown;
    source?: unknown;
  };
  if (payload.ok !== true || typeof payload.policy !== "object" || payload.policy === null) {
    return { ok: false };
  }
  return {
    ok: true,
    policy: payload.policy as ToolGuardPolicy,
    source: payload.source === "bundled" ? "bundled" : "managed",
  };
}

export async function saveToolGuardPolicy(
  policy: ToolGuardPolicy,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const response = await fetcher("/api/tool-guard/policy", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy }),
  });
  const payload = (await response.json()) as { ok?: unknown; message?: unknown };
  return {
    ok: response.ok && payload.ok === true,
    message: typeof payload.message === "string" ? payload.message : "Failed to save policy.",
  };
}

export interface ToolGuardPolicyState {
  readonly state: "loading" | "ready" | "unavailable";
  readonly policy: ToolGuardPolicy | null;
  readonly source: "managed" | "bundled" | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly save: (policy: ToolGuardPolicy) => Promise<boolean>;
}

export function useToolGuardPolicy(enabled: boolean): ToolGuardPolicyState {
  const [policy, setPolicy] = useState<ToolGuardPolicy | null>(null);
  const [source, setSource] = useState<"managed" | "bundled" | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((v) => v + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState("unavailable");
      setPolicy(null);
      setSource(null);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      setState("loading");
      try {
        const result = await requestToolGuardPolicy(fetch, controller.signal);
        if (!result.ok) {
          setState("unavailable");
          setPolicy(null);
          setSource(null);
          return;
        }
        setPolicy(result.policy);
        setSource(result.source);
        setState("ready");
      } catch {
        if (controller.signal.aborted) return;
        setState("unavailable");
        setPolicy(null);
        setSource(null);
      }
    };
    void load();
    return () => controller.abort();
  }, [enabled, refreshSequence]);

  const save = useCallback(async (nextPolicy: ToolGuardPolicy) => {
    setSaving(true);
    setError(null);
    try {
      const result = await saveToolGuardPolicy(nextPolicy);
      if (result.ok) {
        setPolicy(nextPolicy);
        return true;
      }
      setError(result.message);
      return false;
    } catch {
      setError("Failed to save policy.");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { state, policy, source, saving, error, refresh, save };
}
