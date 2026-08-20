# Troubleshooting

Start with the status shown in the UI. d4research separates provider readiness, turn lifecycle,
Memo persistence, and client connection state so one failure does not need to be guessed from
another.

## A Provider Cannot Start

Open **Settings → Providers** and read the provider's readiness and remediation fields. The provider
must be installed, authenticated when required, reachable, and model-ready. Refresh after fixing the
CLI. If it is outside the service process's `PATH`, set the instance's absolute **Binary path**.

Do not solve an unavailable pipeline target by renaming another model as equivalent. Select **Exact
targets only**, or author a literal `FALLBACK directive: !provider:model` and use **Use labeled
fallback**. The run history will show the requested and actual target.

## A Turn Stops or the Provider Process Exits

An unexpected provider exit is terminal for that runtime session. The thread records a failed/error
state and a later request starts a new provider session. Retry after fixing the provider; do not
wait for an old “running” indicator indefinitely.

If an interrupt fails at the provider boundary, d4research records the session error instead of
claiming the provider acknowledged cancellation. Stop the session or retry after the provider is
responsive.

## Send Is Disabled After an Attachment Error

Large attachments are saved to local Memo before the request is dispatched. On a storage or
indexing failure, the draft and attachment stay in the composer and Send is released. Remove the
attachment, correct the Memo connection, or retry in the same page. A browser reload should not be
required.

An unsent oversized attachment cannot be reconstructed from its small draft preview after a reload;
reattach the source file. Once the document has been successfully sent, its manifest and chunks are
durable in Memo.

## Memo or a Handoff Fails

Check **Settings → Connections**:

- built-in storage must be enabled for the zero-dependency local path;
- `memo-rest` must point to a reachable external Memo service;
- a deleted or incomplete document cannot satisfy old chunk tokens.

The built-in file is `memory.sqlite` in the environment state directory. Development normally uses
the repository's `.t3/dev` directory; production uses `userdata` under the configured T3 home. Back
up state before moving or deleting this file.

A provider handoff does not depend on Memo availability. If both the prepared handoff write and its
local fallback write fail, d4research attaches the size-bounded visible-thread transcript directly
and continues the switch. The receiving provider therefore still gets context; only Memo search and
recovery lose that handoff record.

## The Browser Disconnects or a Request Times Out

Keep the page open while it reconnects. Durable thread state and event sequences are replayed after
connection recovery. A connected request that receives no response is bounded; correct the server
or network problem and retry rather than issuing repeated blind sends.

For a remote client, verify that the server machine—not only the browser device—can reach its
provider CLI and local services. See [Remote Access](./remote-access.md).

## A Research Result Omits a Delegate

Open the Agents/progress surface and inspect the run manifest:

- **SKIPPED** means no explicit target was configured or the scenario intentionally omitted it;
- **FAILED** means a real call was attempted and did not return a usable result;
- a fallback is listed under its actual provider/model.

The public starter deliberately skips delegation unless you add an explicit target. This demonstrates
honest provenance without publishing a proprietary production pipeline.

## Collecting Evidence for Support

Record the environment name, thread ID, provider instance/model, visible readiness remediation,
and the terminal lifecycle state. Export the research Markdown from the web/desktop thread header
when available; it includes the visible conversation and controller-owned run provenance.
