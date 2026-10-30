import * as AzureDevOps from "@d4research/source-control-azure-devops/shared/definition";
import * as Bitbucket from "@d4research/source-control-bitbucket/shared/definition";
import { makeSourceControlDefinitionRegistry } from "@d4research/source-control-core/shared/definition";
import * as Forgejo from "@d4research/source-control-forgejo/shared/definition";
import * as GitCafe from "@d4research/source-control-gitcafe/shared/definition";
import * as GitHub from "@d4research/source-control-github/shared/definition";
import * as GitLab from "@d4research/source-control-gitlab/shared/definition";

export { canonicalizePullRequestUrl as canonicalizeGitCafePullRequestUrl } from "@d4research/source-control-gitcafe/shared/definition";

/**
 * GitHub comes first to preserve the client default for repositories with an unknown host.
 * GitCafe claims URLs first because GitHub and Forgejo accept the same routes on any hostname.
 * Remote recognition needs its own order because host labels can overlap (`gitea.github.example`).
 */
export const builtInSourceControlDefinitions = makeSourceControlDefinitionRegistry(
  [
    GitHub.definition,
    GitLab.definition,
    GitCafe.definition,
    Forgejo.definition,
    Bitbucket.definition,
    AzureDevOps.definition,
  ],
  {
    claimChangeRequestUrlsFirst: [GitCafe.definition.kind],
    recognizeRemotesIn: [
      GitCafe.definition.kind,
      Forgejo.definition.kind,
      GitHub.definition.kind,
      GitLab.definition.kind,
      AzureDevOps.definition.kind,
      Bitbucket.definition.kind,
    ],
  },
);
