import { EnvironmentId, ProjectId } from "@d4research/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";
const agentProjectId = ProjectId.make("agent-project");

vi.mock("@d4research/client-runtime/state/projects", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createProjectEnvironmentAtoms: () => ({}),
}));
vi.mock("@d4research/client-runtime/state/runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEnvironmentRpcQueryAtomFamily: () => () => Atom.make(null),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([
          ["local", { enabled: true }],
          ["remote", { enabled: true }],
        ]),
      }),
    },
  };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  const { ProjectId } = await import("@d4research/contracts");
  const v2Project = {
    id: ProjectId.make("agent-project"),
    title: "Owned agent",
    workspaceRoot: "/synthetic/agent",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
  };
  return {
    environmentSnapshotAtom: Atom.family(() =>
      Atom.make({
        projects: [v2Project, { ...v2Project, id: "ordinary", title: "d4 Agent" }],
      }),
    ),
  };
});
vi.mock("./server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const identity = Atom.family(() => Atom.make(AsyncResult.success(null)));
  return {
    serverEnvironment: {
      configValueAtom: Atom.family(() => Atom.make(null)),
      d4AgentIdentity: ({ environmentId }: { environmentId: string }) => identity(environmentId),
    },
  };
});
import { environmentProjects } from "./projects";
import { serverEnvironment } from "./server";

const registry = AtomRegistry.make();
afterEach(() => registry.reset());
it("mobile project navigation hides only the identity-owned project and keeps its chat lookup", () => {
  const local = EnvironmentId.make("local");
  // The real query atom is read-only; the mocked identity source is writable.
  const identity = serverEnvironment.d4AgentIdentity({
    environmentId: local,
    input: {},
  }) as Atom.Writable<AsyncResult.AsyncResult<{ projectId: ProjectId; threadId: string } | null>>;
  registry.set(identity, AsyncResult.success({ projectId: agentProjectId, threadId: "agent" }));
  const visible = registry.get(environmentProjects.normalProjectsAtom);
  expect(
    visible.some((project) => project.environmentId === local && project.id === agentProjectId),
  ).toBe(false);
  expect(
    visible.some((project) => project.environmentId === "remote" && project.id === agentProjectId),
  ).toBe(true);
  expect(visible.filter((project) => project.title === "d4 Agent")).toHaveLength(2);
  expect(
    registry.get(
      environmentProjects.projectAtom({ environmentId: local, projectId: agentProjectId }),
    ),
  ).toMatchObject({ id: agentProjectId, title: "Owned agent" });
  expect(registry.get(environmentProjects.projectsAtom)).toHaveLength(4);
});
