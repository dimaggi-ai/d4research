// Boots an isolated d4research stack and an authenticated browser context so UI
// specs never touch the developer's real ~/.t3 state or a running production
// server. Everything here is disposable: temp base dir, its own ports, its own
// pairing token.
import { chromium } from "playwright-core";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

// Ports are explicit rather than derived so a developer's own dev server (3773 /
// 5733) can keep running while the suite executes.
const SERVER_PORT = Number(process.env.T3_E2E_SERVER_PORT ?? 3931);
const WEB_PORT = Number(process.env.T3_E2E_WEB_PORT ?? 5931);
const BOOT_TIMEOUT_MS = 120_000;

function waitForLine(child, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for server output.\n${buffer.slice(-2000)}`)),
      timeoutMs,
    );
    const onChunk = (chunk) => {
      buffer += chunk.toString();
      const match = predicate(buffer);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onChunk);
        child.stderr.off("data", onChunk);
        resolve(match);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (code ${code}).\n${buffer.slice(-2000)}`));
    });
  });
}

export async function startIsolatedApp() {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-e2e."));
  const workspace = NodePath.join(baseDir, "workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "# e2e fixture\n", "utf8");

  const child = NodeChildProcess.spawn(
    "vp",
    ["run", "dev", "--home-dir", baseDir, "--port", String(SERVER_PORT)],
    {
      cwd: repoRoot,
      env: { ...process.env, T3CODE_PORT_OFFSET: String(WEB_PORT - 5733) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const webUrl = await waitForLine(
    child,
    (buffer) => {
      const match = buffer.match(/Local:\s+(http:\/\/localhost:\d+)\//);
      return match?.[1] ?? null;
    },
    BOOT_TIMEOUT_MS,
  );
  await waitForLine(
    child,
    (buffer) => (buffer.includes("Listening on") ? true : null),
    BOOT_TIMEOUT_MS,
  );

  return { baseDir, workspace, webUrl, serverPort: SERVER_PORT, child };
}

/**
 * Mints a fresh single-use pairing token. Each browser context needs its own —
 * opening one twice consumes it.
 */
export function createPairingUrl(app, label = "e2e") {
  const output = NodeChildProcess.execSync(
    `node apps/server/src/bin.ts auth pairing create --base-dir ${app.baseDir} --dev-url ${app.webUrl} --base-url ${app.webUrl} --ttl 15m --label ${label}`,
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, T3CODE_PORT: String(app.serverPort) },
    },
  );
  const match = output.match(/(http:\/\/\S+\/pair#token=\S+)/);
  if (!match) throw new Error(`Could not read a pairing URL from:\n${output}`);
  return match[1];
}

export async function openAuthenticatedPage(app, label = "e2e") {
  const browser = await chromium.launch({ headless: process.env.T3_E2E_HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });

  await page.goto(createPairingUrl(app, label), { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.href.includes("/pair"), { timeout: 30_000 });
  await page.waitForSelector('[aria-label="d4research"]', { timeout: 30_000 });

  return { browser, context, page, consoleErrors };
}

/**
 * Ensures a project exists and the page sits on one of its threads. Specs share
 * a browser context, so this both registers the project on first use and
 * re-opens it afterwards — thread-scoped chrome (composer, Monitor) only
 * renders inside a thread route.
 */
export async function openProject(page, workspacePath) {
  // Once a project exists the app opens a draft on load, so only register it
  // the first time. "Add project" is always in the sidebar and is therefore not
  // a usable signal for whether registration already happened.
  const alreadyOpen = await page
    .waitForURL(/\/(draft|thread)\//, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!alreadyOpen) {
    await page
      .getByRole("button", { name: /add project/i })
      .first()
      .click();
    await page.locator("input:visible").first().fill(workspacePath);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/(draft|thread)\//, { timeout: 30_000 });
  }
  // The route resolves before the thread chrome mounts; wait for a control that
  // only exists inside a thread so callers can query the header immediately.
  await page
    .getByRole("button", { name: /send message/i })
    .first()
    .waitFor({
      state: "visible",
      timeout: 30_000,
    });
}

export async function stopIsolatedApp(app) {
  app.child.kill("SIGTERM");
  await new Promise((resolve) => {
    app.child.once("exit", resolve);
    setTimeout(resolve, 5_000);
  });
  await NodeFSP.rm(app.baseDir, { recursive: true, force: true }).catch(() => {});
}
