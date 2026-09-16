# Muse

d4research runs Meta's Muse Code CLI as a provider through its Muse Session Protocol (`muse serve`).

## Setup

1. Install the Muse Code CLI from Meta and confirm `muse --version` prints a version.
2. Sign in with `muse login` in a terminal. d4research marks the provider as not signed in until the CLI lists models.
3. Open **Settings → Providers → Muse** in d4research and enable the provider. Muse is off by default.
4. If `muse` is on your `PATH`, leave **Binary path** as `muse`. Otherwise, enter the absolute path to the binary.

The CLI provides the model list during the provider health check. Leave **Model** empty to use your account's default. **Reasoning effort** sets the default for new turns; you can change it per model in the picker.

## Permissions

Muse maps d4research's permission modes onto its own approval modes:

- **Full access** lets Muse run tools without asking.
- **Auto** and **Auto-accept edits** let Muse run trusted tools and ask you about the rest.
- **Approval required** asks before every tool call.

The **Approval mode** setting overrides that mapping for all threads on the instance. If Muse refuses an override that exceeds the host's limit, d4research falls back to the host default and shows a warning in the thread.

Muse runs tool calls in its sandbox. **Disable sandbox** and **Sandbox network** pass through to the CLI unchanged. Leave them alone unless a tool fails because of the sandbox.

## Limits

- Muse sessions support streaming chat, cancellation, approvals, agent questions, image attachments, resume, model selection, provider handoff, and plan mode.
- Provider-side rollback is not available: MSP `session/fork` rejects cuts at earlier turns and stalls the host on text-only cuts, so there is no safe rewind yet.
- File edits stream inline diffs into the thread as unified diffs.
- Muse can orchestrate Dev and Research pipelines: each session receives the d4research MCP tools as the per-thread `t3-code` server.
- Commit message and title generation run through a short Muse session whose log is removed afterwards, so they stay out of `muse` session history.
