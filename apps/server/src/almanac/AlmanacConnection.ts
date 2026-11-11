import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

/** A memory server: a shell command that speaks MCP over stdio, or a streamable HTTP address. */
export type AlmanacTarget =
  | { readonly command: string }
  | { readonly url: string; readonly token: string };

interface Session {
  readonly key: string;
  readonly client: Client;
  readonly ready: Promise<void>;
  tools: Promise<ReadonlyArray<string>> | null;
}

/** One shared MCP session, opened on first use and reopened after it ends. */
export class AlmanacConnection {
  private session: Session | null = null;

  close(): void {
    this.release(this.session);
  }

  async call(
    target: AlmanacTarget,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const { client, ready } = this.open(target);
    await ready;
    return client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: CALL_TIMEOUT_MS,
    });
  }

  /** The tool names of the server, asked once per session. */
  async tools(target: AlmanacTarget, signal: AbortSignal): Promise<ReadonlyArray<string>> {
    const session = this.open(target);
    await session.ready;
    session.tools ??= session.client
      .listTools(undefined, { signal, timeout: CALL_TIMEOUT_MS })
      .then((reply) => reply.tools.map((tool) => tool.name));
    // A failed listing is asked again on the next call.
    session.tools.catch(() => (session.tools = null));
    return session.tools;
  }

  private release(target: Session | null): void {
    if (!target) return;
    if (this.session === target) this.session = null;
    // Closing the client also ends the child, including one that never finished connecting.
    void target.client.close().catch(() => undefined);
  }

  private open(target: AlmanacTarget): Session {
    const key = JSON.stringify(target);
    if (this.session?.key !== key) this.release(this.session);
    if (this.session) return this.session;
    const client = new Client({ name: "d4research", version: "1.0.0" }, { capabilities: {} });
    const transport =
      "command" in target
        ? // The SDK passes a short allowlist by default, which drops SSH_AUTH_SOCK.
          new StdioClientTransport({
            command: "/bin/sh",
            args: ["-c", target.command],
            env: process.env as Record<string, string>,
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(target.url), {
            requestInit: target.token
              ? { headers: { Authorization: `Bearer ${target.token}` } }
              : {},
          });
    const session: Session = {
      key,
      // SDK v1's class declares optional callbacks with explicit undefined,
      // unlike its Transport interface under exactOptionalPropertyTypes.
      client,
      ready: client.connect(transport as Transport, { timeout: CONNECT_TIMEOUT_MS }),
      tools: null,
    };
    client.onclose = () => this.release(session);
    session.ready.catch(() => this.release(session));
    this.session = session;
    return session;
  }
}
