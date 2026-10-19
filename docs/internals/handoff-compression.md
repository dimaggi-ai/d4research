# Handoff Context Compression

Automatic web and desktop handoffs attach a bounded transcript directly to the user's next message. There is no pre-send compression or Memo request. Context is capped at 60,000 characters and reduced further when necessary to fit the 120,000-character message limit. The original task (capped on long threads) and recent messages are retained; omitted history is marked.

## Non-negotiable thread invariant

A provider handoff stays on the existing d4research thread. Only the provider-native session changes. The implementation must retain the thread ID, route, visible transcript, branch, and worktree; it must not call the create-thread flow or navigate to a newly allocated thread.

Picking a cross-provider model in a started chat **stages** the switch; it starts nothing. The user's next send performs it, and the receiving turn is that send: one turn whose message is the user's own instruction with a `<handoff_context>` block appended. There is no acknowledgement round-trip and no machine-authored turn. The block names the target, the source thread, the configured skills, and the carried summary, and it tells the receiving agent to act on the instruction above it rather than resume unrelated prior work.

The saved message is the context bridge between provider-native sessions. One turn-start command carries the target model, user instruction, and context on the original thread. Once accepted by the server, the turn continues independently of client navigation. A connection failure before acceptance is not a completed handoff.

## Settings

The retained preparation/compression endpoints use `ServerSettings.handoff.contextCompression`, exposed under **Settings → General → Handoff → Context compression**. These settings do not delay or summarize automatic web/desktop handoffs.

| Field                 | Type                    | Default              | Description                                                                   |
| --------------------- | ----------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `enabled`             | boolean                 | `false`              | Master toggle                                                                 |
| `backend`             | `"local" \| "provider"` | `"local"`            | Resident local model stack vs. a full provider session                        |
| `localModel`          | string                  | `bonsai2-27b:latest` | Model name sent to the local judge and summarizer when `backend` is `"local"` |
| `instanceId`          | `ProviderInstanceId`    | —                    | Provider instance to run the compression (`backend: provider`)                |
| `model`               | string                  | —                    | Model within that provider (`backend: provider`)                              |
| `maxInputCharacters`  | positive int            | `24 000`             | Max transcript length sent to the compressor                                  |
| `maxOutputCharacters` | positive int            | `3 000`              | Max compressed context length                                                 |
| `customPrompt`        | string                  | `""`                 | Override the default summary system prompt (the judge question is fixed)      |

With `backend: "local"` only `enabled` and `localModel` matter. With `backend: "provider"`, `instanceId` and `model` must also be set.

## Architecture

Model selection stages the target. On Send, `buildImmediateProviderHandoffMessage` builds the attached context synchronously, then the normal send path persists one turn on the existing thread. The timeline folds the attached block into “Handed off to …”. Plan follow-ups use the same builder.

No route-owned preparation promise sits between selecting a provider and submitting the message. If an earlier attachment operation finishes after navigation, the captured send uses its original thread. Send failures restore only that thread's empty draft and do not overwrite the visible composer's refs.

## Server endpoints

**`POST /api/handoff/prepare`** — retained for explicit preparation and older clients, not called by automatic web/desktop sends.

- **Auth:** `AuthOrchestrationOperateScope`
- **Request:** `{ transcript, project?, sourceThreadId?, sourceThreadTitle?, target?, bypassCompression? }`
- **Response:** `{ ok: true, compressed: string, memoryPersisted: boolean }` — `compressed` falls back to structured truncation when the compressor fails; `memoryPersisted` reports the optional Memo mirror independently.

**`POST /api/handoff/compress`** — retained for compatibility; compresses without persisting. Same auth scope, request `{ transcript }`.

## Compression logic

Both live in `apps/server/src/handoffCompression.ts`:

