// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CodexSettings,
  ProviderDriverKind,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";
import { TextGeneration, type TextGenerationShape } from "../src/textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import { defaultInstanceIdForDriver, type ServerProvider } from "@d4research/contracts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapter } from "../src/provider/Layers/CodexAdapter.ts";
import { makeClaudeAdapter } from "../src/provider/Layers/ClaudeAdapter.ts";
import { makeAgyAdapter } from "../src/provider/Layers/AgyAdapter.ts";
import { AgySettings, ClaudeSettings, GrokSettings, OpenCodeSettings } from "@d4research/contracts";
import { makeOpenCodeAdapter } from "../src/provider/Layers/OpenCodeAdapter.ts";
import { makeGrokAdapter } from "../src/provider/Layers/GrokAdapter.ts";
import { OpenCodeRuntimeLive } from "../src/provider/opencodeRuntime.ts";
import type { ProviderAdapterShape } from "../src/provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../src/provider/Errors.ts";

export type RealProviderName = "codex" | "claudeAgent" | "agy" | "opencode" | "grok";
/** Models advertised by the readiness fixture and requested by the real matrix. */
export const REAL_PROVIDER_TEST_MODELS: Readonly<Record<RealProviderName, string>> = {
  claudeAgent: "claude-haiku-4-5",
  codex: "gpt-5.4-mini",
  agy: "gemini-3.6-flash-low",
  opencode: "ollama/gemma4:e4b-it-qat",
  grok: "grok-4.6",
};
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { CheckpointReactor } from "../src/orchestration/Services/CheckpointReactor.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../src/orchestration/Services/ThreadDeletionReactor.ts";
import { RateLimitResumeReactor } from "../src/orchestration/Services/RateLimitResumeReactor.ts";
import { ScheduledQueueReactor } from "../src/orchestration/Services/ScheduledQueueReactor.ts";
import { ResearchIntegrityReactor } from "../src/orchestration/Services/ResearchIntegrityReactor.ts";
import { InlineDelegationRunner } from "../src/mcp/toolkits/research/inlineDelegation.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import * as WorkspaceEntries from "../src/workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../src/vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../src/git/GitWorkflowService.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as NodeHttp from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../src/mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../src/mcp/PreviewAutomationBroker.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeAgySettings = Schema.decodeUnknownEffect(AgySettings);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);
const decodeGrokSettings = Schema.decodeUnknownEffect(GrokSettings);
const MAX_TEST_EVENT_HISTORY = 4_096;

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const initializeGitWorkspace = Effect.fn(function* (cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fileSystem.writeFileString(join(cwd, "README.md"), "v1\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
});

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

class WaitForTimeoutError extends Schema.TaggedErrorClass<WaitForTimeoutError>()(
  "WaitForTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 40_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new WaitForTimeoutError({ description }) : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly drainProviderRuntime: Effect.Effect<void>;
  readonly drainCheckpointReactor: Effect.Effect<void>;
  /** Bound `http://127.0.0.1:<port>/mcp` endpoint when `mcp: true`, else null. */
  readonly mcpEndpoint: string | null;
  /** Number of requests the harness-served t3-code MCP endpoint received. */
  readonly mcpRequestCount: () => number;
  /** Number of decoded MCP `tools/call` requests received for one tool name. */
  readonly mcpToolCallCount: (toolName: string) => number;
  readonly dispose: Effect.Effect<void, never>;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly realCodex?: boolean;
  readonly realProviders?: ReadonlyArray<RealProviderName>;
  /**
   * Serve the real t3-code MCP stack (session registry + /mcp transport +
   * toolkits) on an ephemeral loopback port. Booting the registry is what
   * makes ProviderService mint MCP credentials into provider sessions — the
   * production link the 2026-08-15 codex outage broke, which the matrix
   * could not exercise while the harness ran MCP-less.
   */
  readonly mcp?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const realProviders: ReadonlyArray<RealProviderName> =
      options?.realProviders ?? (options?.realCodex === true ? ["codex"] : []);
    const useRealCodex = realProviders.length > 0;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    const fakeRegistry = adapterHarness
      ? Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [adapterHarness.provider]: adapterHarness.adapter }),
        )
      : null;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const adapters: Partial<Record<string, ProviderAdapterShape<ProviderAdapterError>>> = {};
        for (const name of realProviders) {
          switch (name) {
            case "codex": {
              const codexSettings = yield* decodeCodexSettings({});
              adapters[ProviderDriverKind.make("codex")] = (yield* makeCodexAdapter(
                codexSettings,
              )) as ProviderAdapterShape<ProviderAdapterError>;
              break;
            }
            case "claudeAgent": {
              adapters[ProviderDriverKind.make("claudeAgent")] = (yield* makeClaudeAdapter(
                yield* decodeClaudeSettings({}).pipe(Effect.orDie),
              )) as ProviderAdapterShape<ProviderAdapterError>;
              break;
            }
            case "agy": {
              adapters[ProviderDriverKind.make("agy")] = (yield* makeAgyAdapter(
                yield* decodeAgySettings({}).pipe(Effect.orDie),
              )) as ProviderAdapterShape<ProviderAdapterError>;
              break;
            }
            case "opencode": {
              adapters[ProviderDriverKind.make("opencode")] = (yield* makeOpenCodeAdapter(
                yield* decodeOpenCodeSettings({}).pipe(Effect.orDie),
              )) as ProviderAdapterShape<ProviderAdapterError>;
              break;
            }
            case "grok": {
              adapters[ProviderDriverKind.make("grok")] = (yield* makeGrokAdapter(
                yield* decodeGrokSettings({}).pipe(Effect.orDie),
              )) as ProviderAdapterShape<ProviderAdapterError>;
              break;
            }
          }
        }
        return makeAdapterRegistryMock(adapters);
      }),
    ).pipe(
      Layer.provideMerge(OpenCodeRuntimeLive),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(providerEventLoggersLayer),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(providerEventLoggersLayer),
        );
    const readyProviderSnapshot = (
      driver: "claudeAgent" | "codex" | "agy" | "opencode" | "grok",
      model: string,
    ): ServerProvider => ({
      instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(driver)),
      driver: ProviderDriverKind.make(driver),
      displayName:
        driver === "codex"
          ? "Codex"
          : driver === "agy"
            ? "Antigravity"
            : driver === "opencode"
              ? "OpenCode"
              : driver === "grok"
                ? "Grok"
                : "Claude",
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-14T00:00:00.000Z",
      availability: "available",
      models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    // The turn-start readiness gate fails closed on providers missing from
    // the registry; an empty registry silently failed every integration turn
    // once that gate landed. These snapshots keep the gate honest and open
    // for the drivers this suite drives.
    const providerRegistryLayer = makeProviderRegistryLayer([
      readyProviderSnapshot("claudeAgent", REAL_PROVIDER_TEST_MODELS.claudeAgent),
      readyProviderSnapshot("codex", REAL_PROVIDER_TEST_MODELS.codex),
      readyProviderSnapshot("agy", REAL_PROVIDER_TEST_MODELS.agy),
      readyProviderSnapshot("opencode", REAL_PROVIDER_TEST_MODELS.opencode),
      readyProviderSnapshot("grok", REAL_PROVIDER_TEST_MODELS.grok),
    ]);

    const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer));
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
    const runtimeServicesLayer = Layer.mergeAll(
      projectionSnapshotQueryLayer,
      orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      checkpointStoreLayer,
      providerLayer,
      RuntimeReceiptBusTest,
    ).pipe(
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
    );
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
      renameBranch: (input: {
        readonly cwd: string;
        readonly oldBranch: string;
        readonly newBranch: string;
      }) => Effect.succeed({ branch: input.newBranch }),
    });
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: "update" }),
      generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
    } as unknown as TextGenerationShape);
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(gitWorkflowLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
          streamStatus: () => Stream.empty,
        }),
      ),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
    );
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
      Layer.provideMerge(
        Layer.succeed(ThreadDeletionReactor, {
          start: () => Effect.void,
          drain: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(RateLimitResumeReactor, {
          start: () => Effect.void,
          runDue: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ScheduledQueueReactor, { start: () => Effect.void, runDue: Effect.void }),
      ),
      Layer.provideMerge(
        Layer.succeed(ResearchIntegrityReactor, {
          start: () => Effect.void,
          drain: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          InlineDelegationRunner,
          InlineDelegationRunner.of({
            run: () => Effect.die("inline delegation is out of scope for this harness"),
          }),
        ),
      ),
    );
    // Optional real MCP stack. Building McpSessionRegistry.layer sets the
    // module-global registry, which is the exact switch that makes
    // ProviderService mint t3-code credentials into real provider sessions.
    // The endpoint URL inside those credentials derives from the bound
    // ephemeral port automatically.
    let mcpEndpoint: string | null = null;
    let mcpRequestCount = 0;
    const mcpToolCallCounts = new Map<string, number>();
    let mcpScope: Scope.Closeable | null = null;
    if (options?.mcp === true) {
      mcpScope = yield* Scope.make("sequential");
      const ownedMcpScope = mcpScope;
      // `dispose` closes this eagerly, while the parent finalizer also covers
      // construction failures before the harness can return its disposer.
      yield* Effect.addFinalizer((exit) => Scope.close(ownedMcpScope, exit));
      const countingHttpServer = () => {
        const server = NodeHttp.createServer();
        server.on("request", (request) => {
          if (!request.url?.startsWith("/mcp")) return;
          mcpRequestCount += 1;
          if (request.method !== "POST") return;

          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          request.on("end", () => {
            try {
              const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              const messages = Array.isArray(decoded) ? decoded : [decoded];
              for (const message of messages) {
                if (
                  typeof message !== "object" ||
                  message === null ||
                  !("method" in message) ||
                  message.method !== "tools/call" ||
                  !("params" in message) ||
                  typeof message.params !== "object" ||
                  message.params === null ||
                  !("name" in message.params) ||
                  typeof message.params.name !== "string"
                ) {
                  continue;
                }
                const name = message.params.name;
                mcpToolCallCounts.set(name, (mcpToolCallCounts.get(name) ?? 0) + 1);
              }
            } catch {
              // The real MCP handler owns validation and error responses. This
              // observer records only well-formed evidence and never interferes.
            }
          });
        });
        return server;
      };
      const mcpLayer = HttpRouter.serve(
        McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layer(countingHttpServer, { port: 0 })),
        Layer.provide(
          Layer.mergeAll(
            ServerEnvironment.layer,
            PreviewAutomationBroker.layer,
            providerRegistryLayer,
            useRealCodex ? realCodexRegistry : fakeRegistry!,
            providerSessionDirectoryLayer,
            serverSettingsLayer,
          ),
        ),
        Layer.provide(persistenceLayer),
        Layer.provide(ServerConfig.layerTest(workspaceDir, rootDir)),
        Layer.provide(NodeServices.layer),
      );
      const mcpContext = yield* Layer.buildWithScope(mcpLayer, ownedMcpScope);
      const address = Context.get(mcpContext, HttpServer.HttpServer).address;
      mcpEndpoint = address._tag === "TcpAddress" ? `http://127.0.0.1:${address.port}/mcp` : null;
    }

    const layer = Layer.empty.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(orchestrationReactorLayer),
      Layer.provideMerge(providerRegistryLayer),
      Layer.provide(persistenceLayer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const providerRuntimeIngestion = yield* tryRuntimePromise(
      "load ProviderRuntimeIngestion service",
      () => runtime.runPromise(Effect.service(ProviderRuntimeIngestionService)),
    ).pipe(Effect.orDie);
    const checkpointReactor = yield* tryRuntimePromise("load CheckpointReactor service", () =>
      runtime.runPromise(Effect.service(CheckpointReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore.CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.streamEventsForTest, (receipt) =>
      Ref.update(receiptHistory, (history) => {
        const next = [...history, receipt];
        return next.length > MAX_TEST_EVENT_HISTORY
          ? next.slice(next.length - MAX_TEST_EVENT_HISTORY)
          : next;
      }).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    // Keep a hot in-memory history for test waiters. Replaying the entire
    // SQLite event store on every 10 ms retry becomes O(events × polls) during
    // long real-provider turns; this subscription preserves the same
    // post-dispatch visibility without repeated full scans.
    const domainEventHistory = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
    yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
      Ref.update(domainEventHistory, (history) => {
        const next = [...history, event];
        return next.length > MAX_TEST_EVENT_HISTORY
          ? next.slice(next.length - MAX_TEST_EVENT_HISTORY)
          : next;
      }).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    // Let both hot subscribers establish their PubSub subscriptions, then
    // seed the waiter history from the durable store. The seed closes the
    // startup race without relying on a timing sleep; events dispatched after
    // harness construction arrive through the hot stream.
    yield* Effect.yieldNow;
    const historicalDomainEvents = yield* Stream.runCollect(engine.readEvents(0)).pipe(
      Effect.orDie,
    );
    yield* Ref.update(domainEventHistory, (history) => {
      const next = [...Array.from(historicalDomainEvents), ...history];
      return next.length > MAX_TEST_EVENT_HISTORY
        ? next.slice(next.length - MAX_TEST_EVENT_HISTORY)
        : next;
    });

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Ref.get(domainEventHistory),
        (events) => events.some(predicate),
        "domain event",
        timeoutMs,
      );

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingApprovalRepository
          .getByRequestId({ requestId: ApprovalRequestId.make(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      const readMatchingReceipt = Ref.get(receiptHistory).pipe(
        Effect.map((history) => history.find(predicate)),
      );

      return waitFor(
        readMatchingReceipt,
        (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
        "runtime receipt",
        timeoutMs,
      );
    }

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const closeMcpScopeExit = mcpScope
          ? yield* Effect.exit(Scope.close(mcpScope, Exit.void))
          : Exit.void;
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(closeMcpScopeExit)
            ? closeMcpScopeExit.cause
            : Exit.isFailure(disposeRuntimeExit)
              ? disposeRuntimeExit.cause
              : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      drainProviderRuntime: providerRuntimeIngestion.drain,
      drainCheckpointReactor: checkpointReactor.drain,
      mcpEndpoint,
      mcpRequestCount: () => mcpRequestCount,
      mcpToolCallCount: (toolName) => mcpToolCallCounts.get(toolName) ?? 0,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });
