import { type D4AgentMcpServer, D4AgentMcpServerName } from "@d4research/contracts";
import * as Schema from "effect/Schema";

/** Nia's built-in toolkits. They are part of d4research, so users can switch them but not remove them. */
export const NIA_SERVERS = [
  {
    id: "threads",
    title: "Threads and system",
    description: "Manage threads, projects, schedules, and local usage.",
    accessField: null,
  },
  {
    id: "host",
    title: "Host",
    description: "Check the host system and disk space.",
    accessField: "systemProbeEnabled",
  },
  {
    id: "memory",
    title: "Memory",
    description: "Search and index the local brain vault.",
    accessField: "memoryEnabled",
  },
  {
    id: "cto",
    title: "CTO",
    description: "Connect to the CTO service.",
    accessField: "ctoEnabled",
  },
  {
    id: "toolGuard",
    title: "Tool Guard",
    description: "Check Nia actions against your policy.",
    accessField: null,
  },
] as const;

export type NiaServerId = (typeof NIA_SERVERS)[number]["id"];

export const NIA_USER_SERVERS_NOTE =
  "Nia loads the servers you add only at the Act permission level, and calls their tools without asking.";

/** The editable text form of a user MCP server, shared by the web and mobile settings. */
export interface NiaMcpServerDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly type: "stdio" | "http";
  readonly command: string;
  /** One argument per line, so arguments may contain spaces. */
  readonly args: string;
  /** KEY=value per line for stdio env, Name: value per line for HTTP headers. */
  readonly pairs: string;
  readonly url: string;
}

export const EMPTY_NIA_MCP_SERVER_DRAFT: NiaMcpServerDraft = {
  name: "",
  enabled: true,
  type: "stdio",
  command: "",
  args: "",
  pairs: "",
  url: "",
};

const joinPairs = (pairs: Readonly<Record<string, string>>, separator: string) =>
  Object.entries(pairs)
    .map(([key, value]) => key + separator + value)
    .join("\n");

export function niaMcpServerDraft(server: D4AgentMcpServer): NiaMcpServerDraft {
  const base = { ...EMPTY_NIA_MCP_SERVER_DRAFT, name: server.name, enabled: server.enabled };
  return server.transport.type === "stdio"
    ? {
        ...base,
        command: server.transport.command,
        args: server.transport.args.join("\n"),
        pairs: joinPairs(server.transport.env, "="),
      }
    : {
        ...base,
        type: "http",
        url: server.transport.url,
        pairs: joinPairs(server.transport.headers, ": "),
      };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

function parsePairs(text: string, separator: "=" | ":"): Record<string, string> | string {
  const pairs: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (key.length === 0)
      return separator === "="
        ? `"${line}" is not KEY=value.`
        : `"${line}" is not Header-Name: value.`;
    pairs[key] = line.slice(at + 1).trim();
  }
  return pairs;
}

const isServerName = Schema.is(D4AgentMcpServerName);

/** A server ready to save, or the first problem to show. `others` are the remaining servers. */
export function niaMcpServerFromDraft(
  draft: NiaMcpServerDraft,
  others: ReadonlyArray<D4AgentMcpServer>,
): { readonly server: D4AgentMcpServer } | { readonly error: string } {
  const name = draft.name.trim();
  if (!isServerName(name))
    return {
      error:
        name === "t3-code"
          ? "t3-code is the built-in server name."
          : "Use lowercase letters, digits, - or _, starting with a letter or digit.",
    };
  if (others.some((server) => server.name === name))
    return { error: `A server named ${name} already exists.` };
  if (draft.type === "stdio") {
    const command = draft.command.trim();
    if (command.length === 0) return { error: "Enter the command that starts the server." };
    const env = parsePairs(draft.pairs, "=");
    if (typeof env === "string") return { error: env };
    return {
      server: {
        name,
        enabled: draft.enabled,
        transport: { type: "stdio", command, args: lines(draft.args), env },
      },
    };
  }
  const url = draft.url.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return { error: "Enter an http:// or https:// URL." };
  const headers = parsePairs(draft.pairs, ":");
  if (typeof headers === "string") return { error: headers };
  return { server: { name, enabled: draft.enabled, transport: { type: "http", url, headers } } };
}

export const niaMcpServerSummary = (server: D4AgentMcpServer): string =>
  server.transport.type === "stdio"
    ? [server.transport.command, ...server.transport.args].join(" ")
    : server.transport.url;
