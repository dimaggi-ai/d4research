# The Composer

The message composer is more than a text box. It carries file mentions, provider skills, slash
commands, images, queued follow-ups, and the research toggle.

## Mentions, skills, and slash commands

Three characters open a completion menu at the cursor (detected by `detectComposerTrigger` in
`packages/shared/src/composerTrigger.ts`):

| Trigger | Menu                               | What gets inserted                                                                      |
| ------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `@`     | Files and folders in the workspace | A path mention. Paths with spaces are quoted automatically.                             |
| `$`     | Skills                             | `$<skill-name>` — the provider's own skills, or your installed ones                     |
| `/`     | Commands                           | Built-in `/model`, `/plan`, `/default`, plus the selected provider's own slash commands |
| `!`     | Delegation targets                 | `!provider:model` — only at the very start of a message                                 |

- **File mentions** search the project's entries as you type. Dragging a file from the workspace
  file tree into the composer inserts a markdown-style file link (`[name](path)`) — mentions and
  links both resolve inside the workspace for the agent.
- **Skills** come from the provider when it has its own (Claude and Codex do), so the `$` menu
  changes when you switch models. Providers without built-in skill support offer your installed
  skills instead — the ones listed under **Settings → Skills**, from your agent directories and the
  current project. Attaching one of those adds a short reference to your message: the skill's name,
  what it is for, and where its instructions live, with a note to read them. The agent reads the
  file itself, so a long skill costs you a few lines rather than its whole text, and attaching a
  skill never runs it — it hands the agent instructions to follow. If nothing matches you are
  pointed at `/` to browse provider commands instead.
- **Global** skills are selected in **Settings → Skills** with the **All chats** switch. They apply
  to every turn in every chat. **Chat** skills are added from the **Skills** control in that chat's
  composer and remain active only there, across reloads and provider handoffs. Global and chat
  selections share a 12-skill ceiling; duplicates are charged once and global wins. Message bubbles
  show `Global: name` and `Chat: name` badges. The agent reads each selected `SKILL.md`, so either
  scope consumes context on every affected turn. A project skill overrides a same-named user skill.
  Missing configured skills are removable and are never falsely reported as active.
- Installing a skill from **Settings → Skills** shares its portable instructions with compatible
  coding CLIs automatically. **Also install the Agy plugin package** is a separate opt-in because a
  plugin can include executable hooks and MCP servers in addition to the skill.
- `/model` jumps into the model picker; `/plan` and `/default` switch the interaction mode. A
  standalone `/plan` or `/default` message is treated as the mode switch, not as a prompt.

## Attachments

Paste or drag image files into the composer to attach them. Images are compressed client-side to
the provider's attachment byte limit; files that cannot be decoded or remain too large after
compression are rejected with an explanation.

Pasting a large block of text or dropping a text, source, Markdown, JSON, or log file creates a
collapsed text attachment. Small attachments travel directly with the message. When the complete
request approaches the provider's 120,000-character input limit, d4research first saves the whole
document to the environment's local Memo in 16,000-character chunks. The message then carries a
compact beginning/end preview plus exact `memory_search` tokens that let the agent retrieve only
the pieces it needs. Each Memo-backed document can contain up to 2,000,000 characters.

Memo must confirm the write before the draft can be cleared. Normal sends clear optimistically
during dispatch and restore the draft if the server rejects the turn start; queued sends clear after
the server accepts the Memo-backed request. If local Memo is disabled, unavailable, or times
out, the request stays in the composer and Send becomes available again for a retry. A very large
unsent attachment keeps only a bounded browser-storage preview across a page reload. If the app
asks for the complete source, remove the stale attachment chip and then reattach the file before
sending.

Chunk retrieval is available when the selected provider receives d4research's memory tools. Other
providers still see the compact preview, while the full local Memo copy remains available after a
handoff to a provider with `memory_search`. For a workspace file the agent can read directly, an
`@` mention remains the simplest unabridged option.

