# T3 Research

Local-first, provider-neutral deep research orchestration for T3 Code.

T3 Research keeps the run, plan, evidence, citations, decisions, and artifacts in a durable shared ledger. Codex, Claude Code, Agy, Junie, Ollama, and future remote research agents are replaceable workers rather than owners of the conversation.

## Run with Docker

```bash
docker compose up --build -d
```

Open <http://127.0.0.1:7341/setup>. The installation screen discovers configured providers, runs bounded health checks, creates a plan, executes research, displays status, and supports provider handoff.

Ollama defaults to `host.docker.internal:11434`. CLI agents must be installed inside the container or exposed through a purpose-built remote adapter; the installation test reports them unavailable instead of claiming they work.

## Test

```bash
bun test
bun run typecheck
bash scripts/docker-qa.sh
```

The Docker QA script builds and starts an isolated deployment, verifies UI/API/MCP and a complete deterministic research lifecycle, then removes its containers, network, and volume on success, failure, or interruption.

## MCP

The Streamable HTTP endpoint is `POST /mcp`. Initial tools cover starting/status/execution/handoff, shared-run chat, and memory remember/search.

The same run can chat with one provider, hand off, and continue with another provider. Messages and memory remain attached to the run; provider session IDs never become the source of truth.

## Privacy model

SQLite and indexed memory are local by default. A run chooses a provider explicitly. Cloud providers are adapters and should receive a bounded context packet rather than the entire event history. Provider egress policy and source-level privacy labels are planned before enabling unattended cloud research.
