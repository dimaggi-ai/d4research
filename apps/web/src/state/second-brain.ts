import { createSecondBrainEnvironmentAtoms } from "@d4research/client-runtime/state/second-brain";
import { connectionAtomRuntime } from "../connection/runtime";

export const secondBrain = createSecondBrainEnvironmentAtoms(connectionAtomRuntime);
