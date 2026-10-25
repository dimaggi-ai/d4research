import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@d4research/contracts";
import { createEnvironmentProjectAtoms } from "@d4research/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@d4research/client-runtime/state/projects";

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
