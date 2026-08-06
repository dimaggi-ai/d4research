# Handoff Context Compression

When a user switches providers mid-conversation (e.g. Claude → Agy, or Codex → a local Ollama model), the handoff system transfers conversation context to the new provider. The transcript is structured — the first user message (the task statement) is kept verbatim, the middle is marked as omitted, and the most recent messages fill the remaining budget — and then compressed into a dense summary before it travels. Compression defaults to a local Ollama model, so a handoff costs no cloud tokens and no provider cold start.

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
ChatView (onProviderHandoff)
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
  │     │                       session, 120 s timeout on the turn)
  │     └─ persists the COMPRESSED summary to local Memo, then returns it
  │
  └─ Fallback: prepare failed → the structured transcript itself is the
     summary, and the client backfills Memo best-effort via
     persistProviderHandoffMemoryFallback → POST /api/memory/handoff
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
- `compressHandoffContext` — resolves the provider adapter by `instanceId`, runs `startSession → sendTurn → readThread → stopSession` on an ephemeral thread with a 120 s timeout on the turn; cleanup always runs via `Effect.ensuring`. Errors are wrapped in `HandoffCompressionError`, which the prepare route converts into the truncation fallback.
- `truncateHandoffTranscript` — head+tail truncation with an omission marker; never exceeds the budget, even when the budget is smaller than the marker.

### Default compression prompt

```
Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
Output only the compressed summary, no preamble.
```

## Client integration

`prepareProviderHandoff` in `apps/web/src/providerHandoff.ts` POSTs the structured transcript to `/api/handoff/prepare` and returns the compressed summary, or `null` on any failure (network error, non-ok response, malformed JSON). Silent failure by design — the caller falls back to the structured transcript and backfills Memo through `persistProviderHandoffMemoryFallback`, so a failed compressor never blocks a handoff and never leaves Memo empty for that handoff.

## Failure modes

The system never hard-fails a handoff. The fallback chain is:

1. Compression succeeds → compressed summary in the prompt, same summary in Memo.
2. Compressor fails server-side → structured truncation in the prompt and in Memo.
3. The prepare round-trip itself fails → structured transcript in the prompt; the client backfills Memo via `/api/memory/handoff` best-effort.

## Files

| File                                         | Role                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `packages/contracts/src/settings.ts`         | `HandoffContextCompressionSettings` schema (+ patch)      |
| `apps/server/src/handoffCompression.ts`      | Local + provider compression, truncation, error type      |
| `apps/server/src/handoffCompression.test.ts` | Local success/fallback, provider mock, truncation tests   |
| `apps/server/src/http.ts`                    | `/api/handoff/prepare` and `/api/handoff/compress` routes |
| `apps/server/src/server.ts`                  | Route registration                                        |
| `apps/web/src/providerHandoff.ts`            | Structured transcript, prepare client, Memo fallback      |
| `apps/web/src/providerHandoff.test.ts`       | Client-side transcript/prepare tests                      |
| `apps/web/src/components/ChatView.tsx`       | `onProviderHandoff` — wires preparation into handoff flow |
