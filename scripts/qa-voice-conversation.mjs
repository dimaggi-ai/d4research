#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { chromium } from "../apps/desktop/node_modules/playwright-core/index.mjs";

const pairUrl = NodeProcess.env.T3CODE_QA_PAIR_URL?.trim();
if (!pairUrl) throw new Error("T3CODE_QA_PAIR_URL is required");

const executableCandidates = [
  NodeProcess.env.T3CODE_QA_CHROMIUM?.trim(),
  NodePath.join(NodeOS.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  NodePath.join(NodeOS.homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"),
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => NodeFS.existsSync(candidate));
if (!executablePath) throw new Error("No Chromium executable found; set T3CODE_QA_CHROMIUM");

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ["microphone"],
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(pairUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 30_000 });
  await page.getByRole("button", { name: "Start voice conversation" }).click();
  await page.locator('[data-voice-conversation-status="listening"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("Speak naturally, then pause", { exact: true }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Stop voice conversation" }).click();
  await page.locator("[data-voice-conversation-status]").waitFor({
    state: "hidden",
    timeout: 5_000,
  });
  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join("; ")}`);
  console.log("voice-qa: PASS iPhone-sized touch control starts, reports, and stops listening");
} finally {
  await browser.close();
}
