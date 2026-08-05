# Tool Guard

d2research uses each coding provider's native permissions by default. The access selector beside the
composer controls whether the provider asks for approval, accepts routine edits, operates
automatically, or uses full access.

Tool Guard is an optional environment-local integration for macOS, Linux, and Windows. It adds a shared policy
layer and audit log on the machine running the d2research environment. Installing it on one
environment does not change other local or remote environments.

## Install Core

[Tool Guard Core](https://github.com/dimaggi-ai/tool-guard-core) is maintained in the Dimaggi
organization. Install it on the machine running the d2research environment, not on a phone or remote
browser used to control that environment.

The quickest route is to download the archive for macOS, Linux, or Windows from [Tool Guard Core
releases](https://github.com/dimaggi-ai/tool-guard-core/releases), extract it, and make `tg` (`tg.exe`
on Windows) available on `PATH`. Alternatively, build Core from source with Go and Make:

```bash
git clone https://github.com/dimaggi-ai/tool-guard-core.git
cd tool-guard-core
make build
```

The source build writes the executable under `bin/`. If it is not on `PATH`, set
`T3RESEARCH_TOOL_GUARD_BIN` to its absolute path before starting d2research.

## Manage the d2research integration

1. Open **Settings → General → Agent permissions**.
2. Under **d2research Tool Guard**, select **Install**.

After installation, the same settings section provides **Enable**, **Disable**, and **Uninstall**.
Disabling or uninstalling Tool Guard returns the environment to native provider permissions. If an
external Tool Guard hook already exists, d2research reports it as externally managed and does not
replace it.

The d2research installation copies the detected Core executable, provider wrappers, and policy profiles
into the environment's d2research data directory. Provider configuration files retain unrelated
hooks when the managed integration is disabled or removed.

On Windows, d2research detects `tg.exe`, installs PowerShell hook adapters, and invokes them with a
non-interactive execution-policy bypass. On macOS and Linux it installs the corresponding shell
adapters.
