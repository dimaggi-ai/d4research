import { environmentGatewayPath } from "@d4research/shared/environmentGateway";
export * from "@d4research/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = environmentGatewayPath(httpBaseUrl) + pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};
