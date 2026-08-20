#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="${T3CODE_DEPLOY_REPOSITORY_ROOT:-$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)}"
readonly APP_URL="${T3CODE_DEPLOY_APP_URL:-http://127.0.0.1:3773}"
readonly VOICE_URL="${T3CODE_DEPLOY_VOICE_URL:-http://127.0.0.1:8093/health}"
readonly READY_TIMEOUT_SECONDS="${T3CODE_DEPLOY_READY_TIMEOUT_SECONDS:-180}"
readonly RESTART_MODE="${T3CODE_DEPLOY_RESTART_MODE:-systemd}"
readonly REQUIRE_VOICE="${T3CODE_DEPLOY_REQUIRE_VOICE:-1}"
readonly RESTART_UNIT="d4research-restart"
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
  log_path="$(mktemp --tmpdir "d4research-deploy.XXXXXX.log")"

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
  local started_at=$SECONDS
  local last_report_at=$SECONDS

  until curl --fail --silent --show-error --connect-timeout 2 --max-time 10 "$url" >/dev/null; do
    if ((SECONDS >= deadline)); then
      echo "$name did not become ready within ${READY_TIMEOUT_SECONDS}s: $url" >&2
      return 1
    fi
    if ((SECONDS - last_report_at >= 5)); then
      last_report_at=$SECONDS
      echo "$name: waiting for readiness ($((SECONDS - started_at))s elapsed)"
    fi
    sleep 0.25
  done
  echo "$name: ready after $((SECONDS - started_at))s"
}

restart_journal_has_forced_shutdown() {
  local journal_cursor="$1"
  journalctl \
    --user \
    --unit d4research.service \
    --after-cursor "$journal_cursor" \
    --no-pager \
    --output cat 2>/dev/null | grep -Eq \
    "State 'stop-sigterm' timed out|Killing process .* with signal SIGKILL|Main process exited, code=killed|Failed with result 'timeout'"
}

restart_worker_loaded() {
  local unit load_state
  for unit in "${RESTART_UNIT}.timer" "${RESTART_UNIT}.service"; do
    load_state="$(systemctl --user show --property=LoadState --value "$unit" 2>/dev/null || true)"
    if [[ -n "$load_state" && "$load_state" != "not-found" ]]; then
      return 0
    fi
  done
  return 1
}

run_under_deploy_lock() {
  if [[ "${T3CODE_DEPLOY_LOCK_HELD:-0}" == "1" ]]; then
    return
  fi
  local runtime_directory="${XDG_RUNTIME_DIR:-/tmp}"
  local lock_path="${runtime_directory}/d4research-deploy-${UID}.lock"
  local exit_code=0
  flock \
    --conflict-exit-code 75 \
    --nonblock \
    --close \
    "$lock_path" \
    /usr/bin/env T3CODE_DEPLOY_LOCK_HELD=1 /usr/bin/bash "$SCRIPT_DIRECTORY/deploy-local.sh" "$@" ||
    exit_code=$?
  if [[ "$exit_code" == "75" ]]; then
    echo "pre-deploy: another d4research build or deploy is already running" >&2
  fi
  exit "$exit_code"
}

cd "$REPOSITORY_ROOT"

if [[ "${1:-}" == "--complete-restart" ]]; then
  if [[ "$RESTART_MODE" != "systemd" ]]; then
    echo "restart-worker: unsupported restart mode '$RESTART_MODE'" >&2
    exit 2
  fi
  restart_journal_cursor="$(journalctl --user --unit d4research.service --show-cursor --lines=0 --no-pager | sed -n 's/^-- cursor: //p')"
  if [[ -z "$restart_journal_cursor" ]]; then
    echo "restart-worker: could not capture the pre-restart journal cursor" >&2
    exit 1
  fi
  echo "restart-worker: restarting d4research outside the active T3 session"
  systemctl --user restart d4research.service
  if restart_journal_has_forced_shutdown "$restart_journal_cursor"; then
    echo "restart-worker: old d4research process required a forced shutdown" >&2
    journalctl \
      --user \
      --unit d4research.service \
      --after-cursor "$restart_journal_cursor" \
      --no-pager \
      --lines=80 >&2
    exit 1
  fi
  wait_for_url "d4research manifest" "$APP_URL/manifest.webmanifest"
  wait_for_url "d4research" "$APP_URL/"
  if [[ "$REQUIRE_VOICE" == "1" ]]; then
    wait_for_url "Local voice service" "$VOICE_URL"
  fi
  echo "restart-worker: d4research and local voice are ready"
  exit 0
fi

run_under_deploy_lock "$@"

if [[ "$RESTART_MODE" == "systemd" ]] && restart_worker_loaded; then
  echo "pre-deploy: ${RESTART_UNIT} is still scheduled or running; retry after it completes" >&2
  exit 75
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

echo "build: validating and bundling d4research with bounded steps"
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

echo "restart: scheduling detached readiness worker ${RESTART_UNIT} in 5s"
systemd-run \
  --user \
  --quiet \
  --collect \
  --unit "$RESTART_UNIT" \
  --on-active=5s \
  /usr/bin/bash "$REPOSITORY_ROOT/scripts/deploy-local.sh" --complete-restart

echo "deployed: build complete; detached restart scheduled"
echo "restart logs: journalctl --user -u ${RESTART_UNIT}.service --no-pager"
