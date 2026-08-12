# d4research

A multi-provider coding agent workspace for structured research, built on the [T3 Code](https://github.com/pingdotgg/t3code) foundation. Run coding agents from Codex, Claude, Cursor, Grok, Junie, OpenCode, and Agy side by side, hand off context between them mid-conversation without leaving the thread, replay authored pipelines that delegate steps across models under server-enforced budgets, and layer optional tool-safety policies on top.

## Installation

**Run this fork from source** — see [Setup](#setup) below. No prebuilt binaries are published yet: the [releases page](https://github.com/dimaggi-ai/d4research/releases) is currently empty, and there is no npm package or Docker image. The upstream `npx t3` and T3 Code desktop/mobile releases install the original T3 Code, not this fork.

Desktop artifacts are cut on a maintainer machine rather than in CI, so when they do land the platform set tracks whatever that machine can build — a Linux `x86_64` AppImage via `vp run dist:desktop:linux` — and the binaries are unsigned. macOS and Windows installers are not published; build them from source with the matching `dist:desktop:*` script, or run from source on any platform.

### Requirements

- Git clone access to [dimaggi-ai/d4research](https://github.com/dimaggi-ai/d4research)
- Node.js `^22.16 || ^23.11 || >=24.10`
- At least one provider CLI installed and authenticated (see [Providers](#supported-providers))

### Setup

```bash
git clone git@github.com:dimaggi-ai/d4research.git
cd d4research

# Verifies the Node runtime, installs Vite+ and dependencies,
# and reports which provider CLIs are usable.
./scripts/setup.sh

vp run dev
```

`scripts/setup.sh` is idempotent, so re-run it whenever the environment looks
wrong. Pass `--check` to diagnose without changing anything. It is deliberately
a shell script rather than one of the `scripts/*.ts` entry points, because the
most common failure it catches is a Node binary that reports a version but
crashes on execution — at which point nothing written in TypeScript can run.

To set the environment up by hand instead:

```bash
curl -fsSL https://vite.plus | bash   # Vite+ build tool, one-time
vp i
vp run dev
```

`vp run dev` prints a `[dev-runner]` line with the ports it actually bound
(`5733` for the web client and `13773` for the server by default; both shift if
occupied), followed by a pairing URL:

```
pairingUrl: http://localhost:5733/pair#token=XXXXXXXXXXXX
```

Open that URL. The web app requires pairing, so the bare origin will not
authenticate. Connect from any browser, including remote devices via
[Tailscale or relay](./docs/user/remote-access.md).

> [!NOTE]
> `http://localhost:3773` is the port used by a production `vp run start`
> build, not by `vp run dev`.

### Updating

Pull the latest source and reinstall:

```bash
git pull
vp i
vp run dev
```

`scripts/deploy-local.sh` rebuilds an existing local deployment with systemd restart. It is not a fresh-machine installer.

---

## T3 Code Base Features

Everything from the upstream T3 Code platform is available:

- **Multi-surface clients** -- Web app, Electron desktop (macOS/Windows/Linux), and React Native mobile (iOS/Android)
- **7 provider adapters** -- Codex, Claude, Cursor, Grok, Junie, OpenCode, Agy. Each runs in its own process with native auth
- **Integrated terminals** -- Full PTY terminals alongside the chat, with provider tool access
- **Source control** -- Git integration, diffs, checkpoints, branch management, commit message generation
- **File previews** -- Syntax-highlighted code, images, PDFs, and Jupyter notebooks
- **Checkpoint diff/restore** -- Roll back any provider change to a prior filesystem state
- **Remote access** -- Connect from any device via Tailscale, SSH tunnel, or cloud relay
- **Background service** -- Run headless on Linux as a systemd service
- **Keyboard-driven** -- Configurable keybindings with chord support
- **Provider instances** -- Multiple accounts per provider driver with separate auth and config
- **Settings** -- General, appearance, keybindings, providers, source control, connections, and beta feature panels

## d4research Additions

Features layered on top of the T3 Code base:

### Pipelines

A pipeline is a numbered plan you author once and replay on demand. One model orchestrates it, follows your steps verbatim, and delegates individual steps to other models. Two kinds share the same engine — the same server-enforced budgets, the same tracing, the same honesty rules — and differ only in trigger and intent:

| Kind         | Trigger            | Runs                                                    | The orchestrator                                       |
| ------------ | ------------------ | ------------------------------------------------------- | ------------------------------------------------------ |
| **Research** | `!research:<name>` | In its own thread, so a long investigation stays intact | Synthesizes evidence; does not edit files              |
| **Dev**      | `!dev:<name>`      | In place, because the work belongs to the conversation  | Applies the final change itself; delegates only advise |

Both are configured as **named scenarios** — create one per kind of work (`blog`, `audit`, `review`) in **Settings → Research** and **Settings → Dev pipelines**. A bare `!research` or `!dev` runs the scenario selected in Settings. Naming a scenario that does not exist stops the run and lists the ones you have, rather than improvising a pipeline.

Dev pipelines ship with a working default — a plan → build → review + verify chain that picks distinct model families for each role from whatever providers you have ready, so the reviewer is never the author.

**Directives.** Inside a pipeline, `!provider:model` names a delegation target and `!provider:model:file.md` also hands that delegate one of your attached prompt files. The provider matches by name and the model fragment can be partial as long as it is unambiguous (`fable` → `claude-fable-5`). Typing `!` in the pipeline editor completes providers, then their models, then your attached files; live validation shows what each directive resolved to, or exactly why it did not, before you run anything.

**Prompt files.** Attach Markdown role prompts to a scenario and reference them by name. Contents are inlined server-side into the delegated request, so the orchestrator's own context never carries the file bodies — and a file is readable only by the scenario it is attached to, so an `audit` role prompt cannot reach a `blog` run.

**Budgets, enforced by the server rather than requested of the model.** A step may delegate to the same target at most 3 times, and a run has a hard ceiling of 24 delegations. Loops are allowed and provably terminate: when a guard trips, the orchestrator must say which loop was cut and synthesize from what it has. Delegates cannot delegate further.

**Tracing and honesty.** Every message is prefixed `[step N | visit K]`, the banner above the composer shows the step ledger, and delegations appear in the thread as ordinary tool calls with their step and visit numbers. Each run ends with a `RUN STATE` report naming every step's targets, visits used, and outcome. A delegate that timed out, refused, or returned empty is reported as failed — never paraphrased into a result, and never claimed to have run at all.

Research pipelines can orchestrate from Claude, Codex, Cursor, Grok, or OpenCode (the adapters that expose d4research MCP tools). Junie and Agy can be delegation targets inside any pipeline but cannot orchestrate one.

### Same-Thread Provider Handoff

Switch models mid-conversation without losing context or leaving the thread. This is a product invariant, not an implementation detail: a handoff replaces the provider-native session but never creates a second thread, changes the thread ID or route, forks the transcript, or switches branch or worktree.

The client summarizes a bounded transcript and must prove the handoff context reached local Memo **before** anything else changes. Only then does it stop the old session, update the thread's model selection, and start the receiving provider on the same thread. If both memory writes fail, the switch is abandoned with the original provider still selected — the receiving model never starts against a visible history it cannot recover. The receiving turn is explicitly context-synchronization only: acknowledge and wait, do not resume prior work.

**Context compression** — optionally route the transcript through a separate provider (a local Ollama model, say) before handing off. Configure the compression model, input/output character caps, and a custom compression prompt in **Settings → General → Handoff**. The compressed summary goes in the prompt to save tokens while the full transcript goes to Memo to preserve accuracy. Compression never hard-fails a handoff; unavailable local memory does. Research handoffs skip compression by default so evidence crosses verbatim.

### Skills

Portable `SKILL.md` instruction files, inventoried across every root your agents already read — the shared `~/.agents/skills` user root, Claude's and Codex's own locations, Agy's registry, and the current project — deduplicated when roots alias each other through a symlink, with every root that reaches an entry reported.

Select skills at two scopes: **global** in **Settings → Skills** (every turn in every chat) or **chat** from the composer's Skills control (that chat only, surviving reloads and provider handoffs). The two share a 12-skill ceiling, duplicates are charged once, and message bubbles badge which scope applied. Attaching a skill hands the agent a short reference and asks it to read the file — it costs a few lines rather than the whole text, and it never executes anything.

Install a skill from a Git repository and it is shared with compatible coding CLIs automatically. Installing the whole Agy plugin package is a separate opt-in, because a plugin can carry executable hooks and MCP servers on top of the instructions.

### Local Shared Memory

Providers exchange durable findings through a local shared-memory connector. Handoff context, evidence, file paths, commands, and uncertainty survive across provider switches and sessions. The default backend is a built-in SQLite store (FTS5 keyword search) inside the server itself — zero external dependencies. An external Memo REST server can be selected instead via the `memo-rest` backend in settings.

When shared-memory injection is on, each delegate also receives a bounded set of local matches for
its request **verbatim** — no summarization between what one model learned and what the next one
reads. Raw composer-attachment chunks are excluded from that automatic path; agents retrieve those
only through the exact chunk tokens carried by the turn that attached them.

### Managed Tool Guard

Install, enable, disable, and uninstall [Dimaggi Tool Guard Core](https://github.com/dimaggi-ai/tool-guard-core) per environment from Settings. Four permission modes:

| Mode                  | Behavior                                                      |
| --------------------- | ------------------------------------------------------------- |
| **Supervised**        | Ask before commands and file changes (enforcement)            |
| **Auto-accept edits** | Allow routine edits, ask before riskier actions (enforcement) |
| **Auto**              | Allow routine work, escalate risky actions (enforcement)      |
| **Full access**       | Audit-only shadow mode, no blocking                           |

Provider-native permissions remain the default. Tool Guard is opt-in and environment-scoped.

**Policy editor** (new) -- View and edit enforcement rules directly from Settings > General > Agent permissions > Manage Policies. Add, modify, or remove rules with per-rule effect selection (deny/escalate/allow), regex pattern matching, and scope configuration.

### Voice Workflows

Optional local speech-to-text, summarization, and text-to-speech for voice-driven research sessions, plus an in-thread player for generated audio with scrubbing, 15-second skips, and 1×–2× playback rates. Requires local voice services (not included in a generic source checkout).

### System Monitor

Open **System Monitor** from the lower-left navigation to inspect environment health, including
CPU, memory, GPU, disks, services, processes, and Tool Guard status. Usage and context data stay in
the dedicated Usage page and thread context meter. Requires the local `sysmon` service.

### Composer Additions

Beyond the upstream composer, d4research adds pipeline triggers with autocomplete (`!research:`, `!dev:`), the Skills control for per-chat selections, and pasted-context capture: a paste or dropped text file over ~2,000 characters becomes an attachment chip (up to 8) you can review and remove, instead of burying your actual instruction under a wall of log. Small attachments travel directly with the turn; larger ones use the local Memo path below.

Large text attachments do not have to fit inside one provider request. When the composed message approaches the 120,000-character input ceiling, d4research first commits the complete document to the environment's local Memo as independently searchable 16,000-character chunks (up to 2,000,000 characters per document). The turn carries only a compact head/tail preview and exact `memory_search` tokens, so an agent can retrieve the pieces it needs without reloading the whole file into context. A manifest is written last, making successful retries idempotent and incomplete writes non-authoritative.

Memo must confirm the write before the draft can be cleared. Normal sends clear optimistically during dispatch and restore the draft if the server rejects the turn start; queued sends clear after the Memo-backed request enters the local queue. If memory is disabled, unavailable, or times out, the draft remains intact and Send is released for a retry instead of requiring a page reload. Providers with the injected d4research MCP toolkit can fetch chunks during the turn; Agy and externally managed OpenCode currently receive the preview only, while the full local copy remains available after a same-thread handoff to a capable provider.

Memo-backed attachments use durable local storage. With the built-in SQLite backend, **Settings →
Connections → Stored composer documents** lists complete and interrupted writes and can permanently
delete one document's Memo rows. Deletion never rewrites the authoritative chat transcript. The
external Memo REST contract cannot enumerate or delete these rows, so d4research reports that
limitation explicitly and leaves retention management to that service.

---

## Supported Providers

Install and authenticate each CLI before starting sessions. See [provider setup docs](./docs/user/install.md) for details.

| Provider                                  | CLI            | Notes                   |
| ----------------------------------------- | -------------- | ----------------------- |
| [Codex](./docs/user/providers-codex.md)   | `codex`        | OpenAI Codex CLI        |
| [Claude](./docs/user/providers-claude.md) | `claude`       | Anthropic Claude Code   |
| Cursor                                    | `cursor-agent` | Cursor agent mode       |
| Grok                                      | `grok`         | xAI Grok CLI            |
| [Junie](./docs/user/providers-junie.md)   | `junie`        | JetBrains Junie CLI     |
| OpenCode                                  | `opencode`     | OpenCode CLI            |
| Agy                                       | `agy`          | Google Agy (Gemini) CLI |

Multiple instances of the same provider can run with separate auth via Settings > Providers.

## Project Structure

```
apps/
  web/          Web client (React, Vite, TanStack Router)
  desktop/      Electron desktop app (macOS, Windows, Linux)
  mobile/       React Native mobile app (iOS, Android)
  server/       Node.js WebSocket server (Effect-TS)
  marketing/    Marketing site
packages/
  contracts/    Shared types, schemas, and wire protocol
  shared/       Shared utilities (settings, model selection)
  client-runtime/  Client-side state management
  ssh/          SSH connection support
  tailscale/    Tailscale integration
ops/
  tool-guard/   Tool Guard profiles and policy files
scripts/        Build, release, deploy, and QA scripts
docs/           User guides, internals, and runbooks
```

## Documentation

- [Documentation index](./docs/README.md)
- [Research workflows](./docs/user/research-workflows.md)
- [The composer](./docs/user/composer.md) — mentions, skills, pipeline triggers, pasted context
- [Settings](./docs/user/settings.md)
- [Tool Guard lifecycle](./docs/user/tool-guard.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Remote access](./docs/user/remote-access.md)
- [Background service](./docs/user/background-service.md)
- [Architecture overview](./docs/internals/overview.md)
- [d4research scope](./docs/internals/d4research.md)
- [Docker QA stack](./docs/operations/docker-qa.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for policy and [AGENTS.md](./AGENTS.md) for agent instructions.

## Attribution

d4research is a product-research fork of [T3 Code](https://github.com/pingdotgg/t3code) by [Ping](https://ping.gg). The application architecture, event-sourced server, provider adapters, and multi-surface clients are inherited from T3 Code. Compatibility names (`t3`, `T3CODE_HOME`, package identifiers) are retained where changing them would break protocols, storage, or deployment workflows.
