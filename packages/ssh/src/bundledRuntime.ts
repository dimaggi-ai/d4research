import type { BundledServerRuntime } from "@d4research/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function bundledRuntimeUploadScript(runtime: BundledServerRuntime): string {
  return `set -eu
umask 077
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = ${quote(runtime.arch === "arm64" ? "arm64" : "x86_64")} ] || { echo 'Bundled runtime does not support this host.' >&2; exit 1; }
ROOT="$HOME/.t3/runtime/forks"
mkdir -p "$ROOT"
STAGE="$(mktemp -d "$ROOT/.upload-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cat > "$STAGE/runtime.tar.gz"
[ "$(shasum -a 256 "$STAGE/runtime.tar.gz" | cut -d ' ' -f 1)" = ${quote(runtime.sha256)} ] || { echo 'Runtime checksum mismatch.' >&2; exit 1; }
DEST="$ROOT/${runtime.buildId}"
if [ -f "$DEST/.bundle-sha256" ] && [ "$(cat "$DEST/.bundle-sha256")" = ${quote(runtime.sha256)} ]; then exit 0; fi
INSTALL_LOCK="$ROOT/.${runtime.buildId}.install.lock"
mkdir "$INSTALL_LOCK" 2>/dev/null || { echo 'This bundled runtime is already being installed.' >&2; exit 1; }
trap 'rm -rf "$STAGE"; rmdir "$INSTALL_LOCK"' EXIT
[ ! -e "$DEST" ] || { echo 'Runtime build already exists with different contents.' >&2; exit 1; }
mkdir "$STAGE/content"
tar -xzf "$STAGE/runtime.tar.gz" --strip-components=1 -C "$STAGE/content"
[ -x "$STAGE/content/t3" ]
T3_ACTUAL_VERSION="$("$STAGE/content/t3" --version)"
case "$T3_ACTUAL_VERSION" in ${quote(runtime.version)}|${quote("t3 v" + runtime.version)}|${quote("t3 " + runtime.version)}) ;; *) echo 'Runtime version mismatch.' >&2; exit 1;; esac
printf '%s\\n' ${quote(runtime.sha256)} > "$STAGE/content/.bundle-sha256"
mv "$STAGE/content" "$DEST"
`;
}

