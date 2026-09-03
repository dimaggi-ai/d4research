# Provider architecture

> For maintainers. Using d4research? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. d4research supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS`, which contains seven entries
that all support multiple instances.

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

**Claude** — the model catalog is built-in with version-gated entries (e.g., Opus 5 requires
SDK ≥ 2.1.219). If `ANTHROPIC_BASE_URL` points to a local Ollama server, the driver runs
`ollama list` to discover local models. It supports native updates via `claude update`.

**Agy** — `agy models` hangs on plain pipes on Linux, so the provider wraps it in
`script -q -e -c <command> /dev/null` for a pseudo-terminal. Cold starts can take up to 20 seconds.
Each turn spawns a fresh `agy --print <text>` process; conversation continuity uses
`--conversation <id>`. Model changes require a new thread. See
[providers-agy.md](../user/providers-agy.md) for user-facing details.

**Cursor** — discovers models via the ACP extension method `cursor/list_available_models`. Supports
self-update via `cursor-agent update`.

**Grok** — ships with a built-in `grok-4.6` model. Additional models are discovered via ACP
session model state. The retired `grok-build` slug is treated as "keep the CLI default" so old
threads do not call `session/set_model` with an id current grok CLIs reject. Model changes require
a new thread.

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

### Per-thread gate and the event fence

Each thread carries a per-thread semaphore in its routing entry. Durable transitions (start, stop,
provider replacement) hold that permit across their whole commit, so they never interleave with each
other or with a runtime event's ownership read and publish. Turns and controls do not take the
permit: they bump `activeTurns` / `activeControls` counters, and a transition waits for those to
reach zero before it commits. This keeps a turn and a transition mutually exclusive without a shared
lock.

Runtime events are fenced with the semaphore only. An event reads the thread's binding, decides
whether it is from the current owner, may disarm a restart fence, and publishes — all under the
permit, so it cannot straddle a transition. It deliberately does not wait on `activeTurns`: an
event that waited would stall every co-tenant thread's event stream behind any in-flight turn on the
same instance, because one drain fiber serves all threads on a provider instance.

Two recovery-race windows are knowingly accepted as a result. A `sendTurn` that recovers a missing
native session runs inside the turn path, not a transition, so it writes the new restart generation
without the permit; an event that reads just before that write can publish a stale pre-generation
event. Separately, a compensation path can re-arm a fence generation without the permit while an
event disarms it by adapter identity alone. Both require a rare recovery interleaving and are
low-severity: at worst a single stale event reaches the stream, with no data loss, deadlock, or
security impact. The clean writer-side fix — having recovery take the permit — would deadlock,
because a transition holds the permit across its `activeTurns == 0` wait while the recovering turn
keeps `activeTurns` above zero.

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

Provider work flows through three queue-backed workers built with `makeDrainableWorker` from
[`DrainableWorker.ts`][worker]. Each exposes `drain` for deterministic test synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta, but does not hold the buffer until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000; an append that would exceed this limit invalidates the
buffer and spills the entire accumulated text as a single delta. The buffer also flushes at
interaction boundaries, such as when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

## Provider snapshots: models, skills, usage

### Live Junie compatibility gate

The normal provider suite uses deterministic ACP fixtures. Before shipping a Junie discovery or
model-selection change, run `vp run qa:provider:junie` on an authenticated workstation. This named
gate performs a real ACP handshake, validates the live model catalog, selects the default dev
pipeline's Junie build model, and requires exact streamed output. It is intentionally separate from
CI because it requires the installed CLI and a live account; a skipped probe is not release proof.

Each provider probe produces a `ServerProvider` snapshot
([`server.ts`](../../packages/contracts/src/server.ts)) containing install/auth/status, the model
list, and, where the CLI exposes them, `slashCommands` and `skills`. The web composer surfaces
these as `/` and `$` completions.

`discoverClaudeSkills` ([`ClaudeSkills.ts`](../../apps/server/src/provider/Drivers/ClaudeSkills.ts))
scans `<configDir>/skills` (scope `user`) and `<cwd>/.claude/skills` (scope `project`). It recurses
up to three levels deep, which finds category layouts like `skills/writing/copywriting/SKILL.md`.
The scan skips hidden directories and `node_modules`. A directory containing a `SKILL.md` is treated
as the skill itself, so it is never descended into. Project skills take precedence over user skills
in name collisions.

### Skills inventory and the Skills settings page

[`skillsInventory.ts`](../../apps/server/src/skillsInventory.ts) merges every skills root read by
local agents: the shared user root `~/.agents/skills` (Codex, Cursor, Grok, OpenCode),
`~/.claude/skills`, Codex's hidden `~/.codex/skills/.system` set (scope `system`),
`~/.junie/skills`, `~/.junie/commands/*.md` (kind `command`, description from frontmatter or the
first heading), Agy's documented `~/.gemini/config/skills.json` registry, and the project's
`.agents/skills` and `.claude/skills`. Because project roots often alias one another via symlinks,
entries are deduplicated by resolved path. The aliasing is still reported (`isSymlinked`), and the
`agents` list unions every root that reaches the entry.

Git installs are copied into `~/.agents/skills`, then linked into the Claude and Junie user roots.
Agy receives the same canonical root through an idempotent entry in
`~/.gemini/config/skills.json`; unrelated existing config fields and entries are preserved.
At server startup the same reconciliation runs for skills that were previously installed directly
into Claude, Junie, or d4's obsolete `~/.codex/skills` user location. Reconciliation is idempotent,
never overwrites a same-named skill, and reports conflicts in the server log. An Agy-compatible
repository can also be installed through `agy plugin install`, but only when the user separately
enables **Also install the Agy plugin package**. The bare skill link supplies the portable
instructions automatically; the whole plugin is an explicit, broader capability grant because it
may also contain executable hooks and MCP servers.

Three authenticated endpoints expose it ([`http.ts`](../../apps/server/src/http.ts), registered in
[`server.ts`](../../apps/server/src/server.ts)):

- The typed environment Skills inventory endpoint (read scope, optional `cwd`) returns `{ skills }`
  through the selected local or remote environment connection.
- `POST /api/skills/share` (operate scope, body `{ sourcePath, targetRoot }`) symlinks the skill into
  the target agent root, falling back to a recursive copy. The source must resolve inside a known
  skills root — traversal is rejected with 400 — and an existing target is never overwritten (409).
- `POST /api/skills/install` (operate scope, body `{ url, cwd?, installAgyPlugin? }`) clones and
  fans out portable skills. `installAgyPlugin` must be exactly `true` before the server may invoke
  Agy's whole-package installer; the default is portable skills only.

The web side uses `useSkillsInventory` and `SkillsSettingsPanel` at `/settings/skills`. It groups
skills by root, filters them by name/description/path, provides the Share action for each row, and
stores up to 12 global `skills.enabledByDefault` names in server settings. Web and mobile composers
save additive chat selections in `skills.enabledByThread`, keyed by the durable (preallocated for
drafts) thread id. The system removes empty chat entries and limits the map to 256 configured chats.

The Normalizer merges global and chat skills and resolves them against the live inventory on every
`thread.turn.start`. Global names take precedence in duplicates, capping the effective list at 12.
Project entries beat same-name inventory collisions, followed by the shared user root and
provider-specific roots. The system attaches only existing `SKILL.md` files. It appends the shared
`<enabled_skills>` format from `@d4research/shared/enabledSkillsContext`, which web and mobile parse
identically to strip transport markup and render `Global: name` or `Chat: name` badges. Version-one
persisted blocks still read as global. Although this is reference-only progressive disclosure, the
prompt explicitly requires the receiving agent to read and apply each file, imposing a deliberate
per-turn context cost for every selected skill.

Provider handoff carries the merged global and chat names outside the compressed summary in two
places: the receiving prompt and the durable local Memo record. The receiving turn is normalized
normally as well, which attaches the current live paths after the provider switch. Missing
configured names are omitted rather than claimed as active and remain removable from Settings or
the originating chat.

### Skills on providers with no native support

Only two drivers resolve a `$name` token themselves: **Claude** (`discoverClaudeSkills`) and **Codex**
(`skills/list`, parsed by `parseCodexSkillsListResponse`). Agy, Cursor, Grok, Junie and OpenCode
report `skills: []`, so a bare `$name` would reach them as a meaningless string.

For those, the server expands the token.
[`skillExpansion.ts`](../../apps/server/src/skillExpansion.ts) finds `$name` tokens at a word
boundary, ignoring `$` inside inline code spans, fenced blocks, and `$$`, then appends a compact
reference block after the message text: name, description, the absolute `SKILL.md` path, and one
instruction to read that file first. This is progressive disclosure, not the body; every provider
here is a local CLI with file-read tools. The original token stays in place because it is the user's
visible attachment, and the block states plainly that attaching a skill does not run it.

`normalizeDispatchCommand` ([`Normalizer.ts`](../../apps/server/src/orchestration/Normalizer.ts))
handles the expansion, making it part of the persisted user message so every client (web, desktop,
mobile) sees the same authoritative thread. Constraints worth knowing:

- **Every root, including project skills.** The scan covers `claude-user`, `codex-user`,
  `junie-user` and `project`. A `thread.turn.start` carries no workspace root for an existing
  thread, so the Normalizer resolves it: a bootstrapping turn uses its worktree path, prepared
  worktree cwd, or the project it names, and an existing thread is looked up through
  `ProjectionSnapshotQuery`. That service is optional — without it the scan simply returns no
  project rows.
- **Never twice.** Skill names the target instance already reports natively (looked up through
  `ProviderRegistry` by `instanceId`) are skipped. With no registry in context, or no `instanceId` on
  the command, nothing is treated as native.
- **Never fatal.** A message with no `$` never touches the filesystem, and any failure of the scan
  sends the text through unchanged.
- **Honest about gaps.** A token naming a skill whose `SKILL.md` no longer resolves (a broken share
  symlink) gets a visible "skill file missing" note rather than being dropped silently.

The web composer's `$` menu follows the same rule: when the provider snapshot reports no skills, it
falls back to the local inventory for the thread's workspace
([`composerSkillFallback.ts`](../../apps/web/src/composerSkillFallback.ts)), labelled "Attach as
instructions". `useSkillsInventory` takes an `enabled` flag so chat views on Claude and Codex do not
pay for a poll they never read.

### `skills_search` (MCP)

[`mcp/toolkits/skills`](../../apps/server/src/mcp/toolkits/skills/) registers one read-only tool,
`skills_search(query, limit)`, which answers from `readSkillsInventory` at query time. This live
scan means a deleted skill disappears immediately and there is no index to go stale. It returns each
skill's name, description, absolute path, root/kind/scope, and which agents can see it; it never
runs a skill.

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

The normalized snapshot remains available to provider-readiness and orchestration consumers. The
System Monitor no longer renders provider or thread usage; it is reserved for environment health.

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

The Claude, Codex, and Agy adapters inject Tool Guard variables into the provider process via
`toolGuardEnvironment` (`apps/server/src/provider/toolGuardRuntime.ts`). When the managed
integration is enabled (`setToolGuardRuntimeEnabled`), it sets `T3RESEARCH_RUNTIME_MODE` to the
thread's runtime mode, `T3RESEARCH_TOOL_GUARD_MODE` to `shadow` for `full-access` and `enforcement`
for every other mode, and `T3RESEARCH_TOOL_GUARD_PROFILE`. When disabled, it returns the
environment unchanged, leaving the hooks inert. See [tool-guard.md](./tool-guard.md).

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
