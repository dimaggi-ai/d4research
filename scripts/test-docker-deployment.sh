#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly COMPOSE_FILE="$REPOSITORY_ROOT/compose.qa.yaml"
readonly PROJECT_NAME="${T3CODE_QA_PROJECT_NAME:-t3code-qa}"
readonly QA_PORT="${T3CODE_QA_PORT:-18080}"
readonly QA_URL="http://127.0.0.1:${QA_PORT}"
readonly KEEP_ENVIRONMENT="${T3CODE_QA_KEEP:-0}"
COMPOSE=(docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE")

cleanup() {
  if [[ "$KEEP_ENVIRONMENT" == "1" ]]; then
    echo "docker-qa: retaining stack at $QA_URL"
    return
  fi
  echo "docker-qa: removing containers, network, and QA state volume"
  "${COMPOSE[@]}" down --volumes --remove-orphans
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$REPOSITORY_ROOT"
echo "docker-qa: building image (deadline 8m; Docker output is the progress signal)"
timeout --signal=TERM --kill-after=10s 480s docker compose --progress plain \
  --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" build

echo "docker-qa: starting stack (deadline 4m; service health is the milestone)"
timeout --signal=TERM --kill-after=10s 240s "${COMPOSE[@]}" up --detach --wait --wait-timeout 220

echo "docker-qa: verifying deployment marker and local Agy"
"${COMPOSE[@]}" exec -T t3code test -f /tmp/t3code-deployment-complete
"${COMPOSE[@]}" exec -T t3code agy models | grep -Fq "gemini-3.6-flash-medium"

echo "docker-qa: verifying T3, PWA, monitor, and same-origin voice"
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$QA_URL/" >/dev/null
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$QA_URL/manifest.webmanifest" \
  | jq -e '.display == "standalone" and .start_url == "/"' >/dev/null
service_worker="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  "$QA_URL/service-worker.js")"
grep -Fq 't3code-static-' <<<"$service_worker"
if grep -Fq '__T3CODE_BUILD_ID__' <<<"$service_worker"; then
  echo "docker-qa: service worker build id was not stamped" >&2
  exit 1
fi
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$QA_URL/api/system-monitor" \
  | jq -e '.gpu.name == "Docker QA GPU" and .services[0].active == true' >/dev/null
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$QA_URL/voice/health" \
  | jq -e '.ok == true and .stt == "small.en"' >/dev/null
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  --form 'audio=@/dev/null;filename=voice.webm;type=audio/webm' \
  "$QA_URL/voice/transcribe" | jq -e '.text == "docker voice test"' >/dev/null
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  --data-urlencode 'text=Docker voice reply' "$QA_URL/voice/summarize" \
  | jq -e '.text == "The Docker voice summary is ready to hear."' >/dev/null
tts_type="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  --output /dev/null --write-out '%{content_type}' \
  --data 'text=Docker+reply' "$QA_URL/voice/tts")"
[[ "$tts_type" == "audio/wav" ]]

echo "docker-qa: PASS deployment, PWA, system monitor, Agy, STT, summary, and TTS"

if [[ "$KEEP_ENVIRONMENT" != "1" ]]; then
  cleanup
  trap - EXIT INT TERM
  if [[ -n "$("${COMPOSE[@]}" ps --quiet)" ]]; then
    echo "docker-qa: teardown failed; project containers remain" >&2
    exit 1
  fi
  if docker volume inspect "${PROJECT_NAME}_t3code-qa-state" >/dev/null 2>&1; then
    echo "docker-qa: teardown failed; QA state volume remains" >&2
    exit 1
  fi
  echo "docker-qa: PASS teardown removed the complete QA stack"
fi
