import { EnvironmentId } from "@d4research/contracts";
import { RelayManagedEndpoint } from "@d4research/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionAttemptError } from "../connection/model.ts";

export class RemoteDpopAccessToken extends Schema.Class<RemoteDpopAccessToken>(
  "@d4research/client-runtime/authorization/RemoteDpopAccessToken",
)({
  environmentId: EnvironmentId,
  accountId: Schema.optionalKey(Schema.String),
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  dpopThumbprint: Schema.String,
}) {}

export class RemoteDpopAccessTokenStore extends Context.Service<
  RemoteDpopAccessTokenStore,
  {
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<RemoteDpopAccessToken>, ConnectionAttemptError>;
    readonly put: (token: RemoteDpopAccessToken) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@d4research/client-runtime/authorization/tokenStore/RemoteDpopAccessTokenStore") {}

export const make = (service: RemoteDpopAccessTokenStore["Service"]) =>
  RemoteDpopAccessTokenStore.of(service);
