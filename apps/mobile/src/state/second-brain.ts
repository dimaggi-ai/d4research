import { createSecondBrainEnvironmentAtoms } from "@d4research/client-runtime/state/second-brain";
import { connectionAtomRuntime } from "../connection/runtime";

export const {
  refresh: refreshSecondBrain,
  secondBrainStatusQuery,
  secondBrainProposalsQuery,
  secondBrainProposalQuery,
  secondBrainAcceptCommand,
  secondBrainRejectCommand,
  secondBrainReindexCommand,
  secondBrainLintCommand,
  secondBrainRegenerateIndexCommand,
} = createSecondBrainEnvironmentAtoms(connectionAtomRuntime);
