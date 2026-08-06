# Provider architecture

> For maintainers. Using d4research? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. d4research supports several, and the
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

## Provider snapshots: models, skills, usage

Each provider probe produces a `ServerProvider` snapshot
([`server.ts`](../../packages/contracts/src/server.ts)): install/auth/status, the model list, and —
where the CLI exposes them — `slashCommands` and `skills` that the web composer surfaces as `/` and
`$` completions.

`discoverClaudeSkills` ([`ClaudeSkills.ts`](../../apps/server/src/provider/Drivers/ClaudeSkills.ts))
scans `<configDir>/skills` (scope `user`) and `<cwd>/.claude/skills` (scope `project`). The scan
recurses up to three levels so category layouts (`skills/writing/copywriting/SKILL.md`) are found;
hidden directories and `node_modules` are skipped, and a directory holding a `SKILL.md` is itself a
skill and is never descended into. Project skills win name collisions with user skills.

### Skills inventory and the Skills settings page

[`skillsInventory.ts`](../../apps/server/src/skillsInventory.ts) merges every skills root the local
agents read — `~/.claude/skills`, `~/.codex/skills` plus its hidden `.system` set (scope `system`),
`~/.junie/skills`, `~/.junie/commands/*.md` (kind `command`, description from frontmatter or the
first heading), and the project's `.agents/skills` and `.claude/skills`. Project roots frequently
alias one another through a symlink, so entries are deduplicated by resolved path while the aliasing
is still reported (`isSymlinked`) and the `agents` list unions every root that reaches the entry.

Two raw routes expose it ([`http.ts`](../../apps/server/src/http.ts), registered in
[`server.ts`](../../apps/server/src/server.ts)):

- `GET /api/skills` (read scope, optional `?cwd=` — defaults to the server cwd) returns `{ skills }`.
- `POST /api/skills/share` (operate scope, body `{ sourcePath, targetRoot }`) symlinks the skill into
  the target agent root, falling back to a recursive copy. The source must resolve inside a known
  skills root — traversal is rejected with 400 — and an existing target is never overwritten (409).

The web side is `useSkillsInventory` plus `SkillsSettingsPanel` at `/settings/skills`, which groups
skills by root, filters by name/description/path, and offers the Share action per row.

### Skills on providers with no native support

Only two drivers resolve a `$name` token themselves: **Claude** (`discoverClaudeSkills`) and **Codex**
(`skills/list`, parsed by `parseCodexSkillsListResponse`). Agy, Cursor, Grok, Junie and OpenCode
report `skills: []`, so a bare `$name` would reach them as a meaningless string.

For those, the server expands the token.
[`skillExpansion.ts`](../../apps/server/src/skillExpansion.ts) finds `$name` tokens at a word
boundary — ignoring `$` inside inline code spans, fenced blocks, and `$$` — and appends a compact
reference block after the message text: name, description, the absolute `SKILL.md` path, and one
instruction to read that file first. It is progressive disclosure, not the body: every provider here
is a local CLI with file-read tools. The original token stays in place because it is the user's
visible attachment, and the block states plainly that attaching a skill does not run it.

The expansion happens in `normalizeDispatchCommand`
([`Normalizer.ts`](../../apps/server/src/orchestration/Normalizer.ts)), so it is part of the
persisted user message and every client — web, desktop, mobile — sees the same authoritative thread.
Constraints worth knowing:

- **User roots only.** A `thread.turn.start` carries no workspace root for an existing thread, so the
  inventory scan runs without a cwd: `claude-user`, `codex-user`, `junie-user`. Project-scoped skills
  are out of scope for expansion and remain natively available on Claude and Codex.
- **Never twice.** Skill names the target instance already reports natively (looked up through
  `ProviderRegistry` by `instanceId`) are skipped. With no registry in context, or no `instanceId` on
  the command, nothing is treated as native.
- **Never fatal.** A message with no `$` never touches the filesystem, and any failure of the scan
  sends the text through unchanged.
