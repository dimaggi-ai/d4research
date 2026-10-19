import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";

export interface ManagedRelayDpopProofInput {
  readonly method: HttpMethod.HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class ManagedRelayDpopKeyLoadError extends Schema.TaggedError<ManagedRelayDpopKeyLoadError>()(
  "ManagedRelayDpopKeyLoadError",
  {
    keyStore: Schema.Literals(["expo-secure-store", "indexed-db"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not load relay DPoP proof key.";
  }
}

export class ManagedRelayDpopProofCreationError extends Schema.TaggedError<ManagedRelayDpopProofCreationError>()(
  "ManagedRelayDpopProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not create the relay DPoP proof for ${this.method} ${this.url}.`;
  }
}

export const ManagedRelayDpopSignerError = Schema.Union([
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
]);
export type ManagedRelayDpopSignerError = typeof ManagedRelayDpopSignerError.Type;

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  {
    readonly thumbprint: Effect.Effect<string, ManagedRelayDpopKeyLoadError>;
    readonly createProof: (
      input: ManagedRelayDpopProofInput,
    ) => Effect.Effect<string, ManagedRelayDpopProofCreationError>;
  }
>()("@d4research/client-runtime/relay/managedRelay/ManagedRelayDpopSigner") {}
