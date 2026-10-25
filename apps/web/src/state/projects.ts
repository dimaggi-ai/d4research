import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@d4research/contracts";
import { createEnvironmentProjectAtoms } from "@d4research/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@d4research/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@d4research/client-runtime/state/runtime";
import { WS_METHODS } from "@d4research/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { serverEnvironment } from "./server";

export const agentProjectIdAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const identity = get(serverEnvironment.d4AgentIdentity({ environmentId, input: {} }));
    return Option.getOrNull(AsyncResult.value(identity))?.projectId ?? null;
  }),
);

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  agentProjectIdAtom,
});
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
