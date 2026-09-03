# Local deployment

> For maintainers. Using d4research? See [docs/user](../user/).

The production-style local deployment builds the web and server artifacts, then schedules a
detached systemd worker so the active d4research session is not killed before it can report that
the build completed:

```bash
bash scripts/deploy-local.sh
```

Each build step has its own deadline and emits a heartbeat. A non-blocking process lock rejects
overlapping builds, and the script rejects a new deploy before building while the fixed
`d4research-restart` worker is still loaded. Inspect the worker with:

```bash
journalctl --user -u d4research-restart.service --no-pager
```

## Readiness

The Node HTTP socket may bind before the application routes finish attaching. A successful TCP
connection is therefore not readiness. The worker waits first for `/manifest.webmanifest`, then
the app root, and finally the optional local voice health endpoint. The default readiness deadline
is 180 seconds; override it with `T3CODE_DEPLOY_READY_TIMEOUT_SECONDS` when a slower host needs a
larger bounded window. The probe reports elapsed time every five seconds.

## User service

The repository-owned unit is `ops/systemd/d4research.service`. Build first, point the stable local
deployment link at the checkout, then install and start the unit:

```bash
T3CODE_DEPLOY_RESTART_MODE=build-only T3CODE_DEPLOY_REQUIRE_VOICE=0 bash scripts/deploy-local.sh --build-only
install -d ~/.local/share/d4research
ln -sfn "$(pwd -P)" ~/.local/share/d4research/current
install -Dm644 ops/systemd/d4research.service ~/.config/systemd/user/d4research.service
systemctl --user daemon-reload
systemctl --user enable --now d4research.service
```

The stable link keeps the tracked unit independent of any developer-specific checkout path. A
missing build artifact blocks startup, and the start limiter stops persistent crash loops. The unit
allows up to 45 seconds for shutdown so provider subprocesses and SQLite checkpoint work can close
cleanly instead of inheriting a workstation's shorter manager default. Machine-specific Node PATH
or proxy settings belong in a systemd drop-in rather than an untracked replacement unit.
