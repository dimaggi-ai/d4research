import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { createPairingUrl } from "./harness.mjs";

export async function mobileQueueWhileRunning({ page, context, app, screenshotDir }) {
  await context.addInitScript(() => {
    let runningThreadId = sessionStorage.getItem("queue-fixture-thread");
    let deferredSeedDispatches = 0;
    window.__queueFixtureForbiddenCommands = [];
    window.__queueFixtureQueueDispatches = 0;
    window.__queueFixtureQueueCancellations = 0;
    const fixtureThreadId = () => runningThreadId ?? window.__queueFixtureThreadId ?? null;
    const now = new Date().toISOString();
    // A real deferred V2 run below exercises queue persistence without starting
    // a provider. Present its preparing state as running only in the UI.
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
        "activeRunId" in result
      ) {
        if (result.id === fixtureThreadId()) {
          result.status = "running";
          result.latestRunStartedAt ??= now;
          result.activityRunStartedAt = now;
          result.activityRunStatus = "running";
        }
      }
      // Shell `thread.updated` items also carry `thread` but no `runs`; their
      // nested shell was already rewritten above.
      const projection = result.projection?.thread ? result.projection : result;
      if (projection?.thread?.id === fixtureThreadId() && Array.isArray(projection.runs)) {
        projection.runs = projection.runs.map((run) =>
          run.status === "preparing" ? { ...run, status: "running", startedAt: now } : run,
        );
      }
      if (
        result.threadId === fixtureThreadId() &&
        result.status === "preparing" &&
        typeof result.ordinal === "number" &&
        typeof result.userMessageId === "string"
      ) {
        result.status = "running";
        result.startedAt = now;
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
        let packet;
        try {
          packet = JSON.parse(String(message));
        } catch {
          super.send(message);
          return;
        }
        const command = packet.payload;
        if (
          packet.tag === "orchestration.dispatchCommand" &&
          command?.threadId === fixtureThreadId()
        ) {
          const isDeferredFixtureStart =
            command.type === "message.dispatch" &&
            command.messageId === window.__queueFixtureDeferredMessageId &&
            command.dispatchMode?.type === "defer_start" &&
            deferredSeedDispatches === 0;
          const isQueuedMessage =
            command.type === "message.dispatch" &&
            command.dispatchMode?.type === "queue_after_active";
          if (isDeferredFixtureStart) {
            deferredSeedDispatches += 1;
            super.send(message);
            return;
          }
          if (isQueuedMessage) {
            window.__queueFixtureQueueDispatches += 1;
            super.send(message);
            return;
          }
          if (command.type === "queued-run.cancel") {
            window.__queueFixtureQueueCancellations += 1;
            super.send(message);
            return;
          }
          // Opening the fixture records read state; it cannot schedule a turn.
          if (command.type === "thread.visit") {
            super.send(message);
            return;
          }
          // Never let this fixture release the deferred run or dispatch any
          // other operation that could start, interrupt, or steer a provider.
          window.__queueFixtureForbiddenCommands.push(command.type);
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: packet.id,
                exit: { _tag: "Success", value: { sequence: 0 } },
              }),
            }),
          );
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
  const db = new NodeSqlite.DatabaseSync(NodePath.join(app.baseDir, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  const project = db
    .prepare("SELECT project_id FROM projection_projects WHERE deleted_at IS NULL LIMIT 1")
    .get();
  NodeAssert.ok(project);
  const destination = await page.evaluate(async (projectId) => {
    const socket = window.__queueFixtureSocket;
    const threadId = crypto.randomUUID();
    let requestId = 900000;
    const dispatch = (payload) =>
      new Promise((resolve, reject) => {
        const id = requestId++;
        const timer = setTimeout(() => {
          socket.removeEventListener("message", receive);
          reject(new Error(`Fixture command ${payload.type} timed out`));
        }, 10000);
        const receive = (event) => {
          const packet = JSON.parse(event.data);
          if (packet._tag !== "Exit" || Number(packet.requestId) !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
          if (packet.exit._tag === "Success") resolve(packet.exit.value);
          else reject(new Error(JSON.stringify(packet.exit)));
        };
        socket.addEventListener("message", receive);
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id,
            tag: "orchestration.dispatchCommand",
            payload,
            headers: [],
          }),
        );
      });
    await dispatch({
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId,
      createdBy: "user",
      creationSource: "mobile",
      title: "Mobile queue fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const seedMessageId = crypto.randomUUID();
    window.__queueFixtureThreadId = threadId;
    window.__queueFixtureDeferredMessageId = seedMessageId;
    sessionStorage.setItem("queue-fixture-thread", threadId);
    await dispatch({
      type: "message.dispatch",
      commandId: crypto.randomUUID(),
      threadId,
      messageId: seedMessageId,
      text: "Deferred fixture run: no provider should start.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "mobile",
    });
    return `/${window.__queueFixtureEnvironmentId}/${threadId}`;
  }, project.project_id);
  const fixtureThreadId = await page.evaluate(() => window.__queueFixtureThreadId);
  await page.goto(`${app.webUrl}${destination}`, { waitUntil: "domcontentloaded" });
  const stop = page.getByRole("button", { name: "Stop generation", exact: true });
  const editor = page.getByTestId("composer-editor");
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  await editor.click();
  await stop.waitFor();
  const send = page.getByRole("button", { name: "Queue message", exact: true });
  const persistedQueuedMessages = () =>
    db
      .prepare(
        `SELECT message.message_id AS messageId, message.payload_json AS payload
         FROM orchestration_v2_projection_runs AS run
         INNER JOIN orchestration_v2_projection_messages AS message
           ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
         WHERE run.thread_id = ? AND run.status = 'queued'
         ORDER BY run.ordinal`,
      )
      .all(fixtureThreadId);
  const runStatusForMessage = (text) =>
    db
      .prepare(
        `SELECT run.status AS status
         FROM orchestration_v2_projection_runs AS run
         INNER JOIN orchestration_v2_projection_messages AS message
           ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
         WHERE run.thread_id = ? AND json_extract(message.payload_json, '$.text') = ?
         ORDER BY run.ordinal DESC LIMIT 1`,
      )
      .get(fixtureThreadId, text)?.status;
  const assertNoProviderStart = () => {
    const counts = {
      sessions: db
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ?",
        )
        .get(fixtureThreadId).count,
      turns: db
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_turns WHERE thread_id = ?",
        )
        .get(fixtureThreadId).count,
      startEffects: db
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE thread_id = ? AND effect_type = 'provider-turn.start'",
        )
        .get(fixtureThreadId).count,
    };
    NodeAssert.deepEqual(counts, { sessions: 0, turns: 0, startEffects: 0 });
  };
  assertNoProviderStart();
  NodeAssert.equal(
    runStatusForMessage("Deferred fixture run: no provider should start."),
    "preparing",
    "The underlying V2 run must stay deferred while its UI state is presented as running",
  );
  for (const [index, width] of [390, 320].entries()) {
    await page.setViewportSize({ width, height: 844 });
    await editor.click();
    await editor.fill(`Follow-up from phone ${width}`);
    await send.waitFor({ state: "visible", timeout: 5000 });
    await stop.waitFor({ state: "visible", timeout: 5000 });
    const box = await send.boundingBox();
    NodeAssert.ok(
      box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 844,
      "Send must remain inside the phone viewport",
    );
    NodeAssert.equal(await send.isEnabled(), true);
    await stop.waitFor();
    const header = page.locator("[data-chat-header]");
    const panelControls = await header.locator("[data-workspace-titlebar-controls]").boundingBox();
    NodeAssert.ok(
      panelControls && panelControls.x >= 0 && panelControls.x + panelControls.width <= width,
      `Panel controls must fit inside the header at ${width}px`,
    );
    // V2 moved Git actions from the header overflow into thread details.
    await header.getByRole("button", { name: "Toggle thread details panel", exact: true }).click();
    const initializeGit = page.getByRole("button", { name: "Initialize Git", exact: true });
    await initializeGit.waitFor({ state: "visible", timeout: 5000 });
    NodeAssert.equal(
      await initializeGit.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
      true,
      "The menu Git action must stay named and unobstructed",
    );
    await page.keyboard.press("Escape");
    await initializeGit.waitFor({ state: "hidden" });
    // Visiting header actions blurs and collapses the phone composer.
    const expandAfterMenu = page.getByRole("button", { name: "Expand composer", exact: true });
    if (await expandAfterMenu.isVisible()) await expandAfterMenu.click();
    await editor.click();
    await stop.waitFor();
    await send.waitFor({ state: "visible" });
    await page.screenshot({
      path: NodePath.join(screenshotDir, `mobile-queue-actions-${width}.png`),
      timeout: 10000,
    });
    await send.click();
    const queue = page.getByRole("region", { name: "1 queued message", exact: true });
    await queue.waitFor({ state: "visible", timeout: 10_000 });
    const queueToggle = queue.getByRole("button", { name: /queued messages/i });
    if ((await queueToggle.getAttribute("aria-expanded")) !== "true") await queueToggle.click();
    await queue.getByText(`Follow-up from phone ${width}`, { exact: true }).waitFor();
    await stop.waitFor();
    NodeAssert.deepEqual(
      await page.evaluate(() => window.__queueFixtureForbiddenCommands),
      [],
      "The fixture must block all non-queue work that could reach a provider",
    );
    NodeAssert.equal(
      await page.evaluate(() => window.__queueFixtureQueueDispatches),
      index + 1,
      "Only queue-after-active dispatches may pass the fixture guard",
    );
    const queuedRows = persistedQueuedMessages();
    NodeAssert.equal(queuedRows.length, 1);
    NodeAssert.equal(JSON.parse(queuedRows[0].payload).text, `Follow-up from phone ${width}`);
    assertNoProviderStart();
    await queue.getByRole("button", { name: "Remove queued message", exact: true }).click();
    await queue.waitFor({ state: "hidden", timeout: 10_000 });
    NodeAssert.equal(persistedQueuedMessages().length, 0);
    NodeAssert.equal(runStatusForMessage(`Follow-up from phone ${width}`), "cancelled");
    NodeAssert.equal(
      runStatusForMessage("Deferred fixture run: no provider should start."),
      "preparing",
    );
    assertNoProviderStart();
    NodeAssert.equal(
      await page.evaluate(() => window.__queueFixtureQueueCancellations),
      index + 1,
      "Each removed queued message must be cancelled through the V2 command",
    );
    const expandAfterQueue = page.getByRole("button", { name: "Expand composer", exact: true });
    if (await expandAfterQueue.isVisible()) await expandAfterQueue.click();
    await editor.waitFor({ state: "visible" });
  }
  db.close();
}
