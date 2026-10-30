import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProvider } from "./server.ts";
import {
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshot,
  UsageLimitSourceSnapshots,
} from "./providerUsageLimits.ts";
import { UsageDay, UsageSummaryInput } from "./usage.ts";

export const McpUsageLimitsInput = Schema.Struct({
  refresh: Schema.optional(Schema.Boolean),
  includeConnected: Schema.optional(Schema.Boolean),
});
export type McpUsageLimitsInput = typeof McpUsageLimitsInput.Type;

export const McpUsageLimitsSnapshot = Schema.Struct({
  readAt: IsoDateTime,
  providers: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      driver: ServerProvider.fields.driver,
      displayName: ServerProvider.fields.displayName,
      enabled: Schema.Boolean,
      installed: Schema.Boolean,
      available: Schema.Boolean,
      auth: Schema.Struct({
        status: ServerProvider.fields.auth.fields.status,
        label: ServerProvider.fields.auth.fields.label,
        email: ServerProvider.fields.auth.fields.email,
        workspaceId: ServerProvider.fields.auth.fields.workspaceId,
      }),
      limits: Schema.NullOr(ServerProviderUsageLimits),
    }),
  ),
  sources: UsageLimitSourceSnapshots,
});
export type McpUsageLimitsSnapshot = typeof McpUsageLimitsSnapshot.Type;

export const McpUsageLimitsReport = Schema.Struct({
  readAt: IsoDateTime,
  coverageComplete: Schema.Boolean,
  notices: Schema.Array(Schema.String),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      available: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
  providers: Schema.Array(
    Schema.Struct({
      ...McpUsageLimitsSnapshot.fields.providers.value.fields,
      environmentId: EnvironmentId,
      environmentLabel: Schema.String,
    }),
  ),
  sources: Schema.Array(
    Schema.Struct({
      ...UsageLimitSourceSnapshot.fields,
      environmentId: EnvironmentId,
      environmentLabel: Schema.String,
    }),
  ),
});
export type McpUsageLimitsReport = typeof McpUsageLimitsReport.Type;

export const McpUsageLimitsResult = Schema.Struct({
  environmentId: EnvironmentId,
  currentProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  ...McpUsageLimitsReport.fields,
});

export const McpUsageReadInput = Schema.Struct({
  sinceDay: Schema.optional(UsageDay),
  untilDay: Schema.optional(UsageDay),
  timeZone: Schema.optional(UsageSummaryInput.fields.timeZone),
  resolution: UsageSummaryInput.fields.resolution,
  sinceTime: UsageSummaryInput.fields.sinceTime,
  untilTime: UsageSummaryInput.fields.untilTime,
  awaitRefresh: UsageSummaryInput.fields.awaitRefresh,
});
export type McpUsageReadInput = typeof McpUsageReadInput.Type;