- `compressHandoffContextLocal` — judgment-driven compaction on the resident bonsai2 stack. A transcript that already fits `maxOutputCharacters` is returned verbatim. Otherwise it is split into message units (`USER:` / `ASSISTANT:` sections, the `USER (original task):` header, the client's omission marker), each unit is scored by the local judge, and `planHandoffCompaction` decides what travels: the original task and the newest message are pinned; units judged as filler (score below 0.5) are dropped; the rest are ranked by score with a small recency tie-breaker and kept verbatim until 70 % of the budget is used; whatever is left over is summarized by one `/api/chat` call into the remaining budget under a `[... N earlier messages compressed into the summary below ...]` notice. The summary call is skipped when nothing was omitted. Degradation is total by design: judge unavailable or off-menu → one whole-transcript summary (the previous behaviour); summary unavailable, non-200, empty, or timed out (60 s) → `truncateHandoffTranscript`. Fewer than three judgeable messages skip the judge, since there is nothing to rank.
- `compressHandoffContext` — resolves the provider adapter by `instanceId`, runs `startSession → sendTurn → readThread → stopSession` on an ephemeral thread; cleanup always runs via `Effect.ensuring`. Its internal operations remain bounded, and the prepare route additionally caps the complete provider attempt at 30 seconds before using deterministic truncation. Errors are wrapped in `HandoffCompressionError`.
- `truncateHandoffTranscript` — head+tail truncation with an omission marker; never exceeds the budget, even when the budget is smaller than the marker.

### Local judge (bonsai2 in place of hosted `jev`)

`apps/server/src/localJudge.ts` is a TypeSafe-shaped System One judge backed by the resident Bonsai 2 model: `askLocalJudge({ state, questions })` takes Choice, Noul, and Score questions and returns answers in the same shape as `POST /v1/systemone` (`choice` + `probabilities` + `confidence`, `noul`, `score` + `legend` + `probabilities` + `confidence`). Each question is one single-token completion against `http://127.0.0.1:8094/v1/chat/completions` (llama.cpp behind `bonsai2.service`, the only local endpoint that returns logprobs) with the options lettered A, B, C…; the first-token `top_logprobs` over those letters, renormalised, is the distribution. Thinking is disabled so the token is the answer. When an endpoint returns no logprobs (plain Ollama, or the bonsai2 gateway on `:11434`, which rebuilds replies from the stream) the emitted letter becomes a one-hot answer. Confidence is the margin between the top two options. Off-menu replies fail rather than guess, so callers fall back instead of acting on an invented distribution. Questions run in parallel with concurrency 3, matching the server's slots.

The compaction asks one Score question per message (`HANDOFF_UNIT_KEEP_QUESTION`), with state `{ original_task, position, message }`:

```
Another AI agent is about to take over this conversation and continue the work. Judge how much that agent needs `message`, given `original_task` and that `position` tells where it sits in the conversation.
0  Skip: a greeting, acknowledgement, pleasantry, or a repeat of information already stated elsewhere; the next agent loses nothing without it
1  Summarize: useful background such as reasoning, exploration, or partial results whose gist matters but whose exact wording does not
2  Keep verbatim: states a decision, a user instruction, a file path, identifier, command, error message, or an open task the next agent must act on exactly
```

Only the newest 36 messages are judged (the resident bonsai2 scores about 1.1 full-size messages per second across its three slots); older ones go straight to the summary. Judge calls are capped at 40 s in total. Nothing about the judge is hosted: no key, no network beyond loopback.

### Default summary prompt

```
Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, commands, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
When the transcript is marked as omitted parts, summarize only those parts; the essential messages already travel verbatim.
Output only the compressed summary, no preamble.
```

The summary call goes to the Ollama-compatible gateway at `127.0.0.1:11434` (`/api/chat`, `stream: false`, `keep_alive: "30m"`, `num_ctx` estimated from the text and capped at 32 768). The prompt asks for 80 % of the remaining budget because local models overshoot a stated maximum; the reply is still hard-clipped at the budget.

## Client integration

The retained compatibility helper `prepareProviderHandoff` in `apps/web/src/providerHandoff.ts` POSTs the structured transcript to `/api/handoff/prepare` and preserves both the prepared summary and whether Memo persistence was confirmed. `prepareDurableProviderHandoff` owns the complete fallback: on network error, non-ok response, malformed JSON, or an unconfirmed write, it attempts to store the prepared summary when available (or the structured transcript when preparation itself failed) through `persistProviderHandoffMemoryFallback`. A successful prepared summary is still attached even when the optional mirror write fails; only a failed prepare falls back to the structured transcript.

`onProviderModelSelect` treats every pick the same way: it writes the selection into the composer draft. `resolveProviderHandoffForSelection` is the single predicate that decides whether a selection would hand off; the composer banner, the released provider lock, and the send path all read it, so they cannot disagree. Releasing `deriveLockedProvider` while a handoff is staged is what lets the composer show and dispatch the target instance in a started chat.

`applyStagedProviderHandoff` is the one place the switch happens. It re-resolves the predicate against the model selection the dispatch is actually about to send, calls `buildImmediateProviderHandoffMessage` synchronously, and returns either the combined text or a reason to abort. **Every dispatch path that sends the composer's own model selection must route through it** — today that is `onSend` and `onSubmitPlanFollowUp`. The paths that do not are safe for structural reasons: `onResumeAfterUsageLimit` sends `activeThread.modelSelection` rather than the composer's, and the research divert and `onImplementPlanInNewThread` create a new thread, which has no session to hand off from.

Context is attached and length-checked before clearing the composer. Handoff target model changes are carried by the turn-start command rather than a preceding metadata write. Successful sends remain owned by the original thread; failure recovery must avoid touching refs belonging to another route.

**No dispatch may change the provider-native session without attaching context from the authoritative visible thread.** `resolveProviderHandoffForSelection` checks the source and outgoing selection at dispatch, including switches between instances of the same driver. An unavailable target remains a staged switch, not permission to send it a contextless message. The composer shows a warning and retains the source provider; if an unavailable target reaches `applyStagedProviderHandoff`, the dispatch aborts with an error.

**Cancel switch** is disabled while a send is in flight, since the dispatch already captured its target and reverting the picker would only make the UI disagree with the turn on its way.

The wire formats (build + parse) live in `packages/shared/src/providerHandoffPrompt.ts`. `appendProviderHandoffContext` writes the trailing `<handoff_context>` block as the outermost client-authored layer — after every composer context block, and before the server's `<enabled_skills>` block. Its single-line head fields are read by position, so titles, labels, ids, and project names have their whitespace collapsed on the way in; a multi-line thread title would otherwise destroy the block's structure.

`extractTrailingProviderHandoffContext` peels it back off. Only a block whose closing tag ends the message counts. Candidates are then tried from the **last** opener backwards, because the machine block is always appended last — a complete block the user pasted themselves stays in their visible text instead of being swallowed into the real one. Tag-balanced candidates go first: read from the inside, a summary quoting an entire earlier handoff leaves an unmatched closer behind, while the outer body holds that quote's opener and closer as a matched pair, so the outer block wins. A second pass drops the balance requirement so a summary that merely contains a stray closing line still folds. Validation short-circuits on the headline before splitting, tag positions are collected in one sweep, and the candidate count is capped at 20 — a hostile message degrades to rendering the block raw rather than to a stall. CRLF is normalized on the candidate body only; the returned instruction keeps the line endings it was stored with.

Display follows the same order. `extractUserMessageContexts` (web) and `stripUserMessageTransport` (mobile) peel the handoff block right after enabled skills, so the bubble, the copy button, the minimap preview, and every context chip see only the user's instruction. Above the bubble sits a compact “Handed off to …” row; expanding it reveals the carried summary. Threads created before staged handoff hold the legacy full-turn prompt instead: `parseProviderHandoffPrompt` still recognizes those (parsed against the skills-stripped text, since the server appends `<enabled_skills>` to every user turn), and they keep folding the whole bubble away because they contain no user instruction. Keeping build and parse in one module is what makes both folds safe — the renderer can never drift from the text the client actually sends.

## Failure modes

Automatic handoffs make no compression or Memo request, so those services cannot delay the switch. An oversized instruction that leaves insufficient space for context is rejected with the draft intact. Provider authentication, connection, and turn-start errors remain explicit failures. The retained preparation endpoints still use bounded compression and optional Memo fallback for older clients.

A staged target can go unavailable while it waits for the next send. The dispatch is safe on its own — the lock is restored, the composer substitutes the running instance, and the message goes out on the source provider with no unprepared switch — but silence there would let the banner's promise and the send's behavior diverge. So the banner is driven by the **raw draft pick**, not the composer's substituted selection, and an `unavailable` resolution keeps it on screen in a warning state: _“Handoff to … paused — provider unavailable. Messages continue on … until it returns, or cancel the switch.”_ Cancel still works, and the switch resumes by itself once the target reports ready. `applyStagedProviderHandoff` keeps refusing an `unavailable` target as defence in depth, for any future path that reaches dispatch without the substitution.

A user who pastes a structurally valid `<handoff_context>` block at the end of their own message gets it peeled and shown as a “Handed off to …” row, exactly as a pasted `<pasted_context>` block is peeled into an attachment chip. This is accepted rather than defended against: the persisted wire text stays authoritative and the row expands to show what was matched, and every discriminator we considered (a nonce, a signature) would either break historical messages or move trust into text the user can copy anyway.

## Files

| File                                                     | Role                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/contracts/src/settings.ts`                     | `HandoffContextCompressionSettings` schema (+ patch)                |
| `packages/shared/src/providerHandoffPrompt.ts`           | Combined block append/extract, plus the legacy build + parse        |
| `packages/shared/src/userMessageTransport.ts`            | Mobile peel order; surfaces the handoff target                      |
| `apps/server/src/handoffCompression.ts`                  | Judgment-driven local compaction, provider compression, truncation  |
| `apps/server/src/handoffCompression.test.ts`             | Split/plan/assemble, local fallbacks, provider mock, truncation     |
| `apps/server/src/localJudge.ts`                          | TypeSafe-shaped Choice/Noul/Score judge on the local bonsai2 server |
| `apps/server/src/localJudge.test.ts`                     | Letter-logprob decoding, one-hot fallback, failure modes            |
| `apps/server/src/http.ts`                                | `/api/handoff/prepare` and `/api/handoff/compress` routes           |
| `apps/server/src/server.ts`                              | Route registration                                                  |
| `apps/web/src/providerHandoff.ts`                        | Immediate transcript builder and preparation compatibility helpers  |
| `apps/web/src/providerHandoff.test.ts`                   | Client-side transcript/prepare tests                                |
| `apps/web/src/lib/userMessageContextComposition.ts`      | Web peel order; keeps the block out of visible and copy text        |
| `apps/web/src/components/ChatView.tsx`                   | Stage on pick, banner, attach context and dispatch on Send          |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | Detects legacy vs. combined handoff rows                            |
| `apps/mobile/src/features/threads/ThreadFeed.tsx`        | Mobile fold row for both shapes                                     |
