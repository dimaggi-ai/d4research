import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@d4research/contracts";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@d4research/provider-core/server/snapshot";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
