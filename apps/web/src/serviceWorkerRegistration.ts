import { getPairingTokenFromUrl } from "./pairingUrl";

const PAIRING_PATHNAMES = new Set(["/pair", "/pair/"]);

/**
 * A freshly activated service worker claims the page and triggers a reload.
 * If that lands while a pairing exchange is in flight, the server has already
 * consumed the one-time token but the response — and the session cookie it
 * carries — is thrown away with the navigation, permanently burning the link.
 * Skip registration on the pairing surface; the app registers on the next
 * navigation once the session exists.
 */
export function shouldRegisterServiceWorkerForLocation(url: URL): boolean {
  if (PAIRING_PATHNAMES.has(url.pathname)) return false;
  return (getPairingTokenFromUrl(url) ?? "").trim().length === 0;
}
