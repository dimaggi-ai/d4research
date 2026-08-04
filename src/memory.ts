import type { MemoryConnectorConfig, MemoryRecord } from "./contracts";
import { ResearchDatabase } from "./database";

const TIMEOUT_MS = 10_000;

function endpoint(url: string): string {
  return url.replace(/\/+$/, "");
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEntries(value: unknown): Array<{ id?: string; text: string; score?: number; metadata?: unknown }> {
  const record = asRecord(value);
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record?.results)
      ? record.results
      : [];
  return candidates.flatMap((candidate) => {
    const entry = asRecord(candidate);
    if (!entry) return [];
    const text = typeof entry.text === "string" ? entry.text : typeof entry.memory === "string" ? entry.memory : null;
    if (!text) return [];
    return [{
      text,
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.score === "number" ? { score: entry.score } : {}),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    }];
  });
}

export class MemoryService {
  constructor(private readonly database: ResearchDatabase) {}

  async probe(connector: MemoryConnectorConfig): Promise<{ ok: boolean; message: string }> {
    if (connector.kind === "sqlite") return { ok: true, message: "Local SQLite and FTS memory ready." };
    if (!connector.enabled) return { ok: false, message: "Connector is disabled." };
    try {
      if (connector.kind === "memo") {
        await fetchJson(`${endpoint(connector.url)}/health`);
        return { ok: true, message: "Memo REST memory ready." };
      }
      await this.mekoCall(connector, "memory_search", {
        conversation_id: "t3research-health",
        run_id: "t3research-health",
        agent_id: "t3research",
        scope: "read",
        query: "t3research connector health",
        limit: 1,
      });
      return { ok: true, message: "Meko MCP memory ready." };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async remember(
    connectorId: string,
    input: Omit<MemoryRecord, "id" | "createdAt">,
  ): Promise<unknown> {
    const connector = this.requireEnabled(connectorId);
    if (connector.kind === "sqlite") return this.database.remember(input);
    if (connector.kind === "memo") {
      return await fetchJson(`${endpoint(connector.url)}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: input.content,
          source: "t3research",
          project: input.runId ?? "global",
        }),
      });
    }
    return await this.mekoCall(connector, "memory_add", {
      conversation_id: (input.runId ?? "global").replaceAll("-", ""),
      run_id: input.runId ?? "global",
      agent_id: "t3research",
      scope: "write",
      text: input.content,
      metadata: input.metadata,
    });
  }

  async search(connectorId: string, query: string, runId: string | null, limit = 12): Promise<unknown> {
    const connector = this.requireEnabled(connectorId);
    if (connector.kind === "sqlite") return this.database.searchMemory(query, runId, limit);
    if (connector.kind === "memo") {
      const url = new URL(`${endpoint(connector.url)}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("k", String(limit));
      if (runId) url.searchParams.set("project", runId);
      return normalizeEntries(await fetchJson(url.toString()));
    }
    const raw = await this.mekoCall(connector, "memory_search", {
      conversation_id: (runId ?? "global").replaceAll("-", ""),
      run_id: runId ?? "global",
      agent_id: "t3research",
      scope: "read",
      query,
      limit,
    });
    return normalizeEntries(raw);
  }

  private requireEnabled(id: string): MemoryConnectorConfig {
    const connector = this.database.getMemoryConnector(id);
    if (!connector) throw new Error(`Memory connector ${id} was not found.`);
    if (!connector.enabled) throw new Error(`Memory connector ${id} is disabled.`);
    return connector;
  }

  private async mekoCall(
    connector: MemoryConnectorConfig,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const authorization = process.env.T3RESEARCH_MEKO_AUTHORIZATION?.trim();
    if (!authorization) throw new Error("T3RESEARCH_MEKO_AUTHORIZATION is required.");
    const envelope = asRecord(
      await fetchJson(connector.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const error = asRecord(envelope?.error);
    if (error) throw new Error(typeof error.message === "string" ? error.message : "Meko MCP error.");
    const result = asRecord(envelope?.result);
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.map(asRecord).find((item) => item?.type === "text" && typeof item.text === "string")?.text;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return { text }; }
    }
    return envelope?.result ?? envelope;
  }
}
