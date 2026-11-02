# Permission Modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread shows its mode under the composer. In a thread
on your default mode, open the model picker and choose **Permissions** at its bottom, or press
`mod+shift+a`. A thread on another mode shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

## The Modes

An administrator can cap the modes available on a machine with a
[managed policy](./managed-policy.md#permission-modes); modes above the cap show who manages them.

**Supervised**: approve or reject requests in the conversation. The agent can continue after
you respond, subject to its provider's behavior. Permission modes do
not prevent the agent from asking questions about the task. Subagent approval requests appear in
the parent conversation with the subagent's name, so you can respond without switching threads.

**Auto-accept edits**: auto-approve file changes; ask before other actions. Edits go through
without prompting, while commands and anything else still stop for approval.

**Full access**: allow commands and edits without approval prompts.

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, and fx; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval. On fx, prompts it still sends also come to you.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

T3 Code offers no **Auto-accept edits** or **Full access** for fx. An fx thread already set to either runs in
**Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action. Dangerous-removal safety checks in bypass mode reject the command and show the original warning. Claude can use a safe rewrite when the warning supplies one; otherwise it
continues without the removal and tells you what it skipped.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

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
