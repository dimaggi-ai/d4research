# Keeping d4research in Sync

The web or desktop client and the server it connects to should use the same d4research build. A
version warning means those two components differ; dismissing it does not update either one.

## Source Checkouts

`v0.2.0` does not have a fork-owned npm or automatic update channel. The upstream `npx t3` command
installs T3 Code and must not be used as a d4research updater.

## Continue threads after restarts

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
d4research must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a monitor, subagent, or background task
is woken and told that this work stopped. A background shell, such as a dev server,
does not wake it; the thread learns about it with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Finish or stop active agent and terminal work, then update the server checkout:

```bash
git pull --ff-only
vp i
vp run dev
```

Open the new pairing URL printed by the development runner if the existing browser is no longer
authorized. Saved threads and settings remain in the environment state directory.

## Maintainer-Managed Local Deployment

An existing repository-owned systemd/Caddy installation is updated from its checkout with:

```bash
bash scripts/deploy-local.sh
```

The script typechecks and builds with bounded deadlines, schedules the restart outside the active
agent session, and waits for HTTP readiness. It is not a clean-machine installer. Maintainer setup
and logs are documented in [Local Deployment](../operations/local-deployment.md).

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Update providers

On web and desktop, **Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover over **Update all** to see which providers it will update. Providers that d4research
cannot update automatically remain available for manual updating from their provider row.

## Remote Clients

The orchestration V2 update preserves older conversation transcripts but cannot carry every kind
of runtime history forward. Read [Threads from older versions](./thread-migration.md) before
continuing an important older thread. Keep client and server builds compatible; a protocol
mismatch can prevent connection rather than merely show a version warning.

Update the server machine, not only the browser or phone used to reach it. Provider CLIs, Memo,
projects, and runtime state live in that server environment. Keep the client open during a planned
restart; it reconnects and reloads durable thread state when the server returns.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
d4research downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

If a version mismatch persists, confirm that the browser points to the environment you updated and
that its manifest now reports the expected build. Do not use an upstream T3 desktop or CLI update to
silence a d4research version warning.

See [Install and First Run](./install.md), [Remote Access](./remote-access.md), and
[Troubleshooting](./troubleshooting.md).
