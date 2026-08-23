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

Settings are stored server-side (`ServerSettings` in `packages/contracts/src/settings.ts`), so they
follow the environment: every client connected to the same server sees the same configuration.
Sensitive provider environment variables are kept as server secrets and never sent back to clients
after saving.
