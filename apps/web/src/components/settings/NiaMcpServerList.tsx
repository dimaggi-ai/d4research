import { useState } from "react";
import type { D4AgentMcpServer } from "@d4research/contracts";
import {
  EMPTY_NIA_MCP_SERVER_DRAFT,
  NIA_USER_SERVERS_NOTE,
  type NiaMcpServerDraft,
  niaMcpServerDraft,
  niaMcpServerFromDraft,
  niaMcpServerSummary,
} from "@d4research/client-runtime/niaServers";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";

/** Index of the server being edited, "new" for the add form, or null when nothing is open. */
type Editing = number | "new" | null;

export function NiaMcpServerList({
  servers,
  permissionMode,
  disabled,
  save,
}: {
  servers: ReadonlyArray<D4AgentMcpServer>;
  permissionMode: "read-only" | "ask" | "act";
  disabled: boolean;
  save: (servers: ReadonlyArray<D4AgentMcpServer>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState<NiaMcpServerDraft>(EMPTY_NIA_MCP_SERVER_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const open = (next: Editing) => {
    setEditing(next);
    setError(null);
    setDraft(
      typeof next === "number" ? niaMcpServerDraft(servers[next]!) : EMPTY_NIA_MCP_SERVER_DRAFT,
    );
  };
  const submit = () => {
    const others = servers.filter((_, index) => index !== editing);
    const result = niaMcpServerFromDraft(draft, others);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const next =
      typeof editing === "number"
        ? servers.map((server, index) => (index === editing ? result.server : server))
        : [...servers, result.server];
    void save(next).then(() => setEditing(null));
  };
  const form = (
    <div className="grid gap-2 px-4 py-3" role="group" aria-label="MCP server details">
      <Input
        aria-label="MCP server name"
        placeholder="name, for example docs"
        value={draft.name}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <select
        aria-label="MCP server transport"
        className="max-w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
        value={draft.type}
        disabled={disabled}
        onChange={(event) =>
          setDraft({ ...draft, type: event.target.value === "http" ? "http" : "stdio" })
        }
      >
        <option value="stdio">Command (stdio)</option>
        <option value="http">URL (HTTP)</option>
      </select>
      {draft.type === "stdio" ? (
        <>
          <Input
            aria-label="MCP server command"
            placeholder="command, for example npx"
            value={draft.command}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, command: event.target.value })}
          />
          <Textarea
            aria-label="MCP server arguments"
            placeholder="Arguments, one per line"
            value={draft.args}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, args: event.target.value })}
          />
        </>
      ) : (
        <Input
          aria-label="MCP server URL"
          placeholder="https://example.com/mcp"
          value={draft.url}
          disabled={disabled}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        />
      )}
      <Textarea
        aria-label={draft.type === "stdio" ? "MCP server environment" : "MCP server headers"}
        placeholder={
          draft.type === "stdio"
            ? "Environment, KEY=value per line"
            : "Headers, Header-Name: value per line"
        }
        value={draft.pairs}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, pairs: event.target.value })}
      />
      <p className="text-xs text-muted-foreground">
        Values are stored in this environment's settings and are visible to its paired clients.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={disabled} onClick={submit}>
          {editing === "new" ? "Add server" : "Save server"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
  return (
    <div className="border-t border-border pt-3">
      <p className="px-4 text-sm text-muted-foreground">
        {NIA_USER_SERVERS_NOTE}
        {permissionMode === "act" ? "" : " They stay off until your permission level is Act."}
      </p>
      {servers.map((server, index) => (
        <div key={server.name}>
          <SettingsRow
            title={server.name}
            description={niaMcpServerSummary(server)}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={`${server.name} access`}
                  checked={server.enabled}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    void save(
                      servers.map((item, at) =>
                        at === index ? { ...item, enabled: Boolean(enabled) } : item,
                      ),
                    )
                  }
                />
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Edit ${server.name}`}
                  disabled={disabled}
                  onClick={() => open(index)}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  aria-label={`Remove ${server.name}`}
                  disabled={disabled}
                  onClick={() => {
                    if (editing === index) setEditing(null);
                    void save(servers.filter((_, at) => at !== index));
                  }}
                >
                  Remove
                </Button>
              </div>
            }
          />
          {editing === index ? form : null}
        </div>
      ))}
      {editing === "new" ? (
        form
      ) : (
        <div className="mt-2 px-4 pb-3">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || servers.length >= 32}
            onClick={() => open("new")}
          >
            Add MCP server
          </Button>
        </div>
      )}
    </div>
  );
}
