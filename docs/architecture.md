# Architecture

## Durable run ownership

`ResearchRun` owns the question, approved plan, status, selected provider, messages, evidence memories, report, and event history. Provider sessions are replaceable execution details. A handoff writes a context checkpoint and changes `activeProviderId`; it does not create another run or discard the original chat.

## Execution paths

- Chat appends user and assistant messages to the run and records which provider produced each assistant turn.
- Deep research moves through planning, approval, parallel evidence collection, synthesis, and audit.
- Every stage emits persisted events. The UI polls the read model, while MCP clients use the same orchestration methods.
- Cancellation is explicit. New provider work is bounded by adapter timeouts.

## Memory

- Local SQLite plus FTS is authoritative and enabled by default.
- Memo implements the local `/health`, `/add`, and `/search` REST contract.
- Meko implements JSON-RPC `tools/call` over Streamable HTTP using `memory_add` and `memory_search`.
- External credentials remain environment-only. `T3RESEARCH_MEKO_AUTHORIZATION` is never returned to the client or written to SQLite.

Future vector indexing should augment SQLite search, not replace the durable text ledger. Sources, citations, evidence, reports, and audits are recorded in SQLite with SHA-256 content hashes; larger source snapshots can later move to content-addressed files while keeping those hashes in the ledger.

## Provider policy

- `mock` is deterministic and only for QA.
- `ollama` is the default private/local inference path.
- Codex, Claude Code, and Agy support non-interactive generation.
- Junie is implemented as a CLI adapter but should remain disabled for unattended runs wherever its process does not terminate reliably.
- Managed deep-research providers should be optional adapters. The local run ledger remains authoritative even when a provider offers its own stored interaction ID.

## T3 Code integration

T3 Code or any coding agent can attach to `POST /mcp`. The initial tool set covers run creation, status, execution, provider handoff, shared-context chat, and memory remember/search. HTTP endpoints back the installation UI and provide the same operations.
