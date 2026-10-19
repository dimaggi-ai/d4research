// @effect-diagnostics nodeBuiltinImport:off -- MCP byte verification uses synchronous Node SHA-256 at the SDK boundary.
// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off - MCP SDK is a Promise/fetch boundary; Effect callers receive bounded receipts.
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import * as Schema from "effect/Schema";
import type { HandoffSettings, MekoReceipt } from "@d4research/contracts/settings";

type Config = HandoffSettings["meko"];
const hash = (text: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
const ObjectResult = Schema.Record(Schema.String, Schema.Unknown);
const Created = Schema.Struct({ id: Schema.String });
const Artifact = Schema.Struct({ content_hash: Schema.String, content_base64: Schema.String });
const Packet = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("d4research-handoff"),
  threadId: Schema.String,
  project: Schema.String,
  text: Schema.String,
});
const decodeObject = Schema.decodeUnknownSync(ObjectResult);
const decodeCreated = Schema.decodeUnknownSync(Created);
const decodeArtifact = Schema.decodeUnknownSync(Artifact);
const decodePacket = Schema.decodeUnknownSync(Packet);
const validators = new WeakMap<Tool, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();

class MekoError extends Error {
  readonly status: MekoReceipt["status"];
  constructor(status: MekoReceipt["status"], message: string) {
    super(message);
    this.status = status;
  }
}

/** No cloud default, credential fallback, redirects, sampling, or executable tools. */
export function resolveMekoConnection(config: Config, env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new MekoError("ERROR_CONFIGURATION", "Set a Meko MCP URL.");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new MekoError(
      "ERROR_CONFIGURATION",
      "Use HTTPS, or HTTP on loopback, without URL credentials or query parameters.",
    );
  }
  if (!config.agentId || !config.datapackId)
    throw new MekoError("ERROR_CONFIGURATION", "Set the Meko agent and datapack IDs.");
  if (config.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.tokenEnv))
    throw new MekoError(
      "ERROR_CONFIGURATION",
      "Enter an environment variable name, not an API key.",
    );
  const token = config.tokenEnv ? env[config.tokenEnv] : undefined;
  if (config.tokenEnv && !token)
    throw new MekoError(
      "ERROR_CONFIGURATION",
      "The configured credential variable is missing from the server environment.",
    );
  return {
    url,
    token,
    key: hash(JSON.stringify([url.href, config.datapackId, config.agentId, token ?? ""])),
  };
}

/** Map only advertised arguments; incompatible APIs fail before any write. */
export function mapMekoArguments(tool: Tool, values: Record<string, unknown>) {
  const properties = tool.inputSchema.properties ?? {};
  const mapped = Object.fromEntries(Object.entries(values).filter(([key]) => key in properties));
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in mapped))
      throw new MekoError("ERROR_CONFIGURATION", "Meko requires an unsupported argument.");
  }
  let validate = validators.get(tool);
  if (!validate) {
    validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
    validators.set(tool, validate);
  }
  const validation = validate(mapped);
  if (!validation.valid)
    throw new MekoError(
      "ERROR_CONFIGURATION",
      "Meko arguments do not match its advertised schema.",
    );
  return mapped;
}

export class MekoHandoffClient {
  private catalogs = new Map<string, { expires: number; tools: Tool[] }>();
  private completed = new Map<string, { expires: number; receipt: MekoReceipt }>();
  private pending = new Map<string, Promise<MekoReceipt>>();
  private ledger = new Map<string, MekoReceipt[]>();
  private active = 0;
  private controllers = new Set<AbortController>();

  cancel() {
    for (const controller of this.controllers) controller.abort();
    this.completed.clear();
    this.catalogs.clear();
  }

  status(config: Config, threadId?: string) {
    try {
      const { key } = resolveMekoConnection(config);
      return {
        configured: true,
        recent: (this.ledger.get(key) ?? []).filter(
          (receipt) => threadId === undefined || receipt.threadId === threadId,
        ),
      };
    } catch (error) {
      return {
        configured: false,
        recent: [],
        message: error instanceof Error ? error.message : "Invalid Meko configuration.",
      };
    }
  }

