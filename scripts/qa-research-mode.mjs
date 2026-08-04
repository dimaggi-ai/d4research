#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "../apps/desktop/node_modules/playwright-core/index.mjs";

const baseUrl = process.env.T3CODE_QA_URL?.trim();
const storageStatePath = process.env.T3CODE_QA_STORAGE_STATE?.trim();
if (!baseUrl || !storageStatePath || !fs.existsSync(storageStatePath)) {
  throw new Error("T3CODE_QA_URL and an existing T3CODE_QA_STORAGE_STATE are required");
}

const executableCandidates = [
  process.env.T3CODE_QA_CHROMIUM?.trim(),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"),
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error("No Chromium executable found; set T3CODE_QA_CHROMIUM");

const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({ storageState: storageStatePath });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.getByRole("button", { name: "Start deep research" }).click();
  await page
    .locator('[data-testid="composer-editor"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="composer-editor"]')
          ?.textContent?.includes("#deep-research"),
      undefined,
      { timeout: 5_000 },
    );
  } catch (error) {
    const diagnostic = await page
      .locator('[data-testid="composer-editor"]')
      .evaluateAll((editors) =>
        editors.map((editor) => ({ html: editor.innerHTML, text: editor.textContent })),
      );
    throw new Error(
      `Research composer did not update at ${page.url()}: ${JSON.stringify(diagnostic)}`,
      {
        cause: error,
      },
    );
  }
  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join("; ")}`);
  console.log("research-qa: PASS control inserts #deep-research into the current chat composer");
} finally {
  await browser.close();
}
