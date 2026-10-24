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

## Local thread monitor

In web or desktop Settings → General, select an environment and enable **Monitor
threads**. On iPhone or iPad, use Settings → Thread behavior → Monitor. Each
environment has one monitor configuration shared by its clients. Disable the same
switch to stop monitoring.

The monitor checks unarchived threads every 15 seconds. It lists activity and
attention items with links to their threads. Slow or possibly stuck activity does
not send an alert. Pending input or approval, a failed run, a usage limit, or a
recorded provider failure can require attention. Long-running work and expired
effect leases alone do not prove a run is stuck.

**Saved model** stores your chosen provider and model for the monitor. This version
uses deterministic classification and does not invoke that model. Changing the
selection does not switch an active run's provider or model.

Enable **Attention notifications** to allow alerts. On web and desktop, also enable
system notifications in the existing notification settings. On iPhone or iPad,
allow notifications when asked. The first connected client to claim an attention
item can notify you; other clients still show it in the list. If that client closes
before displaying its alert, the alert can be lost, but the attention item remains.

The server stores status and notification claims across restarts. Clients refresh
from the server on reconnect. Mobile alerts use reports already received by the
app; delivery while iOS suspends the app is not guaranteed. No push service is added.

Monitor reports contain status codes, identifiers, and timestamps. Alert text
contains no thread titles or work content. The monitor does not read conversation
text, alter context prefixes or compaction, retry work, interrupt runs, or perform
public actions. Open the thread to act through its existing permission and approval
controls.
