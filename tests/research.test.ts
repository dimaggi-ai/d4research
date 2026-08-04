import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchDatabase } from "../src/database";
import { ResearchOrchestrator } from "../src/research";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "t3research-run-"));
  directories.push(directory);
  const database = new ResearchDatabase(directory);
  return { database, orchestrator: new ResearchOrchestrator(database) };
}

describe("ResearchOrchestrator", () => {
  test("plans, executes parallel workers, synthesizes, and audits", async () => {
    const { database, orchestrator } = setup();
    database.upsertProvider({
      id: "second-mock",
      name: "Second mock",
      driver: "mock",
      model: "deterministic-v1",
      endpoint: "",
      command: "",
      enabled: true,
    });
    const created = database.createRun({
      title: "Full lifecycle",
      question: "Can provider-neutral shared context support deep research?",
      providerId: "local-mock",
      providerChainIds: ["local-mock", "second-mock"],
      depth: "deep",
    });
    const planned = await orchestrator.plan(created.id);
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.plan?.questions.length).toBeGreaterThan(1);
    orchestrator.execute(created.id);
    await orchestrator.waitForCompletion(created.id);
    const completed = database.requireRun(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.report).toContain("# Research report");
    expect(database.listSources(created.id)).toHaveLength(1);
    expect(database.listCitations(created.id).length).toBeGreaterThan(0);
    const artifactKinds = database.listArtifacts(created.id).map((artifact) => artifact.kind);
    expect(artifactKinds.filter((kind) => kind === "evidence").length).toBeGreaterThan(0);
    expect(artifactKinds).toContain("report");
    expect(artifactKinds).toContain("audit");
    const events = database.listEvents(created.id).map((event) => event.type);
    expect(events).toContain("research.started");
    expect(events).toContain("audit.completed");
    expect(database.listEvents(created.id).filter((event) => event.type === "worker.started").map((event) => event.providerId)).toEqual([
      "local-mock",
      "second-mock",
      "local-mock",
    ]);
    expect(events.filter((event) => event === "task.handoff")).toHaveLength(4);
    expect(database.requireRun(created.id).activeProviderId).toBe("local-mock");
    expect(database.searchMemory("PROVIDER CHAIN", created.id).some((item) => item.kind === "handoff")).toBeTrue();
    database.close();
  });

  test("chat can hand off providers while preserving one run and message history", async () => {
    const { database, orchestrator } = setup();
    const run = database.createRun({
      title: "Handoff",
      question: "Preserve shared context",
      providerId: "local-mock",
      depth: "quick",
    });
    await orchestrator.plan(run.id);
    await orchestrator.chat(run.id, "First provider turn");
    database.upsertProvider({
      id: "second-mock",
      name: "Second mock",
      driver: "mock",
      model: "deterministic-v1",
      endpoint: "",
      command: "",
      enabled: true,
    });
    const handedOff = orchestrator.handoff(run.id, "second-mock");
    expect(handedOff.id).toBe(run.id);
    expect(handedOff.activeProviderId).toBe("second-mock");
    await orchestrator.chat(run.id, "Continue with the shared context");
    expect(database.listMessages(run.id).map((message) => message.providerId)).toEqual([
      null,
      "local-mock",
      null,
      "second-mock",
    ]);
    expect(database.searchMemory("Continue run", run.id).some((item) => item.kind === "handoff")).toBeTrue();
    database.close();
  });
});
