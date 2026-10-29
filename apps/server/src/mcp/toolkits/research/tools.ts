import * as SecondBrainService from "../../../second-brain/SecondBrainService.ts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpClient } from "effect/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import { ProviderAdapterRegistryV2 } from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
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

export class ResearchDelegateError extends Schema.TaggedError<ResearchDelegateError>()(
  "ResearchDelegateError",
  {
    detail: Schema.String,
    /** True when the failure is a spent loop budget rather than a broken delegate. */
    budgetExhausted: Schema.optional(Schema.Boolean),
    failureKind: Schema.optional(ResearchDelegateFailureKind),
  },
) {
  // The MCP layer renders a declared tool failure through error.message. Without
  // this, every refusal (unauthorized fallback, budget, timeout) reaches the
  // orchestrator as an empty error and is reported as an opaque failure.
  override get message(): string {
    return this.detail;
  }
}

const dependencies = [
  SecondBrainService.SecondBrainService,
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService,
  ProviderAdapterRegistryV2,
  ProviderRegistry,

  ProjectionStoreV2,
  ProjectStoreV2,
  ServerConfig.ServerConfig,
  ResearchDelegationBudget,
  Path.Path,
  FileSystem.FileSystem,
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
  fallbackTargets: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(4))).pipe(
    Schema.annotate({
      description:
        'Ordered, explicitly authored fallback targets as "instanceId:model". The server may use one only when pipeline target policy allows labeled fallback, and reports the actual target.',
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
  requestedTarget: Schema.String,
  resolvedTarget: Schema.String,
  substituted: Schema.Boolean,
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

const ResearchDelegateTool = Tool.make("research_delegate", {
  description:
    "Send one bounded request to another provider/model named by the research or development pipeline and return its answer. Explicit fallbacks may be used only under the shared labeled-fallback policy. The result always identifies the requested and actual model.",
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

export class ResearchArtifactReadError extends Schema.TaggedError<ResearchArtifactReadError>()(
  "ResearchArtifactReadError",
  { detail: Schema.String },
) {}

export const ResearchArtifactReadInput = Schema.Struct({
  artifact: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
    Schema.annotate({
      description:
        'Artifact path exactly as the RESUME block or ledger lists it, e.g. "steps/003-step2-v1-claudeagent-claude-fable-5.md", or "ledger.jsonl".',
    }),
  ),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
    Schema.annotate({ description: "Character offset to start reading from." }),
  ),
});
export type ResearchArtifactReadInput = typeof ResearchArtifactReadInput.Type;

export const ResearchArtifactReadOutput = Schema.Struct({
  artifact: Schema.String,
  path: Schema.String,
  offset: Schema.Int,
  totalChars: Schema.Int,
  /** Offset of the next unread chunk, or null when this chunk ends the file. */
  nextOffset: Schema.NullOr(Schema.Int),
  text: Schema.String,
});
export type ResearchArtifactReadOutput = typeof ResearchArtifactReadOutput.Type;

const ResearchArtifactReadTool = Tool.make("research_artifact_read", {
  description:
    "Read a step artifact the server saved for this thread's pipeline run, such as a completed delegation's full answer. Read-only and limited to this thread's own run directory. Use it to resume a run without repeating completed delegations.",
  parameters: ResearchArtifactReadInput,
  success: ResearchArtifactReadOutput,
  failure: ResearchArtifactReadError,
  dependencies,
})
  .annotate(Tool.Title, "Read research step artifact")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ResearchToolkit = Toolkit.make(ResearchDelegateTool, ResearchArtifactReadTool);
