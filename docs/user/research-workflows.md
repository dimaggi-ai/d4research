# Research workflows

New to d4research? Run the checked-in [starter research scenario](./starter-research.md) before authoring a custom pipeline.

d4research is a research workspace for evidence-heavy work across models and providers. Its research
mode structures an investigation, while provider handoff preserves one continuous chat when the
active model changes.

## Configure the pipeline

Research runs **named scenarios** you author in **Settings → Research** — each scenario is a
full pipeline with its own prompt and prompt files. Create one per kind of
work (`blog`, `audit`, `paper`, …) and run it with `!research:<name>`. The intended flow: attach
your role prompt files first, then write the pipeline — typing `!` in the editor suggests ready
providers, their models, and your attached files, and the live validation under it shows every
link resolved (or exactly why not) before you run anything.

| Field            | Purpose                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **Scenario**     | Which named pipeline the rest of the tab edits; add and delete scenarios here.                  |
| **Pipeline**     | Numbered steps the orchestrator must follow verbatim. Loops between steps are allowed.          |
| **Prompt files** | Markdown attachments a step can hand to a delegate. View them in a popup, remove them any time. |

Inside the pipeline, reference models with directives:

```
!provider:model              e.g. !claude:fable   or  !codex:terra
!provider:model:file.md      also sends the named prompt file to that model
```

Provider matches by name (`claude`, `codex`, `junie`, …); the model fragment can be partial as long
as it is unambiguous (`fable` → `claude-fable-5`). The settings screen validates every directive
live and shows what it resolved to — or exactly why it did not.

The composer's **Workflows** menu keeps Chat/Plan, named development pipelines, named research
scenarios, and delegation target policy in one place. **Use labeled fallback** permits only a
fallback written into the active pipeline; **Exact targets only** stops the step when its requested
model is unavailable.

Label a fallback on its own pipeline line so the server can verify it:

```
PRIMARY: !claude:opus
FALLBACK directive: !codex:sol
```

Every delegation result records the requested target, the actual target, and whether the fallback
was used. A Codex fallback is therefore reported as Codex; it is never presented as if Opus ran.

A pipeline can fan out and loop:

```
Step 1: Scope the question.
Step 2: Fan out to !claude:fable:depth.md, !codex:terra, and !junie:opus.
Step 3: Summarize all answers.
Step 4: Argue with the summary. If it does not hold, ask one model to regenerate and go back to step 3.
Step 5: Validate and deliver.
```

## Start deep research

Type `!research:<scenario>` at the very start of your prompt — or bare `!research` for the
scenario selected in Settings. You can also select the scenario from the composer's **Workflows**
menu. The provider and model already selected in the composer orchestrate the run.

```
!research:blog Write a post comparing FTS5 and embedding search.
```

Naming a scenario that does not exist stops with the configured scenario list — the orchestrator
never improvises a pipeline.

### How it works

The thread stores and syncs only the compact trigger and task. At the provider boundary, the server
expands that copy into an orchestrator brief that quotes your pipeline **verbatim** and binds it to
a strict execution protocol. Scenario text therefore does not appear in message history, handoffs,
or another client's transcript.

The orchestrator must use a provider adapter that exposes d4research MCP tools: Claude, Codex,
Cursor, Grok, or OpenCode. Junie and Agy can still be delegation targets inside the pipeline, but
cannot orchestrate it themselves.

1. **Trace** — the orchestrator keeps one plan entry per step, marks exactly one in progress, and
   prefixes every message with `[step N | visit K]`, so you always know where the pipeline is.
2. **Delegate** — `!provider:model` directives execute only through the `research_delegate` tool,
   which runs one bounded request against that provider and returns its answer. The orchestrator is
   forbidden to claim a delegation ran unless the tool returned.
3. **Loop guard** — the server enforces the budgets, not the model: a step can delegate to the same
   target at most 3 times, and a research run has a hard ceiling of 24 delegations. When a guard
   trips, the orchestrator must say which loop was cut and synthesize from what it has.
4. **Honesty** — failed or timed-out delegates are reported as failed; links, commands, and
   uncertainty survive summarization. If a labeled fallback runs, the report names both the
   requested and actual model.

Prompt file contents are inlined **server-side** into the delegated request, so the orchestrator's
own context never carries the file bodies. A file is readable only by the scenario it is attached
to: a run of `audit` cannot inline a file you attached to `blog`, and a delegation that names a
prompt file without naming its scenario is refused rather than answered from whichever scenario
happens to hold that name. When shared-memory injection is on, each delegate also
receives the top local-memory matches for its request **verbatim** — no summarization between what
one model learned and what the next one reads. Research handoffs skip context compression by
default for the same reason.

### Tracing

The research banner above the composer shows the step ledger: which step is active, how many are
done, and the full list when expanded. Delegations appear in the thread as ordinary tool calls with
their step and visit numbers, so a cycling pipeline is visible — and provably terminated — rather
than a mystery.

## Inline delegation

A pipeline is not required to ask another model one question. Open a message with
`!provider:model` and that single message is answered by the target you named:

```
!codex:gpt-5.6-sol explain this stack trace
```

It is the same bounded delegation a pipeline step makes, with the same guarantees:

- **Exact target only.** No fallbacks are attempted or invented. An unknown or ambiguous provider or
  model, or one that is not ready, fails the turn with the reason instead of substituting a
  different model.
- **Same budget.** The call draws on the same per-turn delegation ceiling and visit accounting a
  pipeline run uses, so mixing the two cannot double either.
