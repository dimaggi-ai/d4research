# Handoff Context Compression

When a user switches providers mid-conversation (e.g. Claude → Agy, or Codex → a local Ollama model), the handoff system transfers conversation context to the new provider. By default this is a naïve tail-truncation of the transcript to 6 000 characters. With compression enabled, the transcript is first sent through a chosen provider to produce a dense summary, saving tokens on the receiving side while preserving the full uncompressed context in Memo for accuracy.

## Settings

Compression is configured under **Settings → General → Handoff → Context compression** and stored in `ServerSettings.handoff.contextCompression`.

| Field                 | Type                 | Default | Description                                                          |
| --------------------- | -------------------- | ------- | -------------------------------------------------------------------- |
| `enabled`             | boolean              | `false` | Master toggle                                                        |
| `instanceId`          | `ProviderInstanceId` | —       | Provider instance to run the compression (e.g. a local Ollama model) |
| `model`               | string               | —       | Model name within that provider                                      |
| `maxInputCharacters`  | positive int         | `6 000` | Max transcript length sent to the compressor                         |
| `maxOutputCharacters` | positive int         | `2 000` | Max compressed summary length                                        |
| `customPrompt`        | string               | `""`    | Override the default compression system prompt                       |

All three of `enabled`, `instanceId`, and `model` must be set for compression to activate.

## Architecture

```
ChatView (onProviderHandoff)
  │
  ├─ buildProviderHandoffTranscript(messages, maxInputCharacters)
  │     → tail-truncated plain-text transcript
  │
  ├─ POST /api/handoff/compress  { transcript }
  │     │
  │     ├─ reads compression settings from ServerSettings
  │     ├─ truncates transcript to maxInputCharacters
  │     └─ calls compressHandoffContext(...)
  │           │
  │           ├─ ProviderAdapterRegistry.getByInstance(instanceId)
  │           ├─ adapter.startSession(ephemeral thread)
  │           ├─ adapter.sendTurn(systemPrompt + transcript)
  │           ├─ adapter.readThread → extract response text
  │           ├─ adapter.stopSession (Effect.ensuring — always runs)
  │           └─ truncate output to maxOutputCharacters
  │
  ├─ Dual-write:
  │     ├─ Memo:  full uncompressed transcript  (persistProviderHandoffMemory)
  │     └─ Handoff prompt:  compressed summary   (buildProviderHandoffPrompt)
  │
  └─ Fallback: if compression returns null → summarizeReplyForSpeech
```

## Server endpoint

**`POST /api/handoff/compress`**

- **Auth:** `AuthOrchestrationOperateScope`
- **Request:** `{ transcript: string }`
- **Response:** `{ ok: true, compressed: string }` on success

| Condition        | Status | Response                                                           |
| ---------------- | ------ | ------------------------------------------------------------------ |
| Empty transcript | 400    | `{ ok: false, message: "Transcript must be non-empty." }`          |
| Not configured   | 400    | `{ ok: false, message: "Handoff compression is not configured." }` |
| Provider error   | 502    | `{ ok: false, message: "<detail>" }`                               |
| Unknown error    | 500    | `{ ok: false, message: "Context compression failed." }`            |

The route is registered in `server.ts` between `handoffMemoryRouteLayer` and `assetRouteLayer`.

## Compression logic

`compressHandoffContext` in `apps/server/src/handoffCompression.ts` is an Effect function that:

1. Resolves the provider adapter from the registry by `instanceId`.
2. Builds the turn input: the system prompt (custom or default), a max-length instruction, and the transcript separated by `--- TRANSCRIPT ---`.
3. Creates an ephemeral thread (`handoff-compress-<timestamp>`).
4. Runs `startSession` → `sendTurn` → `readThread` → `stopSession` through the standard adapter interface.
5. Cleanup always runs via `Effect.ensuring`, so the ephemeral session is torn down even on failure.
6. Hard-truncates the output to `maxOutputCharacters` if needed.

This works with any provider that implements the adapter interface — Claude, Codex, Agy, local Ollama models via the Claude adapter, etc.

### Default compression prompt

```
Compress this conversation transcript into a dense context summary for handoff to another AI model.
Preserve: key decisions, agreed approaches, file paths, function names, error messages, and outstanding tasks.
Omit: greetings, filler, repeated information, and verbose explanations.
Output only the compressed summary, no preamble.
```

## Client integration

`compressProviderHandoffContext` in `apps/web/src/providerHandoff.ts` is a simple async function that POSTs the transcript and returns the compressed string, or `null` on any failure (network error, non-ok response, malformed JSON). Silent failure by design — the caller always has a fallback path.

## Dual-write pattern

When compression is enabled, the handoff writes to two destinations:

- **Memo (persistent memory):** receives the **full uncompressed transcript** via `buildProviderHandoffMemory`. This preserves complete context for future `memory_search` queries by any agent.
- **Handoff prompt (to receiving provider):** receives only the **compressed summary** via `buildProviderHandoffPrompt`. This saves tokens on the receiving provider's context window.

When compression is disabled or fails, both destinations receive the same `summarizeReplyForSpeech` output (the legacy behavior).

## Failure modes

The system never hard-fails a handoff. The fallback chain is:

1. Compression succeeds → use compressed summary
2. Compression returns null (provider error, empty response, network failure) → fall back to `summarizeReplyForSpeech`
3. Voice summarization is always available as the last resort

Server-side errors are all wrapped in `HandoffCompressionError` (a `Data.TaggedError`) with a `detail` string describing what went wrong.

## Files

| File                                         | Role                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `packages/contracts/src/settings.ts`         | `HandoffContextCompressionSettings` schema                |
| `apps/server/src/handoffCompression.ts`      | Core compression Effect + error type                      |
| `apps/server/src/handoffCompression.test.ts` | 5 tests with mock adapter                                 |
| `apps/server/src/http.ts`                    | `POST /api/handoff/compress` route                        |
| `apps/server/src/server.ts`                  | Route registration                                        |
| `apps/web/src/providerHandoff.ts`            | `compressProviderHandoffContext` client function          |
| `apps/web/src/providerHandoff.test.ts`       | Client-side compression tests                             |
| `apps/web/src/components/ChatView.tsx`       | `onProviderHandoff` — wires compression into handoff flow |
