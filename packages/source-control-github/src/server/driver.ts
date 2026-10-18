import { SourceControlProviderKind } from "@d4research/contracts";
import { defineSourceControlDriver } from "@d4research/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("github"),
  make: Effect.all({
    sourceControl: GitHubSourceControlProvider.make,
    discovery: GitHubSourceControlProvider.makeDiscovery,
    pullRequests: GitHubPullRequestProvider.make,
  }),
});
