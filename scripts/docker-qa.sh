#!/usr/bin/env bash
set -Eeuo pipefail

project="t3research-qa"
port="17341"
base_url="http://127.0.0.1:${port}"
qa_tmp="$(mktemp -d)"

docker_cleanup() {
  echo "[qa] removing test containers, network, and volume"
  T3RESEARCH_PORT="$port" docker compose -p "$project" down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
}

cleanup() {
  docker_cleanup
  rm -rf -- "$qa_tmp"
}
trap cleanup EXIT INT TERM

docker_cleanup
echo "[qa] building and starting isolated Docker deployment"
T3RESEARCH_PORT="$port" docker compose -p "$project" up --build --detach

echo "[qa] waiting up to 60 seconds for the health milestone"
ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$base_url/health" > "$qa_tmp/health.json"; then
    ready=1
    break
  fi
  if (( attempt % 10 == 0 )); then
    echo "[qa] still waiting (${attempt}s)"
    T3RESEARCH_PORT="$port" docker compose -p "$project" ps
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  T3RESEARCH_PORT="$port" docker compose -p "$project" logs --no-color --tail 200
  exit 1
fi

grep -q '"status":"ok"' "$qa_tmp/health.json"
curl --fail --silent --show-error --max-time 5 "$base_url/setup" | grep -q 'Create and plan'
curl --fail --silent --show-error --max-time 5 "$base_url/setup" | grep -q 'Insert #deep-research'
curl --fail --silent --show-error --max-time 5 "$base_url/icon.svg" | grep -q 'T3 Research'
curl --fail --silent --show-error --max-time 5 "$base_url/manifest.webmanifest" | grep -q '"display":"standalone"'
curl --fail --silent --show-error --max-time 5 -X POST "$base_url/api/providers/local-mock/probe" | grep -q '"ok":true'
curl --fail --silent --show-error --max-time 5 -X POST "$base_url/api/providers" -H 'content-type: application/json' --data '{"id":"docker-second-mock","name":"Docker second mock","driver":"mock","model":"deterministic-v1","endpoint":"","command":"","enabled":true}' >/dev/null

echo "[qa] creating and planning a deterministic research run"
run_json="$(curl --fail --silent --show-error --max-time 10 -X POST "$base_url/api/runs" -H 'content-type: application/json' --data '{"title":"Docker QA","question":"#deep-research [local-mock, docker-second-mock] Prove the installed research lifecycle works","providerId":"local-mock","depth":"quick"}')"
run_id="$(node -e 'const value=JSON.parse(process.argv[1]); if(value.status!=="awaiting_approval" || value.depth!=="deep" || value.question.startsWith("#deep-research") || value.providerChainIds.join(",")!=="local-mock,docker-second-mock") process.exit(2); process.stdout.write(value.id)' "$run_json")"
chat_json="$(curl --fail --silent --show-error --max-time 10 -X POST "$base_url/api/runs/$run_id/chat" -H 'content-type: application/json' --data '{"text":"Continue this run with shared context."}')"
node -e 'const value=JSON.parse(process.argv[1]); if(value.assistant.text!=="Shared-context chat reply from the active provider.") process.exit(2)' "$chat_json"
curl --fail --silent --show-error --max-time 5 -X POST "$base_url/api/runs/$run_id/execute" >/dev/null

echo "[qa] waiting up to 30 seconds for research completion"
completed=0
for attempt in $(seq 1 30); do
  detail="$(curl --fail --silent --show-error --max-time 3 "$base_url/api/runs/$run_id")"
  status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).run.status)' "$detail")"
  if [[ "$status" == "completed" ]]; then completed=1; break; fi
  if [[ "$status" == "failed" || "$status" == "cancelled" ]]; then echo "$detail"; exit 1; fi
  sleep 1
done
[[ "$completed" == "1" ]]
node -e 'const value=JSON.parse(process.argv[1]); if(!value.run.report.includes("Research report")) process.exit(2); if(!value.events.some((event)=>event.type==="audit.completed")) process.exit(3)' "$detail"
node -e 'const value=JSON.parse(process.argv[1]); if(value.sources.length<1 || value.citations.length<1) process.exit(4); const kinds=value.artifacts.map((item)=>item.kind); for(const kind of ["evidence","report","audit"]) if(!kinds.includes(kind)) process.exit(5)' "$detail"
node -e 'const value=JSON.parse(process.argv[1]); const workers=value.events.filter((event)=>event.type==="worker.started").map((event)=>event.providerId); if(workers.join(",")!=="local-mock,docker-second-mock,local-mock" || value.events.filter((event)=>event.type==="task.handoff").length!==4) process.exit(6)' "$detail"
curl --fail --silent --show-error --max-time 5 "$base_url/api/runs/$run_id/export" | grep -q "## Sources"

echo "[qa] validating MCP discovery"
curl --fail --silent --show-error --max-time 5 -X POST "$base_url/mcp" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -q 'research_chat'

echo "[qa] PASS: UI, provider probe, task-level agent handoff, shared chat, research lifecycle, persistence API, and MCP are working"
