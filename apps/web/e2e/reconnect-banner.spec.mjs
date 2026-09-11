import * as assert from "node:assert/strict";
import * as path from "node:path";
import { createPairingUrl, openProject } from "./harness.mjs";

export async function reconnectBanner({ page, context, app, screenshotDir }) {
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__reconnectTestSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__reconnectTestSockets.push(this);
      }
    };
  });
  await page.goto(createPairingUrl(app, "reconnect-banner"), {
    waitUntil: "domcontentloaded",
  });
  await openProject(page, app.baseDir);
  const connections = page.getByRole("button", { name: "Connections", exact: true });
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
      await context.setOffline(true);
      await page.evaluate(() => {
        for (const socket of window.__reconnectTestSockets) socket.close();
      });
      await connections.first().waitFor({ state: "visible" });
      assert.equal(await connections.count(), 1, "Only one reconnect banner owns Connections");
      assert.equal(
        await page.getByRole("button", { name: /^Reconnect(?:ing\.\.\.)?$/ }).count(),
        1,
        "Only one reconnect action is rendered",
      );
      await page.screenshot({ path: path.join(screenshotDir, `reconnect-${width}.png`) });
      await context.setOffline(false);
      await connections.waitFor({ state: "hidden", timeout: 30000 });
    }
  } finally {
    await context.setOffline(false);
  }
}
