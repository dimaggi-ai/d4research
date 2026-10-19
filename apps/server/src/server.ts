import * as SecondBrainCapture from "./second-brain/SecondBrainCapture.ts";
import * as SecondBrainCaptureReactor from "./second-brain/SecondBrainCaptureReactor.ts";
import * as Scheduler from "./scheduling/Scheduler.ts";
import * as SecondBrainService from "./second-brain/SecondBrainService.ts";
import * as SecondBrainFiles from "./second-brain/SecondBrainFiles.ts";
import * as SecondBrainIndex from "./second-brain/SecondBrainIndex.ts";
import * as SecondBrainEmbeddings from "./second-brain/SecondBrainEmbeddings.ts";
import * as SecondBrainMaintenance from "./second-brain/SecondBrainMaintenance.ts";
import * as ProviderEventLoggers from "@d4research/provider-core/server/ProviderEventLoggers";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, type RepositoryIdentity } from "@d4research/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { initializeToolGuardRuntime } from "./toolGuardLifecycle.ts";
import {
  layerOtlpTracesProxyRoute as otlpTracesProxyRouteLayer,
  missionControlSystemRouteLayer,
  toolGuardLifecycleRouteLayer,
  toolGuardStatusRouteLayer,
  toolGuardPolicyReadRouteLayer,
  toolGuardPolicyWriteRouteLayer,
  skillsHttpApiLayer,
  skillsShareRouteLayer,
  skillsInstallRouteLayer,
  handoffMemoryRouteLayer,
  handoffCompressRouteLayer,
  handoffPrepareRouteLayer,
  memoAttachmentRouteLayer,
  layerAssetRoute as assetRouteLayer,
  layerAttachmentUploadRoute as attachmentUploadRouteLayer,
  layerServerEnvironmentHttpApi as serverEnvironmentHttpApiLayer,
  layerStaticAndDevRoute as staticAndDevRouteLayer,
  layerBrowserApiCors as browserApiCorsLayer,
  layerHttpCompression as httpCompressionLayer,
} from "./http.ts";
import { fixPath } from "./os-jank.ts";
import { PortableSkillsInventoryLive, reconcileUserSkills } from "./skillsInventory.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { layer as pullRequestHttpApiLayer } from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@d4research/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@d4research/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@d4research/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as AcpRegistrySupport from "@d4research/provider-acp-registry/server/AcpRegistrySupport";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as DesktopBrowserChannel from "./preview/DesktopBrowserChannel.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Keybindings from "./keybindings.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { ResearchDelegationBudgetLive } from "./mcp/toolkits/research/budget.ts";
import { ResearchIntegrityReactorLive } from "./orchestration-v2/Layers/ResearchIntegrityReactor.ts";
import { ResearchIntegrityReactor } from "./orchestration-v2/Services/ResearchIntegrityReactor.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@d4research/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as Observability from "./observability/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as RelayDeliveryProof from "./scheduledTasks/RelayDeliveryProof.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import * as CursorAccountReader from "@d4research/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@d4research/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@d4research/provider-cursor/server/CursorUsageAccounts";
import * as UsageService from "./usage/UsageService.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ResourceCleanupService from "./orchestration-v2/ResourceCleanupService.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as EventStoreV2 from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as IdAllocatorV2 from "@d4research/provider-core/server/IdAllocator";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as ProjectHttp from "./project/http.ts";
import * as NetService from "@d4research/shared/Net";
import { disableTailscaleServe, ensureTailscaleServe } from "@d4research/tailscale";
import * as ServerActivation from "./serverActivation.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerResourceAttribution = ResourceAttribution.layer;
const layerApplicationObservability = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(layerResourceAttribution),
);

// One rotating store behind both logger views, so driver instances never race
// its rotation.
const layerProviderEventLoggers = Layer.effect(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

const layerPtyAdapter = NodePtyAdapter.layer;

const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

const layerSecondBrain = SecondBrainService.layer.pipe(
  Layer.provide(SecondBrainFiles.layer),
  Layer.provideMerge(SecondBrainIndex.layer),
  Layer.provide(SecondBrainEmbeddings.layer),
  Layer.provide(layerServerSettings),
);

const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const layerDesktopTelemetryReceiver = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(layerServerSettings),
);

const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(layerNativeTelemetry),
  Layer.provideMerge(layerDesktopTelemetryReceiver),
);

const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

// Reuses layerDesktopTelemetryReceiver: a fresh receiver layer here
// would open a second reader on the desktop telemetry fd.
const layerDesktopAppUpdate = DesktopAppUpdate.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

