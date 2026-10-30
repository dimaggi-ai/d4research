import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@d4research/shared/observability";
import * as RelayTracing from "@d4research/shared/relayTracing";
// Runtime credentials cannot enable network tracing in this fork.
const relayLayer = (resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">) =>
  RelayTracing.layer(null, { ...resource, serviceInstanceId: processServiceInstanceId() });

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
