# Research workflows

d2research is a research workspace for evidence-heavy work across models and providers. Its research
mode structures an investigation, while provider handoff preserves one continuous chat when the
active model changes.

## Start deep research

Type `#deep-research` at the very start of your prompt, or click the **telescope icon** in the
composer footer. d2research expands the tag into a research-lead brief that asks the active provider
to plan the investigation, delegate to specialist roles, preserve evidence, challenge weak
conclusions, and synthesize the result.

```
#deep-research Why does the PTY wrapper hang on macOS but not Linux?
```

If you click the telescope button, `#deep-research ` is prepended to whatever is already in the
composer. The tag must appear at the very start of the prompt (after optional whitespace) — placing
it later in the text has no effect.

### How it works

When you send the message, `expandDeepResearchPrompt()` detects the tag, strips it, and injects a
structured brief. The brief:

1. Instructs the provider to act as "research lead for this d2research thread."
2. Lists all ready provider CLIs with their available models so the lead can delegate.
3. Suggests four roles, round-robin assigned to available providers.
4. Caps concurrent delegation at three agents and forbids recursive delegation.
5. Requires status reports after each stage.
6. Instructs agents to store and retrieve findings via `memory_remember` / `memory_search` with
   connector `"local"`.
7. Appends the user's actual research question.

### Roles

The brief suggests four specialist roles:

| Role            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| **Scout**       | Find primary evidence and map the problem                      |
| **Analyst**     | Test competing explanations and inspect implementation details |
| **Challenger**  | Look for missing evidence, regressions, and false confidence   |
| **Synthesizer** | Merge cited findings into the final answer                     |

These are prompt-suggested roles, not guaranteed background jobs. The provider uses whatever
delegation tools it actually has and advertises only providers that are currently ready. Only
enabled, available, and ready provider instances with at least one model appear in the brief.

### Memory integration

When local Memo tools are available, research agents should store durable findings (with sources,
file paths, commands, and uncertainty) via `memory_remember` and retrieve shared context via
`memory_search` before each handoff. The visible thread remains the authoritative record.

## Provider handoff

Choose a different model while a provider session is active. d2research keeps the same thread and
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

- Deep Research structures a provider prompt; it does not create an unbounded autonomous swarm.
- Suggested roles and available providers are not proof that delegated work ran.
- Provider-native authentication and permission behavior still apply.
- Research mode is entirely client-side — there is no server-side orchestration type for research
  threads. They appear as normal threads in the sidebar.
- Tool Guard is separate and opt-in. See [Tool Guard](./tool-guard.md).
- Voice conversation requires the d2 local voice gateway. It is an environment integration, not a
  hosted service bundled with a generic checkout.

## Files

| File                                            | Role                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `apps/web/src/researchMode.ts`                  | Tag detection, prompt expansion, role assignment            |
| `apps/web/src/researchMode.test.ts`             | Tests for tag detection and expansion                       |
| `apps/web/src/providerHandoff.ts`               | Handoff transcript, prompt, memory, compression client      |
| `apps/web/src/components/ChatView.tsx`          | `onProviderHandoff` orchestration, `onStartDeepResearch`    |
| `apps/web/src/components/chat/ChatComposer.tsx` | Telescope button UI                                         |
| `apps/server/src/handoffCompression.ts`         | Server-side compression via provider adapters               |
| `apps/server/src/http.ts`                       | `/api/handoff/compress` and `/api/memory/handoff` endpoints |
