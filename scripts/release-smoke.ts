// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { parse as parseYaml } from "yaml";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array.`);
  }
  return value;
}

const workspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/mobile/deps/react-native-nitro-markdown-0.5.0.tgz",
  "apps/mobile/modules/t3-markdown-text/package.json",
  "apps/mobile/modules/t3-review-diff/package.json",
  "apps/mobile/modules/t3-terminal/package.json",
  "apps/marketing/package.json",
  "oxlint-plugin-t3code/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = NodePath.resolve(repoRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const patchesDirectory = NodePath.resolve(repoRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "latest-mac.yml");
  const x64Path = NodePath.resolve(assetDirectory, "latest-mac-x64.yml");

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: T3-Code-9.9.9-smoke.0-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: T3-Code-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.dmg
    sha512: x64dmg
    size: 138148807
path: T3-Code-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsManifestFixtures(
  targetRoot: string,
  channel: string,
): { arm64Path: string; x64Path: string } {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, `${channel}-win-arm64.yml`);
  const x64Path = NodePath.resolve(assetDirectory, `${channel}-win-x64.yml`);

  NodeFS.writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-arm64.exe
    sha512: arm64exe
    size: 126621344
  - url: T3-Code-9.9.9-smoke.0-arm64.exe.blockmap
    sha512: arm64blockmap
    size: 152344
path: T3-Code-9.9.9-smoke.0-arm64.exe
sha512: arm64exe
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  NodeFS.writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: T3-Code-9.9.9-smoke.0-x64.exe
    sha512: x64exe
    size: 132000112
  - url: T3-Code-9.9.9-smoke.0-x64.exe.blockmap
    sha512: x64blockmap
    size: 160112
