import type { EnvironmentId } from "@d4research/contracts";
import type { AtomCommandResult } from "@d4research/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@d4research/client-runtime/state/runtime";

type RefreshProvidersTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: Record<never, never>;
};

/** Deduplicates taps while the server refresh command is still running. */
export function createProviderCatalogRefreshRunner<Result>(
  refreshProviders: (target: RefreshProvidersTarget) => Promise<Result>,
) {
  let pending: Promise<Result> | null = null;

  return (environmentId: EnvironmentId): Promise<Result> => {
    if (pending) return pending;
    pending = refreshProviders({ environmentId, input: {} }).finally(() => {
      pending = null;
    });
    return pending;
  };
}

export function providerCatalogRefreshError(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Provider discovery failed.";
}
