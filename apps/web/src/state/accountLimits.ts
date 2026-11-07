import { isHostPrimaryConnectionTarget } from "@d4research/client-runtime/connection";
/**
 * Keep readings per environment to avoid clock-skew replacement; collapse
 * only byte-identical rows for the same instance. Legacy unkeyed snapshots
 * belong to the default driver instance, freshest first within each environment.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  ACCOUNT_LIMITS_ACCEPTED_VERSIONS,
  type AccountLimitsSnapshot,
  type EnvironmentId,
  type ServerProvider,
  type UsageProviderKind,
} from "@d4research/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentLimitsStatus {
  readonly environmentId: EnvironmentId;
  /** The environment's display label, for when several report. */
  readonly environmentLabel: string | null;
  /** Whether this is the primary (local) environment - captions resolve
   * environment names through the shared option-label contract, which
   * needs it. */
  readonly environmentIsPrimary: boolean;
  readonly isPending: boolean;
  readonly snapshots: readonly AccountLimitsSnapshot[] | null;
  /** Streamed provider config; the source of instance display names. */
  readonly providers: readonly ServerProvider[] | null;
}

const accountLimitsAtom = Atom.make((get): readonly EnvironmentLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const statuses: EnvironmentLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.accountLimits({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    statuses.push({
      environmentId,
      environmentLabel: presentation.entry.target.label ?? null,
      environmentIsPrimary: isHostPrimaryConnectionTarget(presentation.entry.target),
      providers: providersByEnvironment.get(environmentId) ?? null,
      isPending: result.waiting,
      snapshots:
        summary === null || !ACCOUNT_LIMITS_ACCEPTED_VERSIONS.includes(summary.contractVersion)
          ? null
          : summary.snapshots,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-account-limits"));

/** One rendered limits row: a provider instance seen from one environment. */
export interface AccountLimitsRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly environmentIsPrimary: boolean;
  /**
   * Use the configured name or instance ID, never an account email: captions
   * must preserve the provider UI's email redaction.
   */
  readonly instanceLabel: string;
  /** The accent this account is marked with in provider settings, when it carries one. */
  readonly instanceColor: string | null;
  readonly snapshot: AccountLimitsSnapshot;
}

/** What an unkeyed (pre-instance-attribution) snapshot always meant. */
export const legacyInstanceIdFor = (provider: UsageProviderKind): string =>
  provider === "claude" ? "claudeAgent" : "codex";

/**
 * Pure merge, exported for tests: dedupe freshest-wins per instance WITHIN
 * an environment, never across environments (see module doc), grouped per
 * provider for rendering.
 */
export function mergeEnvironmentLimits(
  statuses: readonly EnvironmentLimitsStatus[],
): ReadonlyMap<UsageProviderKind, readonly AccountLimitsRow[]> {
  const byProvider = new Map<UsageProviderKind, AccountLimitsRow[]>();
  // Two environments on one machine (worktree servers) can hold identical
  // snapshots. Byte-identical rows carry no extra information, so exact
  // duplicates collapse; rows that differ at all - clocks included - stay,
  // because cross-environment freshness cannot be arbitrated (see module doc).
  const seen = new Set<string>();
  for (const status of statuses) {
    const byInstance = new Map<string, AccountLimitsSnapshot>();
    for (const snapshot of status.snapshots ?? []) {
      const key = JSON.stringify([
        snapshot.provider,
        snapshot.instanceId ?? legacyInstanceIdFor(snapshot.provider),
      ]);
      const current = byInstance.get(key);
      // ISO-8601 strings order lexicographically.
      if (current === undefined || snapshot.asOf > current.asOf) {
        byInstance.set(key, snapshot);
      }
    }
    for (const snapshot of byInstance.values()) {
      const instanceId = snapshot.instanceId ?? legacyInstanceIdFor(snapshot.provider);
      // "Byte-identical" must mean the whole row: keying on the stamp alone
      // would let two environments' same-instant-but-different readings
      // collapse into one, silently deleting a real account's numbers.
      const duplicateKey = JSON.stringify([
        snapshot.provider,
        instanceId,
        snapshot.asOf,
        snapshot.source,
        snapshot.plan,
        snapshot.windows,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      // Resolve the caption through the app-wide instance display-name
      // contract (explicit name wins, non-default ids humanize, defaults
      // keep the brand label), so Limits names accounts the same way the
      // picker and provider settings do.
      const entry = deriveProviderInstanceEntries(status.providers ?? []).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      const rows = byProvider.get(snapshot.provider) ?? [];
      rows.push({
        environmentId: status.environmentId,
        environmentLabel: status.environmentLabel,
        environmentIsPrimary: status.environmentIsPrimary,
        instanceLabel: entry?.displayName ?? instanceId,
        instanceColor: entry?.accentColor ?? null,
        snapshot,
      });
      byProvider.set(snapshot.provider, rows);
    }
  }
  for (const rows of byProvider.values()) {
    // Different instances sharing a name need their IDs to distinguish them.
    // The same instance across environments keeps its name; the environment
    // label disambiguates those rows.
    const instancesPerLabel = new Map<string, Set<string>>();
    for (const row of rows) {
      const instanceId = row.snapshot.instanceId ?? legacyInstanceIdFor(row.snapshot.provider);
      const ids = instancesPerLabel.get(row.instanceLabel) ?? new Set<string>();
      ids.add(instanceId);
      instancesPerLabel.set(row.instanceLabel, ids);
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row === undefined) continue;
      if ((instancesPerLabel.get(row.instanceLabel)?.size ?? 0) > 1) {
        rows[index] = {
          ...row,
          instanceLabel: row.snapshot.instanceId ?? legacyInstanceIdFor(row.snapshot.provider),
        };
      }
    }
    rows.sort(
      (a, b) =>
        a.instanceLabel.localeCompare(b.instanceLabel) ||
        a.environmentId.localeCompare(b.environmentId),
    );
  }
  return byProvider;
}

export interface AccountLimitsView {
  /**
   * Rows grouped per provider. Several rows under one provider mean several
   * instances (or several environments), each labeled; most setups have
   * exactly one.
   */
  readonly byProvider: ReadonlyMap<UsageProviderKind, readonly AccountLimitsRow[]>;
  /** Environments that have answered - >1 means rows need their environment named. */
  readonly reportingEnvironments: number;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while any environment is still answering. A provider with no
   * snapshot is "loading" while this holds and "no data" once it clears -
   * the first environment to answer must not decide that for the rest.
   */
  readonly isSettling: boolean;
  readonly refresh: () => void;
}

export function useAccountLimits(): AccountLimitsView {
  const environments = useAtomValue(accountLimitsAtom);

  const byProvider = useMemo(() => mergeEnvironmentLimits(environments), [environments]);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.accountLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const answered = environments.filter((environment) => environment.snapshots !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshots === null && environment.isPending,
  ).length;

  return {
    byProvider,
    reportingEnvironments: answered,
    isPending: answered === 0 && stillReporting > 0,
    isSettling: stillReporting > 0,
    refresh,
  };
}
