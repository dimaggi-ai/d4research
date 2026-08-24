# Merging upstream T3 Code

d4research forked from `pingdotgg/t3code` and renamed its identity surface
(`@t3tools/*` → `@d4research/*`, npm/bin `t3` → `d4research`, Effect tags
`"t3/…"` → `"d4research/…"`, bundle id `com.t3tools.t3code` →
`ai.dimaggi.d4research`). A naive `git merge upstream/main` is worse than it
looks: measured against 292 upstream commits (2026-08-23), it cleanly merges
upstream hunks carrying the old names into ~187 files — the merge "succeeds"
and the build is silently broken.

`release-ops/merge-upstream.sh` fixes this by rebranding upstream on a helper
branch first, so the merge compares like against like.

## Procedure

```sh
bash release-ops/merge-upstream.sh prepare   # fetch upstream, build rebranded branch
bash release-ops/merge-upstream.sh preview   # dry run: conflict counts + leak scan
bash release-ops/merge-upstream.sh merge     # real merge; stops on conflicts
# … resolve conflicts (rules below) …
bash release-ops/merge-upstream.sh rename    # re-neutralize old names in resolved files
bash release-ops/merge-upstream.sh check     # hard gate: no upstream identifiers
vp i && vp test run <touched areas>          # then targeted lint/typecheck
```

`prepare` transforms only the files upstream modified since the merge-base.
Do not "improve" it to transform everything: that converts clean ours-wins
merges into artificial conflicts (measured +66 content, +96 modify/delete).

Baseline expectations (upstream/main at 292 commits ahead): ~176 content
conflicts, ~41 modify/delete conflicts, zero identifier leaks in surviving
files. Substantially worse numbers mean the rename map has drifted — fix the
map in `release-ops/merge-upstream.sh` before merging.

## Conflict-resolution rules

- **`package.json` version fields**: keep ours. The d4research release line
  (0.2.0+) is deliberately isolated from upstream's versioning.
- **`pnpm-lock.yaml`**: take ours (`git checkout --ours pnpm-lock.yaml`), then
  `vp i` after the merge to fold in upstream's dependency changes.
- **Deleted-by-us clusters**: `git rm` anything upstream modified or added
  under the removed integrations — `infra/relay/`, `apps/server/src/{relay,
telemetry,cloud (except bootService/pinnedRuntime/selfUpdate),pullRequest,
sourceControl}/`, `apps/web/src/cloud/`, `apps/web/src/components/{clerk,
cloud}/`, `apps/mobile/src/features/{cloud,observability,agent-awareness}/`,
  Clerk/vercel/web-preview workflow files. Reconsider only if upstream's
  change reveals functionality we actually depend on.
- **Heavily hand-edited files** (real semantic conflicts; read both sides):
  `apps/server/src/server.ts` and its tests, `packages/client-runtime/src/
{authorization,connection}/`, `packages/shared/src/connectAuth.ts`,
  `scripts/build-desktop-artifact.ts`, `.github/workflows/release.yml`,
  `docs/`, `README.md`, `AGENTS.md`.

## Names that must NOT be renamed

The fork keeps T3 compatibility names on purpose. The map and the `check`
gate already know these; keep it that way when editing either:

- `T3CODE_*` env vars, `t3.json`, `t3code://`/`t3code-dev://` schemes,
  `t3_session` cookie, `t3code:` localStorage keys, `~/.t3` home dir.
- `t3.codes` domains, `oxlint-plugin-t3code` and the `t3code/` lint-rule
  namespace, the `t3code/pr-NNN` branch prefix.
- `com.t3tools.{composereditor,nativecontrols,reviewdiff,terminal}` gradle
  groups (only the full `com.t3tools.t3code` app id was renamed).
- Branch-name fixtures `"t3/newer"` etc. in
  `apps/web/src/components/BranchToolbar.logic.test.ts`.
- `pingdotgg/t3code` in test fixtures (GitManager, pull-request and
  source-control suites, thread-transfer report) and README attribution.
  Only the six release/desktop-update/marketing sites use the fork slug.
- The acp-mock fixture `"name": "t3"` in
  `apps/server/scripts/acp-mock-agent.ts`.
- Fork docs sentences contrasting "the upstream `npx t3`" with this fork
  (README, docs/user/\*). The rename map skips lines containing "upstream".

## Known gaps the check gate tolerates

`docs/internals/server-updates.md` and `docs/user/background-service.md` still
show `npx t3@…` / `npm view t3@…`
command examples from before the fork. `merge-upstream.sh rename` fixes the
genuinely-ours ones; remove the corresponding `KNOWN_GAP_EXCLUDES` entries in
the script once that lands.
