#!/usr/bin/env bash
# Merge upstream T3 Code (pingdotgg/t3code) into d4research without drowning in
# rename noise, and without silently reintroducing upstream identifiers.
#
# Why this exists: d4research renamed @t3tools/* -> @d4research/*, npm/bin
# t3 -> d4research, "t3/..." Effect service tags -> "d4research/...", and
# com.t3tools.t3code -> ai.dimaggi.d4research. A naive `git merge upstream/main`
# is measured (2026-08-23, 292 upstream commits) to *cleanly* merge upstream
# hunks carrying old names into ~187 files — a silently broken tree. This script
# pre-applies the rename map to the files upstream touched, so the merge sees
# both sides speaking the same names: reintroductions drop to ~zero and every
# remaining conflict is a real semantic conflict.
#
# Usage:
#   bash release-ops/merge-upstream.sh prepare [upstream-ref]  # build rebranded upstream branch
#   bash release-ops/merge-upstream.sh preview                 # dry-run merge, count conflicts + leaks
#   bash release-ops/merge-upstream.sh merge                   # merge the prepared branch (resolve by hand)
#   bash release-ops/merge-upstream.sh rename [path...]        # apply rename map to working tree (idempotent)
#   bash release-ops/merge-upstream.sh check                   # fail if upstream identifiers leaked
#
# Typical flow:  prepare -> preview -> merge -> resolve -> rename -> check -> test.
# Conflict-resolution rules live in docs/operations/upstream-merge.md.
set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/pingdotgg/t3code"
REBRAND_BRANCH="d4research/upstream-rebrand"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Branch-name test fixtures ("t3/newer", "t3/live", ...) legitimately keep the
# t3/ prefix; every other quoted "t3/..." is an Effect service tag we renamed.
BRANCH_FIXTURE_FILE="apps/web/src/components/BranchToolbar.logic.test.ts"

# pingdotgg/t3code is renamed ONLY at these sites. Everywhere else (README
# attribution, GitManager/PR/sourceControl test fixtures, thread-transfer
# report) the upstream slug is deliberate test data or lineage and must stay.
PINGDOTGG_RENAME_FILES="apps/marketing/src/lib/releases.ts
apps/marketing/src/lib/site.ts
apps/server/package.json
apps/web/src/components/desktopUpdate.logic.ts
apps/web/src/components/desktopUpdate.logic.test.ts
apps/web/src/components/desktopUpdate.toast.test.tsx"

# ---------------------------------------------------------------------------
# The rename map. These patterns deliberately do NOT touch the kept
# compatibility names: T3CODE_* env vars, t3.json, t3code/t3code-dev URL
# schemes, t3_session cookie, t3code: localStorage keys, ~/.t3 home,
# t3.codes domains, oxlint-plugin-t3code, com.t3tools.* gradle groups,
# the t3code/pr-NNN branch prefix, or the acp-mock `"name": "t3"` fixture.
# Extend here when the fork renames more.
# ---------------------------------------------------------------------------
apply_rename_map() { # args: files (text, tracked)
  [ "$#" -gt 0 ] || return 0
  perl -pi -e '
    s/com\.t3tools\.t3code/ai.dimaggi.d4research/g;
    s/\@t3tools/\@d4research/g;
    # Fork docs contrast "the upstream `npx t3`" against this fork on purpose;
    # AGENTS.md/README.md describe the inherited T3 Code lineage. Skip those.
    unless (/upstream/ || $ARGV =~ /(AGENTS|README)\.md$/) {
      s/npx t3\@/npx d4research\@/g;
      s/npx t3\b/npx d4research/g;
      s/bunx t3\b/bunx d4research/g;
    }
    s/\bt3\#/d4research#/g;
    s/npm view t3\@/npm view d4research\@/g;
    s/t3-artifact\.tgz/d4research-artifact.tgz/g;
    s/--filter t3(["\s]|$)/--filter d4research$1/g;
    s/--filter=t3\.\.\./--filter=d4research.../g;
    s{node_modules(\\+|\/)t3\1dist}{node_modules${1}d4research${1}dist}g;
    s/(["\x27\x60 (])t3\@(latest|nightly|\$|<|[0-9])/${1}d4research\@${2}/g;
  ' "$@"

  # Effect service tags: every quoted "t3/..." except branch-name fixtures.
  local tagfiles=()
  local f
  for f in "$@"; do
    case "$f" in
      "$BRANCH_FIXTURE_FILE"|*/"$BRANCH_FIXTURE_FILE") ;;
      *) tagfiles+=("$f") ;;
    esac
  done
  [ "${#tagfiles[@]}" -eq 0 ] || perl -pi -e 's/"t3\//"d4research\//g' "${tagfiles[@]}"

  # Surgical, file-targeted renames a global pattern cannot do safely.
  for f in "$@"; do
    case "$f" in
      apps/server/package.json|*/apps/server/package.json)
        perl -pi -e 's/"name": "t3"/"name": "d4research"/; s/"t3": "\.\/dist\/bin\.mjs"/"d4research": ".\/dist\/bin.mjs"/' "$f" ;;
      apps/server/scripts/cli.ts|*/apps/server/scripts/cli.ts)
        perl -pi -e 's/^(\s*)"t3",$/$1"d4research",/' "$f" ;;
    esac
    local p
    for p in $PINGDOTGG_RENAME_FILES; do
      case "$f" in
        "$p"|*/"$p") perl -pi -e 's/pingdotgg\/t3code/dimaggi-ai\/d4research/g' "$f" ;;
      esac
    done
  done
}

