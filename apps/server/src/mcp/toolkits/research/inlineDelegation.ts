import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import type { ServerProvider } from "@t3tools/contracts";
import {
  deriveResearchProviderCandidatesFromProviders,
  resolveResearchDirective,
  type ResearchModelDirective,
} from "@t3tools/shared/researchPipeline";

import * as ServerConfig from "../../../config.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ResearchDelegationBudget } from "./budget.ts";
import {
  runBoundedDelegation,
  resolveDelegateTarget,
  type BoundedDelegationRequest,
} from "./handlers.ts";
import type { ResearchDelegateError } from "./tools.ts";

/**
 * Step name every inline delegation is charged under. Pipeline steps are named
 * by their pipeline, so this one cannot collide with them in the budget's
 * `${step}→${target}` visit key.
 */
export const INLINE_DELEGATION_STEP = "inline";

/**
 * Turn ids an inline delegation runs under. The prefix is the only marker
 * distinguishing a delegate turn from a provider turn in projected state, and
 * restart reconciliation reads it to settle a delegation honestly instead of
 * reporting a provider session that never existed.
 */
export const INLINE_DELEGATE_TURN_PREFIX = "inline-delegate:";

export function isInlineDelegateTurnId(turnId: string | null | undefined): boolean {
  return typeof turnId === "string" && turnId.startsWith(INLINE_DELEGATE_TURN_PREFIX);
}

export type InlineDelegationResult = Effect.Success<ReturnType<typeof runBoundedDelegation>>;

export type InlineDelegationTarget = {
  readonly instanceId: string;
  readonly model: string;
  readonly resolvedTarget: string;
  readonly providerName: string;
};

/**
 * Resolves a user-typed `!provider:model` directive against the live provider
 * snapshots. Reuses the pipeline resolver so ambiguous providers and models
 * fail with the same prose a pipeline would print, then re-checks readiness
 * with `exact` policy: inline delegation authors no scenario, so it has no
 * labeled fallbacks and must never substitute a target.
 */
export function resolveInlineDelegateTarget(
  directive: ResearchModelDirective,
  providers: ReadonlyArray<ServerProvider>,
):
  | { readonly ok: true; readonly target: InlineDelegationTarget }
  | { readonly ok: false; readonly detail: string } {
  const resolution = resolveResearchDirective(
    directive,
    deriveResearchProviderCandidatesFromProviders(providers),
    [],
  );
  if (!resolution.ok) return { ok: false, detail: resolution.error };
  const readiness = resolveDelegateTarget({
    target: `${resolution.instanceId}:${resolution.model}`,
    policy: "exact",
    providers,
  });
  if (!readiness.ok) return { ok: false, detail: readiness.detail };
  return {
    ok: true,
    target: {
      instanceId: readiness.parsedTarget.instanceId,
      model: readiness.parsedTarget.model,
      resolvedTarget: readiness.resolvedTarget,
      providerName: resolution.providerName,
    },
  };
}

/**
 * Runs one bounded delegation for callers outside the MCP toolkit. The
 * orchestration reactor needs the delegation engine but must not inherit its
 * eight service dependencies, so they are captured here once and replayed for
 * every call.
 */
export class InlineDelegationRunner extends Context.Service<
  InlineDelegationRunner,
  {
    readonly run: (
      input: BoundedDelegationRequest,
    ) => Effect.Effect<InlineDelegationResult, ResearchDelegateError>;
  }
>()("t3/mcp/toolkits/research/inlineDelegation/InlineDelegationRunner") {
  static readonly layer = Layer.effect(
    InlineDelegationRunner,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        | Crypto.Crypto
        | HttpClient.HttpClient
        | Path.Path
        | ProjectionSnapshotQuery
        | ProviderAdapterRegistry
        | ProviderService
        | ResearchDelegationBudget
        | ServerConfig.ServerConfig
        | ServerSettingsService
      >();
      return InlineDelegationRunner.of({
        run: (input) => runBoundedDelegation(input).pipe(Effect.provideContext(context)),
      });
    }),
  );
}
