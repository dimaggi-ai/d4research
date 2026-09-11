import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { openProject } from "./harness.mjs";

export async function composerSurfaceOcclusion({ page, app, screenshotDir }) {
  await openProject(page, app.baseDir);
  const form = page.locator('[data-chat-composer-form="true"]');
  await form.waitFor();
  await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle("dark", value === "dark");
        document.documentElement.classList.toggle("light", value === "light");
      }, theme);
      // Synthetic history sits behind the real rendered surface, without invoking a provider.
      await form.evaluate((element) => {
        const shell = element.parentElement.parentElement.parentElement;
        shell.style.isolation = "isolate";
        shell.style.position = "relative";
        const probe = document.createElement("div");
        probe.dataset.occlusionProbe = "true";
        probe.style.cssText = "position:absolute;inset:0;z-index:-1;pointer-events:none";
        shell.prepend(probe);
      });
      const box = await form.boundingBox();
      NodeAssert.ok(box && box.width > 100 && box.height > 40);
      const clip = {
        x: Math.ceil(box.x + box.width / 2),
        y: Math.ceil(box.y + 8),
        width: 16,
        height: 8,
      };
      const capture = async (color) => {
        await page.locator("[data-occlusion-probe]").evaluate((el, value) => {
          el.style.background = value;
        }, color);
        return page.screenshot({ clip, animations: "disabled", timeout: 10000 });
      };
      const red = await capture("rgb(255,0,0)");
      const blue = await capture("rgb(0,0,255)");
      NodeAssert.ok(red.equals(blue), `History bleeds through composer at ${width}px, ${theme}`);
      // Positive control: ensure the probe really reaches these pixels when the surface is removed.
      const control = await page.addStyleTag({
        content:
          '[data-slot="composer-shell"]::before { display:none!important } [data-chat-composer-form] { visibility:hidden!important }',
      });
      const uncoveredRed = await capture("rgb(255,0,0)");
      const uncoveredBlue = await capture("rgb(0,0,255)");
      NodeAssert.ok(
        !uncoveredRed.equals(uncoveredBlue),
        "Occlusion probe must be visible without the composer surface",
      );
      await control.evaluate((el) => el.remove());
      await page.locator("[data-occlusion-probe]").evaluate((el) => el.remove());
      await page.screenshot({
        path: NodePath.join(screenshotDir, `composer-${width}-${theme}.png`),
        animations: "disabled",
        timeout: 10000,
      });
      console.log(`PASS opaque composer ${width}px ${theme}`);
    }
  }
}
