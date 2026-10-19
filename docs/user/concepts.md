# Product Concepts

d4research keeps one visible investigation authoritative while provider runtimes and devices may
change underneath it.

## Environment

One running d4research server and the machine it controls: its filesystem, provider CLIs and
credentials, settings, projects, local Memo, and runtime state. A remote browser connects to an
environment; it does not move those resources to the browser device.

## Project

An environment-local workspace rooted at a directory. Threads, terminals, source-control status,
and checkpoints are associated with a project.

## Thread and Turn

A **thread** is the durable, visible conversation and work history for a project. A **turn** is one
user request and the provider work that follows it. Reloading or reconnecting reads the same thread;
it does not create a replacement history.

## Provider and Model

A **provider** is the local agent runtime d4research controls, such as Codex, Claude, Cursor, Grok,
Junie, Muse, OpenCode, or Agy. A provider instance can represent a separate account or configuration. A
model selection always belongs to a provider instance.

Pipelines record the requested target and the target that actually ran. An explicitly authored
fallback is not an alias and is never reported as the unavailable requested model.

## Workflow and Delegation

The composer's **Workflows** menu selects Chat/Plan, a named Dev pipeline, or a named Research
scenario. Research and Dev share target resolution, explicit fallback policy, tracing, and
server-enforced budgets.

A **delegation** is a real, bounded provider call made by the orchestrator. Delegates cannot
delegate again. A skipped or failed call stays that way in the run record; model-written prose
cannot turn it into a successful call.

An **inline delegation** is the same bounded call made without a pipeline: open a message with
`!provider:model` and that one message is answered by the model you named, leaving the chat's own
model, session, and history untouched.

## Handoff

A handoff changes the provider/model attached to the same thread. The visible transcript remains
authoritative.

Choosing another provider in a chat that has already started only _stages_ the switch — nothing runs
yet, and the composer tells you the next message will hand off. That next message is the handoff:
d4research attaches a bounded transcript to what you wrote, and the new provider answers your
instruction. Automatic handoffs do not wait for compression or a Memo write. You can switch chats
after sending; an accepted turn continues on its original thread. The context travels in the saved
message, without requiring a separate searchable Memo record.

The attached context keeps the original task and recent messages, up to 60,000 characters, with
less space available for very long instructions. Omitted history is marked. A failed or disconnected
send is not a completed handoff; check the original thread for the sent message or error.

In the thread, a handed-off message carries a compact **Handed off to …** row above your normal
message bubble; expand it to read the context that travelled with it. Handoffs from older versions
of d4research were a separate machine-written turn, and those still fold away behind the same row.

## Memo

Memo is local shared memory for handoff context and research findings. The built-in backend is an
environment-local SQLite database. Oversized text attachments are committed as chunks plus a final
manifest, and the turn carries compact tokens used to retrieve relevant chunks. The external
`memo-rest` backend is an explicit alternative, not a hidden hosted dependency.

## Checkpoint

A checkpoint is a hidden source-control snapshot taken around a turn so file changes can be diffed
or restored. It is separate from the conversation transcript and provider-native session history.

Next: [Install and First Run](./install.md), [Starter Research](./starter-research.md), and
[Troubleshooting](./troubleshooting.md).

## Optional Meko handoff storage

In **Settings → General → Handoff**, select **Meko MCP** to save a copy of handoff context to an MCP server you configure. This integration is off by default and has no preset server URL or destination IDs. Enabling it sends checkpoint text and its project and thread identifiers to that server. The visible thread remains authoritative; recalled checkpoints only add context.

Enter an HTTPS MCP URL, datapack ID, agent ID, and the name of a server environment variable containing your credential. HTTP is accepted only for loopback addresses. Enter the variable name, such as `MEKO_API_KEY`, rather than its value. The credential is not stored in settings. The server reads it from its environment and sends it to your MCP endpoint. **Inspect API** checks tool compatibility without writing data.

Automatic saves run in the background, allow at most two concurrent operations, and have a 12-second deadline. A save is verified only after Meko returns the same bytes and content hash. Failures appear in the thread; **Recent operations** shows receipts from the current server process. Agents can use `handoff_status` and `handoff_read` to inspect and retrieve checkpoints scoped to their current project and thread.

Select **Local Memo** or **No memory copy** to disable Meko saves and recall. Changing the configuration cancels in-flight requests but cannot undo data already sent. Disabling the integration does not delete checkpoints stored on your MCP server.

Provider icons and model display names can be changed in the web or desktop provider settings. These preferences are local to that client and do not change model identifiers or provider routing. Clear a display name or use **Reset icons and model names** to restore defaults. The native mobile client keeps its own preferences and does not expose these appearance controls.
