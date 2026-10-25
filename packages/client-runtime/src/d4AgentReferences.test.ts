import { expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@d4research/contracts";
import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
} from "./d4AgentReferences.ts";

it("offers only active references in the bound scope and current environment", () => {
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("yb");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    d4Agent: {
      ...DEFAULT_SERVER_SETTINGS.d4Agent,
      projectContexts: { [projectId]: "YB" as const },
      pipelineProjects: { "dev:Build": projectId },
    },
    dev: {
      ...DEFAULT_SERVER_SETTINGS.dev,
      scenarios: [{ ...DEFAULT_SERVER_SETTINGS.dev.scenarios[0]!, name: "Build" }],
    },
  };
  const projects = [
    { id: projectId, title: "YB project", environmentId },
    { id: ProjectId.make("secret"), title: "Secret project", environmentId },
  ];
  const base = { projectId, environmentId, archivedAt: null, deletedAt: null };
  const threads = [
    { ...base, id: "active", title: "Active" },
    { ...base, id: "archived", title: "Archived", archivedAt: "2026-01-01" },
    { ...base, id: "deleted", title: "Deleted", deletedAt: "2026-01-01" },
    { ...base, id: "secret-thread", title: "Secret thread", projectId: projects[1]!.id },
    { ...base, id: "remote", title: "Remote", environmentId: EnvironmentId.make("remote") },
  ];
  const input = {
    environmentId,
    context: "YB" as const,
    agentProjectId: null,
    settings,
    projects,
    threads,
    query: "",
  };
  expect(agentMentionOptions(input).map((option) => `${option.kind}:${option.id}`)).toEqual([
    "thread:active",
    "project:yb",
    "pipeline:dev:Build",
  ]);
  expect(
    agentMentionOptions({ ...input, context: "Global" }).map((option) => option.title),
  ).toContain("Secret thread");
  expect(agentMentionOptions({ ...input, query: null })).toEqual([]);
  expect(agentMentionOptions({ ...input, agentProjectId: projectId })).toEqual([]);
});

it("inserts thread, project and pipeline ids without carrying the mutable title", () => {
  for (const kind of ["thread", "project", "pipeline"] as const) {
    const text = insertAgentMention("check @old title", {
      kind,
      id: "stable-id",
      title: "old title",
    });
    expect(text).toBe(`check [[${kind}:stable-id]] `);
    expect(agentMentionQuery(text)).toBeNull();
  }
  expect(agentMentionQuery("check @partial")).toBe("partial");
  expect(agentMentionQuery("name@example.com")).toBeNull();
});

it("flags a draft only when Nia moved to another context or replaced its session", () => {
  const first = ThreadId.make("first");
  const origin = agentDraftOrigin({ brainContext: "Global", threadId: first });
  expect(agentDraftMovedNotice(null, { brainContext: "YB", threadId: null })).toBeNull();
  expect(agentDraftMovedNotice(origin, { brainContext: "Global", threadId: first })).toBeNull();
  expect(agentDraftMovedNotice(origin, { brainContext: "Global", threadId: null })).toBeNull();
  expect(agentDraftMovedNotice(origin, { brainContext: "YB", threadId: first })).toEqual({
    message: "You wrote this draft while Nia was in Global. Nia is now in YB.",
    reassignLabel: "Use in YB",
  });
  expect(
    agentDraftMovedNotice(origin, { brainContext: "Global", threadId: ThreadId.make("second") }),
  ).toEqual({
    message: "You wrote this draft in an earlier Nia session.",
    reassignLabel: "Use in the current session",
  });
});