Memo-backed attachments use durable local storage. With the built-in SQLite backend, open
**Settings → Connections → Stored composer documents** to see complete and interrupted writes and
permanently delete one document's Memo rows. The original message and bounded preview remain in the
authoritative transcript, but later agents can no longer retrieve deleted chunks. Deletion is
idempotent, so retrying an already-completed delete is safe.

The external Memo REST contract does not provide list or delete operations. d4research identifies
that effective backend in Settings and directs you to manage retention in the external service
instead of pretending its rows were removed. Switching backends hides the other backend's rows; it
does not delete them. Sequentially reattaching unchanged content with the same name and project
title reuses the committed document; duplicate copies can still arise across simultaneous sends or
after a project rename, and deleting that document removes every copy with its exact document key.

## Switching provider mid-chat

Picking a different provider or model in a chat that has already started does not restart anything
on its own. The pick is held, and a banner above the composer reads **Next message hands off to …**.
Send, and that one message goes to the new provider with this chat's context attached. **Cancel
switch** in the banner puts the selection back on the provider the chat is running and clears the
hint. See [Handoff](./concepts.md#handoff).

## Queued follow-ups

Sending while a turn is still running does not interrupt the agent: the request is queued and shown
in a **Queued · n** banner above the composer, where individual entries can be removed before they
run. The environment server persists the queue and publishes it to every connected client. After
the server acknowledges a send from mobile, the phone or browser does not need to remain awake or
open: the server dispatches the next request when the current turn settles. A disconnected client
keeps a temporary local retry copy only until it can hand the request to the server.

## Approvals and user input

When the provider asks for approval (a command, an edit) or for user input, the request surfaces as
a panel directly above the composer with approve/reject actions, in addition to the inline
conversation entry. The composer also collects pending context you attach from elsewhere in the
app — terminal selections, preview element annotations, and review comments — and sends them with
the next message.

## Stash

Press `⌘S` (Ctrl+S) with a prompt in the composer to stash it. The stash badge opens a popover of
stashed prompts to restore or delete; stashed entries keep their attached images.

## Ask another model one question

Open a message with `!provider:model` and that one message is answered by the model you named,
inside this chat:

```
!codex:gpt-5.6-sol explain this stack trace
```

The `!` menu completes the target in two steps — provider first, then its models — and only opens at
the very start of a message, so `!` in ordinary prose stays ordinary prose. If the target does not
resolve to a ready provider and model, Send says so and keeps your draft.

What this does and does not do:

- The chat's own model does not change, and no session is restarted or forked. The next message goes
  back to the model the chat was already using.
- The delegate answers once. It reads, it does not write: file changes and commands are declined for
  it, so it cannot touch your worktree.
- Images and files attached to the message go to the delegate too.
- Delegation budgets apply. It is the same bounded delegation a pipeline step uses, drawing on the
  same per-turn ceiling.
- The answer is labeled with the provider and model that actually ran. When that differs from what
  you typed — you wrote `!claude:fable` and `claude-fable-5` answered — the label shows both.
- One at a time per chat. Sending a second delegation while one is running is refused rather than
  quietly replacing it.
- Nothing is hidden. The message stays exactly as you typed it, and stopping the chat stops the
  delegation.

If you have a provider switch staged, a delegation does not consume it: the banner says the handoff
waits for your next normal message, and the switch happens then.

## Pipeline triggers

Two triggers start a pipeline, and both only have an effect at the very start of a message:

| Trigger            | Starts                                 |
| ------------------ | -------------------------------------- |
| `!research:<name>` | A research pipeline, in its own thread |
| `!dev:<name>`      | A dev pipeline, in this thread         |

The **telescope** button inserts `!research:` with the scenario selected in Settings already
filled in; the **Build** control does the same for `!dev:`. Drop the `:<name>` to run whichever
scenario is selected in Settings. Switching one trigger for the other replaces it rather than
stacking both.

See [Research workflows](./research-workflows.md).

## Access and interaction modes

The controls beside the composer set the thread's access mode (see
[Permission modes](./permission-modes.md)) and the interaction mode (**Default** or **Plan**). On
narrow layouts they collapse into one compact controls menu.
