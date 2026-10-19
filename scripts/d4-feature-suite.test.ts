// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  assertD4FeatureSuiteIntegrity,
  D4_FEATURE_SUITES,
  resolveD4FeatureTestFiles,
  parseD4FeatureSuiteArgs,
} from "./d4-feature-suite.ts";

const expectedFeatureIds = [
  "pipelines",
  "inline-delegation",
  "provider-handoff",
  "skills",
  "shared-memory",
  "tool-guard",
  "voice-workflows",
  "composer-attachments",
  "system-monitor",
  "provider-readiness-usage",
  "release-isolation",
];

describe("d4 feature suite inventory", () => {
  it("never silently drops coverage or other runner flags", () => {
    expect(() => parseD4FeatureSuiteArgs(["provider-handoff", "--coverage"])).toThrow(/after --/u);
    expect(
      parseD4FeatureSuiteArgs(["provider-handoff", "--", "--coverage", "--reporter=verbose"]),
    ).toEqual({
      list: false,
      featureIds: ["provider-handoff"],
      vitestArgs: ["--coverage", "--reporter=verbose"],
    });
  });

  it("validates feature names even for listing and does not consume forwarded flags", () => {
    expect(() => parseD4FeatureSuiteArgs(["--list", "typo"])).toThrow(/Unknown d4 feature/u);
    expect(parseD4FeatureSuiteArgs(["shared-memory", "--list"])).toEqual({
      list: true,
      featureIds: ["shared-memory"],
      vitestArgs: [],
    });
    expect(parseD4FeatureSuiteArgs(["--", "--list"]).list).toBe(false);
  });
  it("keeps every documented d4 feature family in the reliability gate", () => {
    expect(D4_FEATURE_SUITES.map((suite) => suite.id)).toEqual(expectedFeatureIds);
  });

  it("references only test files that exist", () => {
    const repoRoot = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
    );
    expect(() => assertD4FeatureSuiteIntegrity(repoRoot)).not.toThrow();
  });

  it("deduplicates shared contract tests without dropping feature coverage", () => {
    const files = resolveD4FeatureTestFiles([]);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain("apps/web/src/researchPipeline.test.ts");
    expect(files).toContain("apps/server/src/toolGuardPolicy.test.ts");
    expect(files).toContain("apps/web/src/components/chat/PodcastPlayer.test.ts");
    expect(files).toContain("apps/web/src/components/chat/composerSubmission.test.ts");
    expect(files).toContain("apps/desktop/src/updates/DesktopUpdates.test.ts");
  });

  it("rejects a misspelled feature instead of silently running nothing", () => {
    expect(() => resolveD4FeatureTestFiles(["handof"])).toThrow(/Unknown d4 feature/u);
  });

  it("runs draft lifecycle and provider-instance boundaries with the handoff gate", () => {
    expect(resolveD4FeatureTestFiles(["provider-handoff"])).toEqual(
      expect.arrayContaining([
        "apps/web/src/composerDraftStore.test.ts",
        "apps/web/src/providerInstances.test.ts",
        "apps/server/src/researchHandoff.qa.test.ts",
      ]),
    );
  });

  it("keeps a selected feature gate scoped and deduplicates repeated selections", () => {
    const once = resolveD4FeatureTestFiles(["shared-memory"]);
    expect(resolveD4FeatureTestFiles(["shared-memory", "shared-memory"])).toEqual(once);
    expect(once).not.toContain("apps/desktop/src/updates/DesktopUpdates.test.ts");
    expect(() => resolveD4FeatureTestFiles(["shared-memory", "typo"])).toThrow(
      /Unknown d4 feature/u,
    );
  });
});
