// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const REQUIRED_SERVER_BUILD_ARTIFACTS = [
  "dist/bin.mjs",
  "dist/service-launcher.mjs",
  "dist/client/index.html",
  "dist/tool-guard/profiles/local-coding/policy.yaml",
  "dist/tool-guard/profiles/local-coding-shadow/policy.yaml",
  "dist/tool-guard/scripts/t3research-tool-guard-hook",
  "dist/tool-guard/scripts/t3research-tool-guard-agy-hook",
  "dist/tool-guard/scripts/t3research-tool-guard-hook.ps1",
  "dist/tool-guard/scripts/t3research-tool-guard-agy-hook.ps1",
] as const;

export async function prepareServerBuildDirectory(serverDirectory: string): Promise<void> {
  const dist = NodePath.join(serverDirectory, "dist");
  await NodeFSP.rm(dist, { recursive: true, force: true });
  await NodeFSP.mkdir(dist, { recursive: true });
}

export async function verifyServerBuildArtifacts(serverDirectory: string): Promise<void> {
  const invalid: string[] = [];
  for (const relativePath of REQUIRED_SERVER_BUILD_ARTIFACTS) {
    try {
      const stats = await NodeFSP.stat(NodePath.join(serverDirectory, relativePath));
      if (!stats.isFile() || stats.size === 0) invalid.push(relativePath);
    } catch {
      invalid.push(relativePath);
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Server build is incomplete; missing or empty: ${invalid.join(", ")}`);
  }
}
