import * as SecondBrainService from "../second-brain/SecondBrainService.ts";
import { SourceControlProviderError, SourceControlProviderKind } from "@d4research/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { ResearchDelegationBudgetLive } from "../mcp/toolkits/research/budget.ts";
import { InlineDelegationRunner } from "../mcp/toolkits/research/inlineDelegation.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";

// Native-provider replay tests never invoke d4's inline delegate. Fail loudly
// if a fixture accidentally enters that separate workflow.
export const researchTurnDependenciesTestLayer = Layer.mergeAll(
  Layer.mock(SecondBrainService.SecondBrainService)({
    buildTurnContext: () => Effect.succeed({ policy: "", core: "", retrieved: "", citations: [] }),
    markContextDelivered: () => Effect.void,
  }),
  NodePath.layer,
  ProviderRegistryMock.layer(),
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

export const layer = Layer.merge(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
);

// Keep repository detection, branch selection and worktree creation on the real Git path.
export const layerRealGit = GitWorkflow.layer.pipe(
  Layer.provide(GitManager.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolve: ({ cwd }) =>
          Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("unknown"),
              operation: "resolve",
              cwd,
              detail: "No source control provider in tests",
            }),
          ),
      }),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-recreate-" })),
  Layer.provideMerge(NodeServices.layer),
);
