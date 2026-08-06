import { useCallback, useEffect, useState } from "react";

export type SkillsInventoryRoot = "claude-user" | "codex-user" | "junie-user" | "project";

export type SkillsInventoryAgent = "claude" | "codex" | "junie" | "all";

export type SkillsInventoryScope = "user" | "project" | "system";

export interface SkillsInventoryEntry {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly root: SkillsInventoryRoot;
  readonly kind: "skill" | "command";
  readonly scope: SkillsInventoryScope;
  readonly agents: ReadonlyArray<SkillsInventoryAgent>;
  readonly isSymlinked: boolean;
}

const ROOTS: ReadonlySet<string> = new Set<SkillsInventoryRoot>([
  "claude-user",
  "codex-user",
  "junie-user",
  "project",
]);
const AGENTS: ReadonlySet<string> = new Set<SkillsInventoryAgent>([
  "claude",
  "codex",
  "junie",
  "all",
]);
const SCOPES: ReadonlySet<string> = new Set<SkillsInventoryScope>(["user", "project", "system"]);

/**
 * Narrow one wire entry, dropping anything whose discriminants the server did
 * not send in a shape this build understands. The inventory is best-effort on
 * the server too, so a partial payload degrades to fewer rows, never a crash.
 */
function toEntry(value: unknown): SkillsInventoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { name, path, root, kind, scope, agents, description } = record;
  if (typeof name !== "string" || !name) return null;
  if (typeof path !== "string" || !path) return null;
  if (typeof root !== "string" || !ROOTS.has(root)) return null;
  if (kind !== "skill" && kind !== "command") return null;
  if (typeof scope !== "string" || !SCOPES.has(scope)) return null;
  return {
    name,
    path,
    root: root as SkillsInventoryRoot,
    kind,
    scope: scope as SkillsInventoryScope,
    agents: Array.isArray(agents)
      ? agents.filter(
          (agent): agent is SkillsInventoryAgent => typeof agent === "string" && AGENTS.has(agent),
        )
      : [],
    isSymlinked: record.isSymlinked === true,
    ...(typeof description === "string" && description ? { description } : {}),
  };
}

export async function requestSkillShare(
  input: {
    readonly sourcePath: string;
    readonly targetRoot: SkillsInventoryRoot;
    readonly cwd?: string | undefined;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const response = await fetcher("/api/skills/share", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
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

export interface SkillsInventoryState {
  readonly state: "loading" | "ready" | "error";
  readonly entries: ReadonlyArray<SkillsInventoryEntry>;
  readonly error: string | null;
  readonly sharing: string | null;
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
}

export function useSkillsInventory(
  cwd?: string,
  options: UseSkillsInventoryOptions = {},
): SkillsInventoryState {
  const enabled = options.enabled !== false;
  const [entries, setEntries] = useState<ReadonlyArray<SkillsInventoryEntry>>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const refresh = useCallback(() => setRefreshSequence((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
        const response = await fetch(`/api/skills${query}`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload = (await response.json()) as { skills?: unknown };
        const parsed = Array.isArray(payload.skills)
          ? payload.skills
              .map(toEntry)
              .filter((entry): entry is SkillsInventoryEntry => entry !== null)
          : [];
        setEntries(parsed);
        setState("ready");
        setError(null);
      } catch {
        if (controller.signal.aborted) return;
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
      controller.abort();
    };
  }, [cwd, enabled, refreshSequence]);

  const share = useCallback(
    async (sourcePath: string, targetRoot: SkillsInventoryRoot) => {
      setSharing(`${sourcePath}:${targetRoot}`);
      try {
        // The workspace cwd scopes project roots server-side; without it a
        // project-skill share resolves against the server's own cwd and fails.
        const result = await requestSkillShare({ sourcePath, targetRoot, cwd });
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
    [cwd],
  );

  return { state, entries, error, sharing, share, refresh };
}
