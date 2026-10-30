import { PrimaryConnectionRegistration } from "./catalog.ts";
import { PrimaryConnectionTarget } from "./model.ts";
import { SHARED_ENVIRONMENT_PROXY_PREFIX, type SharedEnvironmentCatalog } from "@d4research/contracts";

export function sharedEnvironmentRegistrations(
  primary: PrimaryConnectionTarget,
  catalog: SharedEnvironmentCatalog,
  sharedHost?: PrimaryConnectionTarget["sharedHost"],
) {
  return catalog.environments
    .filter((item) => item.environmentId !== primary.environmentId)
    .map((item) => {
      const url = new URL(primary.httpBaseUrl);
      url.pathname = `${SHARED_ENVIRONMENT_PROXY_PREFIX}${encodeURIComponent(item.environmentId)}`;
      url.search = "";
      url.hash = "";
      const ws = new URL(url);
      ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
      ws.pathname += "/ws";
      return new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: item.environmentId,
          label: item.label,
          httpBaseUrl: url.href,
          wsBaseUrl: ws.href,
          ...(sharedHost === undefined ? {} : { sharedHost }),
        }),
      });
    });
}
