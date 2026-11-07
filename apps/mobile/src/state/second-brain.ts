import { createSecondBrainEnvironmentAtoms } from "@d4research/client-runtime/state/second-brain";
import { connectionAtomRuntime } from "../connection/runtime";

export const {
  refresh: refreshSecondBrain,
  secondBrainStatusQuery,
  secondBrainCatalogQuery,
  secondBrainNoteQuery,
  secondBrainSearchQuery,
  secondBrainProposalsQuery,
  secondBrainProposalQuery,
  secondBrainAcceptCommand,
  secondBrainRejectCommand,
  secondBrainReindexCommand,
  secondBrainLintCommand,
  secondBrainRegenerateIndexCommand,
} = createSecondBrainEnvironmentAtoms(connectionAtomRuntime);
