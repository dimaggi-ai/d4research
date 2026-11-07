import type { RepositoryIdentity } from "@d4research/contracts";
const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;
// Git reads `host:path` as SSH too, leaving the user to ssh config. A single letter is a Windows
// drive and `::` names a remote helper.
const USERLESS_SCP_SSH_REMOTE_PATTERN = /^([^@:/\\\s]{2,}):(?!:)\/?[^/\s]+(?:\/[^/\s]+)+\/?$/u;

/** Null unless the remote is `host:path`, with no user. */
export function userlessScpRemoteHost(remoteUrl: string): string | null {
  return USERLESS_SCP_SSH_REMOTE_PATTERN.exec(remoteUrl.trim())?.[1] ?? null;
}

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return (
    SCP_SSH_REMOTE_PATTERN.test(trimmed) ||
    trimmed.toLowerCase().startsWith("ssh://") ||
    userlessScpRemoteHost(trimmed) !== null
  );
}

/**
 * Azure DevOps is the exception: `az repos pr list --repository` takes a repository name, and
 * takes the organisation and project from the checkout it detects — so the recorded
 * `org/project/_git/repo` path is refused outright and the whole repository reads as
 * unavailable. Its name is the last segment, which is what this hands over.
 */
export function sourceControlRepositorySelector(
  identity:
    | Pick<RepositoryIdentity, "provider" | "displayName" | "owner" | "name">
    | null
    | undefined,
): string | null {
  if (!identity) return null;
  if (identity.provider === "azure-devops") {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    return identity.name || segments.at(-1) || null;
  }
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

export function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}
