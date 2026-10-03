import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as sqlite from "node:sqlite";
import { createPairingUrl } from "./harness.mjs";

export async function idleAgentsAndAudio({ page, context, app, screenshotDir }) {
  // The preceding queue case creates this persisted thread without invoking a provider.
  const db = new sqlite.DatabaseSync(path.join(app.baseDir, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  const thread = db
    .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE title = ? LIMIT 1")
    .get("Mobile queue fixture");
  db.close();
  assert.ok(thread, "The queue fixture must have created a persisted thread");
  const environmentId = (
    await fs.readFile(path.join(app.baseDir, "userdata/environment-id"), "utf8")
  ).trim();
  await context.addInitScript(
    ({ threadId }) => {
      const now = new Date().toISOString();
      const runId = "artifact-run";
      const providerThreadId = "artifact-provider-thread";
      const taskRoster = (live) =>
        live
          ? ["reviewer-a", "reviewer-b"].map((taskId) => ({
              taskId,
              description: taskId,
              kind: "subagent",
            }))
          : [];
      const decorateProjection = (projection, live, deliveredAudio) => {
        const text = deliveredAudio
          ? "[Listen](apps/web/src/assets/notification-completion.mp3)"
          : "Finished the source update.";
        const messageId = deliveredAudio ? "artifact-audio-message" : "artifact-message";
        const item = {
          id: `artifact-item-${messageId}`,
          threadId,
          runId,
          nodeId: null,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId,
          text,
          streaming: false,
        };
        const tasks = taskRoster(live);
        projection.thread.activeProviderThreadId = providerThreadId;
        projection.runs = [
          {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: projection.thread.providerInstanceId,
            modelSelection: projection.thread.modelSelection,
            providerThreadId,
            userMessageId: "artifact-user-message",
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        ];
        projection.providerThreads = [
          {
            id: providerThreadId,
            driver: "codex",
            providerInstanceId: projection.thread.providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: tasks,
            contextUsage: null,
            nativeMetadata: null,
            createdAt: now,
            updatedAt: now,
          },
        ];
        projection.messages = [
          {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        ];
        projection.turnItems = [item];
        projection.visibleTurnItems = [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: threadId,
            sourceItemId: item.id,
            item,
          },
        ];
        projection.checkpoints = [
          {
            id: "artifact-checkpoint",
            threadId,
            scopeId: "artifact-checkpoint-scope",
            runId,
            nodeId: "artifact-node",
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: "refs/test/audio",
            status: "ready",
            files: ["notification-completion.mp3", "notification-input.mp3"].map((name) => ({
              path: `apps/web/src/assets/${name}`,
              kind: "added",
              additions: 0,
              deletions: 0,
            })),
            capturedAt: now,
          },
        ];
      };
      const transform = (value) => {
        if (Array.isArray(value)) return value.map(transform);
        if (!value || typeof value !== "object") return value;
        const result = Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, transform(entry)]),
        );
        const live = sessionStorage.getItem("fixture-live-agents") === "true";
        const deliveredAudio = sessionStorage.getItem("fixture-delivered-audio") === "true";
        if (
          result.id === threadId &&
          typeof result.projectId === "string" &&
          "activeRunId" in result
        ) {
          result.pendingBackgroundTasks = taskRoster(live);
        }
        if (result.projection?.thread?.id === threadId) {
          decorateProjection(result.projection, live, deliveredAudio);
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
  // Positive control: V2 pending-background work must stay visible in the composer.
  await page.evaluate(() => sessionStorage.setItem("fixture-live-agents", "true"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Waiting on 2 subagents", { exact: true }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("fixture-delivered-audio", "true"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Remove audio artifact", exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshotDir, "live-agents-delivered-audio.png") });
}
