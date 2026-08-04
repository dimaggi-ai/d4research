import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDirectory = mkdtempSync(join(tmpdir(), "t3research-http-"));
process.env.T3RESEARCH_DATA_DIR = dataDirectory;

let handleRequest: (request: Request) => Promise<Response>;
let closeDatabase: () => void;

beforeAll(async () => {
  const server = await import(`../src/server.ts?test=${crypto.randomUUID()}`);
  handleRequest = server.handleRequest;
  closeDatabase = () => server.database.close();
});

afterAll(() => {
  closeDatabase();
  rmSync(dataDirectory, { recursive: true, force: true });
});

function request(path: string, init?: RequestInit): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`, init));
}

describe("HTTP and MCP", () => {
  test("serves health and the responsive installation UI", async () => {
    expect(await (await request("/health")).json()).toMatchObject({ status: "ok", database: "ready" });
    const html = await (await request("/setup")).text();
    expect(html).toContain("T3 Research");
    expect(html).toContain("Save provider");
    expect(html).toContain("Create and plan");
    expect(html).toContain("@media(max-width:760px)");
  });

  test("lists MCP research and shared-memory tools", async () => {
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const envelope = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(envelope.result.tools.map((tool) => tool.name)).toEqual([
      "research_start",
      "research_status",
      "research_execute",
      "research_handoff",
      "research_chat",
      "memory_remember",
      "memory_search",
    ]);
  });

  test("creates a planned run through the installation API", async () => {
    await request("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-second-mock",
        name: "HTTP second mock",
        driver: "mock",
        model: "deterministic-v1",
        endpoint: "",
        command: "",
        enabled: true,
      }),
    });
    const response = await request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "HTTP run",
        question: "#deep-research [local-mock, http-second-mock] Does the installation flow work?",
        providerId: "local-mock",
        depth: "quick",
      }),
    });
    expect(response.status).toBe(201);
    const run = (await response.json()) as { id: string; question: string; depth: string; providerChainIds: string[] };
    expect(run).toMatchObject({
      title: "HTTP run",
      question: "Does the installation flow work?",
      depth: "deep",
      providerChainIds: ["local-mock", "http-second-mock"],
      status: "awaiting_approval",
    });
    const chat = await request(`/api/runs/${run.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Continue in shared context" }),
    });
    expect(chat.status).toBe(201);
    const detail = (await (await request(`/api/runs/${run.id}`)).json()) as { messages: unknown[]; sources: unknown[]; citations: unknown[]; artifacts: unknown[] };
    expect(detail.messages).toHaveLength(2);
    expect(detail.sources).toEqual([]);
    expect(detail.citations).toEqual([]);
    expect(detail.artifacts).toEqual([]);
  });

  test("rejects a disabled agent in a deep-research chain", async () => {
    const response = await request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Invalid chain",
        question: "#deep-research [local-mock, junie-local] This must not start partially",
        providerId: "local-mock",
        depth: "deep",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Provider junie-local is disabled." });
  });
});
