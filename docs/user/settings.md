# Settings

Settings open from the sidebar. A search box at the top of the settings sidebar
(`apps/web/src/components/settings/settingsSearch.ts`) finds individual controls across every page
and jumps straight to them.

| Page               | What it configures                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **General**        | Thread defaults (new-thread behavior, start-from-origin, add-project location), assistant output delivery, confirmations, auto-open task panel, provider update checks, text generation model, **Handoff → Context compression**, and the d4research Tool Guard lifecycle (Agent permissions) |
| **Appearance**     | Theme, glass opacity, environment identification, fonts (interface, prompt, code, terminal — size and family), font smoothing, word wrap, project grouping, time format, diff whitespace                                                                                                      |
| **Keybindings**    | Rebindable commands, including thread and model-picker jump keys; see [Keyboard shortcuts](./keybindings.md)                                                                                                                                                                                  |
| **Providers**      | Provider instances: driver, binary path, config directory, environment variables (with sensitive values stored server-side), accent colors, models, the Ollama preset for Claude, enable/disable, auth status, and update checks                                                              |
| **Source control** | GitHub / GitLab / Azure DevOps integrations and PR/MR writing preferences; see [Source control](./source-control.md)                                                                                                                                                                          |
| **Connections**    | Remote environments, pairing, version-skew warnings and server updates, Local Memo backend selection, and built-in composer-document storage controls                                                                                                                                         |
| **Tool Guard**     | The active Tool Guard policy: rule cards, and a full rule editor once the managed integration is installed; see [Tool Guard](./tool-guard.md)                                                                                                                                                 |
| **Beta**           | Experimental toggles (for example Sidebar v2)                                                                                                                                                                                                                                                 |
| **Archived**       | Archived threads                                                                                                                                                                                                                                                                              |

Settings live on the server (`ServerSettings` in `packages/contracts/src/settings.ts`) so they
track the environment: every client connected to that same server sees the same configuration.
Sensitive provider environment variables stay as server secrets and never return to clients after
saving.

## d4 Agent

In web or desktop Settings → General, select an environment and open **d4 Agent**.
On iPhone or iPad, use Settings → d4 Agent and threads. Settings are shared
by clients connected to that environment.

Enable **Monitor threads** to see threads that need attention. The server checks
for changes every 15 seconds and groups child-thread problems under their parent.
Choose the stuck threshold and which classes can notify you. Long tool calls can
exceed the threshold while still working; a stuck report is evidence to inspect,
not proof that the provider has failed. Existing problems are visible when you
enable monitoring, but do not generate a new alert.

Enable **agent chat**, choose a provider and model, and use the **d4 Agent**
entry in the sidebar or home screen to open its conversation. Ask what is running,
what needs you, or ask it to
read a particular thread. Model options, including reasoning effort when offered,
come from the environment's provider catalog. The agent stays off if the selected
model is unavailable or the provider cannot enforce its tool restrictions. The
monitor continues to use deterministic rules regardless of the chat model. The
monitor does not read conversation content or take recovery actions.

d4 Agent keeps one visible conversation across context switches. Each model turn receives a compact status
digest; conversation content is fetched through a read tool when needed. The
agent's Settings section shows recent provider-reported input, output, and cache
token counts. Missing counts appear as unavailable. Cache use depends on the
provider and the request; selecting a model does not guarantee a cache hit.

Only authenticated users and the server's heartbeat or continuation services can
send messages into the d4 Agent conversation. An **authenticated user** is
any client session with the orchestration-operate scope (`orchestration:operate`).
Agent MCP calls do not receive that identity. Ownership checks fail closed on
database errors: if the server cannot verify whether a thread belongs to d4 Agent, it
blocks access that requires the check.

The default permission level is **Read-only**. Sending a message or starting a thread,
research run, or pipeline always requires your approval, at every permission level.
Other actions are disabled in Read-only. **Ask** queues those actions for your approval.
**Act** can interrupt a run or answer a user-input request.
Act also creates pending memory proposals and sends CTO questions when those
features are enabled for the selected context. Memory proposals always need
human review. Approval does not change the vault.
Provider permission approvals remain manual. Proposed actions and their outcomes
appear above the agent conversation. These permissions do not grant authority to
publish, push, or run sudo.

An ID, internal link, or exact thread, project, or pipeline title switches the agent
to the target's mapped context before it reads content. An unmapped project uses **Global**.
If a reference is ambiguous, the agent asks which target you mean. You can also select
**Global**, **Personal**, **YB**, or **Dimaggi** above the conversation.

