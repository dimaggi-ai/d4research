// @effect-diagnostics nodeBuiltinImport:off -- Exercise deployment against isolated subprocess fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@d4research/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";
import { bundledRuntimeActivationScript, bundledRuntimeUploadScript } from "./bundledRuntime.ts";
import { buildRemoteLaunchScript } from "./tunnel.ts";

const runtime = {
  version: "0.1.1",
  buildId: "a".repeat(64),
  os: "darwin" as const,
  arch: "arm64" as const,
  sha256: "b".repeat(64),
};

async function run(script: string, home: string, input?: Uint8Array) {
  const child = NodeChildProcess.spawn("sh", ["-c", script], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  return { code, stdout, stderr };
}
async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bundled-runtime-"));
  const children: NodeChildProcess.ChildProcess[] = [];
  const state = NodePath.join(home, ".t3/ssh-launch/test");
  const userdata = NodePath.join(home, ".t3/userdata");
  const root = NodePath.join(home, ".t3/runtime/forks", runtime.buildId);
  await NodeFSP.mkdir(state, { recursive: true });
  await NodeFSP.mkdir(userdata, { recursive: true });
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(userdata, "environment-id"), "test-env");
  await NodeFSP.writeFile(NodePath.join(userdata, "statev2.sqlite"), "original database");
  await NodeFSP.writeFile(NodePath.join(state, "managed"), "managed");
  await NodeFSP.writeFile(NodePath.join(state, "port"), "4173");
  await NodeFSP.writeFile(NodePath.join(root, ".bundle-sha256"), runtime.sha256);
  const runner = `#!/usr/bin/env node
const fs = require('node:fs');
const base = process.env.HOME + '/.t3';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('t3 v0.1.1'); process.exit(0); }
if (args[0] === '__ssh-helper' && args[1] === 'pick-port') { process.stdout.write('4173'); process.exit(0); }
if (args[0] === '__ssh-helper' && args[1] === 'runtime-port') {
 const info = JSON.parse(fs.readFileSync(args[2])); process.kill(info.pid, 0); process.stdout.write(info.pid + ' ' + info.port); process.exit(0);
}
if (args[0] === '__ssh-helper' && args[1] === 'wait-ready') {
 if (args[3] === '30000') process.exit(0);
 const ready = () => { try { const r = JSON.parse(fs.readFileSync(base + '/userdata/server-runtime.json')); return r.buildId === '${runtime.buildId}'; } catch { return false; } };
 const finish = () => process.exit(fs.existsSync(base + '/fail-trial') ? 1 : 0);
 if (ready()) finish();
 const watcher = fs.watch(base + '/userdata', () => { if (ready()) { watcher.close(); finish(); } });
} else {
 if (process.env.T3CODE_SERVER_BUILD_ID && fs.existsSync(base + '/fail-trial')) fs.writeFileSync(base + '/userdata/statev2.sqlite', 'trial database');
 fs.writeFileSync(base + '/userdata/server-runtime.json', JSON.stringify({pid:process.pid,port:4173,buildId:process.env.T3CODE_SERVER_BUILD_ID ?? 'old'}));
 process.on('SIGTERM', () => process.exit(0));
 setInterval(() => {}, 1000);
}
`;
  const executable = NodePath.join(root, "t3");
  await NodeFSP.writeFile(executable, runner, { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(state, "run-t3.sh"),
    `#!/bin/sh\nexec '${executable}' "$@"\n`,
    {
      mode: 0o700,
    },
  );
  const child = NodeChildProcess.spawn(executable, ["serve"], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  children.push(child);
  await NodeFSP.writeFile(NodePath.join(state, "pid"), String(child.pid));
  // The test waits for the fixture's actual ownership record before asking to update it.
  await new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(userdata, async () => {
      try {
        await NodeFSP.access(NodePath.join(userdata, "server-runtime.json"));
        watcher.close();
        resolve();
      } catch {
        /* The atomic write has not arrived yet. */
      }
    });
    child.once("error", reject);
    void NodeFSP.access(NodePath.join(userdata, "server-runtime.json")).then(
      () => {
        watcher.close();
        resolve();
      },
      () => {},
    );
  });
  return {
    home,
    state,
    userdata,
    root,
    async stopServer() {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    },
    async [Symbol.asyncDispose]() {
      const pid = Number(
        await NodeFSP.readFile(NodePath.join(state, "pid"), "utf8").catch(() => "0"),
      );
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
      for (const process of children) process.kill("SIGTERM");
      await NodeFSP.rm(home, { recursive: true, force: true });
    },
  };
}

