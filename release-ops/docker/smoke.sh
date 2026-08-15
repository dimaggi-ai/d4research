#!/usr/bin/env bash
# P0 distribution smoke: package the server artifact and run the clean-machine
# lifecycle in Docker. Replaces the "clean machine" gate for v0.2.0.
#
#   bash release-ops/docker/smoke.sh              # rebuild artifact, run smoke
#   bash release-ops/docker/smoke.sh --no-build   # reuse existing dist/
#
# Exit 0 means: clean install, first launch, pairing, restart persistence,
# update-in-place, and uninstall all passed on a stock node:24 image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SERVER="$REPO/apps/server"

if [ "${1:-}" != "--no-build" ]; then
  echo "[smoke] building server artifact"
  (cd "$SERVER" && vp run build >/dev/null)
fi

[ -f "$SERVER/dist/bin.mjs" ] || { echo "[smoke] missing dist/bin.mjs"; exit 1; }

echo "[smoke] packing installable artifact (catalog specifiers resolved)"
node "$HERE/make-artifact.mjs" "$HERE/t3-artifact.tgz"
echo "[smoke] artifact size: $(du -h "$HERE/t3-artifact.tgz" | cut -f1)"

echo "[smoke] building clean-machine image (npm install -g is the install test)"
docker build -f "$HERE/Dockerfile.smoke" -t d4research-smoke "$HERE"

echo "[smoke] running lifecycle"
docker run --rm d4research-smoke

echo "[smoke] P0 distribution smoke PASS"
