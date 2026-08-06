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
- `/model` jumps into the model picker; `/plan` and `/default` switch the interaction mode. A
  standalone `/plan` or `/default` message is treated as the mode switch, not as a prompt.

## Images

Paste or drag image files into the composer to attach them. Images are compressed client-side to
the provider's attachment byte limit; files that cannot be decoded or remain too large after
compression are rejected with an explanation. Non-image files are not accepted as attachments —
reference them with an `@` mention instead.

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

## Research toggle

The telescope button prepends `#deep-research ` to the prompt; the tag only has an effect at the
very start of a message. See [Research workflows](./research-workflows.md).

## Access and interaction modes

The controls beside the composer set the thread's access mode (see
[Permission modes](./permission-modes.md)) and the interaction mode (**Default** or **Plan**). On
narrow layouts they collapse into one compact controls menu.
