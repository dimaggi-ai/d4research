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

### Inline delegation (`!provider:model`)

A prompt whose first token is a bare `!provider:model` directive — with a task after it — is an **inline delegation**: that one turn is answered by the named target instead of the thread's provider. Parse order is load-bearing, because `!research:blog` and `!dev:review` are directive-shaped: `parseDevTrigger`, then `parseResearchTrigger`, then `parseInlineDelegateTrigger`, which additionally refuses `research`, `dev`, and `deep-research` as provider names. A bare trigger with no task is not a delegation.

`parseInlineDelegateTrigger` owns the whole peel — leading whitespace and the client-side `Ultrathink:` effort marker — so composers, timelines, and the server cannot disagree about what parses. `mightBeInlineDelegateTrigger` is its cheap gate for callers that re-derive per render. Nothing else re-implements the peel.

`ProviderCommandReactor` diverts at the same point it detects a pipeline kind, before any expansion. The thread's provider is never consulted: no session is started, no model selection changes, and the persisted user message stays the compact trigger. Resolution reuses `resolveResearchDirective` against the live provider snapshots, then re-checks readiness with `exact` target policy — inline delegation authors no scenario, so `resolveAuthoredPipelineFallbackTargets` legitimately returns nothing and no fallback may be synthesized. An unresolvable directive terminates the turn in a visible error state; nothing stays running.

The divert refuses before opening a turn when a delegation is already running in the thread (one per thread; the registry reserves the slot synchronously, so two concurrent turn-start fibers cannot orphan each other) or when the message carries a `<handoff_context>` block (impossible from a correct client, and the carried context would be labeled for a provider that is not answering).

The **delegate turn** is a normal turn shape assembled from existing commands, not a new lifecycle:

1. `thread.session.set` → `running` with a synthetic `activeTurnId` of `inline-delegate:<messageId>`, which is what makes the projector publish a running `latestTurn` and the clients show their ordinary working indicator. The record keeps the thread's existing `providerName`, or `null` when the thread never had a session — `providerName === null` is the pre-existing "no native session was ever established" marker, and the client's handoff-staging predicate reads it so a delegate-only thread never stages a pointless Memo bridge.
2. A `tool.started` activity carrying the same MCP tool-call payload shape a pipeline's `research_delegate` call emits, so `projectResearchDelegate` derives the compact `data.researchDelegate` ledger unchanged.
3. `runBoundedDelegation` — the execution core shared with the MCP handler — charges the budget under run id `<threadId>:<turnId>` and synthetic step `inline`, then starts an **adapter-local** delegate session. That locality is the structural non-recursion guarantee, inherited as-is: no MCP credential is minted for the delegate, so it has no delegation tool. The turn's attachments ride along on `sendTurn`, exactly as a normal turn delivers them.
4. On success, a `tool.completed` activity with the ledger, then `thread.message.assistant.delta` + `thread.message.assistant.complete` on the synthetic turn — the same commands adapters author assistant output with. Attribution lives in the ledger and the clients' badge; no machine text is prepended to the answer body.
5. `thread.session.set` → `ready` when the thread had a session, `stopped` when it did not (or `error` with the typed `failureKind`, or `stopped` on interrupt), which settles the turn.
6. A placeholder `thread.turn.diff.complete` records the turn boundary. The delegate changes no files, so this is not about the diff: revert retention keeps only turns carrying a checkpoint, and an assistant message is never rescued by the user-message fallback — a delegate turn without one loses its answer to any later revert. `CheckpointReactor` replaces the placeholder with a real git ref, exactly as it does for provider-reported diffs.

Every settle dispatch is retried on transient engine failure, and a force-settle fallback clears the turn even when the richer rows cannot be written. Nothing may stay "running": restart reconciliation recognizes an `inline-delegate:*` `activeTurnId` and settles it as an interrupted delegation with a failed ledger row, instead of reporting a provider session that never existed.

Cancellation interrupts the delegation fiber; the delegation's own `ensuring` cleanup stops the delegate session, and the fiber's `onExit` finalizer settles the turn. `providerService.interruptTurn` is deliberately not called — there is no thread session to interrupt.

