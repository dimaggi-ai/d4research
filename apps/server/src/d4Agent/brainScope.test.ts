import { assert, it } from "@effect/vitest";
import { DEFAULT_D4_AGENT_SETTINGS, ProjectId } from "@d4research/contracts";
import { contextScopeHash } from "./brainScope.ts";

const yb = ProjectId.make("yb");
const dimaggi = ProjectId.make("dimaggi");
const personal = ProjectId.make("personal");
const settings = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  projectContexts: {
    [yb]: "YB" as const,
    [dimaggi]: "Dimaggi" as const,
    [personal]: "Personal" as const,
  },
  pipelineProjects: { "research:shared": yb, "dev:other": dimaggi },
};

it("pipeline moves invalidate both affected contexts but preserve unrelated work contexts", () => {
  const moved = {
    ...settings,
    pipelineProjects: { ...settings.pipelineProjects, "research:shared": dimaggi },
  };
  for (const context of ["Global", "YB", "Dimaggi"] as const)
    assert.notEqual(contextScopeHash(context, settings), contextScopeHash(context, moved));
  assert.equal(contextScopeHash("Personal", settings), contextScopeHash("Personal", moved));
  const unrelated = {
    ...settings,
    pipelineProjects: { ...settings.pipelineProjects, "dev:other": personal },
  };
  assert.equal(contextScopeHash("YB", settings), contextScopeHash("YB", unrelated));
});

it("remapping a pipeline between projects in one context invalidates that context", () => {
  const second = ProjectId.make("yb-second");
  const before = {
    ...settings,
    projectContexts: { ...settings.projectContexts, [second]: "YB" as const },
  };
  const after = {
    ...before,
    pipelineProjects: { ...before.pipelineProjects, "research:shared": second },
  };
  assert.notEqual(contextScopeHash("YB", before), contextScopeHash("YB", after));
});

it("overview source remapping invalidates only the old and new owning contexts", () => {
  const before = { ...settings, overviewSources: { mail: "Personal" as const } };
  const after = { ...settings, overviewSources: { mail: "Dimaggi" as const } };
  for (const context of ["Personal", "Dimaggi"] as const)
    assert.notEqual(contextScopeHash(context, before), contextScopeHash(context, after));
  for (const context of ["Global", "YB"] as const)
    assert.equal(contextScopeHash(context, before), contextScopeHash(context, after));
});
