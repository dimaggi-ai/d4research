#!/usr/bin/env bash
set -euo pipefail

VOICE_PID=""
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$VOICE_PID" ]] && kill -0 "$VOICE_PID" 2>/dev/null; then
    kill -TERM "$VOICE_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

node /opt/t3-qa/mock-local-control.mjs &
VOICE_PID=$!

voice_deadline=$((SECONDS + 15))
until curl --fail --silent --max-time 2 http://127.0.0.1:8093/health >/dev/null; do
  if ! kill -0 "$VOICE_PID" 2>/dev/null; then
    echo "docker-qa: mock local-control service exited before readiness" >&2
    exit 1
  fi
  if ((SECONDS >= voice_deadline)); then
    echo "docker-qa: mock local-control service missed its 15s readiness deadline" >&2
    exit 1
  fi
  sleep 0.2
done
echo "docker-qa: mock local-control service ready"

test -s /app/dist/bin.mjs
test -s /app/dist/client/manifest.webmanifest
touch /tmp/t3code-deployment-complete

node /app/dist/bin.mjs \
  --base-dir /state \
  --host 0.0.0.0 \
  --port 3773 \
  --no-browser &
APP_PID=$!

echo "docker-qa: T3 Code started as pid $APP_PID"
wait "$APP_PID"