# Tracked text files, minus vendored/lockfile/patch paths we must never rewrite.
list_text_files() { # args: [pathspec...]
  git grep -Il '' -- "${@:-.}" \
    ':(exclude).repos' ':(exclude)pnpm-lock.yaml' ':(exclude)patches' \
    ':(exclude).plans' ':(exclude)apps/server/scripts/acp-mock-agent.ts' \
    2>/dev/null || true
}

ensure_upstream_remote() {
  git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 \
    || git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  git fetch "$UPSTREAM_REMOTE" --quiet
}

cmd_prepare() {
  local ref="${1:-$UPSTREAM_REMOTE/main}"
  ensure_upstream_remote
  local base; base="$(git merge-base HEAD "$ref")"
  local short; short="$(git rev-parse --short "$ref")"
  echo "upstream ref: $ref ($short), merge-base: ${base:0:9}"
  echo "upstream commits to merge: $(git rev-list --count HEAD.."$ref")"

  local wt; wt="$(mktemp -d /tmp/d4r-upstream-rebrand.XXXXXX)"
  git branch -f "$REBRAND_BRANCH" "$ref"
  git worktree add --force "$wt" "$REBRAND_BRANCH" >/dev/null
  trap 'git worktree remove --force "$wt" 2>/dev/null || true' EXIT

  # Transform ONLY files upstream modified since the merge-base. Touching more
  # turns clean ours-wins merges into artificial conflicts (measured: +66
  # content conflicts, +96 modify/delete when transforming everything).
  local listfile="$wt/.rebrand-files"
  # numstat marks binaries with "-"; use git's text classification, not GNU
  # grep's -I heuristic (which misreads source files containing NUL literals,
  # e.g. ChatComposer.tsx, as binary and silently skips them).
  # Disable rename compaction: numstat otherwise emits paths such as
  # `old => new`, which are not real filesystem names and silently skip every
  # renamed destination. As delete+add, the surviving new path is transformed.
  git diff --no-renames --numstat "$base" "$ref" | awk -F'\t' '$1 != "-" {print $3}' > "$listfile.all"
  : > "$listfile"
  local f
  while IFS= read -r f; do
    case "$f" in .repos/*|pnpm-lock.yaml|patches/*|apps/server/scripts/acp-mock-agent.ts) continue ;; esac
    [ -f "$wt/$f" ] || continue                  # dropped = deleted upstream
    printf '%s\n' "$f" >> "$listfile"
  done < "$listfile.all"
  echo "transforming $(wc -l < "$listfile") upstream-touched text files"

  (
    cd "$wt"
    mapfile -t files < .rebrand-files
    apply_rename_map "${files[@]}"
    rm -f .rebrand-files .rebrand-files.all
    git add -A
    git -c user.name="d4research-rebrand" -c user.email="rebrand@localhost" \
      commit --quiet --no-verify --allow-empty \
      -m "chore: mechanical d4research rebrand of upstream $short (merge helper)"
  )
  git worktree remove --force "$wt"
  trap - EXIT
  echo "prepared branch: $REBRAND_BRANCH"
  echo "next: bash release-ops/merge-upstream.sh preview"
}

# Patterns that must not exist outside known-good locations. Notably absent:
# pingdotgg/t3code (legitimate in test fixtures + README attribution) and bare
# `t3 serve`-style prose (kept lineage docs) — audit those by eye instead.
LEAK_PATTERNS='@t3tools
com\.t3tools\.t3code
"t3/
npx t3[ @]
bunx t3[ @]
npm view t3@
--filter t3($|[" ])
--filter=t3\.\.\.
t3-artifact\.tgz
node_modules[/\\]+t3[/\\]'

# Keep this list empty unless a compatibility identifier is both intentional
# and too narrowly scoped for the explicit exclusions above.
KNOWN_GAP_EXCLUDES=()

leak_grep() { # args: pattern, extra git-grep args...; returns 0 if leaks found
  local pat="$1"; shift
  local status=0
  git grep -nE -e "$pat" "$@" -- . \
    ':(exclude).repos' ':(exclude)pnpm-lock.yaml' ':(exclude)patches' \
    ':(exclude).plans' ':(exclude)release-ops/merge-upstream.sh' \
    ':(exclude)docs/operations/upstream-merge.md' \
    ":(exclude)$BRANCH_FIXTURE_FILE" \
    "${KNOWN_GAP_EXCLUDES[@]}" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "git grep failed while checking pattern '$pat' (status $status)" >&2
  fi
  return "$status"
}

cmd_check() {
  local bad=0 pat
  while IFS= read -r pat; do
    if leak_grep "$pat"; then
      echo "^^ LEAK: pattern '$pat' found" >&2
      bad=1
    else
      local status=$?
      if [ "$status" -gt 1 ]; then
        return "$status"
      fi
    fi
  done <<< "$LEAK_PATTERNS"
  if [ "$bad" -eq 0 ]; then
    echo "check clean: no upstream identifiers leaked"
  else
    echo "FAIL: upstream identifiers present — run: bash release-ops/merge-upstream.sh rename" >&2
  fi
  return "$bad"
}

cmd_preview() {
  git rev-parse --verify --quiet "$REBRAND_BRANCH" >/dev/null \
    || { echo "no $REBRAND_BRANCH branch — run prepare first" >&2; exit 1; }
  local out; out="$(mktemp)"
  local tree=""
  if git merge-tree --write-tree --name-only HEAD "$REBRAND_BRANCH" > "$out" 2>&1; then
    tree="$(head -1 "$out")"
    echo "CLEAN merge (no conflicts). Result tree: $tree"
  else
    tree="$(head -1 "$out")"
    echo "content conflicts:       $(grep -c '^CONFLICT (content)' "$out" || true)"
    echo "modify/delete conflicts: $(grep -c '^CONFLICT (modify/delete)' "$out" || true)"
    echo "--- conflicted files (first 40) ---"
    grep '^CONFLICT' "$out" | sed 's/^CONFLICT ([^)]*): //' | sort -u | awk 'NR<=40'
  fi
  echo "--- upstream-identifier leaks in the merged result (want: none outside deleted clusters) ---"
  echo "    (files under relay/cloud/clerk/telemetry/pullRequest/sourceControl are"
  echo "     modify/delete conflicts you will resolve with git rm — ignore those)"
  local pat leaks="" matches status
  while IFS= read -r pat; do
    status=0
    matches="$(git grep -lE -e "$pat" "$tree" 2>"$out.grep-error")" || status=$?
    if [ "$status" -gt 1 ]; then
      cat "$out.grep-error" >&2
      rm -f "$out" "$out.grep-error"
      return "$status"
    fi
    leaks+="$(printf '%s' "$matches" | sed "s/^$tree://")"$'\n'
  done <<< "$LEAK_PATTERNS"
  printf '%s' "$leaks" | grep -vE 'pnpm-lock|\.repos/|\.plans/|BranchToolbar\.logic\.test' \
    | grep -vE 'docs/(internals/server-updates|operations/release|user/background-service)\.md' \
    | sort -u | grep . || echo "none"
  rm -f "$out" "$out.grep-error"
}

cmd_merge() {
  git rev-parse --verify --quiet "$REBRAND_BRANCH" >/dev/null \
    || { echo "no $REBRAND_BRANCH branch — run prepare first" >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
  echo "merging $REBRAND_BRANCH into $(git branch --show-current)…"
  git merge --no-ff "$REBRAND_BRANCH" || {
    echo ""
    echo "Conflicts are expected. Resolve them, then run:"
    echo "  bash release-ops/merge-upstream.sh rename   # re-neutralize any old names"
    echo "  bash release-ops/merge-upstream.sh check    # gate before committing"
    echo "See docs/operations/upstream-merge.md for the resolution rules."
    exit 1
  }
}

cmd_rename() {
  local files
  mapfile -t files < <(list_text_files "$@")
  [ "${#files[@]}" -gt 0 ] || { echo "no matching text files"; return 0; }
  apply_rename_map "${files[@]}"
  git diff --stat | tail -3
  echo "rename pass done (idempotent — empty diffstat above means nothing needed renaming)"
}

case "${1:-}" in
  prepare) shift; cmd_prepare "$@" ;;
  preview) cmd_preview ;;
  merge)   cmd_merge ;;
  rename)  shift; cmd_rename "$@" ;;
  check)   cmd_check ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
