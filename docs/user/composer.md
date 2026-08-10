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
the Memo-backed request enters the local queue. If local Memo is disabled, unavailable, or times
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

## Queued follow-ups

Sending while a turn is still running does not interrupt the agent: the request is queued and shown
in a **Queued · n** banner above the composer, where individual entries can be removed before they
run. Queued requests are dispatched when the current turn settles.

## Approvals and user input

When the provider asks for approval (a command, an edit) or for user input, the request surfaces as
a panel directly above the composer with approve/reject actions, in addition to the inline
conversation entry. The composer also collects pending context you attach from elsewhere in the
app — terminal selections, preview element annotations, and review comments — and sends them with
the next message.

## Stash

Press `⌘S` (Ctrl+S) with a prompt in the composer to stash it. The stash badge opens a popover of
stashed prompts to restore or delete; stashed entries keep their attached images.

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
