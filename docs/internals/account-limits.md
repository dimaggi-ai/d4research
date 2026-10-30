# Account-limit architecture

> For maintainers. Using T3 Code? See [Review usage and account limits](../user/usage.md).

T3 Code reports provider subscription windows as snapshots. It does not calculate a limit from
token totals and it does not send credentials to the client. The client renders the provider data
as-is, so new provider windows can appear without a client schema change.

## Data flow

1. `ClaudeAdapter` and the Codex adapter emit normalized
   `account.rate-limits.updated` runtime events.
   Claude's current stream carries fractional utilization for several windows under
   `rate_limit_info.unifiedWindows`; the normalizer scales those values to percentages and keeps the
   older single-window event as a fallback.
2. `ProviderRuntimeIngestion` forwards those events to `AccountLimitsService` while preserving the
   `providerInstanceId` from the runtime envelope.
3. `AccountLimitsService` normalizes provider-specific payloads into the shared contract, stores one
   snapshot per `(provider, providerInstanceId)`, and persists the cache in the server state
   directory.
4. `server.getAccountLimits` returns the snapshots for one environment.
5. The web client merges rows by `(environment, provider, instance)` and never merges different
   provider instances into one account.

Relevant implementation files:

- Contract: `packages/contracts/src/accountLimits.ts`
- Normalization: `apps/server/src/usage/accountLimitsNormalize.ts`
- Cache and transcript seeding: `apps/server/src/usage/AccountLimitsService.ts`
- Codex transcript recovery: `apps/server/src/usage/accountLimitsTranscripts.ts`
- Client state: `apps/web/src/state/accountLimits.ts`
- UI: `apps/web/src/components/usage/AccountLimits.tsx`

## Provider behavior

Claude's complete usage response is requested through a running provider session and is combined
with streamed single-window events. Claude does not expose an equivalent trustworthy transcript
fallback, so its snapshot is live provider data persisted locally only to survive a server restart.

Codex reports live app-server updates. When a live snapshot is absent, T3 Code reads the newest
`rate_limits` record from local Codex transcripts. A sessions directory is seeded only when one
configured provider instance owns it; a shared directory, including a shadow-home arrangement, is
skipped because the transcript does not identify which account produced the record.

Each instance needs a distinct configured display name for useful UI labels, but the name is not
used as an account identity. The routing key is the provider instance ID. This prevents a personal
and work Claude setup from overwriting each other while still allowing two instances logged into the
same account to show the same provider-reported values.

## Compatibility and freshness

The contract is versioned. Version 2 adds `instanceId` while accepting version-1 snapshots and
migrating them to the provider's default instance. A migrated legacy row is evicted when a live
event proves it belonged to another instance, avoiding a permanent ghost reading.

`asOf` is the provider observation time, not the RPC read time. The UI displays a relative age only
after the snapshot is stale. An empty provider row means no usable snapshot has been reported yet;
it is not a claim that the provider has no subscription limit.

The implementation is intentionally generic: tests use synthetic provider payloads and do not
contain account names, emails, tokens, repository paths, or project data.