- **Honest about gaps.** A token naming a skill whose `SKILL.md` no longer resolves (a broken share
  symlink) gets a visible "skill file missing" note rather than being dropped silently.

The web composer's `$` menu follows the same rule: when the provider snapshot reports no skills, it
falls back to the local inventory filtered to those same user roots
([`composerSkillFallback.ts`](../../apps/web/src/composerSkillFallback.ts)), labelled "Attach as
instructions". `useSkillsInventory` takes an `enabled` flag so chat views on Claude and Codex do not
pay for a poll they never read.

### `skills_search` (MCP)

[`mcp/toolkits/skills`](../../apps/server/src/mcp/toolkits/skills/) registers one read-only tool,
`skills_search(query, limit)`, answered from `readSkillsInventory` at query time — a live scan, so a
deleted skill disappears immediately and there is no index to go stale. It returns each skill's name,
description, absolute path, root/kind/scope, and which agents can see it; it never runs a skill.

Reachability follows the MCP session, not the skills support: **Codex, Claude, Cursor, Grok and
OpenCode** get an `McpProviderSession` and can call it. **Agy and Junie** have no MCP session in
their adapters and cannot. Agy still benefits from token expansion; Junie resolves its own skills and
commands locally.

Snapshots may also carry `usage: ServerProviderUsage` — plan type, rolling usage windows
(`ServerProviderUsageWindow`: label, `utilizationPercent`, `resetsAt`), optional credits, and a
`limitReached` marker. Two drivers populate it today:

- **Claude** — `ClaudeProvider.ts` calls the Agent SDK's experimental usage API
  (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) and maps it via `mapClaudeUsage`;
  failures degrade to `support: "unavailable"`.
- **Codex** — `CodexProvider.ts` maps the app-server rate-limit report (`mapCodexRateLimits`),
  including plan detection; an unauthenticated account reports `support: "unauthenticated"`.

The web System panel renders supported providers in its **Usage limits** section
(`UsageLimitsMonitor` in `apps/web/src/components/SystemPanel.tsx`).

## Ollama models through the Claude driver

The web settings offer an **Ollama preset** for a Claude provider instance
(`apps/web/src/components/settings/ollamaClaudePreset.ts`). `applyOllamaClaudePreset` switches the
instance to the `claudeAgent` driver and sets `ANTHROPIC_BASE_URL=http://127.0.0.1:11434`,
`ANTHROPIC_AUTH_TOKEN=ollama`, and an empty `ANTHROPIC_API_KEY`, so Claude Code talks to the local
Ollama daemon. The preset seeds `customModels` with:

- locally installed models discovered via `fetchLocalOllamaModelIds` (GET
  `http://127.0.0.1:11434/api/tags`, 3 s timeout, failure returns an empty list), and
- the Ollama **cloud** tags in `OLLAMA_CLAUDE_CLOUD_MODELS`: `glm-5.2:cloud`,
  `kimi-k2.7-code:cloud`, `minimax-m2.7:cloud`, `nemotron-3-super:cloud`, `qwen3.5:cloud`.

Server-side, `ClaudeDriver` also discovers local models with `ollama list` when
`ANTHROPIC_BASE_URL` points at `127.0.0.1:11434` (see the transport notes above).
`isOllamaClaudePresetConfigured` detects a preset-shaped instance so the settings card can label it.

## Tool Guard environment

The Claude, Codex, and Agy adapters inject Tool Guard variables into the provider process through
`toolGuardEnvironment` (`apps/server/src/provider/toolGuardRuntime.ts`). When the managed
integration is enabled (`setToolGuardRuntimeEnabled`), it sets `T3RESEARCH_RUNTIME_MODE` to the
thread's runtime mode, `T3RESEARCH_TOOL_GUARD_MODE` to `shadow` for `full-access` and `enforcement`
for every other mode, and `T3RESEARCH_TOOL_GUARD_PROFILE`. When disabled it returns the environment
unchanged, so the hooks stay inert. See [tool-guard.md](./tool-guard.md).

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
