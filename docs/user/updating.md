# Keeping d4research in Sync

The web or desktop client and the server it connects to should use the same d4research build. A
version warning means those two components differ; dismissing it does not update either one.

## Released CLI servers

Install the exact version used by the client:

```bash
npm install --global d4research@0.2.0
```

The desktop client's **Update server** action also requests its exact d4research version rather than
an npm dist-tag. The upstream `npx t3` command installs T3 Code and must not be used as a d4research
updater.

## Desktop

Desktop checks the fork-owned GitHub Release channel for its selected stable or nightly channel.
Install the offered update through the app, or download the matching version manually and verify it
against the release's `SHA256SUMS` file.

## Source Checkouts

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

## Remote Clients

Update the server machine, not only the browser or phone used to reach it. Provider CLIs, Memo,
projects, and runtime state live in that server environment. Keep the client open during a planned
restart; it reconnects and reloads durable thread state when the server returns.

If a version mismatch persists, confirm that the browser points to the environment you updated and
that its manifest now reports the expected build. Do not use an upstream T3 desktop or CLI update to
silence a d4research version warning.

See [Install and First Run](./install.md), [Remote Access](./remote-access.md), and
[Troubleshooting](./troubleshooting.md).