The agent keeps at most one open session per context and resumes it when you return.
Dividers show each switch in the same conversation. **New session** closes the current
session and starts a fresh one. The open-sessions panel shows activity times and recorded
input tokens, with a **Close** control for each session. Idle sessions close after 2 hours
by default; choose 30 minutes, 2 hours, 8 hours, or Never in Settings. The default size budget is
60% of the model's reported context window. At that limit, the old session produces a short
summary for its replacement in the same context. If a summary fails or the scope changes,
the replacement starts without it. Models that report no context window cannot use this
size check. Changing the vault path or relevant project mappings requires a fresh session.

To start research or a pipeline, map the pipeline to its project in Settings, then ask
d4 Agent in the same conversation. Review the final prompt, project, pipeline, and model
before approving. To send a message to another thread, ask the agent to rewrite it for
that thread. The approval card lets you edit and send the draft or send your original text.

Completed threads started by d4 Agent are reported in the conversation, then archived
after 24 hours by default. You can turn this off in Settings. A user reply or pin prevents
automatic archiving; user-started threads are never archived automatically. Use **Undo
archive** in the action log to restore an archived thread.

Enable **Brain memory** in the d4 Agent settings and set **Brain vault path** to the
vault on the environment's host. Memory reads only files approved by that
context's source manifest, after checking their SHA-256 hashes. Work contexts
also include approved neutral Global knowledge. Global memory reads Global
sources only. Missing vaults show **Not available**. A changed or invalid approved
source blocks retrieval until its configuration has been reviewed.

Map each project to a context in the same settings section. A work context's
agent digest, thread reads, and attention list include only its mapped projects.
Global monitoring shows metadata for every project. In Global, the agent can read
messages only from projects with no context mapping. Choose **Unmapped** in a project's context
setting to remove its mapping. Switch to the mapped context to read a work
project's messages.
Notifications outside the agent conversation keep their existing behavior.

**Brain embeddings** are optional. Blank endpoint and model fields use the existing
Second Brain embedding settings. If embedding requests fail, keyword search still
works. The index status shows the approved file count and the last rebuild for each context.
**Not indexed** means the current approved sources need indexing. Retrieval builds
the index from approved sources and rebuilds it when a manifest changes.
Global sessions cannot create memory proposals. Review memory proposals above the
agent conversation with **Approve** or **Reject**.
The list shows proposals from the current context and pending counts for other contexts.
Approved proposals have a **Copy text** action so you can add them to the vault
manually. Approval changes only the proposal status in d4 state; it does not add
knowledge to the vault. The agent never edits vault files or source manifests and
never uses another memory system as a fallback.

CTO tools are available only in Dimaggi sessions. Enable **CTO agents** to use them. The default
**CTO base URL** is `http://127.0.0.1:9093` on the environment's host. Status,
brief, and task-list reads are available at every permission level. CTO questions
require Ask approval or Act mode. Only one question can run at a time. The agent
can continue while it waits, and the answer appears in the same session. If you
change context or start a new session before it arrives, a preview stays in the
action log. Disabling the agent or **CTO agents** cancels the request. Task execution, task changes,
direction saves, and service operations are unavailable through these tools.

**Heartbeat** is off by default. Choose 15, 30, or 60 minutes to let the selected
model summarize changed attention items in the conversation. Quiet hours apply to
these summaries and use the UTC offset saved when you enable quiet hours. Deterministic
notifications are separate from heartbeat summaries.

Enable **System probes** to check failed user services, disk usage, and server
health. Choose the disk warning percentage. These checks run on the environment's
host, including when agent chat is off. A check that the host cannot support shows
**Not available**.

Enable **Attention notifications** and select the classes you want. On iPhone or
iPad, the app first requests provisional notification permission where supported;
Settings shows the current permission state. Lock-screen messages omit thread
titles and conversation content. Each device claims an alert separately; tabs
that share browser storage share one claim. If a
client closes after claiming but before displaying an alert, that device can miss
it; the attention item remains visible. Alerts expire after five minutes of eligibility so
reconnecting does not replay old problems. A new attention episode can alert again.

The server persists monitor episodes and delivery claims across restarts. Mobile
alerts use reports the app has received; delivery while iOS suspends the app is not
guaranteed. No hosted push service is added. Turn off the corresponding chat,
monitor, heartbeat, or probe setting to stop that feature.
