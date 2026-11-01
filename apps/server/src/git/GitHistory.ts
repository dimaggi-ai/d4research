import type { GitCommitFile, GitHistoryCommit, GitHistoryResult } from "@d4research/contracts";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export const GIT_HISTORY_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s", "%b"].join("%x1f");

export function parseGitHistoryCommit(record: string): GitHistoryCommit | null {
  const fields = record.replace(/^\n+/, "").split(FIELD_SEPARATOR);
  if (fields.length < 8) return null;
  const [sha, parents, authorName, authorEmail, authoredAt, decorations, subject, ...body] = fields;
  if (!sha || !authorName || !authoredAt || !subject) return null;
  return {
    sha: sha.trim(),
    parentShas: (parents ?? "").split(" ").filter(Boolean),
    authorName: authorName.trim(),
    authorEmail: (authorEmail ?? "").trim(),
    authoredAt: authoredAt.trim(),
    subject: subject.trim(),
    body: body.join(FIELD_SEPARATOR).trim(),
    decorations: (decorations ?? "")
      .split(",")
      .map((decoration) => decoration.trim())
      .filter(Boolean),
  };
}

export function parseGitHistory(
  stdout: string,
  branch: string | null,
  limit: number,
): GitHistoryResult {
  const commits = stdout
    .split(RECORD_SEPARATOR)
    .map(parseGitHistoryCommit)
    .filter((commit): commit is GitHistoryCommit => commit !== null);
  return {
    isRepo: true,
    branch,
    commits: commits.slice(0, limit),
    truncated: commits.length > limit,
  };
}

export function parseGitCommitFiles(stdout: string): GitCommitFile[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const [additions, deletions, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) return [];
      const parseCount = (value: string | undefined) => {
        if (!value || value === "-") return null;
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      };
      return [{ path, additions: parseCount(additions), deletions: parseCount(deletions) }];
    });
}