On the client, a send whose prompt parses as a delegation skips `applyStagedProviderHandoff` entirely and omits `modelSelection` from both `thread.turn.start` and the settings persist: a delegation must not consume a staged handoff, and it must not change the thread's model for an answer it did not write. The staged pick survives for the next normal send, and the banner says so.

The budget `Ref` is provided once at the server runtime layer and merged, so the MCP `research_delegate` tool and the reactor share one accounting map. Mixing the two entry points cannot double a thread's ceiling.

Prompt-file resolution is deferred behind the charge (`resolvePromptFile`), not moved in front of it: "every `research_delegate` call burns budget" is the loop guard that stops a model retrying an invalid prompt-file argument for free.

### Same-thread provider handoff

An active chat can move to another model without creating a new thread. This is a permanent product invariant, not an implementation preference: a handoff may replace the provider-native session, but it must never create another d4research thread, change the thread ID or route, fork the visible transcript, branch, or worktree, or present the receiving provider as a separate chat. Any proposed change that does so is a regression.

The client constructs a size-bounded recent transcript and requests a local compact summary with a deterministic excerpt fallback. The combined prepare route normally writes that context to the configured local Memo connector; the dedicated memory route is the recovery path. If neither local-memory write succeeds, the client attaches the structured visible-thread transcript directly and continues instead of trapping the user on an exhausted provider. The client then updates the existing thread's model selection and starts the receiving provider on that same thread ID. Selection is rolled back if the later session transition fails.

The visible transcript remains authoritative. Memo supplements it with a compact bridge that can be recovered by another provider through `memory_search` using the local connector and project name.

### Memo-backed composer documents

Oversized pasted text and dropped text files use the same local Memo connector without placing the
whole document in one memory row. Before dispatch, the web client calls the authenticated
operate-scope route `POST /api/memory/attachment`. The server accepts at most 2,000,000 characters
per document, splits the source into 16,000-character rows, and stores every row under the active
project with deterministic alphanumeric document and chunk tokens. It writes a separate manifest
last. A retry searches for that exact manifest token and skips duplicate writes only after the
complete document has been committed; a partial write has no manifest and is retried.

The provider-bound message contains a compact head/tail preview, the project, chunk count, and the
exact `memory_search` query sequence (`<document-token>chunk0001`, then increment). The client
waits for Memo before clearing or queuing the draft. Missing authorization, disabled memory,
unreachable storage, a malformed response, or the 60-second browser timeout aborts preparation and
releases the send latch, leaving the draft available to retry. Text held beyond the persisted draft
preview is memory-only until this write succeeds; after a reload the client refuses to claim that a
truncated preview is complete and asks the user to reattach it.

Retrieval depends on the provider adapter exposing d4research's MCP toolkit. Codex, Claude, Cursor,
Grok/Junie, and server-managed OpenCode sessions receive it. Agy and externally managed OpenCode
currently receive the compact preview but cannot fetch the Memo chunks during that turn. The full
copy remains local and becomes retrievable after a capable same-thread handoff.

Attachment rows use the source label
`d4research-composer-attachment:<validated-document-token>`. The authenticated operate-scope list
and delete routes expose the reverse lifecycle only when the connector structurally supports it.
The built-in store groups rows by that source and deletes with an exact equality predicate; the
route accepts only a document token and derives the source server-side, so handoff and ordinary
memory rows are unreachable. Delete is atomic and idempotent, and the existing SQLite FTS delete
trigger removes the searchable shadow. Interrupted writes remain listable even without a manifest.

The external Memo REST contract exposes only add, search, stats, and health. Its list response is
therefore explicitly `supported: false`, and delete returns 501 rather than probing an undocumented
operation. There are no tombstones or automatic TTL: the built-in store has no replication consumer
for a tombstone, and silent expiry would make older transcript tokens fail without a user action.
The transcript is never rewritten when storage is deleted.

