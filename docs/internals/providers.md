# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with seven entries. All support
multiple instances.

| Driver kind   | Display name | Transport                     | Driver source                           |
| ------------- | ------------ | ----------------------------- | --------------------------------------- |
| `codex`       | Codex        | Codex app-server JSON-RPC     | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | Claude       | Claude Agent SDK (`query()`)  | [`Drivers/ClaudeDriver.ts`][claude]     |
| `agy`         | Agy          | NDJSON stream over stdio      | [`Drivers/AgyDriver.ts`][agy]           |
| `cursor`      | Cursor       | ACP over stdio (`effect-acp`) | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | Grok         | ACP over stdio (`effect-acp`) | [`Drivers/GrokDriver.ts`][grok]         |
| `junie`       | Junie        | ACP over stdio (reuses Grok)  | [`Drivers/JunieDriver.ts`][junie]       |
| `opencode`    | OpenCode     | OpenCode SDK over HTTP        | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

### Transport protocols

The seven drivers use four distinct transport protocols:

- **Claude Agent SDK** — Claude only. Calls `@anthropic-ai/claude-agent-sdk`'s `query()` which
  returns an `AsyncIterable<SDKMessage>`. Also discovers local **Ollama models** when
  `ANTHROPIC_BASE_URL` points to `127.0.0.1:11434`.
- **Codex app-server JSON-RPC** — Codex only. Spawns a Codex app-server child process and
  communicates via the `effect-codex-app-server` RPC client.
- **ACP over stdio** — Cursor, Grok, and Junie. Uses the `effect-acp` library. Junie reuses the
  Grok adapter core (`makeGrokAdapter`) with a Junie-specific ACP runtime, so the orchestration
  logic is shared.
- **NDJSON stream over stdio** — Agy only. Spawns `agy --print` per turn and reads
  newline-delimited JSON events (`init`, `step_update`, `result`). Requires a PTY wrapper on Linux
  for model discovery.

### Per-driver notes

**Codex** — two instances with different `homePath`s run fully independent Codex app-server
processes. Model discovery queries the app-server for account info and model list.

**Claude** — model catalog is built-in with version-gated entries (e.g. Opus 5 requires SDK ≥
2.1.219). When `ANTHROPIC_BASE_URL` points to a local Ollama server, the driver also runs
`ollama list` to discover local models. Supports native updates via `claude update`.

**Agy** — `agy models` hangs on plain pipes on Linux, so the provider wraps it in
`script -q -e -c <command> /dev/null` for a pseudo-terminal. Cold starts can take up to 20 seconds.
Each turn spawns a fresh `agy --print <text>` process; conversation continuity uses
`--conversation <id>`. Model changes require a new thread. See
[providers-agy.md](../user/providers-agy.md) for user-facing details.

**Cursor** — discovers models via the ACP extension method `cursor/list_available_models`. Supports
self-update via `cursor-agent update`.

**Grok** — ships with a built-in `grok-build` model. Additional models are discovered via ACP
session model state. Model changes require a new thread.

**Junie** — reuses the Grok adapter and text generation with a Junie-specific ACP runtime. Ships
with a `default` model. Supports custom Ollama models (e.g. `custom:t3-local-ollama`). Model
changes require a new thread.

**OpenCode** — spawns an OpenCode server process and communicates via the `@opencode-ai/sdk/v2`
TypeScript client. Minimum version: 1.14.19. Supports native updates via `opencode upgrade`.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[agy]: ../../apps/server/src/provider/Drivers/AgyDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[junie]: ../../apps/server/src/provider/Drivers/JunieDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
