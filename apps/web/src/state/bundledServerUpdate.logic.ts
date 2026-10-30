import type { ConnectionCatalogEntry } from "@d4research/client-runtime/connection";
import type { BundledServerRuntime, ServerConfig } from "@d4research/contracts";
import * as Option from "effect/Option";

export function sshServerUpdateTarget(entry: ConnectionCatalogEntry) {
  for (const route of [entry, ...(entry.alternateRoutes ?? [])]) {
    if (Option.isSome(route.profile) && route.profile.value._tag === "SshConnectionProfile") {
      return route.profile.value.target;
    }
  }
  return undefined;
}

export function resolveBundledServerUpdate(
  environment: {
    readonly entry: ConnectionCatalogEntry;
    readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  } | null,
  runtime: BundledServerRuntime | null,
) {
  if (!environment || !runtime || !environment.serverConfig) return undefined;
  const { platform, serverVersion } = environment.serverConfig.environment;
  const target = sshServerUpdateTarget(environment.entry);
  if (!target || platform.os !== runtime.os || platform.arch !== runtime.arch) return undefined;
  return { runtime, target, fromVersion: serverVersion };
}
