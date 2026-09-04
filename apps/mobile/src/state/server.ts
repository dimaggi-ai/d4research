import { createServerEnvironmentAtoms } from "@d4research/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@d4research/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
});
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
