---
name: update-docs
description: Review the whole d2research codebase and bring docs/ plus the product contracts spec up to date. Use when asked to "update docs", "refresh documentation", "update product contracts", "update specs", or after landing a feature that changes architecture, providers, tool guard, handoff, or the contracts package.
---

# Update Project Documentation & Product Contracts

Regenerate and verify the documentation set in `docs/` and the product-contract
spec derived from `packages/contracts/src`. Every claim written into docs MUST
be verified against current source — never copy forward stale prose.

## Scope

- `docs/README.md` — index; must list every doc file with a one-line description.
- `docs/architecture/` — cross-cutting design docs.
- `docs/internals/` — subsystem internals (providers, tool-guard, handoff
  compression, connection runtime, workspace layout, CI, scripts…).
- `docs/internals/product-contracts.md` — **generated spec** of the contracts
  package: one section per module in `packages/contracts/src/*.ts` (skip
  `*.test.ts`), stating what the module governs, its key exported
  schemas/unions, and which sides consume it (server / web / desktop / mobile).
- `docs/operations/` — release, observability, QA.
- `docs/user/` — user-facing guides (install, providers, tool guard,
  permission modes, keybindings…).

## Procedure

1. **Diff-driven survey.** `git log --oneline -60` and `git diff --stat
<last-docs-commit>..HEAD` to find what changed since docs were last touched
   (find it with `git log --oneline -20 -- docs/`). Read the touched
   subsystems' source, not just commit messages.
2. **Contracts spec.** Enumerate `packages/contracts/src/*.ts` and compare
   against the section list in `docs/internals/product-contracts.md`. Add
   sections for new modules, delete sections for removed ones, and update key
   exports (schemas, unions, method maps like `WS_METHODS` /
   `ORCHESTRATION_WS_METHODS`) where they changed. Note cross-module
   relationships (rpc.ts aggregation, environmentHttp.ts HTTP mirror,
   baseSchemas.ts branded IDs).
3. **Verify stale claims.** For each doc that names counts, defaults, paths,
   env vars, model lists, or port numbers, grep the source for the current
   value (e.g. built-in driver list in
   `apps/server/src/provider/builtInDrivers.ts`, tool-guard mode mapping in
   `apps/server/src/provider/toolGuardRuntime.ts`, handoff defaults in
   `packages/contracts/src/settings.ts`). Fix in place.
4. **Coverage check.** Confirm docs exist for: provider adapter system + each
   built-in driver, tool guard (modes, managed lifecycle, external hooks,
   policy editor), provider handoff + local Memo + context compression,
   composer (mentions/skills/slash commands), context-window & token usage,
   preview/browser automation, settings surface, workspace file
   index/browser. Create a missing doc in the matching directory, following
   neighboring files' tone and heading style.
5. **Index.** Update `docs/README.md` so it lists exactly the current doc
   files.
6. **Fan out when large.** If more than ~3 subsystems changed, delegate one
   read-only exploration subagent per subsystem (providers, tool-guard,
   web/composer, contracts) and write docs from their verified reports; keep
   authorship (the writing) in one place for consistent voice.

## Rules

- Only modify files under `docs/`. Never "fix" code to match docs — file the
  discrepancy in the final report instead.
- Keep the existing four-directory taxonomy; do not invent new top-level dirs.
- Cite nothing you have not confirmed in code during this run.
- Do not commit unless explicitly asked; leave changes for review.
- Finish with a report: files created/updated (one line each) + a list of
  code-vs-docs discrepancies that need a human/code decision.
