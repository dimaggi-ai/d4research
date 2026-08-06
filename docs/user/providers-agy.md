# Agy (Google Gemini CLI)

Agy is a provider that wraps the [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) (`agy` binary). It gives d4research access to Gemini models through the same interface used for Claude and Codex.

> **Early Access** — Agy is marked as early access. Some rough edges are expected.

## Setup

### 1. Install the Agy CLI

Follow the [Gemini CLI install instructions](https://github.com/google-gemini/gemini-cli#installation). After install, verify:

```bash
agy --version
agy models
```

If `agy models` hangs on Linux, that's expected — d4research handles this with a PTY wrapper (see [Quirks](#quirks) below). As long as the binary is on your PATH, the provider will work.

### 2. Enable in d4research

In **Settings → Providers**, the Agy provider should appear automatically. If it detects the `agy` binary on your PATH, it will show as ready with the list of available Gemini models.

## Settings

| Setting           | Default                   | Description                                                     |
| ----------------- | ------------------------- | --------------------------------------------------------------- |
| **Binary path**   | `agy`                     | Path to the Agy CLI binary. Leave empty to use `agy` from PATH. |
| **Default model** | `gemini-3.6-flash-medium` | Model used when a thread doesn't select one explicitly.         |
| **Launch args**   | _(empty)_                 | Additional arguments passed to every Agy session.               |

You can also set per-instance environment variables in the provider settings, same as Claude and Codex.

## How it works

### Model discovery

d4research runs `agy models` to discover available Gemini models. On Linux, this command requires a pseudo-terminal (it hangs on plain pipes), so the provider wraps it in `script -q -e -c <command> /dev/null` to provide a PTY. The output contains animated spinner frames and ANSI escapes, which are stripped during parsing.

Cold starts can take up to 20 seconds while Agy initializes its connector state. d4research uses a generous timeout to accommodate this.

### Sessions

Each turn spawns a fresh `agy --print <text>` process rather than maintaining a persistent REPL. Conversation continuity is handled by passing `--conversation <id>` on subsequent turns, using an ID returned in Agy's stream-JSON output.

Sessions run in sandbox mode by default. Full-access mode uses `--dangerously-skip-permissions`. You can toggle the interaction mode in the chat toolbar.

### Text generation

For structured output (commit messages, PR content, branch names), Agy uses `--output-format json` with `--json-schema` instead of the streaming format.

## Multiple accounts

Unlike Claude and Codex, Agy authentication is managed entirely by the `agy` CLI itself (Google account login). d4research does not manage Agy credentials directly — it reports auth status based on whether `agy models` succeeds.

To use multiple Google accounts, create separate Agy provider instances in **Settings → Providers** with different binary paths or environment variables pointing to different Agy configurations.

## Quirks

- **PTY wrapping (Linux only):** `agy models` requires a pseudo-terminal on Linux. d4research handles this automatically via `script(1)`.
- **Cold start:** First model discovery after a reboot can take up to 20 seconds.
- **One turn at a time:** Overlapping turns on the same thread are not supported.
- **Model changes require new threads:** Switching models within an Agy conversation requires starting a new thread.
- **Spinner output:** The `agy models` output contains animated spinner frames that d4research parses out automatically.

## Handoff

Agy works with the [handoff compression](../internals/handoff-compression.md) system. You can use a local Ollama model (via the Claude provider's Ollama integration) to compress context when handing off to or from Agy, saving tokens on Gemini's context window.

## Files

| File                                                  | Role                                          |
| ----------------------------------------------------- | --------------------------------------------- |
| `apps/server/src/provider/Layers/AgyProvider.ts`      | Binary discovery, model listing, health check |
| `apps/server/src/provider/Layers/AgyAdapter.ts`       | Session management, turn execution, streaming |
| `apps/server/src/textGeneration/AgyTextGeneration.ts` | Structured text generation                    |
