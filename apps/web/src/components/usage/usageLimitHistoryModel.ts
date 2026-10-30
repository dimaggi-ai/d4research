import type { UsageLimitHistoryPoint } from "@d4research/contracts";

/** Solid lines connect measured values, including resets. Gaps get dashed bridges. */
export function historySegments(
  points: readonly UsageLimitHistoryPoint[],
  resolutionMinutes: number,
) {
  const segments: UsageLimitHistoryPoint[][] = [];
  for (const point of [...points].sort(
    (a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt),
  )) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    const gap = previous ? Date.parse(point.measuredAt) - Date.parse(previous.measuredAt) : 0;
    if (!segment || !previous || gap > Math.max(15, resolutionMinutes * 2) * 60_000) {
      segments.push([point]);
    } else segment.push(point);
  }
  return segments;
}

export function historyAccounts(points: readonly UsageLimitHistoryPoint[]) {
  const accounts = new Map<
    string,
    { label: string; color: string | null; windows: Map<string, UsageLimitHistoryPoint[]> }
  >();
  for (const point of points) {
    let account = accounts.get(point.accountId);
    if (!account) {
      account = { label: point.label, color: point.color, windows: new Map() };
      accounts.set(point.accountId, account);
    }
    account.label = point.label;
    account.color = point.color;
    const window = account.windows.get(point.windowId);
    if (window) window.push(point);
    else account.windows.set(point.windowId, [point]);
  }
  return [...accounts].sort(
    ([aId, a], [bId, b]) => a.label.localeCompare(b.label) || aId.localeCompare(bId),
  );
}

export function historyProviderGroups(points: readonly UsageLimitHistoryPoint[]) {
  const groups = new Map<string, { label: string; accounts: ReturnType<typeof historyAccounts> }>();
  for (const account of historyAccounts(points)) {
    let driver = "other";
    try {
      const identity: unknown = JSON.parse(account[0]);
      if (Array.isArray(identity)) {
        const candidate =
          identity[0] === "provider" ? identity[1] : identity[0] === "source" ? identity[2] : null;
        if (typeof candidate === "string") driver = candidate;
      }
    } catch {
      /* Historical/custom ids remain visible in Other providers. */
    }
    const label =
      (
        {
          claudeAgent: "Claude",
          claude: "Claude",
          codex: "Codex",
          grok: "Grok",
          other: "Other providers",
        } as Record<string, string>
      )[driver] ?? driver;
    const group = groups.get(label) ?? { label, accounts: [] };
    group.accounts.push(account);
    groups.set(label, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
