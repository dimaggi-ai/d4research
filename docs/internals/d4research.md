# d4research architecture and scope

d4research is a product-research fork of T3 Code. It asks a focused question: what must a fast coding-agent control surface add to support durable, multi-provider research without hiding execution or weakening permission boundaries?

## Product thesis

Research work differs from an ordinary agent turn in four ways:

1. It benefits from multiple perspectives but needs bounded orchestration.
2. It may outlive one provider session or require a better model midstream.
3. Its useful state includes evidence and uncertainty, not only chat text.
4. Extra automation needs a visible, reversible safety boundary.

d4research therefore extends the existing thread rather than inventing a second workflow engine. The provider still reasons and acts; the product supplies structured prompts, durable handoff context, readiness information, lifecycle controls, and focused local integrations.

## Research additions

### Pipeline prompt contract

A pipeline trigger is recognized only at the start of a prompt: `!research[:scenario]` for research, `!dev[:scenario]` for dev pipelines. Both resolve a **named scenario** the user authored in Settings — the pipeline text is theirs, not a built-in role contract, so the earlier fixed Scout/Analyst/Challenger/Synthesizer roles no longer exist.

At the provider boundary the server expands the stored trigger into an orchestrator brief that quotes the scenario pipeline verbatim and binds it to an execution protocol: step tracing through the plan tool, delegation only via `research_delegate`, and a closing run report. Delegation targets come from `!provider:model[:file.md]` directives resolved against enabled, ready provider instances. Budgets are enforced server-side rather than requested of the model — `RESEARCH_STEP_VISIT_LIMIT` visits per step-target and `RESEARCH_DELEGATION_BUDGET_PER_TURN` delegations per run — and recursive delegation is prohibited.

Expansion is idempotent: the wrapper it emits itself begins with the trigger, so a resend or handoff round-trip would otherwise re-wrap an already-expanded pipeline.

This is intentionally prompt-level orchestration. It works with a provider's real capabilities and avoids a parallel scheduler that could disagree with the durable T3 turn lifecycle.

Prompt files attached to a scenario are inlined server-side into the delegated request and are scoped to that scenario. A lookup for an unknown scenario resolves to nothing rather than widening across scenarios, and a delegation naming a prompt file without its scenario is refused — scoping is a disclosure boundary, and an optional tool argument is not an access control.

### Same-thread provider handoff

An active chat can move to another model without creating a new thread. This is a permanent product invariant, not an implementation preference: a handoff may replace the provider-native session, but it must never create another d4research thread, change the thread ID or route, fork the visible transcript, branch, or worktree, or present the receiving provider as a separate chat. Any proposed change that does so is a regression.

The client constructs a size-bounded recent transcript and requests a local compact summary with a deterministic excerpt fallback. Before stopping the old provider session or updating its model selection, it must prove that the handoff context was written through the server to the configured local Memo connector. The combined prepare route normally performs that write; the dedicated memory route is the recovery path. If neither local-memory write succeeds, the handoff stops without changing provider or thread. Once persistence succeeds, the client stops the old provider-native session, updates the existing thread's model selection, and starts the receiving provider on that same thread ID. Selection is rolled back if the later session transition fails.

The visible transcript remains authoritative. Memo supplements it with a compact bridge that can be recovered by another provider through `memory_search` using the local connector and project name.

### Tool Guard lifecycle

d4research does not replace provider permission modes. Native provider behavior is the default. Users may install a managed Tool Guard copy into a specific environment, then enable or disable its hooks for that server and uninstall it completely.

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

- The repository is public and normally installed from source. Desktop builds are cut on a maintainer machine and attached to GitHub releases; there is no `d4research` npm package.
- A pipeline executes the scenario the user wrote. It does not guarantee delegation: a pipeline with no `!provider:model` directives runs entirely on the orchestrating model, and a step may resolve in fewer visits than its budget allows.
- Provider handoff requires a working configured local Memo connector. The built-in local SQLite backend satisfies this contract by default; an unavailable or disabled connector prevents the provider switch rather than creating a contextless receiving session.
- Voice and Mission Control require the matching local deployment services.
- Tool Guard is optional and environment-scoped on macOS, Linux, and Windows.
- d4research is not a claim that all inherited T3 user documentation or compatibility identifiers have been renamed.

## Change checklist

When extending the research layer, verify that:

- the user can see, reverse, or recover every lifecycle transition;
- a provider handoff keeps the exact thread ID, route, transcript, branch, and worktree, and cannot start the receiving provider until local Memo persistence succeeds;
- displayed provider readiness matches the server's actual configured state;
- claims distinguish suggested work from completed work;
- local integrations fail clearly and do not become undeclared hosted dependencies;
- Tool Guard remains opt-in and provider-native permissions still work without it;
- user-visible behavior is documented under `docs/user/`, internals here, and deployment procedures under `docs/operations/`.
