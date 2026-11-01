import { expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId, ThreadId } from "@d4research/contracts";
import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
  niaSystemTextSegments,
  niaThreadReferenceMarkdown,
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

it("links URLs and server-validated thread tokens in Nia system text, nothing else", () => {
  const known = ThreadId.make("known");
  expect(
    niaSystemTextSegments(
      "• Dimaggi: [[thread:known|Completed: Fix]]\n• [[thread:forged|Forged]] — Read: https://host/intel/#cto. <b>x</b>",
      [{ threadId: known }, { threadId: null }],
    ),
  ).toEqual([
    { kind: "text", text: "• Dimaggi: " },
    { kind: "thread", text: "Completed: Fix", threadId: known },
    { kind: "text", text: "\n• Forged — Read: " },
    { kind: "url", text: "https://host/intel/#cto", href: "https://host/intel/#cto" },
    { kind: "text", text: ". <b>x</b>" },
  ]);
  expect(niaSystemTextSegments("javascript:alert(1)", [])).toEqual([
    { kind: "text", text: "javascript:alert(1)" },
  ]);
});

it("links Nia's prose thread references and leaves code, other links and unknown ids alone", () => {
  const environmentId = EnvironmentId.make("local");
  const known = new Set(["0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71"]);
  const action = "d4-action:abc12345-6789";
  const markdown = niaThreadReferenceMarkdown(
    [
      `Started ${action}.`,
      "Known 0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71 and unknown 1a2b3c4d-0000-4000-8000-000000000000.",
      "Open https://app.host/local/0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71, [Fix](https://app.host/local/d4-action%3Aabc12345-6789).",
      "Other https://app.host/remote/0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71 [Docs](https://x.dev/a)",
      `Code \`${action}\` and <t3-thread://v2/local/${action}>`,
    ].join("\n"),
    environmentId,
    known,
  );
  expect(markdown.split("\n")).toEqual([
    "Started [Thread abc12345](t3-thread://v2/local/d4-action:abc12345-6789).",
    "Known [Thread 0f6c2a1e](t3-thread://v2/local/0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71) and unknown 1a2b3c4d-0000-4000-8000-000000000000.",
    "Open [Thread 0f6c2a1e](t3-thread://v2/local/0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71), [Fix](t3-thread://v2/local/d4-action:abc12345-6789).",
    "Other https://app.host/remote/0f6c2a1e-7d4b-4c11-9a2e-5b8f3c0d9e71 [Docs](https://x.dev/a)",
    `Code \`${action}\` and <t3-thread://v2/local/${action}>`,
  ]);
});
