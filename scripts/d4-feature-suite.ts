// @effect-diagnostics nodeBuiltinImport:off, globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface D4FeatureSuite {
  readonly id: string;
  readonly contract: string;
  readonly testFiles: ReadonlyArray<string>;
}

export const D4_FEATURE_SUITES: ReadonlyArray<D4FeatureSuite> = [
  {
    id: "pipelines",
    contract: "Authored Dev and Research pipelines remain bounded, scoped, traceable, and honest.",
    testFiles: [
      "apps/web/src/researchPipeline.test.ts",
      "apps/web/src/devPipeline.test.ts",
      "apps/web/src/devPipelineEnvironment.test.ts",
      "apps/web/src/components/settings/DevPipelinesSettingsPanel.test.ts",
      "apps/web/src/components/chat/ResearchProgressBanner.test.ts",
      "apps/web/src/researchExport.test.ts",
      "apps/server/src/mcp/researchDelegateTiming.test.ts",
      "apps/server/src/mcp/toolkits/pipelines/tools.test.ts",
      "apps/server/src/mcp/toolkits/research/research.test.ts",
      "apps/server/src/orchestration/researchIntegrity.test.ts",
      "apps/server/src/orchestration/Layers/ResearchIntegrityReactor.test.ts",
      "apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts",
      "packages/shared/src/serverSettings.test.ts",
    ],
  },
  {
    id: "inline-delegation",
    contract: "A direct provider directive answers one turn without changing the thread provider.",
    testFiles: [
      "apps/web/src/researchPipeline.test.ts",
      "apps/web/src/components/chat/MessagesTimeline.logic.test.ts",
      "apps/server/src/mcp/toolkits/research/inlineDelegation.test.ts",
      "apps/server/src/mcp/toolkits/research/research.test.ts",
      "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts",
    ],
  },
  {
    id: "provider-handoff",
    contract: "Provider handoff keeps one authoritative thread and always carries bounded context.",
    testFiles: [
      "packages/contracts/src/settings.test.ts",
      "packages/shared/src/providerHandoffPrompt.test.ts",
      "apps/web/src/providerHandoff.test.ts",
      "apps/web/src/modelPickerHandoff.test.ts",
      "apps/web/src/composer-logic.test.ts",
      "apps/web/src/composerDraftStore.test.ts",
      "apps/web/src/providerInstances.test.ts",
      "apps/server/src/handoffCompression.test.ts",
      "apps/server/src/researchHandoff.qa.test.ts",
      "apps/server/src/http.test.ts",
      "apps/mobile/src/lib/foreground-handoff.test.ts",
    ],
  },
  {
    id: "skills",
    contract: "Global and per-chat skills are portable, bounded, deduplicated, and handoff-safe.",
    testFiles: [
      "packages/shared/src/enabledSkillsContext.test.ts",
      "packages/shared/src/serverSettings.test.ts",
      "packages/client-runtime/src/providerSkills.test.ts",
      "packages/client-runtime/src/state/skills.test.ts",
      "apps/server/src/skillsInventory.test.ts",
      "apps/server/src/skillExpansion.test.ts",
      "apps/server/src/mcp/toolkits/skills/skills.test.ts",
      "apps/server/src/provider/Drivers/ClaudeSkills.test.ts",
      "apps/server/src/provider/Drivers/ClaudeSkillDispatch.test.ts",
      "apps/server/src/provider/Drivers/GrokSkills.test.ts",
      "apps/server/src/provider/Drivers/AntigravitySkills.test.ts",
      "apps/web/src/hooks/useSkillsInventory.test.ts",
      "apps/web/src/components/settings/SkillsSettingsPanel.test.ts",
      "apps/web/src/components/chat/ComposerSessionSkillsControl.test.ts",
      "apps/web/src/composerSkillFallback.test.ts",
      "apps/web/src/providerSkillSearch.test.ts",
      "apps/mobile/src/features/threads/mobileSessionSkills.test.ts",
      "apps/mobile/src/features/threads/composerSlashSkillSearch.test.ts",
    ],
  },
  {
    id: "shared-memory",
    contract:
      "Memo stays local, project-scoped, retry-safe, and reversible for composer documents.",
    testFiles: [
      "apps/server/src/mcp/toolkits/memory/builtinStore.test.ts",
      "apps/server/src/mcp/toolkits/memory/memory.test.ts",
      "apps/server/src/memoAttachment.test.ts",
      "apps/web/src/memoAttachments.test.ts",
    ],
  },
  {
    id: "tool-guard",
    contract: "Tool Guard is optional, environment-scoped, reversible, and policy-preserving.",
    testFiles: [
      "apps/server/scripts/copy-tool-guard-assets.test.ts",
      "apps/server/src/provider/toolGuardRuntime.test.ts",
      "apps/server/src/toolGuardLifecycle.test.ts",
      "apps/server/src/toolGuardPolicy.test.ts",
      "apps/server/src/toolGuardStatus.test.ts",
      "apps/web/src/hooks/useToolGuardPolicy.test.ts",
      "apps/web/src/hooks/useToolGuardStatus.test.ts",
      "apps/web/src/toolGuardModes.test.ts",
    ],
  },
  {
    id: "voice-workflows",
    contract: "Voice capture and conversation state fail clearly across web and mobile clients.",
    testFiles: [
      "packages/client-runtime/src/voice-input/controller.test.ts",
      "apps/web/src/hooks/useVoiceConversation.test.ts",
      "apps/web/src/components/chat/PodcastPlayer.test.ts",
      "apps/mobile/src/features/voice-input/voiceInputMetering.test.ts",
      "apps/mobile/src/features/voice-input/voiceInputPresentation.test.ts",
      "apps/mobile/src/native/voiceTranscription.test.ts",
    ],
  },
  {
    id: "composer-attachments",
    contract:
      "Pasted and oversized composer documents stay reviewable, durable, bounded, and retry-safe.",
    testFiles: [
      "packages/shared/src/userMessageTransport.test.ts",
      "packages/client-runtime/src/state/attachments.test.ts",
      "apps/server/src/memoAttachment.test.ts",
      "apps/web/src/memoAttachments.test.ts",
      "apps/web/src/lib/pastedContext.test.ts",
      "apps/web/src/components/chat/ComposerPendingPastedContexts.test.ts",
      "apps/web/src/components/chat/composerDraftOperationKey.test.ts",
      "apps/web/src/components/chat/composerSubmission.test.ts",
      "apps/web/src/composerDraftStore.test.ts",
      "apps/mobile/src/lib/composerAttachmentFiles.test.ts",
    ],
  },
  {
    id: "system-monitor",
    contract: "System Monitor reports environment telemetry without mixing in account usage.",
    testFiles: [
      "apps/server/src/diagnostics/ProcessDiagnostics.test.ts",
      "apps/server/src/diagnostics/ProcessResourceMonitor.test.ts",
      "apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.test.ts",
      "apps/server/src/resourceTelemetry/Model.test.ts",
      "apps/server/src/resourceTelemetry/NativeTelemetryClient.test.ts",
      "apps/server/src/resourceTelemetry/ResourceMonitorBinary.test.ts",
      "apps/server/src/resourceTelemetry/ResourceTelemetry.test.ts",
      "apps/server/src/resourceTelemetry/ResourceTelemetryHistory.test.ts",
      "apps/web/src/components/SystemPanel.test.ts",
      "apps/web/src/components/settings/ResourceTelemetryDiagnostics.logic.test.ts",
    ],
  },
  {
    id: "provider-readiness-usage",
    contract: "Model readiness, provider limits, context, and cost remain explicit and normalized.",
    testFiles: [
      "packages/contracts/src/server.test.ts",
      "packages/contracts/src/threadTurnUsage.test.ts",
      "packages/shared/src/usageFormat.test.ts",
      "packages/shared/src/usageLimits.test.ts",
      "packages/shared/src/usageMerge.test.ts",
      "apps/server/src/provider/providerSnapshot.test.ts",
      "apps/server/src/provider/providerUsageLimits.test.ts",
      "apps/server/src/provider/Layers/ProviderService.test.ts",
      "apps/server/src/provider/Layers/claudeUsageLimits.test.ts",
      "apps/server/src/provider/Layers/codexUsageLimits.test.ts",
      "apps/server/src/usage/usageAggregation.test.ts",
      "apps/server/src/usage/usagePricing.test.ts",
      "apps/web/src/providerModels.test.ts",
      "apps/web/src/providerInstances.test.ts",
      "apps/web/src/components/settings/ProviderModelsSection.test.ts",
      "apps/web/src/components/usage/UsageLimits.test.ts",
      "apps/web/src/components/usage/UsagePage.test.tsx",
      "apps/web/src/components/usage/UsageProviderChart.test.ts",
      "apps/mobile/src/lib/modelOptions.test.ts",
    ],
  },
  {
    id: "release-isolation",
    contract: "d4research packaging and updates never inherit the upstream T3 release line.",
    testFiles: [
      "scripts/d4-feature-suite.test.ts",
      "scripts/build-desktop-artifact.test.ts",
      "scripts/lib/brand-assets.test.ts",
      "scripts/resolve-nightly-release.test.ts",
      "scripts/sign-macos.test.ts",
      "scripts/update-release-package-versions.test.ts",
      "apps/web/src/branding.test.ts",
      "apps/server/src/cloud/bootService.test.ts",
      "apps/server/src/cloud/pinnedRuntime.test.ts",
      "apps/server/src/cloud/selfUpdate.test.ts",
      "apps/server/src/persistence/Migrations/043_044_D4UpgradeCompatibility.test.ts",
      "apps/desktop/src/settings/DesktopAppSettings.test.ts",
      "apps/desktop/src/updates/DesktopUpdates.test.ts",
    ],
  },
];

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export function resolveD4FeatureTestFiles(
  featureIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const requested =
    featureIds.length === 0
      ? D4_FEATURE_SUITES
      : featureIds.map((id) => {
          const suite = D4_FEATURE_SUITES.find((candidate) => candidate.id === id);
          if (!suite) {
            throw new Error(
              `Unknown d4 feature '${id}'. Expected one of: ${D4_FEATURE_SUITES.map((candidate) => candidate.id).join(", ")}.`,
            );
          }
          return suite;
        });
  return [...new Set(requested.flatMap((suite) => suite.testFiles))];
}

