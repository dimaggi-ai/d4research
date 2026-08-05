// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

export async function copyToolGuardAssets(input: {
  readonly repositoryRoot: string;
  readonly destination: string;
}): Promise<void> {
  await NodeFSP.rm(input.destination, { recursive: true, force: true });
  await NodeFSP.mkdir(NodePath.join(input.destination, "scripts"), { recursive: true });
  await NodeFSP.cp(
    NodePath.join(input.repositoryRoot, "ops", "tool-guard", "profiles"),
    NodePath.join(input.destination, "profiles"),
    { recursive: true },
  );
  for (const script of [
    "t3research-tool-guard-hook",
    "t3research-tool-guard-agy-hook",
    "t3research-tool-guard-hook.ps1",
    "t3research-tool-guard-agy-hook.ps1",
  ]) {
    await NodeFSP.copyFile(
      NodePath.join(input.repositoryRoot, "scripts", script),
      NodePath.join(input.destination, "scripts", script),
    );
  }
}

if (import.meta.main) {
  const serverRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
  await copyToolGuardAssets({
    repositoryRoot: NodePath.resolve(serverRoot, "../.."),
    destination: NodePath.join(serverRoot, "dist", "tool-guard"),
  });
}