const layerBackground = BackgroundPolicy.layer.pipe(
  Layer.provide(layerHostPowerMonitor),
  Layer.provideMerge(layerServerSettings),
);

const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AntigravityUsage.layer,
      CursorUsageAccounts.layer.pipe(
        Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
      ),
    ).pipe(Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer)))),
  ),
  Layer.provide(layerServerSettings),
);

const layerResourceDiagnostics = Layer.mergeAll(
  HostResources.layer,
  layerResourceTelemetry,
  ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Bound only the time a peer may spend sending request headers/body.
    // Long research handler execution happens after ingress completes and
    // remains governed by the delegate Effect timeout; disabling this server
    // guard globally allowed slow request bodies to occupy sockets forever.
    return NodeHttpServer.layer(
      () => guardHttpResponseWriteErrors(NodeHttp.createServer({ requestTimeout: 120_000 })),
      {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Negotiate permessage-deflate with clients that offer it; clients
        // that don't still get uncompressed frames on their connection.
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      },
    );
  }),
);

const layerPlatformServices = NodeServices.layer;

const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerRepositoryIdentityResolver = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const kind of SourceControlBuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS.map(
          (driver) => driver.kind,
        )) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(RuntimeLayer.layerProjectService),
  Layer.provide(PullRequestProviderRegistry.layer),
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
  Layer.provide(VcsProcess.layer),
);

const layerGitManager = GitManager.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  // `GitHubCli` is the registry's own instance, exposed because the asset route fetches
  // GitHub-hosted pull request media with the repository's credential.
  Layer.provideMerge(Layer.mergeAll(layerSourceControlProviderRegistry, layerPullRequestService)),
  Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
);

const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(GitVcsDriver.layer),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(GitVcsDriver.layer),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provideMerge(layerKnownWorkspaces),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(layerGitWorkflow),
      // The orchestration runtime also consumes the broadcaster (run
      // finalization), so the policy cannot read the store from the runtime's
      // output.
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerPortScanner = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const layerTerminal = TerminalManager.layer.pipe(
  Layer.provide(layerPtyAdapter),
  Layer.provide(layerPortScanner),
  Layer.provide(layerNativeTelemetry),
);

const layerPreview = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerPortScanner),
);

const layerDevice = DeviceService.layer.pipe(
  Layer.provide(layerServerSettings),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

const layerWorkspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(layerWorkspaceEntries),
  Layer.provide(layerKnownWorkspaces),
);

const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
);

const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const layerServerEnvironment = ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerSecondBrain),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(ResourceCleanupService.layer),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const layerOrchestrationApplication = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerOrchestrationV2Runtime),
);

const layerThreadSettlementWorker = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService), Layer.provide(ProjectionStoreV2.layer));

const layerThreadPullRequestWorker = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService));

const layerProviderInstallationRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
    const codex = yield* CodexInstallation.CodexInstallation;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* Stream.merge(
      antigravity.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
      codex.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
    ).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
  Layer.effectDiscard(
    SecondBrainCaptureReactor.SecondBrainCaptureReactor.use((reactor) => reactor.start()),
  ).pipe(
    Layer.provide(SecondBrainCaptureReactor.layer),
    Layer.provide(EventStoreV2.layerFromOrchestrationEventStore),
  ),
  SecondBrainMaintenance.layer.pipe(Layer.provide(Scheduler.layer)),
  Layer.effectDiscard(ResearchIntegrityReactor.use((reactor) => reactor.start())).pipe(
    Layer.provide(ResearchIntegrityReactorLive),
    Layer.provide(
      Layer.mergeAll(ProjectionStoreV2.layer, IdAllocatorV2.layer, RuntimeLayer.layerEventSink),
    ),
  ),
  layerThreadSettlementWorker,
  StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(
      Layer.merge(EventStoreV2.layerFromOrchestrationEventStore, ProjectionStoreV2.layer),
    ),
  ),
  layerThreadPullRequestWorker,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provideMerge(PullRequestSyncReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provide(PullRequestWatchReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
  ProviderUsageLimitsIngestion.layer,
  layerProviderInstallationRefresh,
  ReplayMarkers.layer,
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
).pipe(
  Layer.provideMerge(SecondBrainCapture.layer.pipe(Layer.provide(ProjectionStoreV2.layer))),
  Layer.provideMerge(layerSecondBrain),
  Layer.provideMerge(layerOrchestrationApplication),
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  // HTTP/MCP handlers resolve adapters when a request arrives, not only while
  // their route layers are built. Keep the shared facade in the server context.
  Layer.provideMerge(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
  Layer.provideMerge(ResearchDelegationBudgetLive),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(
    Layer.mergeAll(ProjectStore.layer, ProjectionStoreV2.layer, ThreadSearch.layer),
  ),
  Layer.provideMerge(layerServerSettings),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview, layerDevice)),
  Layer.provideMerge(layerPersistence),
  Layer.provideMerge(
    Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer, UsageLimitSources.layer),
  ),
  Layer.provideMerge(Layer.mergeAll(PortableSkillsInventoryLive, ProviderRegistry.layer)),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // hydration adds their default instances to `providerInstances` on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      AntigravityInstallation.AntigravityInstallation.layer,
      CodexInstallation.CodexInstallation.layer,
    ),
  ),
);

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
  Layer.provideMerge(
    Layer.mergeAll(
      layerProviderEventLoggers,
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
      ResetCreditCoordinator.layer,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
    ),
  ),
  Layer.provideMerge(
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  Layer.provideMerge(ServerSecretStore.layer),
);

