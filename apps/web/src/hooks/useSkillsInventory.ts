import { useCallback, useEffect, useState } from "react";
import type {
  SkillsInventoryAgent,
  SkillsInventoryEntry,
  SkillsInventoryRoot,
  SkillsInventoryScope,
} from "@d4research/contracts";
import type { PreparedConnection } from "@d4research/client-runtime/connection";
import {
  fetchEnvironmentSkillsInventory,
  preparedEnvironmentFetchAuthorization,
} from "@d4research/client-runtime/state/skills";

import { runtime } from "../lib/runtime";

export type {
  SkillsInventoryAgent,
  SkillsInventoryEntry,
  SkillsInventoryRoot,
  SkillsInventoryScope,
};

function environmentApiUrl(path: string, httpBaseUrl?: string | null): string | null {
  return httpBaseUrl ? new URL(path, httpBaseUrl).toString() : null;
}

export function skillsInventoryRequestUrl(
  cwd?: string,
  httpBaseUrl?: string | null,
): string | null {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  return environmentApiUrl(`/api/skills${query}`, httpBaseUrl);
}

export async function requestSkillShare(
  input: {
    readonly sourcePath: string;
    readonly targetRoot: SkillsInventoryRoot;
    readonly cwd?: string | undefined;
    readonly httpBaseUrl?: string | undefined;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const { httpBaseUrl, ...body } = input;
  const endpoint = environmentApiUrl("/api/skills/share", httpBaseUrl);
  if (endpoint === null) {
    return { ok: false, message: "The selected environment is not connected." };
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { message?: unknown; targetPath?: unknown };
  if (response.ok) {
    return {
      ok: true,
      message:
        typeof payload.targetPath === "string"
          ? `Shared to ${payload.targetPath}`
          : "Skill shared.",
    };
  }
  return {
    ok: false,
    message: typeof payload.message === "string" ? payload.message : "Could not share the skill.",
  };
}

export async function requestSkillInstall(
  input: {
    readonly url: string;
    readonly cwd?: string | undefined;
    readonly installAgyPlugin?: boolean;
    readonly httpBaseUrl?: string | undefined;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const { httpBaseUrl, ...body } = input;
  const endpoint = environmentApiUrl("/api/skills/install", httpBaseUrl);
  if (endpoint === null) {
    return { ok: false, message: "The selected environment is not connected." };
  }
  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as {
    message?: unknown;
    installed?: unknown;
    sharedRoots?: unknown;
    agyPlugin?: unknown;
  };
  if (response.ok) {
    const installed = Array.isArray(payload.installed) ? payload.installed.join(", ") : "";
    // Agy reads the portable skill too. A plugin is a separate, broader
    // package channel, so that outcome is reported independently.
    const agyNote =
      payload.agyPlugin === "installed"
        ? " Agy plugin installed."
        : payload.agyPlugin === "failed"
          ? " Agy plugin install failed."
          : payload.agyPlugin === "agy-unavailable"
            ? " Agy not installed on this machine."
            : "";
    return {
      ok: true,
      message: installed
        ? `Installed ${installed} for Claude, Codex, Cursor, Grok, OpenCode, Junie and Agy.${agyNote}`
        : `Skill installed.${agyNote}`,
    };
  }
  return {
    ok: false,
    message: typeof payload.message === "string" ? payload.message : "Could not install the skill.",
  };
}

export interface SkillsInventoryState {
  readonly state: "loading" | "ready" | "error";
  readonly entries: ReadonlyArray<SkillsInventoryEntry>;
  readonly error: string | null;
  readonly sharing: string | null;
  readonly installing: boolean;
  readonly install: (
    url: string,
    options?: { readonly installAgyPlugin?: boolean },
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly share: (
    sourcePath: string,
    targetRoot: SkillsInventoryRoot,
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
  readonly refresh: () => void;
}

const SKILLS_POLL_INTERVAL_MS = 30_000;

export interface UseSkillsInventoryOptions {
  /**
   * Skip fetching and polling entirely. Callers that only need the inventory
   * as a fallback (the composer, when the provider reports its own skills)
   * pass false so no chat view pays for a poll it will not read.
   */
  readonly enabled?: boolean;
  readonly preparedConnection?: PreparedConnection | null;
}

export function useSkillsInventory(
  cwd?: string,
  options: UseSkillsInventoryOptions = {},
): SkillsInventoryState {
  const enabled = options.enabled !== false;
  const preparedConnection = options.preparedConnection ?? null;
  const httpBaseUrl = preparedConnection?.httpBaseUrl ?? null;
  const [entries, setEntries] = useState<ReadonlyArray<SkillsInventoryEntry>>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !preparedConnection) {
      setEntries([]);
      setState(enabled ? "loading" : "ready");
      setError(null);
      return;
    }
    setEntries([]);
    setState("loading");
    setError(null);
    let active = true;
    const load = async () => {
      try {
        const payload = await runtime.runPromise(
          fetchEnvironmentSkillsInventory({ prepared: preparedConnection, cwd }),
        );
        if (!active) return;
        setEntries(payload.skills);
        setState("ready");
        setError(null);
      } catch {
        if (!active) return;
        setEntries([]);
        setState("error");
        setError("Could not read the local skills inventory.");
      }
    };

    void load();
    // Skills live on disk and change behind the app's back (a CLI install, a
    // deleted symlink) — poll like the other system-state hooks do.
    const interval = window.setInterval(() => void load(), SKILLS_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      active = false;
    };
  }, [cwd, enabled, preparedConnection, refreshSequence]);

  const authorizedFetcher = useCallback<typeof fetch>(
    async (input, init) => {
      if (!preparedConnection) throw new Error("Environment is not connected.");
      const url = String(input);
      const method = init?.method === "POST" ? "POST" : "GET";
      const auth = await runtime.runPromise(
        preparedEnvironmentFetchAuthorization(preparedConnection, method, url),
      );
      return fetch(input, {
        ...init,
        ...(auth.credentials ? { credentials: auth.credentials } : {}),
        headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...auth.headers },
      });
    },
    [preparedConnection],
  );

  const share = useCallback(
    async (sourcePath: string, targetRoot: SkillsInventoryRoot) => {
      setSharing(`${sourcePath}:${targetRoot}`);
      try {
        // The workspace cwd scopes project roots server-side; without it a
        // project-skill share resolves against the server's own cwd and fails.
        const result = await requestSkillShare(
          {
            sourcePath,
            targetRoot,
            cwd,
            ...(httpBaseUrl ? { httpBaseUrl } : {}),
          },
          authorizedFetcher,
        );
        if (result.ok) {
          setError(null);
          setRefreshSequence((value) => value + 1);
        } else {
          setError(result.message);
        }
        return result;
      } catch {
        const message = "Could not share the skill.";
        setError(message);
        return { ok: false, message };
      } finally {
        setSharing(null);
      }
    },
    [authorizedFetcher, cwd, httpBaseUrl],
  );

  const install = useCallback(
    async (url: string, options?: { readonly installAgyPlugin?: boolean }) => {
      setInstalling(true);
      try {
        const result = await requestSkillInstall(
          {
            url,
            cwd,
            installAgyPlugin: options?.installAgyPlugin === true,
            ...(httpBaseUrl ? { httpBaseUrl } : {}),
          },
          authorizedFetcher,
        );
        if (result.ok) {
          setError(null);
          setRefreshSequence((value) => value + 1);
        } else {
          setError(result.message);
        }
        return result;
      } catch {
        const message = "Could not install the skill.";
        setError(message);
        return { ok: false, message };
      } finally {
        setInstalling(false);
      }
    },
    [authorizedFetcher, cwd, httpBaseUrl],
  );

  return { state, entries, error, sharing, installing, install, share, refresh };
}
