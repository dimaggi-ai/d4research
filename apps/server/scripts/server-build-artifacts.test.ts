// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  prepareServerBuildDirectory,
  REQUIRED_SERVER_BUILD_ARTIFACTS,
  verifyServerBuildArtifacts,
} from "./server-build-artifacts.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryServerDirectory(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d4-build-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("server build artifacts", () => {
  it("cleans stale output once, then accepts the complete composed artifact", async () => {
    const serverDirectory = await temporaryServerDirectory();
    const stale = NodePath.join(serverDirectory, "dist", "stale-sentinel.txt");
    await NodeFSP.mkdir(NodePath.dirname(stale), { recursive: true });
    await NodeFSP.writeFile(stale, "stale");

    await prepareServerBuildDirectory(serverDirectory);
    await expect(NodeFSP.access(stale)).rejects.toThrow();

    for (const relativePath of REQUIRED_SERVER_BUILD_ARTIFACTS) {
      const target = NodePath.join(serverDirectory, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, "fixture");
    }
    await expect(verifyServerBuildArtifacts(serverDirectory)).resolves.toBeUndefined();
  });

  it("rejects an interrupted build instead of deploying partial output", async () => {
    const serverDirectory = await temporaryServerDirectory();
    await prepareServerBuildDirectory(serverDirectory);
    await expect(verifyServerBuildArtifacts(serverDirectory)).rejects.toThrow(/dist\/bin\.mjs/);
  });

  it("rejects empty files instead of accepting a corrupt composed artifact", async () => {
    const serverDirectory = await temporaryServerDirectory();
    for (const relativePath of REQUIRED_SERVER_BUILD_ARTIFACTS) {
      const target = NodePath.join(serverDirectory, relativePath);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, relativePath === "dist/bin.mjs" ? "" : "fixture");
    }
    await expect(verifyServerBuildArtifacts(serverDirectory)).rejects.toThrow(/dist\/bin\.mjs/);
  });
});
