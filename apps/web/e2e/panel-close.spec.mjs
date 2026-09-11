import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

export async function panelCloseReachability({ page, webUrl, screenshotDir }) {
  const originalViewport = page.viewportSize();
  try {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      const right = page.getByRole("button", { name: "Toggle right panel", exact: true });
      await right.click({ timeout: 20000 });
      const header = page.locator("[data-right-panel-tabbar]");
      await header.waitFor({ state: "visible" });
      const close = header.getByRole("button", { name: "Toggle right panel", exact: true });
      await close.waitFor({ state: "visible", timeout: 5000 });
      NodeAssert.equal(
        await right.count(),
        1,
        `An open panel must have one visible toggle, without a duplicate in the chat at width ${width}`,
      );
      const box = await close.boundingBox();
      NodeAssert.ok(
        box && box.y >= 0 && box.y + box.height <= 52 && box.x + box.width <= width,
        `Right panel close must be in the visible top bar at width ${width}`,
      );
      if (width >= 1024) {
        await header.getByRole("button", { name: "Maximize panel", exact: true }).click();
        await header.getByRole("button", { name: "Restore panel size", exact: true }).waitFor();
        await close.click();
        await header.waitFor({ state: "hidden" });
        await right.click();
        await header
          .getByRole("button", { name: "Maximize panel", exact: true })
          .waitFor({ timeout: 5000 });
      }
      if (screenshotDir) {
        await close.waitFor({ state: "visible" });
        await page.screenshot({
          path: NodePath.join(screenshotDir, `panel-close-${width}.png`),
          timeout: 10000,
        });
      }
      await close.click({ timeout: 5000 });
      await header.waitFor({ state: "hidden", timeout: 5000 });
      const left = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
      if (width >= 768) {
        await left.click();
        NodeAssert.equal(await left.getAttribute("aria-pressed"), "false");
        await left.click();
        NodeAssert.equal(await left.getAttribute("aria-pressed"), "true");
      } else {
        await left.click();
        const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
        await drawer.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
        await drawer.waitFor({ state: "hidden" });
      }
      console.log(`PASS left/right panel close, width ${width}`);
    }
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
