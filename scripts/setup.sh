#!/usr/bin/env bash
# Fresh-machine setup for running d4research from source.
#
# Complements scripts/deploy-local.sh, which rebuilds an existing deployment and
# assumes the toolchain is already working. This script establishes that
# toolchain: it verifies the Node runtime, installs Vite+ and dependencies,
# reports provider CLI readiness, and checks the optional local services.
#
# Safe to re-run. Use --check to diagnose without changing anything.
set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/.." && pwd)"
readonly VP_INSTALL_URL="${T3CODE_SETUP_VP_INSTALL_URL:-https://vite.plus}"
readonly OLLAMA_URL="${T3CODE_SETUP_OLLAMA_URL:-http://127.0.0.1:11434}"
readonly MEMO_URL="${T3CODE_LOCAL_MEMO_URL:-http://127.0.0.1:8099}"
readonly COMPRESSION_MODEL="${T3CODE_SETUP_COMPRESSION_MODEL:-gemma4:e4b-it-qat}"
readonly DEV_WEB_PORT=5733
readonly DEV_SERVER_PORT=13773

CHECK_ONLY=0
ASSUME_YES=0
FAILURES=0
WARNINGS=0

# Provider CLIs d4research drives. Only the binary name is load-bearing; the
# label is for output. Kept in sync with docs/user/install.md.
readonly PROVIDER_SPECS=(
  "codex|Codex"
  "claude|Claude Code"
  "cursor-agent|Cursor"
  "grok|Grok"
  "junie|Junie"
  "opencode|OpenCode"
  "agy|Agy"
)

