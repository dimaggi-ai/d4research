import { createPullRequestEnvironmentAtoms } from "@d4research/client-runtime/state/pull-requests";

import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