const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerBackground),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
  Layer.provideMerge(DirectEndpoints.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

const layerMakeRoutes = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(WebhookRoute.layer.pipe(Layer.provide(RelayDeliveryProof.layer))),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(skillsHttpApiLayer),
      Layer.provide(pullRequestHttpApiLayer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    otlpTracesProxyRouteLayer,
    missionControlSystemRouteLayer,
    toolGuardStatusRouteLayer,
    toolGuardLifecycleRouteLayer,
    toolGuardPolicyReadRouteLayer,
    toolGuardPolicyWriteRouteLayer,
    skillsShareRouteLayer,
    skillsInstallRouteLayer,
    handoffMemoryRouteLayer,
    handoffCompressRouteLayer,
    handoffPrepareRouteLayer,
    memoAttachmentRouteLayer,
    assetRouteLayer,
    attachmentUploadRouteLayer,
    DeviceHubProxy.layer,
    staticAndDevRouteLayer,
    Ws.layer,
  ),
  McpHttpServer.layer.pipe(
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
  ),
).pipe(
  Layer.provide(RuntimeLayer.layerProjectService),
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
  // Guides read through the same pull request service as every other surface.
  Layer.provide(
    PullRequestReviewGuideService.layer.pipe(Layer.provide(PullRequestReviewGuides.layer)),
  ),
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP.
  Layer.provide(layerPullRequestService),
  Layer.provide(ServerBrowser.layer.pipe(Layer.provide(DesktopBrowserChannel.layer))),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ServerSelfUpdate.layer.pipe(Layer.provide(layerDesktopAppUpdate))),
  Layer.provide(layerCommandReadiness),
  Layer.provide(browserApiCorsLayer),
  Layer.provide(httpCompressionLayer),
);

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per T3 home.
    const ownership = yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath);
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const layerLauncher = ServiceLauncherClient.layer;

    yield* initializeToolGuardRuntime();
    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });

    // Reconcile before any provider runtime or route can start. Running this
    // as a sibling Layer races provider session creation: a CLI can snapshot
    // its skills milliseconds before the links appear and remain stale for
    // the whole session.
    yield* reconcileUserSkills().pipe(
      Effect.tap(({ shared, conflicts, failures }) => {
        if (shared.length === 0 && conflicts.length === 0 && failures.length === 0) {
          return Effect.void;
        }
        const details = {
          shared: shared.map(({ name, targetRoot }) => `${name}:${targetRoot}`),
          conflicts: conflicts.map(({ name, targetRoot }) => `${name}:${targetRoot}`),
          failures: failures.map(({ name, targetRoot }) => `${name}:${targetRoot}`),
        };
        return failures.length > 0 || conflicts.length > 0
          ? Effect.logWarning("User skill reconciliation completed with conflicts", details)
          : Effect.logInfo("User skills shared across coding CLIs", details);
      }),
      Effect.provide(layerPlatformServices),
    );

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
        yield* awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return;
        }

        const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
        const state = yield* makePersistedServerRuntimeState({
          config,
          port: address.port,
          serviceManaged: launcher.managed,
        });
        yield* ownership
          .publish(state)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
      }),
    );
    const layerTailscaleServe = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(
      Layer.provideMerge(layerRuntimeDependencies),
      Layer.provide(layerLauncher),
      Layer.provide(layerPersistence),
    );

    const layerRoutes = HttpRouter.serve(layerMakeRoutes.pipe(Layer.provide(layerLauncher)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerRuntimeState.pipe(Layer.provide(layerLauncher)),
      layerTailscaleServe,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      // The connect routes and the startup/shutdown link work share one instance.
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(McpProviderSessions.layer),
      Layer.provide(layerActivation),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(layerApplicationObservability),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));

export const runServer = Layer.launch(layerMakeServer);