usage() {
  cat <<'USAGE'
Usage: scripts/setup.sh [options]

  --check        Diagnose only; make no changes. Exits non-zero if the
                 environment cannot run d4research.
  --yes          Do not prompt before installing Vite+.
  -h, --help     Show this message.

Environment overrides:
  T3CODE_SETUP_COMPRESSION_MODEL  Ollama model for handoff compression
  T3CODE_LOCAL_MEMO_URL           Local Memo service base URL
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
pass() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() {
  printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"
  WARNINGS=$((WARNINGS + 1))
}
fail() {
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"
  FAILURES=$((FAILURES + 1))
}
hint() { printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }

# macOS ships no `timeout`, and several provider CLIs block forever when their
# stdout is not a terminal, so every external probe goes through this.
run_with_timeout() {
  local seconds="$1"
  shift
  # The subshell converts a signal death into a normal exit, so the shell does
  # not print its own "Abort trap: 6" line when a probed CLI crashes — which is
  # precisely the case this script exists to report cleanly.
  ("$@" >/dev/null 2>&1; exit $?) 2>/dev/null &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if ((waited >= seconds * 10)); then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid"
}

port_owner() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

http_ok() {
  curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Node runtime
#
# Two independent requirements, and conflating them is what makes this fail
# silently:
#
#   1. d4research needs a Node matching engines.node. Vite+ resolves that
#      itself, so the ambient `node` does not have to be the right version.
#   2. Provider CLIs are `#!/usr/bin/env node` scripts. They use whatever
#      `node` is first on PATH, and they bypass Vite+ entirely.
#
# Requirement 2 is the one that bites: a Homebrew Node whose linked ICU library
# has been upgraded out from under it still prints a version string from the
# package manager's point of view, but every invocation dies in the dynamic
# loader. So this executes Node rather than trusting `node -v`.
# ---------------------------------------------------------------------------
check_node_runtime() {
  section "Node runtime"

  if ! command -v node >/dev/null 2>&1; then
    fail "No \`node\` on PATH."
    hint "Provider CLIs (codex, claude, agy) are Node scripts and cannot start without it."
    hint "Install Node 24 LTS, e.g. brew install node@24"
    return
  fi

  local node_path
  node_path="$(command -v node)"

  # The real test: does it run? Capture stderr so a loader failure is quotable.
  local probe_output probe_status=0
  probe_output="$(node -e 'process.stdout.write(process.versions.node)' 2>&1)" || probe_status=$?

  if ((probe_status != 0)); then
    fail "\`node\` exists at $node_path but fails to execute."
    printf '%s\n' "$probe_output" | head -3 | while IFS= read -r line; do hint "$line"; done
    if [[ "$probe_output" == *"Library not loaded"* || "$probe_output" == *"dyld"* ]]; then
      hint "This is a broken Homebrew link: Node was built against a library version"
      hint "that has since been replaced. Every Node-based CLI is down until it is fixed."
      hint "Repair with:  brew reinstall node    (or relink an LTS: brew link --overwrite --force node@24)"
    fi
    return
  fi

  pass "node $probe_output executes ($node_path)"

  # Warn when the runnable Node is far from what the repo wants, since provider
  # CLIs and the repo then disagree about which runtime they are on.
  local required
  required="$(node -e 'try{process.stdout.write(require("'"$REPOSITORY_ROOT"'/package.json").engines.node)}catch(e){}' 2>/dev/null || true)"
  if [[ -n "$required" ]]; then
    local satisfies
    satisfies="$(node -e '
      const [range, current] = [process.argv[1], process.versions.node];
      const parse = (v) => v.replace(/^[^0-9]*/, "").split(".").map(Number);
      const [cMaj, cMin, cPat] = parse(current);
      const gte = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
      const ok = range.split("||").map((s) => s.trim()).some((clause) => {
        const [maj, min = 0, pat = 0] = parse(clause);
        if (clause.startsWith("^")) return cMaj === maj && gte([cMaj, cMin, cPat], [maj, min, pat]);
        if (clause.startsWith(">=")) return gte([cMaj, cMin, cPat], [maj, min, pat]);
        return cMaj === maj && cMin === min && cPat === pat;
      });
      process.stdout.write(ok ? "yes" : "no");
    ' "$required" 2>/dev/null || echo "unknown")"
    if [[ "$satisfies" == "no" ]]; then
      warn "Ambient node $probe_output is outside the repo's engines range ($required)."
      hint "Vite+ selects a matching Node for d4research itself, so this is not fatal,"
      hint "but keeping them aligned avoids confusing version-skew reports."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Vite+
# ---------------------------------------------------------------------------
vp_command() {
  if command -v vp >/dev/null 2>&1; then
    command -v vp
    return 0
  fi
  if [[ -x "$HOME/.vite-plus/bin/vp" ]]; then
    printf '%s\n' "$HOME/.vite-plus/bin/vp"
    return 0
  fi
  return 1
}

check_vite_plus() {
  section "Vite+ (build tool)"

  local vp_path
  if vp_path="$(vp_command)"; then
    pass "vp available ($vp_path)"
    VP_BIN="$vp_path"
    return
  fi

  if ((CHECK_ONLY)); then
    fail "Vite+ is not installed."
    hint "Install with:  curl -fsSL $VP_INSTALL_URL | bash"
    return
  fi

  if ((!ASSUME_YES)); then
    printf '  Vite+ is required and not installed.\n'
    printf '  Install it from %s? [Y/n] ' "$VP_INSTALL_URL"
    local reply=""
    read -r reply </dev/tty || reply="n"
    if [[ -n "$reply" && "$reply" != [Yy]* ]]; then
      fail "Vite+ not installed; cannot continue."
      return
    fi
  fi

  printf '  installing Vite+...\n'
  if ! curl -fsSL "$VP_INSTALL_URL" | bash; then
    fail "Vite+ installation failed."
    return
  fi

  if vp_path="$(vp_command)"; then
    pass "vp installed ($vp_path)"
    VP_BIN="$vp_path"
    hint "Restart your shell, or the installer's PATH entry will not apply to this session."
  else
    fail "Vite+ installer ran but \`vp\` is still not on PATH."
  fi
}

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
check_dependencies() {
  section "Dependencies"

  if [[ -z "${VP_BIN:-}" ]]; then
    fail "Skipped: Vite+ unavailable."
    return
  fi

  if ((CHECK_ONLY)); then
    if [[ -d "$REPOSITORY_ROOT/node_modules" ]]; then
      pass "node_modules present"
    else
      fail "Dependencies not installed."
      hint "Install with:  vp i"
    fi
    return
  fi

  printf '  running vp i...\n'
  if (cd "$REPOSITORY_ROOT" && "$VP_BIN" i); then
    pass "dependencies installed"
  else
    fail "\`vp i\` failed."
  fi
}

# ---------------------------------------------------------------------------
# Provider CLIs
#
# Presence and executability only. Deliberately no subcommands beyond
# --version: `agy models` never exits without a TTY and `codex models` is an
# interactive picker, so probing capability here would hang the setup script.
# Live health and auth belong in Settings, which runs those probes correctly.
# ---------------------------------------------------------------------------
check_providers() {
  section "Provider CLIs"

  local found=0
  local spec binary label path status
  for spec in "${PROVIDER_SPECS[@]}"; do
    binary="${spec%%|*}"
    label="${spec##*|}"

    if ! path="$(command -v "$binary" 2>/dev/null)"; then
      printf '  %s-%s %s (%s) not installed\n' "$DIM" "$RESET" "$label" "$binary"
      continue
    fi

    status=0
    run_with_timeout 15 "$binary" --version || status=$?
    if ((status == 0)); then
      pass "$label ($binary) runs"
      found=$((found + 1))
    elif ((status == 124)); then
      warn "$label ($binary) did not respond to --version within 15s."
      hint "Found at $path"
    else
      fail "$label ($binary) is installed but exits non-zero on --version."
      hint "Found at $path — if this is a Node CLI, check the Node runtime above."
      found=$((found + 1))
    fi
  done

  if ((found == 0)); then
    warn "No provider CLI is usable. d4research will start, but no session can run."
    hint "See docs/user/install.md for per-provider install and login steps."
  fi
}

# ---------------------------------------------------------------------------
# Dev ports
# ---------------------------------------------------------------------------
check_ports() {
  section "Dev ports"

  local port owner
  for port in "$DEV_WEB_PORT" "$DEV_SERVER_PORT"; do
    owner="$(port_owner "$port")"
    if [[ -z "$owner" ]]; then
      pass "$port free"
    else
      warn "$port already in use by pid $owner."
      hint "The dev runner shifts to the next free port and prints the real one"
      hint "on its [dev-runner] line. Read the ports from there, not from the docs."
    fi
  done
}

# ---------------------------------------------------------------------------
# Optional local services
#
# Never installed automatically: both are opt-in features, and one of them
# downloads several gigabytes of model weights.
# ---------------------------------------------------------------------------
check_optional_services() {
  section "Optional local services"

  if http_ok "$OLLAMA_URL"; then
    if curl -fsS --max-time 5 "$OLLAMA_URL/api/tags" 2>/dev/null | grep -q "\"$COMPRESSION_MODEL\""; then
      pass "Ollama running with $COMPRESSION_MODEL (handoff compression)"
      hint "Enable it in Settings > General > Handoff > Context compression."
    else
      warn "Ollama is running but $COMPRESSION_MODEL is not pulled."
      hint "Pull it with:  ollama pull $COMPRESSION_MODEL"
    fi
  else
    printf '  %s-%s Ollama not running (handoff context compression stays off)\n' "$DIM" "$RESET"
    hint "Optional. Install Ollama, then: ollama pull $COMPRESSION_MODEL"
  fi

  if http_ok "$MEMO_URL/health"; then
    pass "Local Memo reachable at $MEMO_URL"
  else
    printf '  %s-%s Local Memo not reachable at %s\n' "$DIM" "$RESET" "$MEMO_URL"
    hint "Optional. Without it, handoffs still work; they just carry no durable memory."
    hint "Override the URL with T3CODE_LOCAL_MEMO_URL or in Settings > Connections."
  fi
}

# ---------------------------------------------------------------------------

main() {
  printf '%sd4research setup%s  %s(%s)%s\n' "$BOLD" "$RESET" "$DIM" "$REPOSITORY_ROOT" "$RESET"
  ((CHECK_ONLY)) && printf '%scheck only — no changes will be made%s\n' "$DIM" "$RESET"

  check_node_runtime
  check_vite_plus
  check_dependencies
  check_providers
  check_ports
  check_optional_services

  section "Result"
  if ((FAILURES > 0)); then
    printf '  %s%d blocking problem(s)%s, %d warning(s).\n' "$RED" "$FAILURES" "$RESET" "$WARNINGS"
    printf '  Resolve the ✗ items above and re-run.\n'
    return 1
  fi

  if ((WARNINGS > 0)); then
    printf '  Ready, with %d warning(s).\n' "$WARNINGS"
  else
    printf '  %sReady.%s\n' "$GREEN" "$RESET"
  fi

  if ((!CHECK_ONLY)); then
    cat <<'NEXT'

  Start the dev server:

      vp run dev

  It prints a [dev-runner] line with the real ports and, once the server is
  up, a pairing URL of the form http://localhost:<port>/pair#token=<token>.
  Open that URL — the bare origin will not authenticate.
NEXT
  fi
  return 0
}

main
