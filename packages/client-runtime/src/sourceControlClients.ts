/**
 * The source control host definitions web and mobile ship, and the one lookup they use.
 *
 * Adding a host means writing its `@d4research/source-control-<host>` package with a
 * `./client/definition` entry and adding it here; clients then label, list, and check out its
 * change requests without further branches.
 *
 * @module client-runtime/sourceControlClients
 */
import * as AzureDevOps from "@d4research/source-control-azure-devops/client/definition";
import * as Bitbucket from "@d4research/source-control-bitbucket/client/definition";
import {
  makeSourceControlClientRegistry,
  readSourceControlHostSettings,
} from "@d4research/source-control-core/client/definition";
import type { ServerSettings } from "@d4research/contracts";

export {
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestTerminology,
  type SourceControlClientDefinition,
} from "@d4research/source-control-core/client/definition";
import * as Forgejo from "@d4research/source-control-forgejo/client/definition";
import * as GitCafe from "@d4research/source-control-gitcafe/client/definition";
import * as GitHub from "@d4research/source-control-github/client/definition";
import * as GitLab from "@d4research/source-control-gitlab/client/definition";

/**
 * GitHub comes first because a repository that has not reported its host yet reads as GitHub,
 * which is what clients have always shown there. A change request URL goes to the first host
 * whose shape it has, so GitCafe, which claims `/pulls/` only on its own hostnames, comes before
 * Forgejo, which claims it everywhere. Pickers sort by readiness and label, not by this order.
 */
const BUILT_IN_SOURCE_CONTROL_CLIENTS = [
  GitHub.definition,
  GitLab.definition,
  GitCafe.definition,
  Forgejo.definition,
  Bitbucket.definition,
  AzureDevOps.definition,
];

/** `definitions` lists the built-in hosts in that order, for pickers that offer every host. */
export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
);

export type { GitHubSettings } from "@d4research/source-control-github/client/definition";

/**
 * An environment's GitHub host choices and tokens, decoded with GitHub's settings schema. GitHub's
 * settings panels are its own, since its logins come from `gh` at runtime.
 */
export function readGitHubSettings(settings: Pick<ServerSettings, "sourceControlHosts">) {
  return readSourceControlHostSettings(GitHub.settings, settings.sourceControlHosts.github);
}
