import { SHARED_ENVIRONMENT_PROXY_PREFIX } from "@d4research/contracts";

/** Only our same-origin gateway may carry an API path prefix. Ordinary hosts retain root routing. */
export function environmentGatewayPath(baseUrl: string): string {
  const path = new URL(baseUrl).pathname.replace(/\/$/u, "");
  const rest = path.slice(SHARED_ENVIRONMENT_PROXY_PREFIX.length);
  return path.startsWith(SHARED_ENVIRONMENT_PROXY_PREFIX) && rest.length > 0 && !rest.includes("/")
    ? path
    : "";
}

export function environmentResourceUrl(baseUrl: string, resource: string): string {
  const prefix = environmentGatewayPath(baseUrl);
  const base = new URL(baseUrl);
  const url = new URL(resource, prefix ? `${base.origin}${prefix}/` : baseUrl);
  if (prefix && url.origin === new URL(baseUrl).origin && !url.pathname.startsWith(`${prefix}/`))
    url.pathname = `${prefix}${url.pathname}`;
  return url.toString();
}