/** Runs only after the archive and executable have been checked, before any live process changes. */
export function bundledRuntimeActivationScript(input: {
  readonly runtime: BundledServerRuntime;
  readonly stateKey: string;
  readonly environmentId: string;
}): string {
  const { runtime } = input;
  return `set -eu
umask 077
STATE="$HOME/.t3/ssh-launch/${input.stateKey}"
ROOT="$HOME/.t3/runtime/forks/${runtime.buildId}"
[ "$(cat "$HOME/.t3/userdata/environment-id")" = ${quote(input.environmentId)} ] || { echo 'SSH environment identity does not match.' >&2; exit 1; }
[ "$(cat "$STATE/managed")" = managed ] || { echo 'This server is not managed by desktop SSH.' >&2; exit 1; }
[ "$(cat "$ROOT/.bundle-sha256")" = ${quote(runtime.sha256)} ]
PID="$(cat "$STATE/pid")"
PORT="$(cat "$STATE/port")"
case "$PID:$PORT" in *[!0-9:]*|:*|*:) echo 'Invalid managed server state.' >&2; exit 1;; esac
LIFECYCLE_LOCK="$STATE/lifecycle.lock"
mkdir "$LIFECYCLE_LOCK" 2>/dev/null || { echo 'An SSH server launch or update is in progress. Reconnect before updating.' >&2; exit 1; }
trap 'rmdir "$LIFECYCLE_LOCK"' EXIT
# The runtime record must still belong to the PID we are about to replace.
INFO="$("$ROOT/t3" __ssh-helper runtime-port "$HOME/.t3/userdata/server-runtime.json")"
[ "$INFO" = "$PID $PORT" ] || { echo 'Managed server ownership changed. Reconnect before updating.' >&2; exit 1; }
LOCK="$STATE/update.lock"
mkdir "$LOCK" 2>/dev/null || { echo 'An SSH server update is already running.' >&2; exit 1; }
trap 'rmdir "$LOCK" "$LIFECYCLE_LOCK"' EXIT HUP INT TERM
BACKUP="$(mktemp -d "$STATE/.previous-XXXXXX")"
cp "$STATE/run-t3.sh" "$BACKUP/run-t3.sh"
STOPPED=0
SNAPSHOT_READY=0
COMMITTED=0
NEW_PID=''
start_server() {
  nohup env T3CODE_NO_BROWSER=1 "$STATE/run-t3.sh" serve --host 127.0.0.1 --port "$PORT" --base-dir "$HOME/.t3" >> "$STATE/server.log" 2>&1 < /dev/null &
  NEW_PID="$!"
  printf '%s\\n' "$NEW_PID" > "$STATE/pid"
}
recover() {
  RESULT=$?
  trap - EXIT HUP INT TERM
  if [ "$COMMITTED" = 0 ] && [ "$STOPPED" = 1 ]; then
    if [ -n "$NEW_PID" ]; then kill "$NEW_PID" 2>/dev/null || true; fi
    # Never restore database files while a trial can still own them.
    COUNT=0
    while [ -n "$NEW_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; do
      case "$(ps -o stat= -p "$NEW_PID" 2>/dev/null || true)" in *Z*) break;; esac
      COUNT=$((COUNT + 1)); [ "$COUNT" -lt 120 ] || { echo 'Trial did not stop; previous runtime retained for recovery.' >&2; rmdir "$LOCK" "$LIFECYCLE_LOCK"; exit 1; }
      sleep 1
    done
    if [ "$SNAPSHOT_READY" = 1 ]; then
    for FILE in statev2.sqlite statev2.sqlite-wal statev2.sqlite-shm state.sqlite state.sqlite-wal state.sqlite-shm; do
      rm -f "$HOME/.t3/userdata/$FILE"
      if [ -f "$BACKUP/$FILE" ]; then cp "$BACKUP/$FILE" "$HOME/.t3/userdata/$FILE"; fi
    done
    fi
    cp "$BACKUP/run-t3.sh" "$STATE/run-t3.sh"
    chmod 700 "$STATE/run-t3.sh"
    start_server
    echo 'Update failed; restored the previous server and database snapshot.' >&2
  fi
  rmdir "$LOCK" "$LIFECYCLE_LOCK"
  exit "$RESULT"
}
trap recover EXIT HUP INT TERM
# Stop the recorded owner gracefully; never start a second writer beside it.
kill "$PID"
COUNT=0
while kill -0 "$PID" 2>/dev/null; do
  case "$(ps -o stat= -p "$PID" 2>/dev/null || true)" in *Z*) break;; esac
  COUNT=$((COUNT + 1)); [ "$COUNT" -lt 120 ] || { echo 'Server is still stopping; update cancelled.' >&2; exit 1; }
  sleep 1
done
STOPPED=1
for FILE in statev2.sqlite statev2.sqlite-wal statev2.sqlite-shm state.sqlite state.sqlite-wal state.sqlite-shm; do
  if [ -f "$HOME/.t3/userdata/$FILE" ]; then cp "$HOME/.t3/userdata/$FILE" "$BACKUP/$FILE"; fi
done
SNAPSHOT_READY=1
cat > "$STATE/run-t3.next" <<'RUNNER'
#!/bin/sh
export T3CODE_SERVER_BUILD_ID=${quote(runtime.buildId)}
exec "$HOME/.t3/runtime/forks/${runtime.buildId}/t3" "$@"
RUNNER
chmod 700 "$STATE/run-t3.next"
mv "$STATE/run-t3.next" "$STATE/run-t3.sh"
start_server
"$ROOT/t3" __ssh-helper wait-ready "$PORT" 300000 2000
COMMITTED=1
printf '%s\\n' '${runtime.buildId}'
`;
}
