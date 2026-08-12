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
Junie, OpenCode, or Agy. A provider instance can represent a separate account or configuration. A
model selection always belongs to a provider instance.

Pipelines record the requested target and the target that actually ran. An explicitly authored
fallback is not an alias and is never reported as the unavailable requested model.

## Workflow and Delegation

The composer's **Workflows** menu selects Chat/Plan, a named Dev pipeline, or a named Research
scenario. Research and Dev share target resolution, explicit fallback policy, tracing, and
server-enforced budgets.

A **delegation** is a real, bounded provider call made by the orchestrator. Delegates cannot
delegate again. A skipped or failed call remains skipped or failed in the run record; model-written
prose cannot turn it into a successful call.

## Handoff

A handoff changes the provider/model attached to the same thread. The visible transcript remains
authoritative. d4research first stores recoverable context in local Memo; if that durable bridge
cannot be established, the switch does not happen.

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
