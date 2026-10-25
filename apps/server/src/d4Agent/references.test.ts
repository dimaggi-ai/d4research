import { assert, it } from "@effect/vitest";
import { DEFAULT_D4_AGENT_SETTINGS, ProjectId, ThreadId } from "@d4research/contracts";
import type { AgentReference } from "./references.ts";
import { referenceContext, resolveAgentReference, validateReplyReferences } from "./references.ts";

const projectId = ProjectId.make("project-one");
const threadId = ThreadId.make("thread-one");
const thread: AgentReference = {
  kind: "thread",
  id: threadId,
  title: "Investigate the cache",
  projectId,
  threadId,
};
const config = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  projectContexts: { [projectId]: "Dimaggi" as const },
};

it("resolves references by explicit id, deep link, and stable mention token", () => {
  for (const text of [
    `Open ${threadId}`,
    `Open https://app.example/threads/${threadId}`,
    `Open [[thread:${threadId}]]`,
  ]) {
    const result = resolveAgentReference(text, [thread]);
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") assert.equal(result.target, thread);
  }
});

it("ignores duplicate titles and asks only for multiple explicit identities", () => {
  const duplicate: AgentReference = {
    ...thread,
    id: "thread-two",
    threadId: ThreadId.make("thread-two"),
  };
  const another: AgentReference = {
    kind: "project",
    id: "project-two",
    title: "Release readiness",
    projectId: ProjectId.make("project-two"),
    threadId: null,
  };

  const duplicateResult = resolveAgentReference("Open Investigate the cache", [thread, duplicate]);
  assert.equal(duplicateResult.kind, "none");
  if (duplicateResult.kind === "ambiguous") assert.equal(duplicateResult.candidates.length, 2);

  const multipleResult = resolveAgentReference(`${threadId} and project-two`, [thread, another]);
  assert.equal(multipleResult.kind, "ambiguous");
  if (multipleResult.kind === "ambiguous") assert.equal(multipleResult.candidates.length, 2);
});

it("defaults unmapped references to Global and uses the mapped context", () => {
  assert.equal(referenceContext({ ...thread, projectId: null }, config), "Global");
  assert.equal(referenceContext(thread, config), "Dimaggi");
});

it("links valid in-scope thread references and renders other references as plain labels", () => {
  const unmappedThread = {
    ...thread,
    id: "thread-unmapped",
    title: "Server supplied unmapped title",
    projectId: ProjectId.make("unmapped-project"),
    threadId: ThreadId.make("thread-unmapped"),
  };
  const result = validateReplyReferences(
    `See [[thread:${threadId}|model alias]], [[thread:${unmappedThread.id}|untrusted alias]], and [[thread:missing|missing thread]].`,
    [thread, unmappedThread],
    "Dimaggi",
    config,
  );

  assert.equal(
    result.text,
    "See Investigate the cache, Unavailable reference, and Unavailable reference.",
  );
  assert.deepEqual(result.links, [
    { label: "Investigate the cache", threadId, projectId },
    { label: "Unavailable reference", threadId: null, projectId: null },
    { label: "Unavailable reference", threadId: null, projectId: null },
  ]);
});