export function assertD4FeatureSuiteIntegrity(root = repoRoot): void {
  const ids = new Set<string>();
  for (const suite of D4_FEATURE_SUITES) {
    if (ids.has(suite.id)) throw new Error(`Duplicate d4 feature id '${suite.id}'.`);
    ids.add(suite.id);
    if (suite.testFiles.length === 0) throw new Error(`d4 feature '${suite.id}' has no tests.`);
    for (const testFile of suite.testFiles) {
      if (!/\.test\.(?:ts|tsx)$/u.test(testFile)) {
        throw new Error(`d4 feature '${suite.id}' contains a non-test path: ${testFile}.`);
      }
      if (!NodeFS.existsSync(NodePath.resolve(root, testFile))) {
        throw new Error(`d4 feature '${suite.id}' references a missing test: ${testFile}.`);
      }
    }
  }
}

function printSuite(suites: ReadonlyArray<D4FeatureSuite>): void {
  for (const suite of suites) {
    process.stdout.write(`${suite.id}: ${suite.contract}\n`);
    for (const testFile of suite.testFiles) process.stdout.write(`  ${testFile}\n`);
  }
}

export function parseD4FeatureSuiteArgs(args: ReadonlyArray<string>): {
  list: boolean;
  featureIds: ReadonlyArray<string>;
  vitestArgs: ReadonlyArray<string>;
} {
  const separatorIndex = args.indexOf("--");
  const suiteArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const vitestArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
  for (const arg of suiteArgs) {
    if (arg.startsWith("-") && arg !== "--list") {
      throw new Error(`Unknown suite option '${arg}'. Pass test-runner options after --.`);
    }
  }
  const featureIds = suiteArgs.filter((arg) => arg !== "--list");
  resolveD4FeatureTestFiles(featureIds);
  return { list: suiteArgs.includes("--list"), featureIds, vitestArgs };
}

