import { type BrainProposalQuery, type EnvironmentId, WS_METHODS } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createSecondBrainEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const revision = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const refresh = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) => {
    registry.update(revision(environmentId), (value) => value + 1);
  };
  const refreshTrigger = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    revision(environmentId);
  const onSettled = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => refresh(environmentId, registry));
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "second-brain:status",
    tag: WS_METHODS.secondBrainStatus,
    staleTimeMs: 5_000,
    refreshTrigger,
  });
  const proposals = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "second-brain:proposals",
    tag: WS_METHODS.secondBrainListProposals,
    staleTimeMs: 5_000,
    refreshTrigger,
  });
  const proposal = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "second-brain:proposal",
    tag: WS_METHODS.secondBrainGetProposal,
    staleTimeMs: 5_000,
    refreshTrigger,
  });
  return {
    refresh,
    secondBrainStatusQuery: (environmentId: EnvironmentId) => status({ environmentId, input: {} }),
    secondBrainProposalsQuery: ({
      environmentId,
      ...input
    }: { readonly environmentId: EnvironmentId } & Pick<
      BrainProposalQuery,
      "state" | "offset" | "limit"
    >) => proposals({ environmentId, input: { limit: 25, ...input } }),
    secondBrainProposalQuery: ({
      environmentId,
      id,
    }: {
      readonly environmentId: EnvironmentId;
      readonly id: string;
    }) => proposal({ environmentId, input: { id } }),
    secondBrainAcceptCommand: createEnvironmentRpcCommand(runtime, {
      label: "second-brain:accept",
      tag: WS_METHODS.secondBrainAcceptProposal,
      onSettled,
    }),
    secondBrainRejectCommand: createEnvironmentRpcCommand(runtime, {
      label: "second-brain:reject",
      tag: WS_METHODS.secondBrainRejectProposal,
      onSettled,
    }),
    secondBrainReindexCommand: createEnvironmentRpcCommand(runtime, {
      label: "second-brain:reindex",
      tag: WS_METHODS.secondBrainReindex,
      onSettled,
    }),
    secondBrainLintCommand: createEnvironmentRpcCommand(runtime, {
      label: "second-brain:lint",
      tag: WS_METHODS.secondBrainLint,
    }),
    secondBrainRegenerateIndexCommand: createEnvironmentRpcCommand(runtime, {
      label: "second-brain:regenerate-index",
      tag: WS_METHODS.secondBrainRegenerateIndex,
      onSettled,
    }),
  };
}
