#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "../apps/desktop/node_modules/playwright-core/index.mjs";

const pairUrl = process.env.T3CODE_QA_PAIR_URL?.trim();
const storageStatePath = process.env.T3CODE_QA_STORAGE_STATE?.trim();
if (!pairUrl && !storageStatePath) {
  throw new Error("T3CODE_QA_PAIR_URL or T3CODE_QA_STORAGE_STATE is required");
}

const baseUrl =
  process.env.T3CODE_QA_URL?.trim() || (pairUrl ? new URL(pairUrl).origin : undefined);
if (!baseUrl) throw new Error("T3CODE_QA_URL is required when reusing browser storage state");
const executableCandidates = [
  process.env.T3CODE_QA_CHROMIUM?.trim(),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"),
].filter(Boolean);
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) {
  throw new Error("No Chromium executable found; set T3CODE_QA_CHROMIUM");
}

const SETTINGS_SCREENS = [
  ["General", "/settings/general"],
  ["Appearance", "/settings/appearance"],
  ["Keybindings", "/settings/keybindings"],
  ["Providers", "/settings/providers"],
  ["Source Control", "/settings/source-control"],
  ["Connections", "/settings/connections"],
  ["Beta", "/settings/beta"],
  ["Archive", "/settings/archived"],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForAttribute(locator, name, predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await locator.getAttribute(name);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function clickAndWaitForPath(page, label, pathname) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForURL((url) => url.pathname === pathname, { timeout: 10_000 });
  assert((await page.locator("body").innerText()).trim().length > 0, `${pathname} rendered empty`);
  console.log(`web-qa: PASS navigation ${pathname}`);
}

const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({
  ...(storageStatePath && fs.existsSync(storageStatePath)
    ? { storageState: storageStatePath }
    : {}),
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  if (pairUrl) {
    await page.goto(pairUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 30_000 });
    if (storageStatePath) await context.storageState({ path: storageStatePath });
    console.log("web-qa: PASS paired isolated browser");
  } else {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    console.log("web-qa: PASS reused authenticated browser state");
  }

  await page.goto(`${baseUrl}/settings/general`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  for (const [label, pathname] of SETTINGS_SCREENS) {
    await page.goto(`${baseUrl}/settings/general`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await clickAndWaitForPath(page, label, pathname);
  }

  await page.goto(`${baseUrl}/settings/providers`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  const detailsButton = page.getByRole("button", { name: /^Show .* details$/ }).first();
  const detailsLabel = await detailsButton.getAttribute("aria-label");
  const providerName = detailsLabel?.match(/^Show (.*) details$/)?.[1];
  assert(providerName, "provider details button has no provider name");
  await detailsButton.click();
  const hideDetailsButton = page.getByRole("button", {
    name: `Hide ${providerName} details`,
    exact: true,
  });
  await hideDetailsButton.waitFor({ timeout: 5_000 });
  assert(
    (await hideDetailsButton.getAttribute("aria-expanded")) === "true",
    "provider did not expand",
  );
  await hideDetailsButton.click();
  await page
    .getByRole("button", { name: `Show ${providerName} details`, exact: true })
    .waitFor({ timeout: 5_000 });
  console.log("web-qa: PASS provider details collapse/expand");

  const providerSwitch = page.getByRole("switch", { name: /^Enable / }).first();
  const originalProviderState = await waitForAttribute(
    providerSwitch,
    "aria-checked",
    (value) => value === "true" || value === "false",
  );
  await providerSwitch.click();
  const changedProviderState = await waitForAttribute(
    providerSwitch,
    "aria-checked",
    (value) => value !== originalProviderState,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  const persistedProviderSwitch = page.getByRole("switch", { name: /^Enable / }).first();
  await waitForAttribute(
    persistedProviderSwitch,
    "aria-checked",
    (value) => value === changedProviderState,
  );
  await persistedProviderSwitch.click();
  await waitForAttribute(
    persistedProviderSwitch,
    "aria-checked",
    (value) => value === originalProviderState,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await waitForAttribute(
    page.getByRole("switch", { name: /^Enable / }).first(),
    "aria-checked",
    (value) => value === originalProviderState,
  );
  console.log("web-qa: PASS provider setting persisted and restored");

  await page.getByRole("button", { name: "Add provider instance" }).click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 });
  await page.getByRole("button", { name: "Refresh provider status" }).click();
  console.log("web-qa: PASS provider add dialog and refresh controls");

  await page.goto(`${baseUrl}/settings/general`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  const preferredOpener = page.getByRole("combobox", { name: "Preferred project opener" });
  await preferredOpener.click();
  await page.getByRole("option", { name: /^(Files|Finder|Explorer)$/ }).click();
  console.log("web-qa: PASS preferred opener menu in Settings");

  await page.getByRole("link", { name: "Go to threads" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/settings"), { timeout: 10_000 });

  await page.getByRole("button", { name: "Start deep research" }).click();
  const composerEditor = page.locator('[data-testid="composer-editor"]');
  await composerEditor.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="composer-editor"]')
        ?.textContent?.includes("#deep-research"),
    undefined,
    { timeout: 5_000 },
  );
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  console.log("web-qa: PASS research control targets the current chat composer");

  const monitorRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/system-monitor") {
      monitorRequests.push(Date.now());
    }
  });
  await page.getByRole("button", { name: "Open system monitor" }).click();
  await page.getByText("Mission Control", { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(4_250);
  assert(
    monitorRequests.length >= 3,
    `monitor polled ${monitorRequests.length} times, expected >= 3`,
  );
  await page.getByRole("button", { name: "Close system monitor" }).click();
  await page.getByRole("button", { name: "Open system monitor" }).click();
  await page.getByText("Mission Control", { exact: false }).first().waitFor({ timeout: 10_000 });
  console.log("web-qa: PASS monitor collapse/restore and 2-second polling");

  await page.getByRole("button", { name: "Open project with preferred app" }).click();
  await page.getByText("Files", { exact: true }).first().waitFor({ timeout: 10_000 });
  console.log("web-qa: PASS single Open button uses Settings preference");

  assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join("; ")}`);
  console.log("web-qa: PASS all screens, safe buttons, and navigation");
} finally {
  await browser.close();
}
