# Install and First Run

d4research `v0.2.0` is distributed as the fork-owned `d4research` npm CLI and as desktop installers
on the [d4research GitHub Releases](https://github.com/dimaggi-ai/d4research/releases) page. The
upstream `npx t3` command and T3 Code store apps install T3 Code, not d4research.

## Install the server CLI

Run without a permanent global installation:

```bash
npx d4research@0.2.0
```

Or install the exact release globally:

```bash
npm install --global d4research@0.2.0
d4research
```

The server prints a one-time pairing URL. Open the complete URL, including its token. Provider CLIs,
projects, credentials, and local Memo data stay on the server machine.

## Install the desktop client

Download the artifact for macOS, Windows, or Linux from the GitHub Release. Version 0.2.0 installers
are unsigned early-access artifacts. Use `SHA256SUMS` on the release page to verify a manual
download.

## Build from source

## Requirements

- Git access to `dimaggi-ai/d4research`
- Node.js `^22.16 || ^23.11 || >=24.10`
- At least one supported provider CLI installed and authenticated on the server machine

### Start from a checkout

```bash
git clone git@github.com:dimaggi-ai/d4research.git
cd d4research
./scripts/setup.sh
vp run dev
```

The setup script verifies Node, installs Vite+ and dependencies, and reports the provider CLIs it
can find. It is safe to run again. Use `./scripts/setup.sh --check` for a read-only diagnosis.

The development runner prints its actual ports and a one-time pairing URL, for example:

```text
pairingUrl: http://localhost:5733/pair#token=XXXXXXXXXXXX
```

Open the complete URL, including the token. The bare origin cannot pair the browser. Port `5733`
is only the usual development default and shifts when occupied.

## Five-Minute Readiness Check

1. Open **Settings → Providers**. Choose an enabled provider whose status says it can start and
   whose model list contains the model you intend to use. Follow the remediation shown beside a
   provider that is installed but not authenticated, reachable, or model-ready.
2. Add the cloned d4research directory as a project and open a new thread.
3. Open **Settings → Connections**. Keep the built-in local shared-memory backend enabled for
   provider handoffs and large-document storage.
4. Open the composer's **Workflows** menu. It contains Chat/Plan, named Dev pipelines, named
   Research scenarios, and the shared target policy.
5. Run the [starter research scenario](./starter-research.md), then export the result from the
   thread header on web or desktop.

## Provider Commands

Provider CLIs run on the machine hosting the d4research server. A browser or phone connected to
that server does not supply provider credentials.

| Provider   | Default binary | Typical authentication command |
| ---------- | -------------- | ------------------------------ |
| Codex      | `codex`        | `codex login`                  |
| Claude     | `claude`       | `claude auth login`            |
| Cursor     | `cursor-agent` | `agent login`                  |
| Grok Build | `grok`         | `grok login`                   |
| OpenCode   | `opencode`     | `opencode auth login`          |
| Junie      | `junie`        | Run `junie` and sign in        |
| Agy        | `agy`          | Follow the CLI's login flow    |

If a CLI is outside the server process's `PATH`, set its absolute **Binary path** on the provider
instance in Settings. A binary being present is not enough: d4research separately reports
authentication, reachability, and model readiness before allowing a turn to start.

## Target Selection Is Literal

The Workflows policy never guesses that another model is equivalent to the target authored in a
pipeline:

- **Exact targets only** stops the step if the requested target is unavailable.
- **Use labeled fallback** may use only a `FALLBACK directive: !provider:model` written into that
  scenario.

The run records both requested and resolved targets. If an authored Codex fallback runs because
Opus is unavailable, the result says Codex ran; it never claims Opus ran.

## Local Data

The built-in Memo database lives at `memory.sqlite` inside the environment's d4research state
directory. Normal source development uses the repository-local `.t3/dev` state unless an explicit
home directory is provided; a production server uses the `userdata` directory under its configured
T3 home. Choosing the external `memo-rest` backend sends Memo records to the configured REST
service instead of the built-in database.

See [Troubleshooting](./troubleshooting.md) before deleting or replacing local state.

## Updating a Source Checkout

Stop or finish active agent work, then:

```bash
git pull --ff-only
vp i
vp run dev
```

Maintainers of an existing local systemd/Caddy deployment use `scripts/deploy-local.sh`; it is a
deployment updater, not a clean-machine installer.

## What Is Supported Today

- Web through the released CLI or source runner is the primary first-run path.
- GitHub Releases provide desktop artifacts for macOS, Windows, and Linux. Signing is optional and
  the release notes identify whether a particular artifact was signed.
- Mobile can connect to a compatible d4research server, but a d4research-branded store build is not
  part of the current source distribution.
- Remote browsers connect to the server environment; provider CLIs, projects, Memo, and credentials
  remain on that server.

Continue with [Product Concepts](./concepts.md), [Research Workflows](./research-workflows.md), and
[Remote Access](./remote-access.md).
