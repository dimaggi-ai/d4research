import { createEnvironmentRpcQueryAtomFamily } from "@d4research/client-runtime/state/runtime";
import { WS_METHODS } from "@d4research/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const composerPullRequests = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:composer:pull-requests",
    tag: WS_METHODS.pullRequestsList,
    staleTimeMs: 30_000,
  }),
  detail: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "mobile:composer:pull-request-detail",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 60_000,
  }),
};
