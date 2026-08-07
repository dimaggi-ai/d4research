# Research workflows

d4research is a research workspace for evidence-heavy work across models and providers. Its research
mode structures an investigation, while provider handoff preserves one continuous chat when the
active model changes.

## Configure the pipeline

Research runs **named scenarios** you author in **Settings → Research** — each scenario is a
full pipeline with its own prompt, prompt files, and orchestrator model. Create one per kind of
work (`blog`, `audit`, `paper`, …) and run it with `!research:<name>`. The intended flow: attach
your role prompt files first, then write the pipeline — typing `!` in the editor suggests ready
providers, their models, and your attached files, and the live validation under it shows every
link resolved (or exactly why not) before you run anything.

| Field                  | Purpose                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scenario**           | Which named pipeline the rest of the tab edits; add and delete scenarios here.                                                                                                     |
| **Orchestrator model** | The provider/model that runs the scenario's pipeline. Off uses the thread's current model. A mid-tier model is fine — the pipeline does the thinking; the orchestrator follows it. |
| **Pipeline**           | Numbered steps the orchestrator must follow verbatim. Loops between steps are allowed.                                                                                             |
| **Prompt files**       | Markdown attachments a step can hand to a delegate. View them in a popup, remove them any time.                                                                                    |

Inside the pipeline, reference models with directives:

```
!provider:model              e.g. !claude:fable   or  !codex:terra
!provider:model:file.md      also sends the named prompt file to that model
```

Provider matches by name (`claude`, `codex`, `junie`, …); the model fragment can be partial as long
as it is unambiguous (`fable` → `claude-fable-5`). The settings screen validates every directive
live and shows what it resolved to — or exactly why it did not.

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
scenario selected in Settings. The legacy `#deep-research` trigger still works. Clicking the
**telescope icon** inserts the selected scenario's trigger; if that scenario has a dedicated
orchestrator model, the thread switches to it through the normal handoff flow first.

```
!research:blog Write a post comparing FTS5 and embedding search.
```

Naming a scenario that does not exist stops with the configured scenario list — the orchestrator
never improvises a pipeline.

### How it works

The tag expands into an orchestrator brief that quotes your pipeline **verbatim** and binds it to a
strict execution protocol:

1. **Trace** — the orchestrator keeps one plan entry per step, marks exactly one in progress, and
   prefixes every message with `[step N | visit K]`, so you always know where the pipeline is.
2. **Delegate** — `!provider:model` directives execute only through the `research_delegate` tool,
   which runs one bounded request against that provider and returns its answer. The orchestrator is
   forbidden to claim a delegation ran unless the tool returned.
3. **Loop guard** — the server enforces the budgets, not the model: a step can delegate to the same
   target at most 3 times, and a research run has a hard ceiling of 24 delegations. When a guard
   trips, the orchestrator must say which loop was cut and synthesize from what it has.
4. **Honesty** — failed or timed-out delegates are reported as failed; links, commands, and
   uncertainty survive summarization.

Prompt file contents are inlined **server-side** into the delegated request, so the orchestrator's
own context never carries the file bodies. When shared-memory injection is on, each delegate also
receives the top local-memory matches for its request **verbatim** — no summarization between what
one model learned and what the next one reads. Research handoffs skip context compression by
default for the same reason.

### Tracing

The research banner above the composer shows the step ledger: which step is active, how many are
done, and the full list when expanded. Delegations appear in the thread as ordinary tool calls with
their step and visit numbers, so a cycling pipeline is visible — and provably terminated — rather
than a mystery.

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
2. Summarize/compress   Either:
                        a. Compression enabled → POST /api/handoff/compress
                        b. Compression disabled or failed → summarizeReplyForSpeech()
3. Persist to Memo      POST /api/memory/handoff
                        → stored with tag "t3research-provider-handoff"
                        → when compression is on, the FULL transcript goes to Memo
4. Stop old session     adapter.stopSession()
5. Update model         thread metadata updated to new model selection
6. Start new turn       handoff prompt injected as user message to receiving provider
7. Rollback on failure  model selection reverted if anything fails
```

### What the receiving provider sees

The handoff prompt tells the receiving provider:

- Which thread and source provider it is continuing from
- That the visible transcript is the authoritative conversation history
- That shared context is available via `memory_search` with connector `"local"`
- A compact summary of the conversation so far

### Context compression (optional)

When enabled in **Settings → General → Handoff → Context compression**, the transcript is sent
through a chosen provider to produce a dense summary before handoff. This saves tokens on the
receiving side while preserving full context in Memo.

| Setting                   | Default   | Description                                                     |
| ------------------------- | --------- | --------------------------------------------------------------- |
| **Enabled**               | off       | Master toggle                                                   |
| **Provider instance**     | —         | Which provider runs the compression (e.g. a local Ollama model) |
| **Model**                 | —         | Model within that provider                                      |
| **Max input characters**  | 6 000     | How much transcript to send to the compressor                   |
| **Max output characters** | 2 000     | Max length of the compressed summary                            |
| **Custom prompt**         | _(empty)_ | Override the default compression system prompt                  |

The dual-write pattern: compressed summary goes in the handoff prompt (saves tokens), full
uncompressed transcript goes in Memo (preserves accuracy). See
[handoff-compression.md](../internals/handoff-compression.md) for implementation details.

### Fallback behavior

If compression is disabled, not configured, or returns an error, the handoff falls back to
`summarizeReplyForSpeech()` — the same voice-gateway summarizer used for speech output. The handoff
never hard-fails; it always degrades gracefully.

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
| `apps/web/src/researchPipeline.ts`              | Tag detection, directive parsing, orchestrator brief        |
| `apps/server/src/mcp/toolkits/research/`        | `research_delegate` tool, delegation budgets                |
| `apps/web/src/providerHandoff.ts`               | Handoff transcript, prompt, memory, compression client      |
| `apps/web/src/components/ChatView.tsx`          | `onProviderHandoff` orchestration, `onStartDeepResearch`    |
| `apps/web/src/components/chat/ChatComposer.tsx` | Telescope button UI                                         |
| `apps/server/src/handoffCompression.ts`         | Server-side compression via provider adapters               |
| `apps/server/src/http.ts`                       | `/api/handoff/compress` and `/api/memory/handoff` endpoints |
