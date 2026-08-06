# Context Window and Usage

d4research surfaces three kinds of consumption data: the active thread's context window, the
thread's token/cost totals, and your account-level provider usage limits.

## Context window meter

Each thread shows a context window meter beside the composer, fed by the provider's own reports. Whenever the provider
emits a token-usage update, the server records a `context-window.updated` activity on the thread;
the client derives the latest snapshot from it (`deriveLatestContextWindowSnapshot` in
`apps/web/src/lib/contextWindow.ts`) and renders used vs. maximum tokens as a percentage
(`ContextWindowMeter`). Token counts are shortened (`12k`, `1.2m`). Providers that compact their
context automatically are flagged in the snapshot (`compactsAutomatically`), so a full meter does
not necessarily mean an imminent failure.

If the provider does not report a maximum, the meter falls back to a plain used-token count.

## Token usage

The System panel's **Token Usage** section (`TokenUsageMonitor` in
`apps/web/src/components/SystemPanel.tsx`) expands the same snapshot: the context-window bar plus a
breakdown of input, cached input, output, and reasoning tokens, tool uses, turn duration, and —
when the provider reports it — the accumulated cost in USD.

## Usage limits

Providers that expose account rate limits appear in the System panel's **Usage limits** section
(`UsageLimitsMonitor`). For each supported provider instance it shows the plan type and each rolling
usage window with its utilization percentage and reset time. Today Claude (via the Agent SDK's usage
API) and Codex (via the app-server rate-limit report) support this; other providers simply do not
appear in the section. A provider that is installed but not signed in reports its usage as
unauthenticated rather than showing stale numbers.
