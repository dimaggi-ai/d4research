import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { MekoReceipt, MekoStatus } from "@d4research/contracts/settings";
import { preparedEnvironmentFetchAuthorization } from "@d4research/client-runtime/state/skills";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { runtime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SettingsRow } from "./settingsLayout";

const decodeReceipt = Schema.decodeUnknownSync(MekoReceipt);
const decodeStatus = Schema.decodeUnknownSync(MekoStatus);

export function MekoHandoffSettings() {
  const { handoff } = usePrimarySettings();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <MekoHandoffControls
      key={JSON.stringify([environmentId, handoff.memoryBackend, handoff.meko])}
    />
  );
}

function MekoHandoffControls() {
  const { handoff } = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const connection = usePreparedConnection(usePrimaryEnvironmentId());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReadonlyArray<MekoReceipt>>([]);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function inspect(action: "status" | "check") {
    if (connection._tag !== "Some" || busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const url = new URL("/api/handoff/meko", connection.value.httpBaseUrl).toString();
      const auth = await runtime.runPromise(
        preparedEnvironmentFetchAuthorization(connection.value, "POST", url),
      );
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        ...(auth.credentials ? { credentials: auth.credentials } : {}),
        headers: { "content-type": "application/json", ...auth.headers },
        body: JSON.stringify({ action }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok)
        throw new Error(
          "Could not inspect Meko. Check the environment connection and permissions.",
        );
      const body: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (action === "check") {
        const receipt = decodeReceipt(body);
        setMessage(`${receipt.status}: ${receipt.message}`);
      } else {
        const status = decodeStatus(body);
        setRecent(status.recent);
        setMessage(
          status.message ??
            (status.recent.length
              ? "Recent operations on this server."
              : "No recent Meko operations on this server."),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Meko inspection failed.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <SettingsRow
        id="handoff-memory-backend"
        title="Handoff memory"
        description="Choose where handoff context is saved. Meko sends context to your configured MCP endpoint. The visible thread stays authoritative."
        control={
          <select
            aria-label="Handoff memory"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-48"
            value={handoff.memoryBackend}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "local" || value === "meko" || value === "none")
                update({ handoff: { memoryBackend: value } });
            }}
          >
            <option value="local">Local Memo</option>
            <option value="meko">Meko MCP</option>
            <option value="none">No memory copy</option>
          </select>
        }
      />
      {handoff.memoryBackend === "meko" ? (
        <>
          {(
            [
              [
                "url",
                "Meko MCP URL",
                "Streamable HTTP endpoint. No default cloud connection.",
                "https://example.test/mcp",
              ],
              [
                "datapackId",
                "Datapack ID",
                "Explicit destination for this environment's handoff context.",
                "Datapack ID",
              ],
              [
                "agentId",
                "Agent ID",
                "Stable Meko identity used for writes and keyed reads.",
                "Agent ID",
              ],
              [
                "tokenEnv",
                "Credential variable",
                "Name of a server environment variable containing the bearer token, not the token itself. Leave empty for an unauthenticated local server.",
                "MEKO_API_KEY",
              ],
            ] as const
          ).map(([field, title, description, placeholder]) => (
            <SettingsRow
              key={field}
              title={title}
              description={description}
              control={
                <DraftInput
                  aria-label={title}
                  value={handoff.meko[field]}
                  placeholder={placeholder}
                  className="w-full sm:w-72"
                  onCommit={(value) => update({ handoff: { meko: { [field]: value.trim() } } })}
                />
              }
            />
          ))}
          <SettingsRow
            title="Meko connection"
            description="Inspect the MCP API without writing data. Automatic saves run in the background, verify by hash, and stay quiet on success. Failures appear in the thread and in Recent operations."
            control={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || connection._tag !== "Some"}
                  onClick={() => void inspect("check")}
                >
                  {busy ? "Checking…" : "Inspect API"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || connection._tag !== "Some"}
                  onClick={() => void inspect("status")}
                >
                  Recent operations
                </Button>
              </div>
            }
          />
          {message ? (
            <div
              role="status"
              className="space-y-2 break-words px-4 py-2 text-xs text-muted-foreground"
            >
              <p>{message}</p>
              {recent.slice(0, 5).map((receipt) => (
                <div key={`${receipt.timestamp}-${receipt.contentHash ?? receipt.message}`}>
                  <p>
                    {receipt.timestamp} · {receipt.status} · {receipt.message}
                  </p>
                  {receipt.contentHash ? (
                    <p className="break-all font-mono">{receipt.contentHash}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
