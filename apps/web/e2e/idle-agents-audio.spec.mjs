import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as sqlite from "node:sqlite";
import { createPairingUrl } from "./harness.mjs";

export async function idleAgentsAndAudio({ page, context, app, screenshotDir }) {
  // The preceding queue case creates this persisted thread without invoking a provider.
  const db = new sqlite.DatabaseSync(path.join(app.baseDir, "userdata/state.sqlite"), {
    readOnly: true,
  });
  const thread = db
    .prepare("SELECT thread_id FROM projection_threads WHERE title = ? LIMIT 1")
    .get("Mobile queue fixture");
  db.close();
  assert.ok(thread, "The queue fixture must have created a persisted thread");
  const environmentId = (
    await fs.readFile(path.join(app.baseDir, "userdata/environment-id"), "utf8")
  ).trim();
  await context.addInitScript(
    ({ threadId }) => {
      const now = new Date().toISOString();
      const transform = (value) => {
        if (Array.isArray(value)) return value.map(transform);
        if (!value || typeof value !== "object") return value;
        const result = Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, transform(entry)]),
        );
        if (result.id !== threadId || !result.projectId) return result;
        const live = sessionStorage.getItem("fixture-live-agents") === "true";
        const deliveredAudio = sessionStorage.getItem("fixture-delivered-audio") === "true";
        const messageId = deliveredAudio ? "artifact-audio-message" : "artifact-message";
        result.updatedAt = now;
        result.backgroundLiveness = live ? "working" : null;
        result.session = {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        };
        result.latestTurn = {
          turnId: "artifact-turn",
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: messageId,
        };
        if (Array.isArray(result.messages)) {
          result.messages = [
            {
              id: messageId,
              role: "assistant",
              text: deliveredAudio
                ? "[Listen](apps/web/src/assets/notification-completion.mp3)"
                : "Finished the source update.",
              turnId: "artifact-turn",
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ];
          result.activities = ["reviewer-a", "reviewer-b"].map((taskId, sequence) => ({
            id: `activity-${taskId}`,
            kind: "task.updated",
            tone: "info",
            summary: "Task running",
            payload: {
              taskId,
              status: "running",
              title: taskId,
              agentKind: "agent",
              timelineBypass: true,
            },
            turnId: "artifact-turn",
            sequence,
            createdAt: now,
          }));
          result.checkpoints = [
            {
              turnId: "artifact-turn",
              checkpointTurnCount: 1,
              checkpointRef: "refs/test/audio",
              status: "ready",
              assistantMessageId: messageId,
              completedAt: now,
              files: ["notification-completion.mp3", "notification-input.mp3"].map((name) => ({
                path: `apps/web/src/assets/${name}`,
                kind: "added",
                additions: 0,
                deletions: 0,
              })),
            },
          ];
        }
        return result;
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (!response.headers.get("content-type")?.includes("application/json")) return response;
        return new Response(JSON.stringify(transform(await response.clone().json())), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        send(message) {
          const packet = JSON.parse(String(message));
          if (packet.payload?.threadId === threadId && "afterSequence" in packet.payload) {
            // Fixture mode changes are not persisted server events. Request a
            // full snapshot instead of resuming the unchanged real event cursor.
            delete packet.payload.afterSequence;
          }
          super.send(JSON.stringify(packet));
        }
        constructor(...args) {
          super(...args);
          const transformed = new WeakSet();
          this.addEventListener("message", (event) => {
            if (transformed.has(event)) return;
            const next = new MessageEvent("message", {
              data: JSON.stringify(transform(JSON.parse(event.data))),
              origin: event.origin,
            });
            transformed.add(next);
            event.stopImmediatePropagation();
            this.dispatchEvent(next);
          });
        }
      };
    },
    { threadId: thread.thread_id },
  );
  await page.goto(createPairingUrl(app, "idle-agents-audio"), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  await page.goto(`${app.webUrl}/${environmentId}/${thread.thread_id}`, {
    waitUntil: "domcontentloaded",
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByText("Finished the source update.", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Remove audio artifact", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: /Toggle right panel, .*agents working/ }).count(),
      0,
    );
    assert.equal(await page.getByText(/agents working in the background/).count(), 0);
    await page.screenshot({ path: path.join(screenshotDir, `idle-agents-no-audio-${width}.png`) });
  }
  // Positive control: the same roster must stay visible when the server reports live work.
  await page.evaluate(() => sessionStorage.setItem("fixture-live-agents", "true"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("2 agents working in the background", { exact: true }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("fixture-delivered-audio", "true"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Remove audio artifact", exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshotDir, "live-agents-delivered-audio.png") });
}