- **Read-only adviser.** The delegate runs with approvals declined; it cannot edit files or run
  commands.
- **No recursion.** A delegate has no delegation tool of its own.
- **Honest attribution.** The answer is labeled with the provider and model that actually ran, and a
  failed or timed-out delegation is reported as failed rather than paraphrased.
- **One per chat.** A second delegation started while one is running is refused, so a running one is
  never silently abandoned.
- **Nothing left running.** If d4research restarts mid-delegation, the turn is closed with a visible
  failure rather than left spinning.

The chat's model selection, provider session, and history are untouched — the next message goes back
to the model the chat was already using. Stopping the chat stops the delegation. A staged provider
switch is not consumed by a delegation; it waits for the next normal message.

## Provider handoff

Choose a different model while a provider session is active. d4research keeps the same thread and
transfers context to the new provider.

### When handoff triggers

A handoff is required when all of these are true:

- A provider session has already started
- The provider instance changed, the model change requires a new thread, or the provider driver
  changed

Switching models within the same provider (when the provider supports in-session model switching)
does not trigger a handoff — it's a simple model swap.

### Lifecycle

```
1. Build transcript     buildProviderHandoffTranscript(messages, maxChars)
                        → tail-truncated plain text of the conversation
2. Prepare context      POST /api/handoff/prepare
                        → optional compression or deterministic truncation
                        → best-effort Memo mirror
3. Fallback mirror      if persistence was not confirmed, attempt
                        POST /api/memory/handoff with the prepared summary
                        (or the structured transcript if preparation failed)
4. Attach context       append <handoff_context> to the user's pending message
5. Update model         thread metadata updated to the target model selection
6. Start receiving turn the user's instruction and context run as one turn on
                        the same thread; no acknowledgement-only turn
7. Rollback on failure  model selection reverted if the session transition fails
```

### What the receiving provider sees

The handoff prompt tells the receiving provider:

- Which thread and source provider it is continuing from
- That the visible transcript is the authoritative conversation history
- That shared context may be available via `memory_search` with connector `"local"`
- Which global and chat skills are active, so the receiving provider keeps them active
- A compact summary of the conversation so far
- That it must act on the user's instruction outside the handoff block and not resume unrelated
  prior work

The merged global and chat skill names are included in the attached handoff block and, when the
local mirror succeeds, in the Memo handoff record.
Chat selections are keyed by the same durable thread id, so a provider switch does not change their
scope. The receiving turn gets the normal per-turn skill references after compression, so
compression cannot silently remove either preference.

### Context compression (optional)

When enabled in **Settings → General → Handoff → Context compression**, the transcript is sent
through a chosen provider to produce a dense summary before handoff. This saves tokens on the
receiving side; Memo receives the prepared summary on either path when one exists, or the structured
transcript if preparation failed.

| Setting                   | Default   | Description                                                     |
| ------------------------- | --------- | --------------------------------------------------------------- |
| **Enabled**               | off       | Master toggle                                                   |
| **Provider instance**     | —         | Which provider runs the compression (e.g. a local Ollama model) |
| **Model**                 | —         | Model within that provider                                      |
| **Max input characters**  | 6 000     | How much transcript to send to the compressor                   |
| **Max output characters** | 2 000     | Max length of the compressed summary                            |
| **Custom prompt**         | _(empty)_ | Override the default compression system prompt                  |

The prepared summary goes in the handoff prompt and is mirrored to Memo when the primary write
succeeds. If that write is not confirmed, the client separately offers the prepared summary (or the
structured transcript if preparation failed) to Memo without replacing a usable prepared summary in
the receiving message. See
[handoff-compression.md](../internals/handoff-compression.md) for implementation details.

### Fallback behavior

If compression is disabled, not configured, or returns an error, the handoff falls back to a
structured transcript. Provider-backed compression has a 30-second total budget, so an exhausted
provider cannot hold the switch open. Compression and Memo persistence are both best-effort: if
neither Memo write succeeds, d4research still attaches the prepared summary when one exists (or the
structured transcript after a preparation failure) and continues the handoff.

## Boundaries

- Deep Research executes the pipeline you wrote; it does not create an unbounded autonomous swarm.
- Delegations are real, bounded, budgeted calls; the orchestrator may not claim one ran unless it did, and delegates cannot delegate further.
- Provider-native authentication and permission behavior still apply.
- Research threads appear as normal threads in the sidebar. The pipeline brief is composed
  client-side; delegation runs through the server's `research_delegate` tool with server-enforced
  budgets.
- Tool Guard is separate and opt-in. See [Tool Guard](./tool-guard.md).
- Voice conversation requires the d2 local voice gateway. It is an environment integration, not a
  hosted service bundled with a generic checkout.

## Files

| File                                            | Role                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `packages/shared/src/researchPipeline.ts`       | Tag detection, directive parsing, orchestrator brief        |
| `apps/server/src/mcp/toolkits/research/`        | `research_delegate` tool, delegation budgets                |
| `apps/web/src/providerHandoff.ts`               | Handoff transcript, prompt, memory, compression client      |
| `apps/web/src/components/ChatView.tsx`          | `onProviderHandoff` orchestration, `onStartDeepResearch`    |
| `apps/web/src/components/chat/ChatComposer.tsx` | Workflows menu and composer integration                     |
| `apps/server/src/handoffCompression.ts`         | Server-side compression via provider adapters               |
| `apps/server/src/http.ts`                       | `/api/handoff/compress` and `/api/memory/handoff` endpoints |
