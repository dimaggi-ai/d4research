import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

export async function sidebarHeaderSafeArea({ page, webUrl, screenshotDir }) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const { width, height, top } of [
      { width: 1024, height: 768, top: 24 },
      { width: 820, height: 1180, top: 24 },
      { width: 1366, height: 1024, top: 20 },
      { width: 768, height: 1024, top: 24 },
      { width: 390, height: 844, top: 59 },
      { width: 1440, height: 900, top: 0 },
    ]) {
      await page.setViewportSize({ width, height });
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top, bottom: top ? 20 : 0, left: 0, right: 0 },
      });
      for (const route of ["/", "/settings/general"]) {
        await page.goto(`${webUrl}${route}`, { waitUntil: "domcontentloaded" });
        const toggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
        await toggle.waitFor();
        const mobile = width < 768;
        if (mobile) await toggle.click();
        const sidebar = page.locator(
          mobile ? '[data-sidebar="sidebar"][data-mobile="true"]' : '[data-slot="sidebar-inner"]',
        );
        await sidebar.waitFor();
        await sidebar.evaluate((element) =>
          Promise.all(
            element.getAnimations({ subtree: true }).map((animation) => animation.finished),
          ),
        );
        const header = sidebar.locator('[data-sidebar="header"]');
        const brand = header.getByRole("link", { name: "Go to threads", exact: true });
        const control = mobile
          ? header.getByRole("button", { name: "Toggle Sidebar", exact: true })
          : toggle;
        await brand.waitFor();
        const research = brand.getByText("[Research]", { exact: true });
        await research.waitFor({ state: "visible" });
        NodeAssert.equal(await brand.locator("img").getAttribute("src"), "/d4-mark.svg");
        const labelBox = await research.boundingBox();
        const logoBox = await brand.boundingBox();
        NodeAssert.ok(labelBox && logoBox);
        NodeAssert.ok(
          labelBox.y >= logoBox.y &&
            labelBox.y + labelBox.height <= logoBox.y + logoBox.height + 1 &&
            labelBox.x + labelBox.width <= logoBox.x + logoBox.width + 1,
          `[Research] is clipped in the sidebar at ${width}px`,
        );
        const controlBox = await control.boundingBox();
        const headerBox = await header.boundingBox();
        NodeAssert.ok(logoBox && controlBox && headerBox);
        NodeAssert.ok(
          logoBox.y >= top,
          `Sidebar logo overlaps status bar: ${width}px ${route}, y=${logoBox.y}`,
        );
        NodeAssert.ok(
          Math.abs(headerBox.y - top) <= 1,
          `Sidebar safe-area padding must apply exactly once: ${width}px ${route}`,
        );
        NodeAssert.ok(
          Math.abs(logoBox.y + logoBox.height / 2 - controlBox.y - controlBox.height / 2) <= 1,
          `Sidebar logo and toggle must share a header row: ${width}px ${route}`,
        );
        if (route === "/") {
          const search = sidebar.getByRole("combobox", { name: "Search threads", exact: true });
          await search.waitFor();
          const searchBox = await search.boundingBox();
          NodeAssert.ok(
            searchBox && searchBox.y - (controlBox.y + controlBox.height) >= 8,
            `Sidebar toggle must have space above Search: ${width}px`,
          );
          await search.click();
          await search.fill("sidebar reachability probe");
          NodeAssert.equal(await search.inputValue(), "sidebar reachability probe");
          const clearSearch = sidebar.getByRole("button", {
            name: "Clear thread search",
            exact: true,
          });
          await clearSearch.click();
          await clearSearch.waitFor({ state: "hidden" });
          NodeAssert.equal(await search.inputValue(), "");
        }
        await page.screenshot({
          path: NodePath.join(
            screenshotDir,
            `sidebar-header-${width}-${route === "/" ? "threads" : "settings"}.png`,
          ),
          timeout: 10000,
        });
        if (mobile) {
          await control.click();
          await sidebar.waitFor({ state: "hidden" });
        } else {
          await toggle.click();
          NodeAssert.equal(await toggle.getAttribute("aria-pressed"), "false");
          await toggle.click();
          NodeAssert.equal(await toggle.getAttribute("aria-pressed"), "true");
        }
        console.log(`PASS sidebar header ${width}×${height} inset=${top} ${route}`);
      }
    }
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
  }
}
