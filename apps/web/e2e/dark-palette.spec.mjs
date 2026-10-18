import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { openProject } from "./harness.mjs";

export async function darkPalette({ page, app, screenshotDir }) {
  await page.evaluate(() => localStorage.setItem("t3code:theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject(page, app.baseDir);
  const send = page.getByRole("button", { name: "Submit message", exact: true });
  await send.waitFor();
  const canvasColor = () =>
    send.evaluate((el) => getComputedStyle(el.closest(".bg-background")).backgroundColor);
  NodeAssert.equal(await canvasColor(), "rgb(18, 19, 23)");
  NodeAssert.equal(
    await page
      .locator('[data-slot="sidebar-inner"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(22, 23, 27)",
  );
  NodeAssert.equal(
    await send.evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 152, 46)",
  );
  NodeAssert.equal(await send.evaluate((el) => getComputedStyle(el).color), "rgb(10, 16, 49)");
  // Keep this as a local draft: show the enabled accent without invoking a provider.
  await page.getByTestId("composer-editor").fill("Compare compute scheduling strategies");
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Submit message"]')?.disabled,
  );
  for (const [width, height] of [
    [1440, 900],
    [820, 1180],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: NodePath.join(screenshotDir, `dark-palette-${width}.png`),
      animations: "disabled",
    });
  }
  // Compare the same expanded desktop surface after the theme switch; on
  // phones a reload restores the collapsed composer with a different action.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("t3code:theme", "light"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await send.waitFor();
  NodeAssert.equal(await canvasColor(), "oklch(0.992 0 0)");
  NodeAssert.notEqual(
    await send.evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(255, 152, 46)",
  );
}
