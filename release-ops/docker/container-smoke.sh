#!/usr/bin/env bash
# Runs inside the smoke container. Exercises the P0 lifecycle against the
# globally installed artifact: first launch, pairing, restart persistence,
# update-in-place, uninstall. Exits nonzero on the first broken step.
set -euo pipefail

export T3CODE_HOME=/data
export T3CODE_HOST=127.0.0.1
export T3CODE_PORT=3773
export T3CODE_NO_BROWSER=1

ORIGIN="http://127.0.0.1:3773"
SERVER_PID=""

say() { echo "[smoke] $*"; }

fail() {
  say "FAIL: $*"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  exit 1
}

start_server() {
  d4research >/tmp/d4research-server.log 2>&1 &
  SERVER_PID=$!
}

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$SERVER_PID" 2>/dev/null || { SERVER_PID=""; return 0; }
    sleep 1
  done
  fail "server did not stop within 30s"
}

wait_healthy() {
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$ORIGIN/" || true)
    if [ "$code" = "200" ]; then return 0; fi
    kill -0 "$SERVER_PID" 2>/dev/null || {
      say "server process exited during startup; last log lines:"
      tail -20 /tmp/d4research-server.log
      fail "startup crash"
    }
    sleep 1
  done
  say "no 200 from $ORIGIN within 60s; last log lines:"
  tail -20 /tmp/d4research-server.log
  fail "first launch never became healthy"
}

say "== step 1: first launch on a clean home"
start_server
wait_healthy
[ -f /data/userdata/state.sqlite ] || fail "state.sqlite was not created under T3CODE_HOME"
say "first launch healthy, state created"

say "== step 2: pairing CLI mints a link against the live server"
PAIR_OUT=$(d4research pair 2>&1) || fail "d4research pair exited nonzero: $PAIR_OUT"
echo "$PAIR_OUT" | grep -Eq "http" || fail "d4research pair printed no URL: $PAIR_OUT"
say "pair output carries a URL"

say "== step 3: restart preserves state"
stop_server
start_server
wait_healthy
[ -f /data/userdata/state.sqlite ] || fail "state.sqlite lost across restart"
say "restart healthy with persisted state"

say "== step 4: update-in-place (reinstall artifact over live state)"
stop_server
npm install -g /smoke/d4research-artifact.tgz >/dev/null 2>&1 || fail "reinstall failed"
start_server
wait_healthy
say "updated install serves the same state"

say "== step 5: uninstall leaves nothing on PATH"
stop_server
npm rm -g d4research >/dev/null 2>&1 || fail "npm rm -g d4research failed"
if command -v d4research >/dev/null 2>&1; then fail "d4research still on PATH after uninstall"; fi
say "uninstall clean"

say "SMOKE PASS"