Research delegation searches the same project-scoped memory pool, but automatic shared context
filters composer-attachment rows by source label and record signature before joining results. The
remaining verbatim context is capped at 24,000 characters with an explicit truncation marker. Raw
documents are retrieved only through the exact chunk-token instructions in the turn that attached
them.

### Tool Guard lifecycle

d4research does not replace provider permission modes. Native provider behavior is the default. Users may install a managed Tool Guard copy into a specific environment, then enable or disable its hooks for that server and uninstall it completely.

The managed installation copies versioned binaries, platform-native wrappers, and profiles into the environment rather than depending on a developer checkout. Hooks are gated by the d2 server runtime and remain inert outside an enabled environment. The lifecycle is exposed in Settings, and a dedicated **Settings → Tool Guard** page shows the active policy — read-only from the bundled profile before installation, editable once managed. Both are covered by focused server and web tests on macOS, Linux, and Windows paths. See [tool-guard.md](./tool-guard.md).

### Readiness and usage visibility

Provider snapshots carry optional account usage data (`ServerProviderUsage`): plan type and rolling
rate-limit windows with utilization and reset times. Context and cost history are presented through
the thread context meter and lower-left Usage page. The lower-left System Monitor is intentionally
limited to environment health and Tool Guard status.

### Local environment integrations

The voice conversation flow calls local transcription, summarization, and speech endpoints. The system panel calls the d2 Mission Control monitor. The Docker QA stack supplies isolated substitutes for these dependencies. They are deployment integrations, not assumptions embedded in the core event-sourced server.

## Inherited foundation

The fork retains T3 Code's Node WebSocket server, typed contracts, provider adapters, event-sourced commands/events/projectors, receipt-driven side effects, checkpoints, and web/desktop/mobile clients. It also retains compatibility-facing names such as the `t3` CLI and `T3CODE_HOME` where renaming would break users or protocols.

Follow-up messages are environment state, not client state. A turn start received while a session
is running is persisted in the server's queued-message projection and acknowledged to the sending
client. Web, desktop, and mobile render that shared projection; the server drains it after the
active turn ends, so delivery does not depend on a browser tab or mobile React tree remaining
active. Client storage is only a pre-acknowledgement retry buffer for disconnected sends.

Research changes must continue to account for:

- web, desktop, and mobile surfaces where the feature is applicable;
- local, remote, relay, and tunnel connections;
- Codex, Claude, Cursor, Grok, OpenCode, Junie, and other configured adapters;
- reversible UI states and typed wire contracts;
- performance on long threads and remote connections.

## Current boundaries

- Version 0.2.0 publishes the fork-owned `d4research` npm CLI and CI-built desktop artifacts for
  macOS, Windows, and Linux. There is no d4research-branded mobile-store release; mobile connects to
  a compatible d4research server.
- A pipeline executes the scenario the user wrote. It does not guarantee delegation: a pipeline with no `!provider:model` directives runs entirely on the orchestrating model, and a step may resolve in fewer visits than its budget allows.
- Provider handoff mirrors context to the configured local Memo connector when available. An unavailable or disabled connector does not prevent the switch because the receiving message carries the structured visible-thread transcript directly.
- Memo-backed composer documents require the same connector. Providers without the injected d4research MCP toolkit receive only the bounded preview during their turn.
- Voice and Mission Control require the matching local deployment services.
- Tool Guard is optional and environment-scoped on macOS, Linux, and Windows.
- d4research is not a claim that all inherited T3 user documentation or compatibility identifiers have been renamed.

## Change checklist

When extending the research layer, verify that:

- the user can see, reverse, or recover every lifecycle transition;
- a provider handoff keeps the exact thread ID, route, transcript, branch, and worktree, and cannot start the receiving provider without an attached visible-thread context block;
- displayed provider readiness matches the server's actual configured state;
- claims distinguish suggested work from completed work;
- local integrations fail clearly and do not become undeclared hosted dependencies;
- Tool Guard remains opt-in and provider-native permissions still work without it;
- user-visible behavior is documented under `docs/user/`, internals here, and deployment procedures under `docs/operations/`.
