import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

export const SHARED_ENVIRONMENT_PROXY_PREFIX = "/api/shared-environments/proxy/";
/** Additional restriction only; never grants more than the authenticated credential. */
export const DELEGATED_PERMISSIONS_HEADER = "x-t3-delegated-permissions";

export const SharedEnvironmentRegistration = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  bearerToken: Schema.NullOr(Schema.String),
});
export type SharedEnvironmentRegistration = typeof SharedEnvironmentRegistration.Type;
export const PublishSharedEnvironmentsInput = Schema.Struct({
  environments: Schema.Array(SharedEnvironmentRegistration).check(Schema.isMaxLength(128)),
});
export type PublishSharedEnvironmentsInput = typeof PublishSharedEnvironmentsInput.Type;
export const SharedEnvironmentCatalogItem = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type SharedEnvironmentCatalogItem = typeof SharedEnvironmentCatalogItem.Type;
export const SharedEnvironmentCatalog = Schema.Struct({
  environments: Schema.Array(SharedEnvironmentCatalogItem),
});
export type SharedEnvironmentCatalog = typeof SharedEnvironmentCatalog.Type;
