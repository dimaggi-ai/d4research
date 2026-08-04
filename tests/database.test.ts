import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchDatabase } from "../src/database";

const directories: string[] = [];

function makeDatabase(): ResearchDatabase {
  const directory = mkdtempSync(join(tmpdir(), "t3research-db-"));
  directories.push(directory);
  return new ResearchDatabase(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ResearchDatabase", () => {
  test("seeds every supported local provider adapter", () => {
    const database = makeDatabase();
    expect(database.listProviders().map((provider) => provider.driver).sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "junie",
      "mock",
      "ollama",
    ]);
    expect(database.getProvider("junie-local")?.enabled).toBeFalse();
    database.close();
  });

  test("seeds local, Memo, and Meko memory connector choices safely", () => {
    const database = makeDatabase();
    expect(database.listMemoryConnectors()).toEqual([
      { id: "memo", name: "Local Memo", kind: "memo", url: "http://host.docker.internal:8099", enabled: false },
      { id: "local", name: "Local SQLite", kind: "sqlite", url: "", enabled: true },
      { id: "meko", name: "Meko Cloud", kind: "meko", url: "https://mcp.mekodata.ai/mcp", enabled: false },
    ]);
    database.close();
  });

  test("persists searchable memory under one durable run", () => {
    const database = makeDatabase();
    const run = database.createRun({
      title: "Memory",
      question: "How do agents share evidence?",
      providerId: "local-mock",
      depth: "deep",
    });
    database.remember({
      runId: run.id,
      kind: "evidence",
      content: "SQLite is the authoritative local evidence ledger.",
      metadata: { source: "test" },
    });
    expect(database.searchMemory("authoritative evidence", run.id)).toHaveLength(1);
    expect(database.listEvents(run.id).map((event) => event.type)).toContain("run.created");
    database.close();
  });
});
