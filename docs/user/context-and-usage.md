# Context Window and Usage

d4research keeps consumption data separate from environment health: the active thread shows its
context window beside the composer, while **Usage** in the lower-left navigation summarizes token
and cost history.

## Context window meter

Each thread shows a context window meter beside the composer, fed by the provider's own reports. Whenever the provider
emits a token-usage update, the server records a `context-window.updated` activity on the thread;
the client derives the latest snapshot from it (`deriveLatestContextWindowSnapshot` in
`apps/web/src/lib/contextWindow.ts`) and renders used vs. maximum tokens as a percentage
(`ContextWindowMeter`). Token counts are shortened (`12k`, `1.2m`). Providers that compact their
context automatically are flagged in the snapshot (`compactsAutomatically`), so a full meter does
not necessarily mean an imminent failure.

If the provider does not report a maximum, the meter falls back to a plain used-token count.

## Usage page

The **Usage** page aggregates processed tokens, cache reads, output, sessions, and estimated raw API
cost over selectable time windows. It is intentionally separate from **System Monitor**, which is
reserved for CPU, memory, GPU, disk, service, process, and Tool Guard health.

System Monitor does not query thread token history, so opening it is independent of the active
thread and does not duplicate the Usage page.