  private async session<A>(
    config: Config,
    signal: AbortSignal,
    run: (
      call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<A>,
  ): Promise<A> {
    const { url, token, key } = resolveMekoConnection(config);
    const client = new Client(
      { name: "d4research-handoff", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        });
        if (response.status === 401 || response.status === 403)
          throw new MekoError(
            "ERROR_AUTH_RESTRICTED",
            "Meko denied access. Check the configured credential and datapack.",
          );
        let bytes = 0;
        const body = response.body?.pipeThrough(
          new TransformStream({
            transform(chunk: Uint8Array, controller) {
              bytes += chunk.byteLength;
              if (bytes > 1_048_576)
                throw new MekoError("ERROR_TOOL_FAILURE", "Meko response exceeded the size limit.");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    try {
      // SDK v1's class declares optional callbacks with explicit undefined,
      // unlike its Transport interface under exactOptionalPropertyTypes.
      await client.connect(transport as Transport, { signal, timeout: 10_000 });
      let catalog = this.catalogs.get(key);
      if (!catalog || catalog.expires < Date.now()) {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 8; page++) {
          const result = await client.listTools(cursor ? { cursor } : {}, {
            signal,
            timeout: 10_000,
          });
          tools.push(...result.tools);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (cursor || tools.length > 256)
          throw new MekoError("ERROR_TOOL_FAILURE", "Meko tool catalog exceeded the limit.");
        for (const [name, args] of Object.entries({
          conversation_create: ["agent_id", "datapack_id", "session_id"],
          artifact_put: [
            "filename",
            "content_base64",
            "content_type",
            "conversation_id",
            "agent_id",
            "datapack_id",
          ],
          artifact_get: ["content_hash", "conversation_id", "agent_id", "datapack_id"],
        })) {
          const tool = tools.find((tool) => tool.name === name);
          if (!tool || args.some((arg) => !(arg in (tool.inputSchema.properties ?? {})))) {
            throw new MekoError(
              "ERROR_CONFIGURATION",
              `Meko must advertise a compatible ${name} tool.`,
            );
          }
          for (const required of tool.inputSchema.required ?? []) {
            if (!args.includes(required))
              throw new MekoError("ERROR_CONFIGURATION", "Meko requires an unsupported argument.");
          }
        }
        catalog = { expires: Date.now() + 300_000, tools };
        if (this.catalogs.size >= 8) this.catalogs.clear();
        this.catalogs.set(key, catalog);
      }
      const tools = catalog.tools;
      return await run(async (name, args) => {
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) throw new MekoError("ERROR_CONFIGURATION", "Meko tool is unavailable.");
        const result = await client.callTool(
          {
            name,
            arguments: mapMekoArguments(tool, {
              ...args,
              agent_id: config.agentId,
              datapack_id: config.datapackId,
            }),
          },
          undefined,
          { signal, timeout: 10_000 },
        );
        if (result.isError) throw new MekoError("ERROR_TOOL_FAILURE", `Meko ${name} failed.`);
        const content =
          result.structuredContent ??
          (Array.isArray(result.content)
            ? (JSON.parse(
                result.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
              ) as unknown)
            : undefined);
        const decoded = decodeObject(content);
        if (decoded.error || decoded.ok === false) {
          const restricted =
            typeof decoded.error === "string" &&
            /auth|forbidden|permission|agent_id_mismatch|access_denied/i.test(decoded.error);
          throw new MekoError(
            restricted ? "ERROR_AUTH_RESTRICTED" : "ERROR_TOOL_FAILURE",
            `Meko ${name} rejected the request.`,
          );
        }
        return decoded;
      });
    } catch (error) {
      this.catalogs.delete(key);
      throw error;
    } finally {
      await client.close();
    }
  }

  private async bounded(
    config: Config,
    run: (signal: AbortSignal) => Promise<Omit<MekoReceipt, "timestamp">>,
    scope?: { threadId: string; project: string },
  ): Promise<MekoReceipt> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let receipt: MekoReceipt;
    try {
      if (this.active >= 2)
        throw new MekoError("ERROR_BUSY", "Meko is busy. The thread keeps its attached context.");
      this.active++;
      try {
        receipt = { ...(await run(controller.signal)), timestamp: new Date().toISOString() };
      } finally {
        this.active--;
      }
    } catch (error) {
      receipt = {
        status:
          controller.signal.aborted ||
          (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
            ? "ERROR_TIMEOUT"
            : error instanceof MekoError
              ? error.status
              : "ERROR_TOOL_FAILURE",
        message:
          error instanceof MekoError
            ? error.message
            : "Meko did not complete the operation. The attached context is unchanged.",
        timestamp: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
    receipt = { ...receipt, ...scope };
    try {
      const { key } = resolveMekoConnection(config);
      if (this.ledger.size >= 8 && !this.ledger.has(key)) this.ledger.clear();
      this.ledger.set(key, [receipt, ...(this.ledger.get(key) ?? [])].slice(0, 20));
    } catch {
      /* An invalid connection has no credential-scoped ledger. */
    }
    return receipt;
  }

  check(config: Config) {
    return this.bounded(config, (signal) =>
      this.session(config, signal, async () => ({
        status: "SUCCESS_WITH_EVIDENCE",
        message: "MCP connected; handoff tools are compatible. No data was written.",
      })),
    );
  }

  save(config: Config, input: { text: string; threadId: string; project: string }) {
    const packet = JSON.stringify({ version: 1, kind: "d4research-handoff", ...input });
    const contentHash = hash(packet);
    let key: string;
    try {
      key = `${resolveMekoConnection(config).key}:${contentHash}`;
    } catch {
      return this.bounded(config, async () => {
        resolveMekoConnection(config);
        throw new Error();
      });
    }
    const previous = this.completed.get(key);
    if (previous && previous.expires > Date.now()) return Promise.resolve(previous.receipt);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.bounded(
      config,
      (signal) =>
        this.session(config, signal, async (call) => {
          if (!input.text.trim() || input.text.length > 60_000 || !input.threadId || !input.project)
            throw new MekoError(
              "ERROR_CONFIGURATION",
              "Handoff context requires a project, thread, and non-empty text of at most 60,000 characters.",
            );
          const conversation = decodeCreated(
            await call("conversation_create", {
              session_id: `d4research:${hash(JSON.stringify([input.project, input.threadId]))}`,
              title: "d4research handoff",
            }),
          );
          const args = { conversation_id: conversation.id };
          const written = await call("artifact_put", {
            ...args,
            filename: "d4research-handoff.json",
            content_type: "application/json",
            content_base64: Buffer.from(packet).toString("base64"),
          });
          if (written.content_hash !== contentHash)
            throw new MekoError("ERROR_TOOL_FAILURE", "Meko returned a different content hash.");
          const readback = decodeArtifact(
            await call("artifact_get", { ...args, content_hash: contentHash }),
          );
          if (
            readback.content_hash !== contentHash ||
            !Buffer.from(readback.content_base64, "base64").equals(Buffer.from(packet))
          )
            throw new MekoError(
              "ERROR_TOOL_FAILURE",
              "Meko handoff readback did not match. The save is unverified.",
            );
          signal.throwIfAborted();
          return {
            status: "SUCCESS_WITH_EVIDENCE",
            message: "Handoff saved and verified.",
            contentHash,
            conversationId: conversation.id,
            size: Buffer.byteLength(packet),
          };
        }),
      { threadId: input.threadId, project: input.project },
    )
      .then((receipt) => {
        if (receipt.status === "SUCCESS_WITH_EVIDENCE") {
          if (this.completed.size >= 64) this.completed.clear();
          this.completed.set(key, { receipt, expires: Date.now() + 300_000 });
        }
        return receipt;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async read(
    config: Config,
    input: { contentHash: string; conversationId: string; threadId: string; project: string },
  ) {
    let text: string | undefined;
    const receipt = await this.bounded(
      config,
      (signal) =>
        this.session(config, signal, async (call) => {
          const artifact = decodeArtifact(
            await call("artifact_get", {
              content_hash: input.contentHash,
              conversation_id: input.conversationId,
            }),
          );
          const bytes = Buffer.from(artifact.content_base64, "base64");
          const raw = bytes.toString("utf8");
          if (hash(bytes) !== input.contentHash || artifact.content_hash !== input.contentHash)
            throw new MekoError("ERROR_TOOL_FAILURE", "Meko handoff content hash did not match.");
          const packet = decodePacket(JSON.parse(raw));
          if (packet.project !== input.project || packet.threadId !== input.threadId)
            throw new MekoError(
              "ERROR_AUTH_RESTRICTED",
              "Meko handoff belongs to a different project or thread.",
            );
          if (packet.text.length > 60_000)
            throw new MekoError("ERROR_TOOL_FAILURE", "Meko handoff exceeded the context limit.");
          signal.throwIfAborted();
          text = packet.text;
          return {
            status: "SUCCESS_WITH_EVIDENCE",
            message: "Handoff retrieved and verified.",
            contentHash: input.contentHash,
            conversationId: input.conversationId,
            size: Buffer.byteLength(raw),
          };
        }),
      { threadId: input.threadId, project: input.project },
    );
    return {
      receipt,
      ...(receipt.status === "SUCCESS_WITH_EVIDENCE" && text !== undefined ? { text } : {}),
    };
  }
}
