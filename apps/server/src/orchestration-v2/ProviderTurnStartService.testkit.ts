import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { ResearchDelegationBudgetLive } from "../mcp/toolkits/research/budget.ts";
import { InlineDelegationRunner } from "../mcp/toolkits/research/inlineDelegation.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";

// Native-provider replay tests never invoke d4's inline delegate. Fail loudly
// if a fixture accidentally enters that separate workflow.
export const researchTurnDependenciesTestLayer = Layer.mergeAll(
  NodePath.layer,
  makeProviderRegistryLayer(),
  ServerSettings.layerTest().pipe(Layer.orDie),
  ResearchDelegationBudgetLive,
  NodeHttpClient.layerUndici,
  Layer.mock(InlineDelegationRunner)({
    run: () => Effect.die("Unexpected inline research delegation in provider fixture"),
  }),
  Layer.mock(OrchestrationEventStore)({}),
);

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export const worktreeRepairDependenciesTestLayer = Layer.mergeAll(
  researchTurnDependenciesTestLayer,
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
  }),
);
