import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

export async function mobileSidebarReachability({ page, webUrl, screenshotDir }) {
  const originalViewport = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
    });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
      { width: 744, height: 390 },
      { width: 390, height: 260 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [name, destination] of [
        ["Settings", "/settings/general"],
        ["Usage", "/usage"],
        ["System Monitor", "/system"],
      ]) {
        await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).click();
        const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
        await drawer.waitFor({ state: "visible" });
        await drawer.evaluate((element) =>
          Promise.all(element.getAnimations().map((animation) => animation.finished)),
        );
        const button = drawer.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        NodeAssert.ok(
          box && box.y >= 0 && box.y + box.height <= viewport.height,
          `${name} must be reachable at ${viewport.width}×${viewport.height}`,
        );
        if (screenshotDir && name === "Settings") {
          await page.screenshot({
            path: NodePath.join(screenshotDir, `sidebar-${viewport.width}x${viewport.height}.png`),
            timeout: 10000,
          });
        }
        await button.click({ timeout: 5000 });
        await page.waitForURL((url) => url.pathname === destination, {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
        await drawer.waitFor({ state: "hidden", timeout: 10000 });
        console.log(`PASS sidebar ${name}: ${viewport.width}×${viewport.height}`);
      }
    }
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  }
}

export async function mobileStatusBarReachability({ page, webUrl, screenshotDir }) {
  const originalViewport = page.viewportSize();
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
    });
    for (const route of ["/", "/settings/general", "/usage", "/system"]) {
      await page.goto(`${webUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      const toggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
      await toggle.waitFor({ state: "visible" });
      const box = await toggle.boundingBox();
      NodeAssert.ok(
        box && box.y >= 59,
        `Sidebar toggle overlaps status bar on ${route}: y=${box?.y}`,
      );
      await toggle.click({ timeout: 5000 });
      const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
      await drawer.waitFor({ state: "visible" });
      await drawer.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const close = drawer.getByRole("button", { name: "Toggle Sidebar", exact: true });
      await close.waitFor({ state: "visible" });
      const closeBox = await close.boundingBox();
      NodeAssert.ok(closeBox && closeBox.y >= 59, `Drawer close overlaps status bar on ${route}`);
      if (screenshotDir && route === "/") {
        await page.screenshot({
          path: NodePath.join(screenshotDir, "sidebar-status-bar.png"),
          timeout: 10000,
        });
      }
      await close.click({ timeout: 5000 });
      await drawer.waitFor({ state: "hidden" });
      console.log(
        `PASS status-bar sidebar open/close: ${route} (toggle y=${box.y}, close y=${closeBox.y})`,
      );
    }
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const rightToggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
    await rightToggle.waitFor({ state: "visible", timeout: 20000 });
    const rightBox = await rightToggle.boundingBox();
    NodeAssert.ok(rightBox && rightBox.y >= 59, "Right-panel toggle overlaps status bar");
    await rightToggle.click({ timeout: 5000 });
    const tabbar = page.locator("[data-right-panel-tabbar]");
    await tabbar.waitFor({ state: "visible", timeout: 10000 });
    const tabbarBox = await tabbar.boundingBox();
    NodeAssert.ok(
      tabbarBox && tabbarBox.y >= 59,
      `Right-panel tab bar overlaps status bar: y=${tabbarBox?.y}`,
    );
    if (screenshotDir) {
      await page.screenshot({
        path: NodePath.join(screenshotDir, "right-panel-status-bar.png"),
        timeout: 10000,
      });
    }
    await page.setViewportSize({ width: 744, height: 390 });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, bottom: 21, left: 59, right: 59 },
    });
    const landscapeClose = tabbar.getByRole("button", { name: "Toggle right panel", exact: true });
    const landscapeBox = await landscapeClose.boundingBox();
    NodeAssert.ok(
      landscapeBox && landscapeBox.x >= 59 && landscapeBox.x + landscapeBox.width <= 744 - 59,
      "Right-panel close must clear landscape safe areas after rotation",
    );
    await landscapeClose.click({ timeout: 5000 });
    await tabbar.waitFor({ state: "hidden", timeout: 10000 });
    console.log("PASS status-bar right-panel open/close and landscape rotation");
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const desktopToggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
    await desktopToggle.waitFor({ state: "visible" });
    const desktopBox = await desktopToggle.boundingBox();
    NodeAssert.ok(
      desktopBox && desktopBox.y >= 0 && desktopBox.y < 52,
      "Desktop controls must remain in the titlebar when there is no status-bar inset",
    );
    console.log("PASS desktop controls have no extra status-bar gap");
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
}