path: T3-Code-9.9.9-smoke.0-x64.exe
sha512: x64exe
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function writeWindowsBuilderDebugFixtures(targetRoot: string): {
  arm64Path: string;
  x64Path: string;
} {
  const assetDirectory = NodePath.resolve(targetRoot, "release-assets");
  NodeFS.mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = NodePath.resolve(assetDirectory, "builder-debug-win-arm64.yml");
  const x64Path = NodePath.resolve(assetDirectory, "builder-debug-win-x64.yml");
  const debugFixture = `arm64:
  firstOrDefaultFilePatterns:
    - '**/*'
nsis:
  script: |-
    !include "example.nsh"
`;

  NodeFS.writeFileSync(arm64Path, debugFixture);
  NodeFS.writeFileSync(x64Path, debugFixture);

  return { arm64Path, x64Path };
}
function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertExists(path: string, message: string): void {
  if (!NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

function assertPackageVersion(path: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    readonly version?: unknown;
  };

  if (packageJson.version !== version) {
    throw new Error(`Expected ${path} to have version ${version}.`);
  }
}

function assertMissing(path: string, message: string): void {
  if (NodeFS.existsSync(path)) {
    throw new Error(message);
  }
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

try {
  const releaseWorkflow = NodeFS.readFileSync(
    NodePath.resolve(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  for (const line of releaseWorkflow.split("\n")) {
    if (/^\s*uses:/.test(line) && !/@[0-9a-f]{40}(?:\s+#.*)?$/.test(line)) {
      throw new Error(`Release workflow action is not pinned to a commit SHA: ${line.trim()}`);
    }
  }
  const workflow = asRecord(parseYaml(releaseWorkflow), "release workflow");
  const jobs = asRecord(workflow.jobs, "release workflow jobs");
  const preflightJob = asRecord(jobs.preflight, "preflight job");
  const preflightOutputs = asRecord(preflightJob.outputs, "preflight outputs");
  const preflightSteps = asArray(preflightJob.steps, "preflight steps").map((step, index) =>
    asRecord(step, `preflight step ${index + 1}`),
  );
  if (!preflightSteps.some((step) => step.name === "Verify authored stable release notes")) {
    throw new Error("Preflight must reject missing authored notes before npm publication.");
  }
  if (
    preflightOutputs.publication_allowed !==
    "${{ github.event_name == 'push' || github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.channel == 'nightly') }}"
  ) {
    throw new Error(
      "Publication policy must allow tags/schedules/nightly dispatch and deny stable dispatch.",
    );
  }
  const outwardJobs = ["publish_cli", "release", "announce_discord"] as const;
  for (const jobName of outwardJobs) {
    const job = asRecord(jobs[jobName], `${jobName} job`);
    const condition = String(job.if ?? "");
    assertContains(
      condition,
      "vars.RELEASE_PUBLISH_ENABLED == 'true'",
      `${jobName} must remain explicitly opt-in.`,
    );
    assertContains(
      condition,
      "needs.preflight.outputs.publication_allowed == 'true'",
      `${jobName} must honor the event-specific publication gate.`,
    );
  }
  for (const jobName of ["build", "publish_cli"] as const) {
    const job = asRecord(jobs[jobName], `${jobName} job`);
    if (job.environment !== "release-production") {
      throw new Error(`${jobName} must use the protected release-production environment.`);
    }
  }
  const releaseJob = asRecord(jobs.release, "release job");
  if (releaseJob.environment !== undefined) {
    throw new Error("GitHub Release publication must not wait on a second post-npm approval.");
  }
  const releasePermissions = asRecord(releaseJob.permissions, "release permissions");
  for (const [permission, expected] of [
    ["attestations", "write"],
    ["contents", "write"],
    ["id-token", "write"],
  ] as const) {
    if (releasePermissions[permission] !== expected) {
      throw new Error(`Release permission ${permission} must be ${expected}.`);
    }
  }
  const releaseSteps = asArray(releaseJob.steps, "release steps").map((step, index) =>
    asRecord(step, `release step ${index + 1}`),
  );
  const releaseStepNames = releaseSteps.map((step) => String(step.name ?? ""));
  const requiredOrder = [
    "Download all desktop artifacts",
    "Merge macOS updater manifests",
    "Download the published CLI package",
    "Generate release checksums",
    "Attest release assets",
    "Prepare release notes",
    "Publish release",
  ];
  let previousIndex = -1;
  for (const stepName of requiredOrder) {
    const index = releaseStepNames.indexOf(stepName);
    if (index <= previousIndex) {
      throw new Error(`Release step '${stepName}' is missing or out of order.`);
    }
    previousIndex = index;
  }
  const attestStep = releaseSteps.find((step) => step.name === "Attest release assets");
  const attestWith = asRecord(attestStep?.with, "attestation inputs");
  if (attestWith["subject-path"] !== "release-assets/*") {
    throw new Error("Release attestation must cover every finalized release asset.");
  }
  for (const stepName of ["Publish release", "Publish first release"] as const) {
    const publishStep = releaseSteps.find((step) => step.name === stepName);
    const publishWith = asRecord(publishStep?.with, `${stepName} inputs`);
    const files = String(publishWith.files ?? "");
    for (const artifact of ["release-assets/*.tgz", "release-assets/SHA256SUMS"] as const) {
      assertContains(files, artifact, `${stepName} must upload ${artifact}.`);
    }
  }
  assertNotContains(
    releaseWorkflow,
    "blacksmith-",
    "Release workflow must use runners available to the d4research fork.",
  );
  for (const runner of ["ubuntu-24.04", "macos-14", "windows-2025"]) {
    assertContains(
      releaseWorkflow,
      `runner: ${runner}`,
      `Release workflow is missing the ${runner} build runner.`,
    );
  }
  assertContains(
    releaseWorkflow,
    "vars.RELEASE_PUBLISH_ENABLED == 'true'",
    "Release publication must remain explicitly opt-in.",
  );
  assertNotContains(
    releaseWorkflow,
    "ref: main",
    "Release finalization must not target the fork's nonexistent main branch.",
  );
  assertNotContains(
    releaseWorkflow,
    "git push origin HEAD:master",
    "Release jobs must not mutate master after publication.",
  );
  assertNotContains(
    releaseWorkflow,
    "actions/create-github-app-token",
    "Release finalization must not require an undeclared GitHub App credential.",
  );
  assertContains(
    releaseWorkflow,
    "--provenance --verbose",
    "npm publication must emit registry provenance.",
  );
  assertContains(
    releaseWorkflow,
    "release-assets/SHA256SUMS",
    "GitHub Releases must include checksums for published assets.",
  );
  assertContains(
    releaseWorkflow,
    "actions/attest-build-provenance@",
    "GitHub Release assets must receive build-provenance attestations.",
  );
  assertContains(
    releaseWorkflow,
    "T3CODE_DESKTOP_UPDATE_REPOSITORY: dimaggi-ai/d4research",
    "Desktop updater metadata must point at the fork-owned release repository.",
  );
  assertContains(
    releaseWorkflow,
    "D4_SIGNING_ENABLED: ${{ needs.preflight.outputs.version != '0.2.0' }}",
    "The 0.2.0 release must deterministically produce the documented unsigned artifacts.",
  );
  assertContains(
    releaseWorkflow,
    "if: matrix.platform == 'win' && needs.preflight.outputs.version != '0.2.0'",
    "Unsigned 0.2.0 builds must not initialize the Windows signing toolchain.",
  );
  assertContains(
    releaseWorkflow,
    "body_path: release-notes.md",
    "Stable releases must use authored product release notes.",
  );
  assertContains(
    releaseWorkflow,
    'notes_path="docs/user/release-$RELEASE_VERSION.md"',
    "Stable release notes must resolve from the exact release version.",
  );

  copyWorkspaceManifestFixture(tempRoot);

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });

  NodeChildProcess.execFileSync("vp", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
  assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "apps/mobile/package.json",
    "apps/marketing/package.json",
    "packages/contracts/package.json",
  ]) {
    assertPackageVersion(NodePath.resolve(tempRoot, relativePath), "9.9.9-smoke.0");
  }

  const nightlyReleaseMetadata = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=d4research Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"),
      "--platform",
      "mac",
      arm64Path,
      x64Path,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = NodeFS.readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "T3-Code-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  const { arm64Path: winArm64Path, x64Path: winX64Path } = writeWindowsManifestFixtures(
    tempRoot,
    "latest",
  );
  const mergedWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/latest.yml");
  const { arm64Path: nightlyWinArm64Path, x64Path: nightlyWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "nightly");
  const mergedNightlyWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/nightly.yml");
  const { arm64Path: previewWinArm64Path, x64Path: previewWinX64Path } =
    writeWindowsManifestFixtures(tempRoot, "preview");
  const mergedPreviewWindowsManifestPath = NodePath.resolve(tempRoot, "release-assets/preview.yml");
  const { arm64Path: winDebugArm64Path, x64Path: winDebugX64Path } =
    writeWindowsBuilderDebugFixtures(tempRoot);
  NodeChildProcess.execFileSync(
    "bash",
    [
      "-lc",
      `
        release_assets_dir=${JSON.stringify(NodePath.resolve(tempRoot, "release-assets"))}
        shopt -s nullglob
        found_windows_manifest=false
        for x64_manifest in "$release_assets_dir"/*-win-x64.yml; do
          if [[ "$(basename "$x64_manifest")" == builder-debug-* ]]; then
            continue
          fi

          arm64_manifest="\${x64_manifest/-x64.yml/-arm64.yml}"
          output_manifest="\${x64_manifest/-win-x64.yml/.yml}"
          if [[ ! -f "$arm64_manifest" ]]; then
            echo "Missing matching arm64 Windows manifest for $x64_manifest" >&2
            exit 1
          fi

          found_windows_manifest=true
          ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.resolve(repoRoot, "scripts/merge-update-manifests.ts"))} --platform win \
            "$arm64_manifest" \
            "$x64_manifest" \
            "$output_manifest"
          rm -f "$arm64_manifest" "$x64_manifest"
        done

        if [[ "$found_windows_manifest" != true ]]; then
          echo "No Windows updater manifests found to merge." >&2
          exit 1
        fi
      `,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedWindowsManifest = NodeFS.readFileSync(mergedWindowsManifestPath, "utf8");
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged Windows manifest is missing the x64 asset.",
  );
  const mergedNightlyWindowsManifest = NodeFS.readFileSync(
    mergedNightlyWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged nightly Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedNightlyWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged nightly Windows manifest is missing the x64 asset.",
  );
  const mergedPreviewWindowsManifest = NodeFS.readFileSync(
    mergedPreviewWindowsManifestPath,
    "utf8",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-arm64.exe",
    "Merged preview Windows manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedPreviewWindowsManifest,
    "T3-Code-9.9.9-smoke.0-x64.exe",
    "Merged preview Windows manifest is missing the x64 asset.",
  );
  assertMissing(
    winArm64Path,
    "Windows release smoke unexpectedly kept the arm64 updater manifest.",
  );
  assertMissing(winX64Path, "Windows release smoke unexpectedly kept the x64 updater manifest.");
  assertMissing(
    nightlyWinArm64Path,
    "Windows release smoke unexpectedly kept the nightly arm64 updater manifest.",
  );
  assertMissing(
    nightlyWinX64Path,
    "Windows release smoke unexpectedly kept the nightly x64 updater manifest.",
  );
  assertMissing(
    previewWinArm64Path,
    "Windows release smoke unexpectedly kept the preview arm64 updater manifest.",
  );
  assertMissing(
    previewWinX64Path,
    "Windows release smoke unexpectedly kept the preview x64 updater manifest.",
  );
  assertExists(
    winDebugArm64Path,
    "Windows release smoke unexpectedly removed the arm64 builder debug fixture.",
  );
  assertExists(
    winDebugX64Path,
    "Windows release smoke unexpectedly removed the x64 builder debug fixture.",
  );

  Effect.runSync(Console.log("Release smoke checks passed."));
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
