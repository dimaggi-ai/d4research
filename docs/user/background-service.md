# Running d4research in the Background

d4research can run as a user-level systemd service on Linux. The current source distribution uses
the repository-owned unit and build artifacts described below.

This is a maintainer-managed deployment. From the d4research checkout:

```bash
T3CODE_DEPLOY_RESTART_MODE=build-only \
T3CODE_DEPLOY_REQUIRE_VOICE=0 \
bash scripts/deploy-local.sh --build-only

install -d ~/.local/share/d4research
ln -sfn "$(pwd -P)" ~/.local/share/d4research/current
install -Dm644 ops/systemd/d4research.service \
  ~/.config/systemd/user/d4research.service
systemctl --user daemon-reload
systemctl --user enable --now d4research.service
```

Check the service and recent logs:

```bash
systemctl --user status d4research.service
journalctl --user -u d4research.service -n 100 --no-pager
```

Update an existing installation from its checkout with:

```bash
bash scripts/deploy-local.sh
```

The deployment script builds first, then schedules a detached restart and waits for the web
manifest and app root to become ready. Let active provider and terminal work finish before an
update. The stable `~/.local/share/d4research/current` link keeps the unit independent of a
developer-specific checkout path.

Disable and remove the user unit with:

```bash
systemctl --user disable --now d4research.service
rm ~/.config/systemd/user/d4research.service
systemctl --user daemon-reload
```

This does not delete the checkout or its d4research state. Back up the configured T3 home before
removing local data. The background service currently requires Linux with systemd.

Detailed readiness, voice-service, and worker-log behavior is in
[Local Deployment](../operations/local-deployment.md).

## Reclaim database space

d4research removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `d4research doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.
