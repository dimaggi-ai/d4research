import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export async function onboardingBranding({ page, webUrl, screenshotDir }) {
  await page.goto(`${webUrl}/welcome`, { waitUntil: "domcontentloaded" });
  await page.getByRole("dialog", { name: "Set up d4research", exact: true }).waitFor();
  const identity = page.getByRole("img", { name: "d4research", exact: true });
  await identity.waitFor();
  assert.equal(await identity.locator("svg image").getAttribute("href"), "/d4-mark.svg");
  await identity.getByText("[Research]", { exact: true }).waitFor();
  assert.equal(await page.getByText("Set up T3 Code", { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(screenshotDir, "onboarding-d4-branding.png") });
}

export async function branding({ page, webUrl, screenshotDir }) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(webUrl, { waitUntil: "commit" });
    await page.locator("#boot-shell-logo").waitFor();
    await page.waitForFunction(() => document.querySelector("#boot-shell-logo")?.naturalWidth > 0);
    assert.equal(await page.title(), "d4[Research]");
    await page.locator("#boot-shell-card").getByText("[Research]", { exact: true }).waitFor();
    assert.equal(await page.locator("#boot-shell-logo").getAttribute("src"), "/d4-mark.svg");
    await page.screenshot({
      path: path.join(screenshotDir, "branding-loading.png"),
      timeout: 10000,
    });
    for (const name of ["d4-mark.svg", "favicon.ico", "apple-touch-icon.png"]) {
      const response = await page.request.get(`${webUrl}/${name}`);
      assert.equal(response.status(), 200);
      assert.deepEqual(
        await response.body(),
        await readFile(new URL(`../public/${name}`, import.meta.url)),
      );
    }
    const manifest = await (await page.request.get(`${webUrl}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, "d4[Research]");
    assert.equal(manifest.short_name, "d4[Research]");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
}
