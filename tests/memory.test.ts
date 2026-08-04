import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchDatabase } from "../src/database";
import { MemoryService } from "../src/memory";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "t3research-memory-"));
  const database = new ResearchDatabase(directory);
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, memory: new MemoryService(database) };
}

describe("MemoryService", () => {
  test("uses the durable local connector by default", async () => {
    const { memory } = setup();
    await memory.remember("local", {
      runId: null,
      kind: "context",
      content: "Shared provider-neutral context",
      metadata: {},
    });
    const results = await memory.search("local", "provider-neutral", null);
    expect(results).toHaveLength(1);
    expect(await memory.probe({ id: "local", name: "Local", kind: "sqlite", url: "", enabled: true })).toEqual({
      ok: true,
      message: "Local SQLite and FTS memory ready.",
    });
  });

  test("supports the Memo REST add, search, and health contract", async () => {
    const { database, memory } = setup();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") return Response.json({ status: "ok" });
        if (url.pathname === "/add") return Response.json({ ok: true, id: "memo-1" });
        if (url.pathname === "/search") {
          return Response.json({ results: [{ id: "memo-1", text: "Memo evidence", score: 0.9 }] });
        }
        return new Response(null, { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    const connector = {
      id: "memo-test",
      name: "Memo test",
      kind: "memo" as const,
      url: `http://127.0.0.1:${server.port}`,
      enabled: true,
    };
    database.upsertMemoryConnector(connector);
    expect((await memory.probe(connector)).ok).toBeTrue();
    expect(
      await memory.remember(connector.id, {
        runId: null,
        kind: "context",
        content: "Remember this",
        metadata: {},
      }),
    ).toEqual({ ok: true, id: "memo-1" });
    expect(await memory.search(connector.id, "evidence", null)).toEqual([
      { id: "memo-1", text: "Memo evidence", score: 0.9 },
    ]);
  });
});
