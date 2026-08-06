# d2research architecture and scope

d2research is a private product-research fork of T3 Code. It asks a focused question: what must a fast coding-agent control surface add to support durable, multi-provider research without hiding execution or weakening permission boundaries?

## Product thesis

Research work differs from an ordinary agent turn in four ways:

1. It benefits from multiple perspectives but needs bounded orchestration.
2. It may outlive one provider session or require a better model midstream.
3. Its useful state includes evidence and uncertainty, not only chat text.
4. Extra automation needs a visible, reversible safety boundary.

d2research therefore extends the existing thread rather than inventing a second workflow engine. The provider still reasons and acts; the product supplies structured prompts, durable handoff context, readiness information, lifecycle controls, and focused local integrations.

## Research additions

### Deep Research prompt contract

The web client recognizes `#deep-research` only at the start of a prompt. It adds a research-lead contract with optional Scout, Analyst, Challenger, and Synthesizer roles. Provider availability is derived from enabled, ready provider instances. The contract limits delegated concurrency to three and prohibits recursive delegation.

This is intentionally prompt-level orchestration. It works with a provider's real capabilities and avoids a parallel scheduler that could disagree with the durable T3 turn lifecycle.

### Same-thread provider handoff

An active chat can move to another model without creating a new thread. The client constructs a size-bounded recent transcript, requests a local compact summary with a deterministic excerpt fallback, writes handoff context through the server to local Memo, stops the old session, updates the model selection, and starts the receiving provider. Selection is rolled back on failure.

The visible transcript remains authoritative. Memo supplements it with a compact bridge that can be recovered by another provider through `memory_search` using the local connector and project name.

### Tool Guard lifecycle

d2research does not replace provider permission modes. Native provider behavior is the default. Users may install a managed Tool Guard copy into a specific environment, then enable or disable its hooks for that server and uninstall it completely.

The managed installation copies versioned binaries, platform-native wrappers, and profiles into the environment rather than depending on a developer checkout. Hooks are gated by the d2 server runtime and remain inert outside an enabled environment. The lifecycle is exposed in Settings, and a dedicated **Settings → Tool Guard** page shows the active policy — read-only from the bundled profile before installation, editable once managed. Both are covered by focused server and web tests on macOS, Linux, and Windows paths. See [tool-guard.md](./tool-guard.md).

### Readiness and usage visibility

Provider snapshots carry optional account usage data (`ServerProviderUsage`): plan type and rolling
rate-limit windows with utilization and reset times, probed from the Claude Agent SDK and the Codex
app-server. The System panel shows them beside token usage and the context-window meter, so a
handoff target can be chosen with limits in view.

### Local environment integrations

The voice conversation flow calls local transcription, summarization, and speech endpoints. The system panel calls the d2 Mission Control monitor. The Docker QA stack supplies isolated substitutes for these dependencies. They are deployment integrations, not assumptions embedded in the core event-sourced server.

## Inherited foundation

The fork retains T3 Code's Node WebSocket server, typed contracts, provider adapters, event-sourced commands/events/projectors, receipt-driven side effects, checkpoints, and web/desktop/mobile clients. It also retains compatibility-facing names such as the `t3` CLI and `T3CODE_HOME` where renaming would break users or protocols.

Research changes must continue to account for:

- web, desktop, and mobile surfaces where the feature is applicable;
- local, remote, relay, and tunnel connections;
- Codex, Claude, Cursor, Grok, OpenCode, Junie, and other configured adapters;
- reversible UI states and typed wire contracts;
- performance on long threads and remote connections.

## Current boundaries

- The repository is private and installed from source; it has no public `d2research` npm package or desktop release channel.
- Deep Research does not guarantee delegation and may use fewer roles when that is sufficient.
- Memo-backed handoff depends on a configured local Memo service.
- Voice and Mission Control require the matching local deployment services.
- Tool Guard is optional and environment-scoped on macOS, Linux, and Windows.
- d2research is not a claim that all inherited T3 user documentation or compatibility identifiers have been renamed.

## Change checklist

When extending the research layer, verify that:

- the user can see, reverse, or recover every lifecycle transition;
- a provider handoff cannot silently lose the current selection or thread;
- displayed provider readiness matches the server's actual configured state;
- claims distinguish suggested work from completed work;
- local integrations fail clearly and do not become undeclared hosted dependencies;
- Tool Guard remains opt-in and provider-native permissions still work without it;
- user-visible behavior is documented under `docs/user/`, internals here, and deployment procedures under `docs/operations/`.
