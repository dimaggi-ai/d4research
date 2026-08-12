# Running d4research in the Background

d4research can run as a user-level systemd service on Linux. The current source distribution uses
the repository-owned unit and build artifacts; the upstream `npx t3 service` commands manage T3
Code, not this fork.

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
