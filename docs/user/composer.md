# The Composer

The message composer is more than a text box. It carries file mentions, provider skills, slash
commands, images, queued follow-ups, and the research toggle.

## Model selection on multiple devices

In an existing thread, the model you select is shared with your other connected devices.
A reconnecting device loads the latest selection from the server. Your unsent message and
attachments stay on the device where you entered them. Selecting a different provider stages
a handoff for the next send; cancelling that handoff also updates your other devices.

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

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path; it does not enable native video input.

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
during dispatch and restore the draft if the server rejects the turn start; queued sends clear once
the message is waiting in the thread. If local Memo is disabled, unavailable, or times out, the
request stays in the composer and Send becomes available again for a retry. A very large
unsent attachment keeps only a bounded browser-storage preview across a page reload. If the app
asks for the complete source, remove the stale attachment chip and then reattach the file before
sending.

Chunk retrieval works when the selected provider receives d4research's memory tools. Other
providers still see the compact preview, and the full local Memo copy stays available after a
handoff to a provider with `memory_search`. For workspace files the agent can read directly, an
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

## Follow-up messages

On web and desktop, choose **Settings → General → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited, reordered, or removed above the composer.
`Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the opposite action:
it steers when your default is Queue and queues when your default is Steer.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Follow-ups**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer when the running agent supports it.

## Switching provider mid-chat

Picking a different provider or model in a chat that has already started does not restart anything
on its own. The pick is held, and a banner above the composer reads **Next message hands off to …**.
Send, and that one message goes to the new provider with this chat's context attached. **Cancel
switch** in the banner puts the selection back on the provider the chat is running and clears the
hint. See [Handoff](./concepts.md#handoff).

## Queued follow-ups

On web and desktop, a message sent during a running turn waits as a dashed bubble at the end of the
conversation. **Settings → General → Follow-up behavior** chooses when it goes out. **Wait**, the
default, sends it when the turn ends. **Queue** sends it after the agent's next tool call. **Steer**
sends it into the running turn right away.

The arrow under the bubble sends the message now. The X returns it to the composer. Stop returns
every queued message to the composer. The setting applies to the current client. Muse and Agy
cannot take a message during a turn, so their queued messages always wait for the turn to end.

`Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux sends the oldest queued
message now. Change `thread.steerQueuedMessage` in **Settings → Keybindings** to use another
shortcut. The send waits while the agent needs an approval or an answer.

Mobile keeps its own queue and is not affected by this setting.

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

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` (macOS) or `Ctrl+S` (Windows, Linux) to save
the current prompt and its attachments. Wait for uploads to finish first.
In an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes with uploaded files must be restored in their original environment.
Files are retained for 24 hours. After an upload expires, restore the prompt,
then use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones running iOS 26 or later, tap the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for review and editing before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording but preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Transcription runs on your device. d4research deletes the temporary audio after
transcription or cancellation. Only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments shows the send action selected in **Follow-up behavior**.
Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to use the opposite action for that message.
See [Follow-up messages](#follow-up-messages) for the shortcuts and steering requirements.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

If the server restarts, saved queued messages keep their order and are held. Press
**Resume** in an empty composer on web or desktop, or **Resume queue** in the queue
sheet on mobile, to continue. You can edit, reorder, or remove held messages without starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

After adding or changing skills, plugins, or MCP servers, use **Restart agent
session** in the command palette on web and desktop. The conversation continues;
your next message starts the agent again with the new setup.

Provider commands must start the message to run. d4research commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or on web and desktop drag a thread out of the sidebar and drop it on the
composer; a multi-selection drops together. The chip shows the thread's current title and
opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, rather than adding the full transcript to your prompt. Attaching a thread does
not change it or itself send a message to that thread.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete d4research tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your d4research session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
