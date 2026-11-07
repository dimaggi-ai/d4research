import { createAlmanacEnvironmentAtoms } from "@d4research/client-runtime/state/almanac";
import { connectionAtomRuntime } from "../connection/runtime";

export const almanac = createAlmanacEnvironmentAtoms(connectionAtomRuntime);
