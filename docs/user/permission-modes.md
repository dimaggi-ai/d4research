# Permission Modes

A permission mode controls how much the agent acts independently and when it pauses to ask for input.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

## The Modes

**Supervised**: ask before commands and file changes. The agent pauses and shows you what it
wants to run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve file changes; ask before other actions. Edits go through
without prompting, while commands and anything else still stop for approval.

**Full access**: allow commands and edits without approval prompts.

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

## Choosing a Mode

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes to its own approval and sandbox settings. Codex, for example,
translates the mode into an approval policy and sandbox level: **Supervised** runs the CLI
with prompting enabled and a restricted workspace, while **Full access** disables both. The
labels above describe what you get; the exact per-provider translation is internal and may
change.

Mobile offers the same four modes. It labels the first one **Approve actions** rather than
**Supervised**.

If the optional [Tool Guard](./tool-guard.md) integration is installed and enabled, the mode also
selects how the guard runs: the three guarded modes enforce the shared policy, while **Full
access** only audits.
