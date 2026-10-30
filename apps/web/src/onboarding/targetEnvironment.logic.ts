import type { EnvironmentId } from "@d4research/contracts";

interface OnboardingEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
}

/** Waits only for first connection attempts; offline, failing, or unsupported computers cannot block setup. */
export function resolveOnboardingSetup(
  environments: ReadonlyArray<Pick<OnboardingEnvironment, "environmentId" | "connection">>,
  selectedIds: ReadonlySet<EnvironmentId>,
): {
  readonly ready: boolean;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly skippedIds: ReadonlyArray<EnvironmentId>;
} {
  const selected = environments.filter((environment) => selectedIds.has(environment.environmentId));
  const idsInPhase = (keep: (phase: string) => boolean) =>
    selected
      .filter((environment) => keep(environment.connection.phase))
      .map((environment) => environment.environmentId);
  const environmentIds = idsInPhase((phase) => phase === "connected");
  const settling = selected.some((environment) => environment.connection.phase === "connecting");
  return {
    ready: environmentIds.length > 0 && !settling,
    environmentIds,
    skippedIds: idsInPhase((phase) => phase !== "connected" && phase !== "connecting"),
  };
}

export function resolveOnboardingTargetEnvironment<TEnvironment extends OnboardingEnvironment>({
  mode,
  environments,
  primaryEnvironment,
  pairedEnvironmentId,
}: {
  readonly mode: "local" | "connect" | "direct";
  readonly environments: ReadonlyArray<TEnvironment>;
  readonly primaryEnvironment: TEnvironment | null;
  readonly pairedEnvironmentId: EnvironmentId | null;
}): TEnvironment | null {
  if (mode === "direct" && pairedEnvironmentId !== null) {
    const pairedEnvironment = environments.find(
      (environment) => environment.environmentId === pairedEnvironmentId,
    );
    return pairedEnvironment?.connection.phase === "connected" ? pairedEnvironment : null;
  }

  if (primaryEnvironment?.connection.phase === "connected") {
    return primaryEnvironment;
  }

  return null;
}
