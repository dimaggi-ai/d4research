# Handoff Context Compression

When a user switches providers mid-conversation (e.g. Claude → Agy, or Codex → a local Ollama model), the handoff system transfers conversation context to the new provider. The transcript is structured — the first user message (the task statement) is kept verbatim, the middle is marked as omitted, and the most recent messages fill the remaining budget — and then compressed into a dense summary before it travels. Compression defaults to a local Ollama model, so a handoff costs no cloud tokens and no provider cold start.

## Non-negotiable thread invariant

A provider handoff stays on the existing d4research thread. Only the provider-native session changes. The implementation must retain the thread ID, route, visible transcript, branch, and worktree; it must not call the create-thread flow or navigate to a newly allocated thread.

Picking a cross-provider model in a started chat **stages** the switch; it starts nothing. The user's next send performs it, and the receiving turn is that send: one turn whose message is the user's own instruction with a `<handoff_context>` block appended. There is no acknowledgement round-trip and no machine-authored turn. The block names the target, the source thread, the configured skills, and the carried summary, and it tells the receiving agent to act on the instruction above it rather than resume unrelated prior work.

The visible thread transcript is the authoritative context bridge between provider-native sessions. Local Memo mirrors the carried summary for later search and recovery, but it is not the transport for the receiving turn. The client first asks `/api/handoff/prepare` to compress and persist the summary, then attempts `/api/memory/handoff` with the structured transcript when that is not proven. If both writes fail, the same structured transcript is still attached directly to the receiving message. This keeps an exhausted source provider or unavailable Memo from trapping the user on the old session without creating a contextless receiving turn.

## Settings

Compression is configured under **Settings → General → Handoff → Context compression** and stored in `ServerSettings.handoff.contextCompression`.

| Field                 | Type                    | Default             | Description                                                    |
| --------------------- | ----------------------- | ------------------- | -------------------------------------------------------------- |
| `enabled`             | boolean                 | `false`             | Master toggle                                                  |
| `backend`             | `"local" \| "provider"` | `"local"`           | Local Ollama daemon vs. a full provider session                |
| `localModel`          | string                  | `gemma4:e4b-it-qat` | Ollama model used when `backend` is `"local"`                  |
| `instanceId`          | `ProviderInstanceId`    | —                   | Provider instance to run the compression (`backend: provider`) |
| `model`               | string                  | —                   | Model within that provider (`backend: provider`)               |
| `maxInputCharacters`  | positive int            | `6 000`             | Max transcript length sent to the compressor                   |
| `maxOutputCharacters` | positive int            | `2 000`             | Max compressed summary length                                  |
| `customPrompt`        | string                  | `""`                | Override the default compression system prompt                 |

With `backend: "local"` only `enabled` and `localModel` matter. With `backend: "provider"`, `instanceId` and `model` must also be set.

## Architecture

```
Model picker (started chat, cross-provider)
  │
  └─ stage the selection in the composer draft — no turn, no session change

ChatView (onSend, staged handoff pending)
  │
  ├─ buildStructuredHandoffTranscript(messages, maxInputCharacters)
  │     → head (first user message, capped) + omission marker + freshest tail
  │
  ├─ POST /api/handoff/prepare  { transcript, project, sourceThreadId, sourceThreadTitle, target }
  │     │
  │     ├─ reads compression settings from ServerSettings
  │     ├─ backend "local"    → compressHandoffContextLocal (Ollama /api/chat,
  │     │                       stream:false, keep_alive 2m, 60 s timeout;
  │     │                       any failure → truncateHandoffTranscript)
  │     ├─ backend "provider" → compressHandoffContext (ephemeral provider
  │     │                       session, 30 s total prepare-route budget)
  │     └─ persists the COMPRESSED summary to local Memo, then returns it
  │
  ├─ Fallback: prepare did not prove persistence → the structured transcript
  │  becomes the summary and the client writes it via
  │  POST /api/memory/handoff; write failure does not block the switch
  │
  └─ Start ONE turn on the same thread, on the target model
        → message = user's instruction + trailing <handoff_context> block
```

One round-trip does both jobs. The browser uploads the transcript once; Memo stores the compressed summary (the local memory service applies its own curation on top), not a duplicate of the raw transcript.

## Server endpoints

**`POST /api/handoff/prepare`** — the primary path.

- **Auth:** `AuthOrchestrationOperateScope`
- **Request:** `{ transcript, project?, sourceThreadId?, sourceThreadTitle?, target? }`
- **Response:** `{ ok: true, compressed: string }` — `compressed` falls back to structured truncation when the compressor fails; the route only errors on an empty transcript or an internal fault.