function run(): void {
  const { list, featureIds, vitestArgs } = parseD4FeatureSuiteArgs(process.argv.slice(2));
  assertD4FeatureSuiteIntegrity();
  const selectedSuites =
    featureIds.length === 0
      ? D4_FEATURE_SUITES
      : D4_FEATURE_SUITES.filter((suite) => featureIds.includes(suite.id));
  if (list) {
    printSuite(selectedSuites);
    return;
  }

  const testFiles = resolveD4FeatureTestFiles(featureIds);
  process.stdout.write(
    `[d4-feature-suite] ${selectedSuites.length} feature contracts, ${testFiles.length} test files\n`,
  );
  for (const suite of selectedSuites) process.stdout.write(`[d4-feature-suite] ${suite.id}\n`);

  // Several server tests replace process-level provider state and migrate SQLite fixtures.
  // Serial files make this reliability gate deterministic instead of letting unrelated
  // feature tests race over those globals.
  const child = NodeChildProcess.spawn(
    "vp",
    ["test", "run", "--no-file-parallelism", "--maxWorkers=1", ...vitestArgs, ...testFiles],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  child.once("error", (error) => {
    process.stderr.write(`[d4-feature-suite] could not start tests: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.stderr.write(`[d4-feature-suite] tests ended from signal ${signal}\n`);
    process.exitCode = code ?? 1;
  });
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
if (invokedPath === NodeURL.fileURLToPath(import.meta.url)) run();
