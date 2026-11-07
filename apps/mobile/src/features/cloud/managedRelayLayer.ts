import { DpopProof, ManagedRelay } from "@d4research/client-runtime/relay";
import { RelayMobileClientId } from "@d4research/contracts/relay";
import * as Layer from "effect/Layer";

import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(Layer.provideMerge(layerRelayDpopSigner));
