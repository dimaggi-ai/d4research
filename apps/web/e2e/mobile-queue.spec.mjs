import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { createPairingUrl } from "./harness.mjs";

export async function mobileQueueWhileRunning({ page, context, app, screenshotDir }) {
  await context.addInitScript(() => {
    let runningThreadId = sessionStorage.getItem("queue-fixture-thread");
    window.__queueFixtureForbiddenDispatch = false;
    const now = new Date().toISOString();
    // Keep the production composer and queue store real. Only the incoming
    // provider state is simulated; no agent process should run for this test.
    const runningSnapshot = (value) => {
      if (Array.isArray(value)) return value.map(runningSnapshot);
      if (!value || typeof value !== "object") return value;
      const result = Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, runningSnapshot(entry)]),
      );
      if (typeof result.environmentId === "string")
        window.__queueFixtureEnvironmentId = result.environmentId;
      if (
        typeof result.id === "string" &&
        typeof result.projectId === "string" &&
        "session" in result
      ) {
        runningThreadId ??= result.id;
        if (result.id === runningThreadId) {
          result.session = {
            threadId: result.id,
            status: "running",
            providerName: "codex",
            providerInstanceId: "codex",
            runtimeMode: "full-access",
            activeTurnId: "queue-test-turn",
            lastError: null,
            updatedAt: now,
          };
          result.latestTurn = {
            turnId: "queue-test-turn",
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          };
        }
      }
      return result;
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!response.headers.get("content-type")?.includes("application/json")) return response;
      return new Response(JSON.stringify(runningSnapshot(await response.clone().json())), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    // Playwright's WebSocket proxy does not preserve this app's auth protocol.
    // Keep the native connection and transform only its delivered message events.
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("open", () => {
          window.__queueFixtureSocket = this;
        });
        const transformed = new WeakSet();
        this.addEventListener("message", (event) => {
          if (transformed.has(event)) return;
          const next = new MessageEvent("message", {
            data: JSON.stringify(runningSnapshot(JSON.parse(event.data))),
            origin: event.origin,
          });
          transformed.add(next);
          event.stopImmediatePropagation();
          this.dispatchEvent(next);
        });
      }
      send(message) {
        if (/thread\.turn\.(start|interrupt)/u.test(String(message))) {
          window.__queueFixtureForbiddenDispatch = true;
          return;
        }
        super.send(message);
      }
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(createPairingUrl(app, "mobile-queue"), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  await page.waitForURL((url) => url.pathname !== "/" && url.pathname !== "/pair", {
    timeout: 20000,
  });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(app.baseDir, "userdata/state.sqlite"), {
    readOnly: true,
  });
  const project = db
    .prepare("SELECT project_id FROM projection_projects WHERE deleted_at IS NULL LIMIT 1")
    .get();
  db.close();
  NodeAssert.ok(project);
  const destination = await page.evaluate(async (projectId) => {
    const socket = window.__queueFixtureSocket;
    const threadId = crypto.randomUUID();
    const requestId = 900000;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(new Error("Thread fixture creation timed out"));
      }, 10000);
      const receive = (event) => {
        const packet = JSON.parse(event.data);
        if (packet._tag !== "Exit" || Number(packet.requestId) !== requestId) return;
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        if (packet.exit._tag === "Success") resolve();
        else reject(new Error(JSON.stringify(packet.exit)));
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag: "orchestration.dispatchCommand",
          payload: {
            type: "thread.create",
            commandId: crypto.randomUUID(),
            threadId,
            projectId,
            title: "Mobile queue fixture",
            modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          headers: [],
        }),
      );
    });
    sessionStorage.setItem("queue-fixture-thread", threadId);
    return `/${window.__queueFixtureEnvironmentId}/${threadId}`;
  }, project.project_id);
  await page.goto(`${app.webUrl}${destination}`, { waitUntil: "domcontentloaded" });
  const stop = page.getByRole("button", { name: "Stop generation", exact: true });
  const editor = page.getByTestId("composer-editor");
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  await editor.click();
  await stop.waitFor();
  const send = page.getByRole("button", { name: "Queue message", exact: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await editor.click();
    await editor.fill(`Follow-up from phone ${width}`);
    await send.waitFor({ state: "visible", timeout: 5000 });
    const box = await send.boundingBox();
    NodeAssert.ok(
      box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844,
      "Send must remain inside the phone viewport",
    );
    NodeAssert.equal(await send.isEnabled(), true);
    await stop.waitFor();
    const header = page.locator("[data-chat-header]");
    const actions = await header.locator("[data-chat-header-actions]").boundingBox();
    const panelControls = await header.locator("[data-workspace-titlebar-controls]").boundingBox();
    NodeAssert.ok(
      actions &&
        panelControls &&
        actions.x >= 0 &&
        actions.x + actions.width <= panelControls.x &&
        panelControls.x + panelControls.width <= width,
      `Header actions must fit before panel controls without overlap at ${width}px`,
    );
    const initializeGit = header.getByRole("button", { name: "Initialize Git", exact: true });
    await initializeGit.waitFor({ state: "visible", timeout: 5000 });
    NodeAssert.equal(
      await initializeGit.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
      true,
      "The compact Git action must stay named and unobstructed",
    );
    await page.screenshot({
      path: NodePath.join(screenshotDir, `mobile-queue-actions-${width}.png`),
      timeout: 10000,
    });
    await send.click();
    const queue = page.locator('[data-chat-request-queue="true"]');
    await queue.getByText(`Follow-up from phone ${width}`, { exact: true }).waitFor();
    await stop.waitFor();
    NodeAssert.equal(
      await page.evaluate(() => window.__queueFixtureForbiddenDispatch),
      false,
      "Queuing must not interrupt or start a provider turn",
    );
    await queue
      .getByRole("button", { name: "Cancel and return to the composer", exact: true })
      .first()
      .click();
    await queue.waitFor({ state: "hidden" });
    // The returned text lands in the composer. Re-expand only if it collapsed.
    const expand = page.getByRole("button", { name: "Expand composer", exact: true });
    if (await expand.isVisible()) await expand.click();
    await editor.waitFor({ state: "visible" });
    console.log(
      `PASS phone ${width}px queues and removes a follow-up while Stop remains available`,
    );
  }
}
