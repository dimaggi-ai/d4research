import {
  McpUsageLimitsInput,
  McpUsageLimitsResult,
  McpUsageReadInput,
  OrchestratorMcpFailure,
  UsageSummary,
} from "@d4research/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UsageSnapshots from "../../../usage/UsageSnapshots.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Environment.ServerEnvironment,
    UsageSnapshots.UsageSnapshots,
  ],
};

export const UsageToolkit = Toolkit.make(
  Tool.make("t3_usage_limits_read", {
    ...shared,
    description:
      "Read Usage → Limits across this server AND connected environments by default, including Claude/Codex profiles and hubs. Each provider/source has environmentId and environmentLabel; instance IDs alone are not global. A token-only Claude instance can report unsupported while another machine's named Claude accounts have valid windows: inspect ALL providers before declaring Claude unsupported. Quotas can be duplicated across machines; do not sum a shared account's allowance. Returns usedPercent, resetsAt, checkedAt, unavailable states and the calling instance ID. Null means unknown, never zero or unlimited. Check coverageComplete, environments and notices: an unreachable environment's quota is unknown, never safe. Keep an updated app connected to both machines. refresh:true uses existing page probes. includeConnected:false explicitly limits the read to this server. Does not redeem credits or change accounts.",
    parameters: McpUsageLimitsInput,
    success: Schema.toCodecJson(McpUsageLimitsResult),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_usage_read", {
    ...shared,
    description:
      "Read token/cost history from the same sources and scanner as this environment's Usage page, for every supported provider/account and model. Defaults to today in UTC; pass sinceDay/untilDay (YYYY-MM-DD) and an IANA timeZone for another window. Costs may be estimates or unpriced: inspect costSource, pricing, source status and refreshing. awaitRefresh:true waits for slow sources instead of returning cached data. Session totals do not equal subscription quota; use t3_usage_limits_read for quota. Input token categories are disjoint; reasoningTokens is already included in outputTokens. Hourly resolution also requires sinceTime/untilTime ISO instants. Other environments are not included.",
    parameters: McpUsageReadInput,
    success: Schema.toCodecJson(UsageSummary),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
