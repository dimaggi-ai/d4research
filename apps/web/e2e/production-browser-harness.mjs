import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";

export async function runProductionBrowserSuite(specs) {
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d4-browser-test."));
  const artifactDir = process.env.T3_UI_ARTIFACT_DIR ?? NodePath.join(baseDir, "artifacts");
  await NodeFSP.mkdir(artifactDir, { recursive: true });
  // CI has no provider CLIs. A stub binary and loopback Ollama endpoint make a ready provider.
  // The server puts the login shell's PATH first, so settings pin the binary.
  const claudeStub = NodePath.join(baseDir, "claude-stub");
  await NodeFSP.writeFile(
    claudeStub,
    '#!/bin/sh\n[ "$1" = "--version" ] && echo "2.1.100 (Claude Code)" && exit 0\nexit 1\n',
    { mode: 0o755 },
  );
  const ollamaCatalog = NodeHttp.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ name: "e2e-alpha" }, { name: "e2e-beta" }] }));
  });
  await new Promise((resolve) => ollamaCatalog.listen(0, "127.0.0.1", resolve));
  ollamaCatalog.unref();
  await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(baseDir, "userdata", "settings.json"),
    JSON.stringify({
      // An update prompt for an installed CLI would cover the controls under test.
      enableProviderUpdateChecks: false,
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", config: { binaryPath: claudeStub } },
      },
    }),
  );
  const port = process.env.T3_UI_TEST_PORT
    ? Number(process.env.T3_UI_TEST_PORT)
    : await new Promise((resolve, reject) => {
        const listener = NodeNet.createServer();
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const { port } = listener.address();
          listener.close(() => resolve(port));
        });
      });
  const bin = process.env.T3_PWA_TEST_SERVER_BIN ?? NodePath.join(root, "apps/server/dist/bin.mjs");
  const executable = process.env.T3_UI_TEST_SERVER_EXECUTABLE;
  await NodeFSP.access(executable ?? bin);
  const app = { baseDir, serverPort: port, webUrl: `http://127.0.0.1:${port}` };
  const serverLog = NodeFS.createWriteStream(NodePath.join(artifactDir, "server.log"));
  const server = NodeChildProcess.spawn(
    executable ?? process.execPath,
    [
      ...(executable ? [] : [bin]),
      "--base-dir",
      baseDir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    {
      cwd: baseDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("T3CODE_")),
        ),
        T3CODE_HOME: baseDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${ollamaCatalog.address().port}`,
        ANTHROPIC_AUTH_TOKEN: "ollama",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (process.env.T3_UI_TEST_PID_FILE && server.pid !== undefined) {
    await NodeFSP.writeFile(process.env.T3_UI_TEST_PID_FILE, `${server.pid}\n`);
  }
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  let browser;
  let interrupted = false;
  const results = [];
  const interrupt = () => {
    interrupted = true;
    void browser?.close();
    server.kill("SIGTERM");
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Test server startup exceeded 30s")), 30000);
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes("Listening on")) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on("data", onData);
      server.stderr.on("data", onData);
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Test server exited: ${code}`));
      });
    });
    console.log(`Isolated production server ready; artifacts: ${artifactDir}`);
    browser = await chromium.launch({
      headless: true,
      timeout: 15000,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    for (const { name, run } of specs) {
      if (interrupted) throw new Error("Browser suite interrupted");
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        hasTouch: true,
      });
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(20000);
      await context.addInitScript(() => {
        localStorage.setItem(
          "t3code:client-settings:v1",
          JSON.stringify({
            onboardingCompletedAt: "2026-09-09T00:00:00.000Z",
            followUpBehavior: "queue",
          }),
        );
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      const consoleLog = [];
      context.on("console", (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
      context.on("weberror", (error) => consoleLog.push(`pageerror: ${error.error().message}`));
      const timer = setTimeout(() => {
        void context.close();
      }, 90000);
      console.log(`RUN ${name} (90s deadline)`);
      try {
        await run({ page, context, app, webUrl: app.webUrl, screenshotDir: artifactDir });
        results.push({ name, status: "passed" });
        console.log(`PASS ${name}`);
      } catch (error) {
        results.push({ name, status: "failed", error: String(error) });
        console.error(`FAIL ${name}: ${error}`);
        const failurePage = context.pages().at(-1);
        await failurePage
          ?.screenshot({ path: NodePath.join(artifactDir, `${name}-failed.png`), timeout: 5000 })
          .catch(() => {});
      } finally {
        clearTimeout(timer);
        await NodeFSP.writeFile(
          NodePath.join(artifactDir, `${name}-console.log`),
          consoleLog.join("\n"),
        );
        await context.tracing
          .stop({ path: NodePath.join(artifactDir, `${name}-trace.zip`) })
          .catch(() => {});
        await context.close();
      }
    }
    if (results.some((result) => result.status === "failed")) {
      throw new Error(
        `${results.filter((result) => result.status === "failed").length} browser regression cases failed`,
      );
    }
  } finally {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    await browser?.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    serverLog.end();
    await NodeFSP.writeFile(
      NodePath.join(artifactDir, "results.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      `Test server stopped. ${results.filter((result) => result.status === "passed").length}/${specs.length} cases passed.`,
    );
  }
}
