#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="${T3CODE_DEPLOY_REPOSITORY_ROOT:-$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)}"
readonly APP_URL="${T3CODE_DEPLOY_APP_URL:-http://127.0.0.1:3773}"
readonly VOICE_URL="${T3CODE_DEPLOY_VOICE_URL:-http://127.0.0.1:8093/health}"
readonly READY_TIMEOUT_SECONDS="${T3CODE_DEPLOY_READY_TIMEOUT_SECONDS:-20}"
readonly RESTART_MODE="${T3CODE_DEPLOY_RESTART_MODE:-systemd}"
readonly REQUIRE_VOICE="${T3CODE_DEPLOY_REQUIRE_VOICE:-1}"
CURRENT_RUNNER_PID=""

cleanup_runner() {
  if [[ -n "$CURRENT_RUNNER_PID" ]] && kill -0 "$CURRENT_RUNNER_PID" 2>/dev/null; then
    kill -TERM "$CURRENT_RUNNER_PID" 2>/dev/null || true
    wait "$CURRENT_RUNNER_PID" 2>/dev/null || true
  fi
}

trap cleanup_runner EXIT INT TERM

run_with_heartbeat() {
  local name="$1"
  local timeout_seconds="$2"
  shift 2
  local log_path
  local started_at=$SECONDS
  local last_heartbeat_at=$SECONDS
  local previous_size=0
  log_path="$(mktemp --tmpdir "t3code-deploy.XXXXXX.log")"

  echo "$name: started (deadline ${timeout_seconds}s)"
  timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" "$@" >"$log_path" 2>&1 &
  CURRENT_RUNNER_PID=$!

  while kill -0 "$CURRENT_RUNNER_PID" 2>/dev/null; do
    sleep 1
    if ! kill -0 "$CURRENT_RUNNER_PID" 2>/dev/null; then
      break
    fi
    if ((SECONDS - last_heartbeat_at < 10)); then
      continue
    fi
    last_heartbeat_at=$SECONDS
    local current_size
    current_size="$(wc -c <"$log_path")"
    echo "$name: running for $((SECONDS - started_at))s"
    if [[ "$current_size" -gt "$previous_size" ]]; then
      tail -n 4 "$log_path"
      previous_size="$current_size"
    else
      echo "$name: no new output in the last 10s"
    fi
  done

  local exit_code=0
  wait "$CURRENT_RUNNER_PID" || exit_code=$?
  CURRENT_RUNNER_PID=""
  if [[ "$exit_code" -ne 0 ]]; then
    echo "$name: failed after $((SECONDS - started_at))s (exit $exit_code)" >&2
    tail -n 80 "$log_path" >&2
    rm -f "$log_path"
    return "$exit_code"
  fi
  echo "$name: completed in $((SECONDS - started_at))s"
  tail -n 12 "$log_path"
  rm -f "$log_path"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))

  until curl --fail --silent --show-error --max-time 2 "$url" >/dev/null; do
    if ((SECONDS >= deadline)); then
      echo "$name did not become ready within ${READY_TIMEOUT_SECONDS}s: $url" >&2
      return 1
    fi
    sleep 0.25
  done
}

cd "$REPOSITORY_ROOT"

if [[ "${1:-}" == "--complete-restart" ]]; then
  if [[ "$RESTART_MODE" != "systemd" ]]; then
    echo "restart-worker: unsupported restart mode '$RESTART_MODE'" >&2
    exit 2
  fi
  echo "restart-worker: restarting T3 Code outside the active T3 session"
  systemctl --user restart t3code.service
  wait_for_url "T3 Code" "$APP_URL/"
  wait_for_url "T3 Code manifest" "$APP_URL/manifest.webmanifest"
  if [[ "$REQUIRE_VOICE" == "1" ]]; then
    wait_for_url "Local voice service" "$VOICE_URL"
  fi
  echo "restart-worker: T3 Code and local voice are ready"
  exit 0
fi

if [[ "$REQUIRE_VOICE" == "1" ]]; then
  echo "pre-deploy: checking persistent local voice service"
  if [[ "$RESTART_MODE" == "systemd" ]]; then
    systemctl --user is-active --quiet mission-control.service
  fi
  wait_for_url "Local voice service" "$VOICE_URL"
else
  echo "pre-deploy: local voice readiness check disabled"
fi

echo "build: validating and bundling T3 Code with bounded steps"
run_with_heartbeat "Web typecheck" 120 vp run --filter @t3tools/web typecheck
run_with_heartbeat "Web build" 180 vp run --filter @t3tools/web build
run_with_heartbeat "Server build" 180 node apps/server/scripts/cli.ts build

if [[ "${1:-}" == "--build-only" || "$RESTART_MODE" == "build-only" ]]; then
  echo "deployed: build artifacts are ready (restart delegated to container/runtime)"
  exit 0
fi

if [[ "$RESTART_MODE" != "systemd" ]]; then
  echo "restart: unsupported mode '$RESTART_MODE'" >&2
  exit 2
fi

restart_unit="t3code-restart-$(date +%s)-$$"
echo "restart: scheduling detached readiness worker ${restart_unit} in 5s"
systemd-run \
  --user \
  --quiet \
  --unit "$restart_unit" \
  --on-active=5s \
  /usr/bin/bash "$REPOSITORY_ROOT/scripts/deploy-local.sh" --complete-restart

echo "deployed: build complete; detached restart scheduled"
echo "restart logs: journalctl --user -u ${restart_unit}.service --no-pager"
