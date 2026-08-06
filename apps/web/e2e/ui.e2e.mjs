// Browser coverage for the surfaces d2research adds on top of upstream t3code.
// Unit tests already cover their logic; these assert the wiring a user actually
// touches — routes render, data reaches the DOM, and nothing throws in console.
import * as NodeAssert from "node:assert/strict";

import {
  openProject,
  openAuthenticatedPage,
  startIsolatedApp,
  stopIsolatedApp,
} from "./harness.mjs";

const specs = [];
const spec = (name, run) => specs.push({ name, run });

spec("app shell pairs and renders d2research branding", async ({ page }) => {
  NodeAssert.equal(await page.locator('[aria-label="d2research"]').count(), 1);
  NodeAssert.ok((await page.getByRole("button").allTextContents()).length > 3);
});

spec("manifest is requested with credentials", async ({ page }) => {
  const crossorigin = await page.evaluate(() =>
    document.querySelector('link[rel="manifest"]')?.getAttribute("crossorigin"),
  );
  NodeAssert.equal(crossorigin, "use-credentials");
});

spec("tool guard settings lists policy rules", async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/settings/tool-guard`, { waitUntil: "domcontentloaded" });
  await page.getByText("Policy Rules").waitFor({ timeout: 20_000 });
  const body = await page.locator("body").innerText();
  NodeAssert.ok(body.includes("Tool Guard"), "expected the Tool Guard section");
  const ruleIds = body.match(/deny-|review-/g) ?? [];
  NodeAssert.ok(ruleIds.length >= 5, `expected bundled rules, saw ${ruleIds.length}`);
});

spec("general settings expose handoff and auto-resume controls", async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await page.getByText("Context compression").waitFor({ timeout: 20_000 });
  const body = await page.locator("body").innerText();
  NodeAssert.ok(body.includes("Resume after usage limits"), "expected the auto-resume toggle");
  NodeAssert.ok(body.includes("Open Tool Guard settings"), "expected the Tool Guard deep link");
});

spec("settings search reaches the tool guard page", async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: /search settings/i }).fill("tool guard");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/settings\/tool-guard/, { timeout: 15_000 });
});

spec("model picker hides malformed model slugs", async ({ page, webUrl, workspace }) => {
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await openProject(page, workspace);
  await page
    .locator("button")
    .filter({ hasText: /GPT|Claude|Gemini|Default/i })
    .last()
    .click();
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  NodeAssert.ok(!body.includes("Fetching available models"), "spinner text leaked into the picker");
  NodeAssert.ok(!/[⠀-⣿]/.test(body), "braille spinner frames leaked into the picker");
  await page.keyboard.press("Escape");
  // An open popover marks the rest of the page inert, which would hide header
  // controls from later specs' accessibility-role queries.
  await page.waitForTimeout(500);
});

spec("system panel renders monitors for the active thread", async ({ page, webUrl, workspace }) => {
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject(page, workspace);
  // The control is labelled "Open local tools"; "Monitor" is only its visible text.
  await page
    .getByRole("button", { name: /open local tools/i })
    .first()
    .click();
  await page.getByRole("menuitem").first().click();
  await page.waitForTimeout(2500);
  const body = await page.locator("body").innerText();
  NodeAssert.ok(
    /Per-turn token usage|Tool Guard|CPU|Memory/i.test(body),
    "expected the system panel monitors",
  );
});

async function main() {
  const app = await startIsolatedApp();
  let session;
  const failures = [];
  try {
    session = await openAuthenticatedPage(app);
    for (const { name, run } of specs) {
      try {
        await run({ ...session, webUrl: app.webUrl, workspace: app.workspace });
        console.log(`PASS ${name}`);
      } catch (cause) {
        failures.push(name);
        console.error(`FAIL ${name}\n  ${cause instanceof Error ? cause.message : cause}`);
      }
    }
    const unexpected = session.consoleErrors.filter(
      (message) => !/favicon|manifest|401|WebSocket/i.test(message),
    );
    if (unexpected.length > 0) {
      failures.push("console clean");
      console.error(`FAIL console clean\n  ${unexpected.slice(0, 3).join("\n  ")}`);
    } else {
      console.log("PASS console clean");
    }
  } finally {
    await session?.browser.close().catch(() => {});
    await stopIsolatedApp(app);
  }

  console.log(`\n${specs.length + 1 - failures.length}/${specs.length + 1} passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
