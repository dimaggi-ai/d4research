import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { ResearchDelegationBudget } from "./budget.ts";

export class ResearchDelegateError extends Schema.TaggedErrorClass<ResearchDelegateError>()(
  "ResearchDelegateError",
  {
    detail: Schema.String,
    /** True when the failure is a spent loop budget rather than a broken delegate. */
    budgetExhausted: Schema.optional(Schema.Boolean),
  },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService,
  ProviderAdapterRegistry,
  ServerConfig.ServerConfig,
  ResearchDelegationBudget,
  Path.Path,
  HttpClient.HttpClient,
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
        "Name of a prompt file attached in Settings → Research. Its content is inlined server-side ahead of the prompt.",
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
