import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { ResearchDelegationBudget } from "./budget.ts";

/**
 * Machine-readable failure category. The orchestrator's RUN STATE report and
 * the UI both need to say *how* a delegation failed (refusal vs timeout vs
 * crash), and a prose-only detail string cannot be classified reliably.
 */
export const ResearchDelegateFailureKind = Schema.Literals([
  "authorization",
  "budget",
  "start",
  "timeout",
  "empty",
  "error",
]);
export type ResearchDelegateFailureKind = typeof ResearchDelegateFailureKind.Type;

export class ResearchDelegateError extends Schema.TaggedErrorClass<ResearchDelegateError>()(
  "ResearchDelegateError",
  {
    detail: Schema.String,
    /** True when the failure is a spent loop budget rather than a broken delegate. */
    budgetExhausted: Schema.optional(Schema.Boolean),
    failureKind: Schema.optional(ResearchDelegateFailureKind),
  },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService,
  ProviderAdapterRegistry,
  ProviderService,
  ProjectionSnapshotQuery,
  ServerConfig.ServerConfig,
  ResearchDelegationBudget,
  Path.Path,
  HttpClient.HttpClient,
  Crypto.Crypto,
];

export const ResearchDelegateInput = Schema.Struct({
  target: Schema.String.pipe(
    Schema.annotate({
      description:
        'Delegation target as "instanceId:model", exactly as listed in the research briefing (e.g. "claudeAgent:claude-fable-5").',
    }),
  ),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)).pipe(
    Schema.annotate({ description: "The request to send to the delegate model." }),
  ),
  promptFileName: Schema.optional(Schema.String).pipe(
    Schema.annotate({
      description:
        "Name of a prompt file attached to this run's scenario. Its content is inlined server-side ahead of the prompt. Requires scenario; only files attached to that scenario can be named.",
    }),
  ),
  pipelineKind: Schema.optional(Schema.Literals(["research", "dev"])).pipe(
    Schema.withDecodingDefault(Effect.succeed("research")),
    Schema.annotate({
      description:
        "Pipeline settings namespace used for prompt-file lookup. Pass dev for a !dev run; defaults to research for compatibility.",
    }),
  ),
  scenario: Schema.optional(Schema.String).pipe(
    Schema.annotate({
      description:
        "Scenario this pipeline run belongs to, copied exactly from the briefing. Scopes prompt-file lookup to that scenario's attachments; required whenever promptFileName is set.",
    }),
  ),
  step: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).pipe(
    Schema.annotate({
      description:
        'Pipeline step this call belongs to (e.g. "2" or "2: fan out"). Used for tracing and loop accounting.',
    }),
  ),
  visit: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(1)),
    Schema.annotate({ description: "1-based visit number for this step, incremented on loops." }),
  ),
});
export type ResearchDelegateInput = typeof ResearchDelegateInput.Type;

export const ResearchDelegateOutput = Schema.Struct({
  target: Schema.String,
  step: Schema.String,
  visit: Schema.Int,
  /** Delegations left in this research run's budget after this call. */
  remainingBudget: Schema.Int,
  /** Wall-clock cost of the delegation, for the run's resource ledger. */
  durationMs: Schema.Int,
  /** True when the delegate's answer was cut at the output cap. */
  truncated: Schema.Boolean,
  text: Schema.String,
});
export type ResearchDelegateOutput = typeof ResearchDelegateOutput.Type;

export const ResearchDelegateTool = Tool.make("research_delegate", {
  description:
    "Send one bounded request to another provider/model named by the research pipeline and return its answer. Every call is budgeted and traced by step; use the exact targets from the research briefing.",
  parameters: ResearchDelegateInput,
  success: ResearchDelegateOutput,
  failure: ResearchDelegateError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate research step")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ResearchToolkit = Toolkit.make(ResearchDelegateTool);
