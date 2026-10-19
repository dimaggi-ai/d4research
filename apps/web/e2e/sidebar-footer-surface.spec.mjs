import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

export async function sidebarFooterSurface({ page, webUrl, screenshotDir }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 24, bottom: 20, left: 0, right: 0 },
  });
  try {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => localStorage.setItem("t3code:theme", value), theme);
      for (const width of [1440, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(webUrl, { waitUntil: "domcontentloaded" });
        if (width < 768) {
          await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).click();
        }
        const footer = page.locator('[data-slot="sidebar-footer"]:visible');
        await footer.waitFor();
        const metrics = await footer.evaluate((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--sidebar-control-surface)";
          probe.style.color = "var(--contrast-sidebar-foreground)";
          element.appendChild(probe);
          const expected = getComputedStyle(probe);
          const result = {
            width: box.width,
            bottom: box.bottom,
            viewportHeight: window.innerHeight,
            bottomPadding: parseFloat(style.paddingBottom),
            parentWidth: parent.width,
            background: style.backgroundColor,
            expectedBackground: expected.backgroundColor,
            expectedText: expected.color,
            border: style.borderTopWidth,
            buttons: [...element.querySelectorAll('[data-sidebar="menu-button"]')].map(
              (button) => ({
                width: button.getBoundingClientRect().width,
                color: getComputedStyle(button).color,
              }),
            ),
          };
          probe.remove();
          return result;
        });
        NodeAssert.ok(
          Math.abs(metrics.width - metrics.parentWidth) <= 2,
          "Footer fills sidebar width",
        );
        NodeAssert.ok(
          Math.abs(metrics.bottom - metrics.viewportHeight) <= 1,
          "Footer surface reaches the viewport bottom without a safe-area gap",
        );
        NodeAssert.ok(
          metrics.bottomPadding >= 20,
          "Footer controls stay above the home-indicator safe area",
        );
        NodeAssert.equal(
          metrics.background,
          metrics.expectedBackground,
          "Footer uses the shared raised surface",
        );
        NodeAssert.notEqual(metrics.background, "rgba(0, 0, 0, 0)");
        NodeAssert.equal(metrics.border, "1px", "Footer has a subtle top separator");
        NodeAssert.ok(metrics.buttons.length >= 3);
        for (const button of metrics.buttons) {
          NodeAssert.equal(button.width, metrics.width - 16, "Footer actions fill the padded row");
          NodeAssert.equal(
            button.color,
            metrics.expectedText,
            "Footer actions retain full text contrast",
          );
        }
        await page.screenshot({
          path: NodePath.join(screenshotDir, `footer-surface-${theme}-${width}.png`),
        });
        await footer.getByRole("button", { name: "Settings", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/settings/general");
      }
    }
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
  }
}