describe("bundled SSH runtime", () => {
  it("does not launch a competing server while a bundled update owns the restart", async () => {
    await using f = await fixture();
    const pid = await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8");
    await NodeFSP.mkdir(NodePath.join(f.state, "update.lock"));
    await f.stopServer();
    const result = await run(
      "set -- test\n" +
        buildRemoteLaunchScript({ archiveVersion: runtime.version, forkBuildId: runtime.buildId }),
      f.home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("update is in progress");
    expect(await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8")).toBe(pid);
  });
  it("reconnects to an older healthy server without activating the newly staged runner", async () => {
    await using f = await fixture();
    const pid = await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8");
    const runner = await NodeFSP.readFile(NodePath.join(f.state, "run-t3.sh"), "utf8");
    const result = await run(
      "set -- test\n" +
        buildRemoteLaunchScript({ archiveVersion: runtime.version, forkBuildId: runtime.buildId }),
      f.home,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('{"remotePort":4173,"serverKind":"managed"}');
    expect(await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8")).toBe(pid);
    expect(await NodeFSP.readFile(NodePath.join(f.state, "run-t3.sh"), "utf8")).toBe(runner);
  });
  it("refuses another environment before touching its managed server", async () => {
    await using f = await fixture();
    const before = await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8");
    const result = await run(
      bundledRuntimeActivationScript({ runtime, stateKey: "test", environmentId: "wrong-env" }),
      f.home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("identity does not match");
    expect(await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8")).toBe(before);
  });
  it("refuses an external server without stopping it", async () => {
    await using f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.state, "managed"), "external");
    const result = await run(
      bundledRuntimeActivationScript({ runtime, stateKey: "test", environmentId: "test-env" }),
      f.home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not managed");
  });
  it("activates the bundled build on the existing port without replacing user data", async () => {
    await using f = await fixture();
    const before = await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8");
    const result = await run(
      bundledRuntimeActivationScript({ runtime, stateKey: "test", environmentId: "test-env" }),
      f.home,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(runtime.buildId);
    expect(await NodeFSP.readFile(NodePath.join(f.state, "pid"), "utf8")).not.toBe(before);
    expect(await NodeFSP.readFile(NodePath.join(f.state, "port"), "utf8")).toBe("4173");
    expect(await NodeFSP.readFile(NodePath.join(f.userdata, "statev2.sqlite"), "utf8")).toBe(
      "original database",
    );
  });
  it("restores the previous database and runner when the trial cannot become ready", async () => {
    await using f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.home, ".t3/fail-trial"), "1");
    const oldRunner = await NodeFSP.readFile(NodePath.join(f.state, "run-t3.sh"), "utf8");
    const result = await run(
      bundledRuntimeActivationScript({ runtime, stateKey: "test", environmentId: "test-env" }),
      f.home,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("restored the previous server");
    expect(await NodeFSP.readFile(NodePath.join(f.userdata, "statev2.sqlite"), "utf8")).toBe(
      "original database",
    );
    expect(await NodeFSP.readFile(NodePath.join(f.state, "run-t3.sh"), "utf8")).toBe(oldRunner);
  });
  it.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "publishes a verified self-contained archive with the CLI's real version format",
    async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-valid-"));
      try {
        const content = NodePath.join(home, "payload");
        await NodeFSP.mkdir(content);
        await NodeFSP.writeFile(
          NodePath.join(content, "t3"),
          "#!/bin/sh\nprintf 't3 v0.1.1\\n'\n",
          {
            mode: 0o755,
          },
        );
        const archived = NodeChildProcess.spawnSync("tar", ["-czf", "-", "-C", home, "payload"], {
          maxBuffer: 1024 * 1024,
        });
        expect(archived.status).toBe(0);
        const sha256 = NodeCrypto.createHash("sha256").update(archived.stdout).digest("hex");
        const manifest = {
          ...runtime,
          sha256,
          arch:
            HostProcess.Architecture.defaultValue() === "arm64"
              ? ("arm64" as const)
              : ("x64" as const),
        };
        const result = await run(bundledRuntimeUploadScript(manifest), home, archived.stdout);
        expect(result.code, result.stderr).toBe(0);
        expect(
          await NodeFSP.readFile(
            NodePath.join(home, ".t3/runtime/forks", runtime.buildId, ".bundle-sha256"),
            "utf8",
          ),
        ).toBe(sha256 + "\n");
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    },
  );
  it("rejects a corrupt payload before publishing any runtime", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-upload-"));
    try {
      const result = await run(
        bundledRuntimeUploadScript({
          ...runtime,
          arch: HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64",
        }),
        home,
        new TextEncoder().encode("corrupt archive"),
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        HostProcess.Platform.defaultValue() === "darwin" ? "checksum mismatch" : "does not support",
      );
      expect(
        await NodeFSP.stat(NodePath.join(home, ".t3/runtime/forks", runtime.buildId)).catch(
          () => null,
        ),
      ).toBeNull();
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