**`POST /api/handoff/compress`** — retained for compatibility; compresses without persisting. Same auth scope, request `{ transcript }`.

## Compression logic

Both live in `apps/server/src/handoffCompression.ts`:

- `compressHandoffContextLocal` — POSTs Ollama's `/api/chat` with the compression prompt, `stream: false`, `keep_alive: "2m"`, and a `num_ctx` sized to the input budget. Total by design: daemon down, non-200, malformed JSON, empty content, or timeout (60 s) all fall back to `truncateHandoffTranscript` instead of erroring.
- `compressHandoffContext` — resolves the provider adapter by `instanceId`, runs `startSession → sendTurn → readThread → stopSession` on an ephemeral thread; cleanup always runs via `Effect.ensuring`. Its internal operations remain bounded, and the prepare route additionally caps the complete provider attempt at 30 seconds before using deterministic truncation. Errors are wrapped in `HandoffCompressionError`.
- `truncateHandoffTranscript` — head+tail truncation with an omission marker; never exceeds the budget, even when the budget is smaller than the marker.

### Default compression prompt

```
Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
Output only the compressed summary, no preamble.
```

## Client integration

`prepareProviderHandoff` in `apps/web/src/providerHandoff.ts` POSTs the structured transcript to `/api/handoff/prepare` and returns the compressed summary only when the response also proves `memoryPersisted: true`. `prepareDurableProviderHandoff` owns the complete fallback: on network error, non-ok response, malformed JSON, or an unconfirmed write, it attempts to store the structured transcript through `persistProviderHandoffMemoryFallback`. Whether or not that mirror write succeeds, it returns the structured transcript for direct attachment to the receiving message.

`onProviderModelSelect` treats every pick the same way: it writes the selection into the composer draft. `resolveProviderHandoffForSelection` is the single predicate that decides whether a selection would hand off; the composer banner, the released provider lock, and the send path all read it, so they cannot disagree. Releasing `deriveLockedProvider` while a handoff is staged is what lets the composer show and dispatch the target instance in a started chat.

`applyStagedProviderHandoff` is the one place the switch happens. It re-resolves the predicate against the model selection the dispatch is actually about to send, runs `runSameThreadProviderHandoffTransition`, and returns either the combined text or a reason to abort. **Every dispatch path that sends the composer's own model selection must route through it** — today that is `onSend` and `onSubmitPlanFollowUp`. The paths that do not are safe for structural reasons: `onResumeAfterUsageLimit` sends `activeThread.modelSelection` rather than the composer's, and the research divert and `onImplementPlanInNewThread` create a new thread, which has no session to hand off from.

Placement matters. Context preparation completes before `persistThreadSettingsForNextTurn` records the target model and before the composer is cleared. The combined text is re-length-checked after the block is appended, because attached context can push an already-long message past the 120,000-character turn limit. Preparation is bounded but asynchronous, so callers compare the route thread against `routeThreadKeyRef` afterwards and abandon the send if the user navigated away: this component is not remounted per thread, and the rest of a dispatch writes optimistic rows, anchors, and the live composer ref that now belong to a different thread.

**No dispatch may change the provider-native session without attaching context from the authoritative visible thread**, and that is enforced at the dispatch boundary rather than at staging time. `resolveProviderHandoffForSelection` decides whether a handoff is _required_ from the thread and the outgoing selection alone — never from the target's health. Health is a separate verdict: a target that is disabled, unavailable, not `ready`, or has no models resolves as `unavailable`, which hides the banner and keeps the lock, and makes the dispatch **abort with an error** instead of falling through to a plain send. The distinction matters because the provider lock only constrains driver _kind_: a sibling instance of the running driver (`codex_personal` while the session is on `codex`) passes the composer's lock check, so treating an unhealthy target as "no handoff needed" would switch instances without the handoff context block.

**Cancel switch** is disabled while a send is in flight, since the dispatch already captured its target and reverting the picker would only make the UI disagree with the turn on its way.

The wire formats (build + parse) live in `packages/shared/src/providerHandoffPrompt.ts`. `appendProviderHandoffContext` writes the trailing `<handoff_context>` block as the outermost client-authored layer — after every composer context block, and before the server's `<enabled_skills>` block. Its single-line head fields are read by position, so titles, labels, ids, and project names have their whitespace collapsed on the way in; a multi-line thread title would otherwise destroy the block's structure.

