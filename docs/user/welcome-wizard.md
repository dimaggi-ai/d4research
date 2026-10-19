# Welcome wizard

d4research offers a setup flow for a new workspace. Select the connected computers you want to
configure, check your providers, and choose projects to import. Existing workspaces skip setup.

## Connect a computer

The environment serving the app is already selected. Use **Add a computer** to connect another
reachable environment with its pairing link. See [Remote access](./remote-access.md).
Unchecking a computer excludes it from setup without disconnecting it.

If startup cannot confirm the workspace, setup shows **Still connecting** with a reload action.
If saved settings cannot be read, retry after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check providers and import projects

Setup checks Claude Code and Codex on the selected computers. Install and sign-in actions open
a terminal with the correct command ready to run for the selected provider. Install uses the
vendor's own installer, which keeps **Update now** working in Settings. Other providers can be
configured in Settings.

Project discovery looks for directories used by Claude Code or Codex. Choose which projects to
import. Conversation import is best effort: malformed or unreadable history can be skipped, and
large histories can reach the scan budget. Imported conversations keep visible user and assistant
messages, not tool activity or attachments. The importer retains the first user prompt and the
newest remaining messages, up to 200 messages in total.

You can continue without configuring providers or importing projects. Setup navigation pauses
while an import is running.
