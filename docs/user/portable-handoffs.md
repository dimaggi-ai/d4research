# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

By default, short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. The default mode transfers a budgeted selection.

## Choose a handoff mode

In **Settings → Handoff → Automatic handoff**, choose how provider switches transfer context:

- **Bounded history** keeps the default selection described above.
- **Direct (no compaction)** transfers the covered historical text intact. If it exceeds the
  transfer allowance, the handoff fails instead of shortening it. Provider reasoning, native
  tool state, and attachments still do not transfer.
- **Smart compaction** uses local models to judge context against your current request. It keeps
  essential messages verbatim where space allows, summarizes useful background, and drops filler.
  Your visible thread stays unchanged, and retrieval references remain available.

Smart mode uses Bonsai by default. You can configure a separate local judge model and an
OpenAI-compatible endpoint, plus an optional second local judge. Set both the second model and
endpoint to enable it; when the judges disagree, the higher importance score wins. These endpoints
run on the server's machine, including when you connect from a phone or tablet.

If judging fails, smart mode tries a local summary. If summarization also fails, it falls back to
bounded text with an omission marker. Model output can miss details; repeat critical constraints
in your current request. Short histories that fit the output limit need no model call.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. If even its retrieval references cannot fit, T3 Code reports an error
instead of shortening your request. Compact the target conversation or select a larger-context
model before trying again.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). Direct mode bypasses this initial allowance while retaining the transfer ceiling and model
capacity checks. The allowance is not a provider context-window guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options keeps reported usage for the same
native conversation, while refreshing model-specific limits and discarding stale compaction thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves at
least 16,000 tokens, or a quarter of the window when larger, for instructions, tools, and subsequent
work. Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references. Existing context is estimated from saved
activity when usage telemetry is unavailable. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
