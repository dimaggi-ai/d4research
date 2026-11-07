import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

interface Session {
  readonly command: string;
  readonly client: Client;
  readonly ready: Promise<void>;
}

/** One shared MCP stdio session, opened on first use and reopened after it ends. */
export class AlmanacConnection {
  private session: Session | null = null;

  close(): void {
    this.release(this.session);
  }

  async call(
    command: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const { client, ready } = this.open(command);
    await ready;
    return client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: CALL_TIMEOUT_MS,
    });
  }

  private release(target: Session | null): void {
    if (!target) return;
    if (this.session === target) this.session = null;
    // Closing the client also ends the child, including one that never finished connecting.
    void target.client.close().catch(() => undefined);
  }

  private open(command: string): Session {
    if (this.session?.command !== command) this.release(this.session);
    if (this.session) return this.session;
    const client = new Client({ name: "d4research", version: "1.0.0" }, { capabilities: {} });
    // The SDK passes a short allowlist by default, which drops SSH_AUTH_SOCK.
    const transport = new StdioClientTransport({
      command: "/bin/sh",
      args: ["-c", command],
      env: process.env as Record<string, string>,
      stderr: "ignore",
    });
    const session: Session = {
      command,
      // SDK v1's class declares optional callbacks with explicit undefined,
      // unlike its Transport interface under exactOptionalPropertyTypes.
      client,
      ready: client.connect(transport as Transport, { timeout: CONNECT_TIMEOUT_MS }),
    };
    client.onclose = () => this.release(session);
    session.ready.catch(() => this.release(session));
    this.session = session;
    return session;
  }
}
