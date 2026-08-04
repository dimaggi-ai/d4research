# T3 Research contributor guidance

- Keep the run ledger provider-neutral. Provider-specific protocol handling belongs in adapters.
- SQLite is the authoritative local state; external memory connectors are optional mirrors or explicit query targets.
- Never persist provider credentials or Meko authorization in SQLite or browser storage.
- Long-running research must expose persisted stage events, cancellation, and bounded provider timeouts.
- Tests wait on orchestrator completion or persisted milestones, never arbitrary sleeps.
- Use `bun test` and `bun run typecheck` for focused validation.
- `scripts/docker-qa.sh` must own a unique Compose project and remove its containers, network, volume, and temporary files on every exit.
- Do not expose host coding-agent credentials inside the default Docker image. Use an explicit bridge or provider API.
