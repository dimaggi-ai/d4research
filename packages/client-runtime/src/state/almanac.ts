import {
  type AlmanacBrowseInput,
  type AlmanacReadInput,
  type AlmanacSearchInput,
  type EnvironmentId,
  WS_METHODS,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

type Scoped<T> = { readonly environmentId: EnvironmentId } & T;

export function createAlmanacEnvironmentAtoms<R, E>(
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
  const query = {
    staleTimeMs: 30_000,
    refreshTrigger,
  };
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "almanac:status",
    tag: WS_METHODS.almanacStatus,
  });
  const browse = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "almanac:browse",
    tag: WS_METHODS.almanacBrowse,
  });
  const search = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "almanac:search",
    tag: WS_METHODS.almanacSearch,
  });
  const recall = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "almanac:recall",
    tag: WS_METHODS.almanacRecall,
  });
  const read = createEnvironmentRpcQueryAtomFamily(runtime, {
    ...query,
    label: "almanac:read",
    tag: WS_METHODS.almanacRead,
  });
  return {
    refresh,
    almanacStatusQuery: (environmentId: EnvironmentId) => status({ environmentId, input: {} }),
    almanacBrowseQuery: ({ environmentId, ...input }: Scoped<AlmanacBrowseInput>) =>
      browse({ environmentId, input }),
    almanacSearchQuery: ({ environmentId, ...input }: Scoped<AlmanacSearchInput>) =>
      search({ environmentId, input }),
    almanacRecallQuery: ({ environmentId, ...input }: Scoped<AlmanacSearchInput>) =>
      recall({ environmentId, input }),
    almanacReadQuery: ({ environmentId, ...input }: Scoped<AlmanacReadInput>) =>
      read({ environmentId, input }),
    almanacRememberCommand: createEnvironmentRpcCommand(runtime, {
      label: "almanac:remember",
      tag: WS_METHODS.almanacRemember,
      onSettled,
    }),
    almanacUpdateCommand: createEnvironmentRpcCommand(runtime, {
      label: "almanac:update",
      tag: WS_METHODS.almanacUpdate,
      onSettled,
    }),
    almanacForgetCommand: createEnvironmentRpcCommand(runtime, {
      label: "almanac:forget",
      tag: WS_METHODS.almanacForget,
      onSettled,
    }),
  };
}
