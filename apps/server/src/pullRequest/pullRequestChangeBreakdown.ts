import type { PullRequestChangeBreakdown } from "@d4research/contracts";
import { classifyChangedFile } from "@d4research/shared/changedFileKind";
import type { ProviderFileStats } from "@d4research/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  const empty = () => ({ additions: 0, deletions: 0 });
  const breakdown = {
    code: empty(),
    tests: empty(),
    mocks: empty(),
    generated: empty(),
    docs: empty(),
  };
  for (const file of stats.files) {
    const bucket = breakdown[classifyChangedFile(file.path)];
    bucket.additions += file.additions;
    bucket.deletions += file.deletions;
  }
  return breakdown;
}