`extractTrailingProviderHandoffContext` peels it back off. Only a block whose closing tag ends the message counts. Candidates are then tried from the **last** opener backwards, because the machine block is always appended last — a complete block the user pasted themselves stays in their visible text instead of being swallowed into the real one. Tag-balanced candidates go first: read from the inside, a summary quoting an entire earlier handoff leaves an unmatched closer behind, while the outer body holds that quote's opener and closer as a matched pair, so the outer block wins. A second pass drops the balance requirement so a summary that merely contains a stray closing line still folds. Validation short-circuits on the headline before splitting, tag positions are collected in one sweep, and the candidate count is capped at 20 — a hostile message degrades to rendering the block raw rather than to a stall. CRLF is normalized on the candidate body only; the returned instruction keeps the line endings it was stored with.

Display follows the same order. `extractUserMessageContexts` (web) and `stripUserMessageTransport` (mobile) peel the handoff block right after enabled skills, so the bubble, the copy button, the minimap preview, and every context chip see only the user's instruction. Above the bubble sits a compact “Handed off to …” row; expanding it reveals the carried summary. Threads created before staged handoff hold the legacy full-turn prompt instead: `parseProviderHandoffPrompt` still recognizes those (parsed against the skills-stripped text, since the server appends `<enabled_skills>` to every user turn), and they keep folding the whole bubble away because they contain no user instruction. Keeping build and parse in one module is what makes both folds safe — the renderer can never drift from the text the client actually sends.

## Failure modes

Compression and unavailable local memory do not hard-fail a handoff. Compression is bypassed
when its configured provider is the provider being replaced, so an exhausted quota, failed
authentication, or wedged runtime cannot prevent the user from switching away. The fallback chain is:

1. Compression succeeds → compressed summary in the attached block, same summary in Memo.
2. Compressor fails server-side → structured truncation in the block and in Memo.
3. The prepare round-trip does not prove persistence → structured transcript in the block; the client writes it to Memo via `/api/memory/handoff`.
4. Both Memo paths fail → the structured transcript remains in the attached block and the handoff continues; only the searchable Memo mirror is missing.

A staged target can go unavailable while it waits for the next send. The dispatch is safe on its own — the lock is restored, the composer substitutes the running instance, and the message goes out on the source provider with no unprepared switch — but silence there would let the banner's promise and the send's behavior diverge. So the banner is driven by the **raw draft pick**, not the composer's substituted selection, and an `unavailable` resolution keeps it on screen in a warning state: _“Handoff to … paused — provider unavailable. Messages continue on … until it returns, or cancel the switch.”_ Cancel still works, and the switch resumes by itself once the target reports ready. `applyStagedProviderHandoff` keeps refusing an `unavailable` target as defence in depth, for any future path that reaches dispatch without the substitution.

A user who pastes a structurally valid `<handoff_context>` block at the end of their own message gets it peeled and shown as a “Handed off to …” row, exactly as a pasted `<pasted_context>` block is peeled into an attachment chip. This is accepted rather than defended against: the persisted wire text stays authoritative and the row expands to show what was matched, and every discriminator we considered (a nonce, a signature) would either break historical messages or move trust into text the user can copy anyway.

## Files

| File                                                     | Role                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/contracts/src/settings.ts`                     | `HandoffContextCompressionSettings` schema (+ patch)           |
| `packages/shared/src/providerHandoffPrompt.ts`           | Combined block append/extract, plus the legacy build + parse   |
| `packages/shared/src/userMessageTransport.ts`            | Mobile peel order; surfaces the handoff target                 |
| `apps/server/src/handoffCompression.ts`                  | Local + provider compression, truncation, error type           |
| `apps/server/src/handoffCompression.test.ts`             | Local success/fallback, provider mock, truncation tests        |
| `apps/server/src/http.ts`                                | `/api/handoff/prepare` and `/api/handoff/compress` routes      |
| `apps/server/src/server.ts`                              | Route registration                                             |
| `apps/web/src/providerHandoff.ts`                        | Structured transcript, prepare client, Memo fallback           |
| `apps/web/src/providerHandoff.test.ts`                   | Client-side transcript/prepare tests                           |
| `apps/web/src/lib/userMessageContextComposition.ts`      | Web peel order; keeps the block out of visible and copy text   |
| `apps/web/src/components/ChatView.tsx`                   | Stage on pick, banner, prepare + dispatch inside the send path |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | Detects legacy vs. combined handoff rows                       |
| `apps/mobile/src/features/threads/ThreadFeed.tsx`        | Mobile fold row for both shapes                                |
