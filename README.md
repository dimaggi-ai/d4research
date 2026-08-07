# d4research

A multi-provider coding agent workspace for structured research, built on the [T3 Code](https://github.com/pingdotgg/t3code) foundation. Run coding agents from Codex, Claude, Cursor, Grok, Junie, OpenCode, and Agy side by side, hand off context between them mid-conversation, and layer optional tool-safety policies on top.

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

# Install the Vite+ build tool (one-time)
curl -fsSL https://vite.plus | bash

# Install dependencies and start the dev server
vp i
vp run dev
```

The web UI opens at `http://localhost:3773`. Connect from any browser, including remote devices via [Tailscale or relay](./docs/user/remote-access.md).

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

### Deep Research

Prefix a prompt with `#deep-research` to activate structured multi-agent research. The system constructs a research-lead brief with Scout, Analyst, Challenger, and Synthesizer roles, advertises only currently ready providers, caps delegated work at three concurrent agents, and forbids recursive delegation.

### Same-Thread Provider Handoff

Switch models mid-conversation without losing context. The system summarizes a bounded transcript, stores handoff context in local Memo, stops the previous session, and continues with the new provider in the same thread. Failed handoffs roll back to the prior selection.

**Context compression** (new) -- Optionally route the transcript through a separate provider for summarization before handing off. Configurable in Settings > General > Handoff: choose a compression model, set max input/output characters, and provide a custom compression prompt.

### Local Shared Memory

Providers exchange durable findings through a local [Memo](https://github.com/dimaggi-ai/meko-mcp-server) connector. Handoff context, evidence, file paths, commands, and uncertainty survive across provider switches and sessions.

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

Optional local speech-to-text, summarization, and text-to-speech for voice-driven research sessions. Requires local voice services (not included in a generic source checkout).

### System Monitor

Mission Control panel for environment health. Requires the local `sysmon` service.

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
- [Tool Guard lifecycle](./docs/user/tool-guard.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Remote access](./docs/user/remote-access.md)
- [Background service](./docs/user/background-service.md)
- [Architecture overview](./docs/internals/overview.md)
- [d4research scope](./docs/internals/d4research.md)
- [Docker QA stack](./docs/operations/docker-qa.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for policy and [AGENTS.md](./AGENTS.md) for agent instructions.

## Attribution

d4research is a product-research fork of [T3 Code](https://github.com/pingdotgg/t3code) by [Ping](https://ping.gg). The application architecture, event-sourced server, provider adapters, and multi-surface clients are inherited from T3 Code. Compatibility names (`t3`, `T3CODE_HOME`, package identifiers) are retained where changing them would break protocols, storage, or deployment workflows.
