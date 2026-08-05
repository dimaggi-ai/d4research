// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { copyToolGuardAssets } from "./copy-tool-guard-assets.ts";

describe("Tool Guard release assets", () => {
  it("stages profiles and both provider wrappers", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-tg-assets-"));
    const destination = NodePath.join(root, "dist", "tool-guard");
    await NodeFSP.mkdir(NodePath.join(root, "ops", "tool-guard", "profiles", "local-coding"), {
      recursive: true,
    });
    await NodeFSP.mkdir(NodePath.join(root, "scripts"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "ops", "tool-guard", "profiles", "local-coding", "policy.yaml"),
      "mode: enforcement\n",
    );
    await Promise.all(
      [
        "t3research-tool-guard-hook",
        "t3research-tool-guard-agy-hook",
        "t3research-tool-guard-hook.ps1",
        "t3research-tool-guard-agy-hook.ps1",
      ].map((script) =>
        NodeFSP.writeFile(
          NodePath.join(root, "scripts", script),
          script.endsWith(".ps1") ? '$ErrorActionPreference = "Stop"\n' : "#!/bin/sh\n",
        ),
      ),
    );

    await copyToolGuardAssets({ repositoryRoot: root, destination });

    await expect(
      NodeFSP.readFile(NodePath.join(destination, "profiles/local-coding/policy.yaml"), "utf8"),
    ).resolves.toContain("enforcement");
    await expect(
      NodeFSP.readFile(NodePath.join(destination, "scripts/t3research-tool-guard-hook"), "utf8"),
    ).resolves.toContain("#!/bin/sh");
    await expect(
      NodeFSP.readFile(
        NodePath.join(destination, "scripts/t3research-tool-guard-hook.ps1"),
        "utf8",
      ),
    ).resolves.toContain("ErrorActionPreference");
    await expect(
      NodeFSP.readFile(
        NodePath.join(destination, "scripts/t3research-tool-guard-agy-hook"),
        "utf8",
      ),
    ).resolves.toContain("#!/bin/sh");
  });
});
