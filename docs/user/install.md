# Install T3 Code

> [!NOTE]
> This page documents the upstream T3 Code distribution inherited by d4research. It is useful for provider and runtime setup, but `npx t3`, the T3 desktop releases, and package-manager entries install T3 Code, not d4research. To run d4research, clone the repository and follow the [source instructions](../../README.md#run-from-source).

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

```bash
yay -S t3code-bin
```

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                                | Default binary | Log in with             |
| ---------- | ------------------------------------------------------------------ | -------------- | ----------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)               | `codex`        | `codex login`           |
| Claude     | [Claude Code](https://claude.com/product/claude-code)              | `claude`       | `claude auth login`     |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                               | `cursor-agent` | `agent login`           |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                                 | `grok`         | `grok login`            |
| OpenCode   | [OpenCode](https://opencode.ai)                                    | `opencode`     | `opencode auth login`   |
| Junie      | [JetBrains Junie](https://junie.jetbrains.com/docs/junie-cli.html) | `junie`        | Run `junie` and sign in |

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping d4research in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
