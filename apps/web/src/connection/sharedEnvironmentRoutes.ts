import {
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@d4research/client-runtime/connection";
import { type PublishSharedEnvironmentsInput } from "@d4research/contracts";

export interface SharedHostConnection {
  readonly entry: ConnectionCatalogEntry;
  readonly prepared: PreparedConnection | null;
}

export function sharedEnvironmentPublication(current: ReadonlyArray<SharedHostConnection>) {
  const host = current.find(
    ({ entry, prepared }) =>
      entry.enabled &&
      entry.target._tag === "PrimaryConnectionTarget" &&
      prepared?.httpAuthorization?._tag === "Bearer",
  );
  if (!host?.prepared || host.prepared.httpAuthorization?._tag !== "Bearer") return null;
  const payload: PublishSharedEnvironmentsInput = {
    environments: current
      .filter(
        ({ entry }) =>
          entry.enabled && entry.target.environmentId !== host.entry.target.environmentId,
      )
      .map(({ entry, prepared }) => {
        const canShare = prepared?.httpAuthorization?._tag === "Bearer";
        return {
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          httpBaseUrl: canShare ? new URL(prepared.httpBaseUrl).origin + "/" : null,
          bearerToken: canShare ? prepared.httpAuthorization.token : null,
        };
      }),
  };
  return {
    httpBaseUrl: host.prepared.httpBaseUrl,
    headers: { authorization: `Bearer ${host.prepared.httpAuthorization.token}` },
    payload,
  };
}
