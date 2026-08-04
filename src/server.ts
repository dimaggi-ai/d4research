import { isProviderDriver, type ProviderConfig, type ResearchRun } from "./contracts";
import { ResearchDatabase } from "./database";
import { probeProvider } from "./providers";
import { ResearchOrchestrator } from "./research";
import { INSTALL_UI } from "./ui";
import { MemoryService } from "./memory";
import { parseResearchDirective } from "./directives";

const VERSION = "0.1.0";
const host = process.env.T3RESEARCH_HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.T3RESEARCH_PORT || "7341", 10);
const dataDirectory = process.env.T3RESEARCH_DATA_DIR?.trim() || "./data";

export const database = new ResearchDatabase(dataDirectory);
export const orchestrator = new ResearchOrchestrator(database);
export const memory = new MemoryService(database);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function runDetail(runId: string) {
  return {
    run: database.requireRun(runId),
    events: database.listEvents(runId),
    messages: database.listMessages(runId),
    sources: database.listSources(runId),
    citations: database.listCitations(runId),
    artifacts: database.listArtifacts(runId),
  };
}

function exportedReport(runId: string): Response {
  const detail = runDetail(runId);
  const report = detail.run.report || "Research has not produced a report yet.";
  const sources = detail.sources.length
    ? `\n\n## Sources\n\n${detail.sources.map((source, index) => `${index + 1}. [${source.title}](${source.url}) — SHA-256 \`${source.contentHash}\``).join("\n")}`
    : "\n\n## Sources\n\nNo source URLs were recorded.";
  const audit = [...detail.artifacts].reverse().find((artifact) => artifact.kind === "audit");
  const content = `${report}${sources}${audit ? `\n\n## Audit\n\n${audit.content}` : ""}\n`;
  const filename = `${detail.run.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "research"}.md`;
  return new Response(content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
  return value as Record<string, unknown>;
}

function providerIds(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return [fallback];
  const ids = [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
  return ids.length ? ids : [fallback];
}

function createRunInput(input: Record<string, unknown>) {
  const providerId = requireString(input.providerId, "providerId");
  const requestedDepth = (["quick", "deep", "max"].includes(String(input.depth)) ? input.depth : "deep") as ResearchRun["depth"];
  const directive = parseResearchDirective(
    requireString(input.question, "question"),
    providerIds(input.providerIds, providerId),
    requestedDepth,
  );
  for (const id of directive.providerIds) {
    const provider = database.getProvider(id);
    if (!provider) throw new Error(`Provider ${id} was not found.`);
    if (!provider.enabled) throw new Error(`Provider ${id} is disabled.`);
  }
  return {
    title: requireString(input.title, "title"),
    question: directive.question,
    providerId: directive.providerIds[0]!,
    providerChainIds: directive.providerIds,
    depth: directive.depth,
  };
}

async function mcp(request: Request): Promise<Response> {
  const envelope = await body(request);
  const id = envelope.id ?? null;
  const method = envelope.method;
  const params = (envelope.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "t3research", version: VERSION },
    });
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  if (method === "tools/list") {
    const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: "object",
      properties,
      required,
      additionalProperties: false,
    });
    return ok({ tools: [
      { name: "research_start", description: "Create and plan a durable research run. Use providerIds or #deep-research [id, id] in the question for task-level agent rotation.", inputSchema: schema({ title:{type:"string"}, question:{type:"string"}, providerId:{type:"string"}, providerIds:{type:"array",items:{type:"string"}}, depth:{enum:["quick","deep","max"]} }, ["title","question","providerId"]) },
      { name: "research_status", description: "Read a research run and its event history.", inputSchema: schema({ runId:{type:"string"} }, ["runId"]) },
      { name: "research_execute", description: "Approve and execute a proposed research plan.", inputSchema: schema({ runId:{type:"string"} }, ["runId"]) },
      { name: "research_handoff", description: "Change provider while preserving shared run context.", inputSchema: schema({ runId:{type:"string"}, providerId:{type:"string"} }, ["runId","providerId"]) },
      { name: "research_chat", description: "Continue a durable run using its active provider and shared context.", inputSchema: schema({ runId:{type:"string"}, text:{type:"string"} }, ["runId","text"]) },
      { name: "memory_remember", description: "Store shared context in local SQLite, Memo, or Meko.", inputSchema: schema({ connector:{type:"string",default:"local"}, runId:{type:"string"}, content:{type:"string"}, kind:{enum:["context","evidence","decision","handoff"]} }, ["content"]) },
      { name: "memory_search", description: "Search local or configured external research memory.", inputSchema: schema({ connector:{type:"string",default:"local"}, query:{type:"string"}, runId:{type:"string"} }, ["query"]) },
    ] });
  }
  if (method === "tools/call") {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (name === "research_start") {
      const run = database.createRun(createRunInput(args));
      result = await orchestrator.plan(run.id);
    } else if (name === "research_status") {
      const runId = requireString(args.runId, "runId");
      result = runDetail(runId);
    } else if (name === "research_execute") {
      orchestrator.execute(requireString(args.runId, "runId"));
      result = { accepted: true };
    } else if (name === "research_handoff") {
      result = orchestrator.handoff(requireString(args.runId, "runId"), requireString(args.providerId, "providerId"));
    } else if (name === "research_chat") {
      result = await orchestrator.chat(requireString(args.runId, "runId"), requireString(args.text, "text"));
    } else if (name === "memory_remember") {
      result = await memory.remember(typeof args.connector === "string" ? args.connector : "local", {
        runId: typeof args.runId === "string" ? args.runId : null,
        kind: (["context", "evidence", "decision", "handoff"].includes(String(args.kind)) ? args.kind : "context") as "context",
        content: requireString(args.content, "content"),
        metadata: { source: "mcp" },
      });
    } else if (name === "memory_search") {
      result = await memory.search(
        typeof args.connector === "string" ? args.connector : "local",
        requireString(args.query, "query"),
        typeof args.runId === "string" ? args.runId : null,
      );
    } else {
      throw new Error(`Unknown MCP tool ${String(name)}.`);
    }
    return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  }
  return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      return new Response(INSTALL_UI, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", version: VERSION, database: "ready" });
    }
    if (request.method === "POST" && url.pathname === "/mcp") return await mcp(request);
    if (request.method === "GET" && url.pathname === "/api/providers") return json(database.listProviders());
    if (request.method === "GET" && url.pathname === "/api/memory-connectors") return json(database.listMemoryConnectors());
    if (request.method === "POST" && url.pathname === "/api/memory-connectors") {
      const input = await body(request);
      const kind = String(input.kind);
      if (!["sqlite", "memo", "meko"].includes(kind)) throw new Error("Unsupported memory connector kind.");
      const connector = {
        id: requireString(input.id, "id"),
        name: requireString(input.name, "name"),
        kind: kind as "sqlite" | "memo" | "meko",
        url: typeof input.url === "string" ? input.url.trim() : "",
        enabled: input.enabled !== false,
      };
      database.upsertMemoryConnector(connector);
      return json(connector, 201);
    }
    if (request.method === "POST" && segments[0] === "api" && segments[1] === "memory-connectors" && segments[3] === "probe") {
      const connector = database.getMemoryConnector(requireString(segments[2], "connector id"));
      if (!connector) return json({ error: "Memory connector not found." }, 404);
      return json(await memory.probe(connector));
    }
    if (request.method === "POST" && url.pathname === "/api/providers") {
      const input = await body(request);
      if (!isProviderDriver(input.driver)) throw new Error("Unsupported provider driver.");
      const provider: ProviderConfig = {
        id: requireString(input.id, "id"),
        name: requireString(input.name, "name"),
        driver: input.driver,
        model: typeof input.model === "string" ? input.model.trim() : "",
        endpoint: typeof input.endpoint === "string" ? input.endpoint.trim() : "",
        command: typeof input.command === "string" ? input.command.trim() : "",
        enabled: input.enabled !== false,
      };
      database.upsertProvider(provider);
      return json(provider, 201);
    }
    if (request.method === "POST" && segments[0] === "api" && segments[1] === "providers" && segments[3] === "probe") {
      const provider = database.getProvider(requireString(segments[2], "provider id"));
      if (!provider) return json({ error: "Provider not found." }, 404);
      return json(await probeProvider(provider));
    }
    if (request.method === "GET" && url.pathname === "/api/runs") return json(database.listRuns());
    if (request.method === "POST" && url.pathname === "/api/runs") {
      const input = await body(request);
      const run = database.createRun(createRunInput(input));
      return json(await orchestrator.plan(run.id), 201);
    }
    if (segments[0] === "api" && segments[1] === "runs" && segments[2]) {
      const runId = segments[2];
      if (request.method === "GET" && segments.length === 3) {
        return json(runDetail(runId));
      }
      if (request.method === "GET" && segments[3] === "export") return exportedReport(runId);
      if (request.method === "POST" && segments[3] === "execute") {
        orchestrator.execute(runId); return json({ accepted: true }, 202);
      }
      if (request.method === "POST" && segments[3] === "cancel") return json(orchestrator.cancel(runId));
      if (request.method === "POST" && segments[3] === "handoff") {
        const input = await body(request); return json(orchestrator.handoff(runId, requireString(input.providerId, "providerId")));
      }
      if (request.method === "POST" && segments[3] === "chat") {
        const input = await body(request);
        return json(await orchestrator.chat(runId, requireString(input.text, "text")), 201);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/memory/search") {
      return json(
        await memory.search(
          url.searchParams.get("connector") || "local",
          url.searchParams.get("q") || "",
          url.searchParams.get("runId"),
        ),
      );
    }
    return json({ error: "Not found." }, 404);
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : String(cause) }, 400);
  }
}

if (import.meta.main) {
  Bun.serve({ hostname: host, port, fetch: handleRequest });
  console.log(`[t3research] listening on http://${host}:${port} (data=${dataDirectory})`);
}
