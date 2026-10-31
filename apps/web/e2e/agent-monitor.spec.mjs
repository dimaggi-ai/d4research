import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { openProject } from "./harness.mjs";

async function savedChange(app, label, change, matches, section = "agentMonitor") {
  const directory = NodePath.join(app.baseDir, "userdata");
  let watcher;
  let timer;
  let lastValue = null;
  const saved = new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const settings = JSON.parse(
          await NodeFSP.readFile(NodePath.join(directory, "settings.json"), "utf8"),
        );
        lastValue = settings[section] ?? {};
        if (matches(lastValue)) resolve(lastValue);
      } catch {}
    };
    watcher = NodeFS.watch(directory, () => {
      void check();
    });
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: ${section} was not saved within 10s; persisted ${JSON.stringify(lastValue)}`,
          ),
        ),
      10_000,
    );
    void check();
  });
  try {
    const [, settings] = await Promise.all([change(), saved]);
    return settings;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

const chooseEnvironment = (page) =>
  page
    .getByText("Choose one environment to configure Nia.", { exact: true })
    .locator("..")
    .getByRole("button")
    .click();

export async function agentMonitorSettings({ page, app, screenshotDir }) {
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await chooseEnvironment(page);
  const enabled = page.getByRole("switch", { name: "Monitor threads", exact: true });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "false");
  await savedChange(
    app,
    "enable monitor",
    () => enabled.click(),
    (value) => value.enabled === true,
  );
  console.log("PASS monitor enable and persistence");
  await page.getByText("No threads need attention.", { exact: true }).waitFor();
  const picker = page.getByRole("button", { name: "Nia model", exact: true });
  await picker.click();
  const selected = await savedChange(
    app,
    "select agent model",
    () =>
      page
        .locator("[data-model-picker-content]")
        .getByRole("option")
        .and(page.locator(':not([aria-disabled="true"])'))
        .first()
        .click(),
    (value) => typeof value.modelSelection?.model === "string",
    "d4Agent",
  );
  NodeAssert.ok(selected.modelSelection.instanceId);
  console.log("PASS Nia model persistence");
  const agentEnabled = page.getByRole("switch", { name: "Enable Nia", exact: true });
  await savedChange(
    app,
    "enable agent chat",
    () => agentEnabled.click(),
    (value) => value.enabled === true,
    "d4Agent",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  // The project filter renders only when a project exists.
  const workspace = NodePath.join(app.baseDir, "agent-monitor-workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "# fixture\n");
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  await openProject(page, workspace);
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  const agent = sidebar.getByRole("button", { name: "Nia", exact: true });
  await agent.waitFor();
  const search = sidebar.getByRole("combobox", { name: "Search threads", exact: true });
  await search.waitFor();
  NodeAssert.ok(
    await agent.evaluate(
      (entry, searchElement) =>
        Boolean(entry.compareDocumentPosition(searchElement) & Node.DOCUMENT_POSITION_FOLLOWING),
      await search.elementHandle(),
    ),
  );
  await agent.click();
  const chat = page.getByRole("region", { name: "Nia chat", exact: true });
  await chat.waitFor();
  // The real agent-owned project has the same title as its dedicated entry.
  NodeAssert.equal(await sidebar.getByText("Nia", { exact: true }).count(), 1);
  // The accessible name gains ": <project>" while a project filter is active.
  await sidebar.getByRole("combobox", { name: /^Filter threads by project/ }).click();
  const projectSearch = page.getByRole("combobox", { name: "Search projects", exact: true });
  await projectSearch.waitFor();
  await projectSearch.fill("agent-monitor-workspace");
  await page.getByRole("option", { name: /agent-monitor-workspace/ }).waitFor();
  await projectSearch.fill("Nia");
  await page.getByText("No matching projects.", { exact: true }).waitFor();
  NodeAssert.equal(await page.getByRole("option", { name: "Nia", exact: true }).count(), 0);
  await projectSearch.press("Escape");
  for (const name of ["Initialize Git", "Add project script", "Open in Files"])
    NodeAssert.equal(await chat.getByRole("button", { name, exact: true }).count(), 0);
  for (const name of ["Nia model", "Attach files", "Start voice conversation", "Submit message"])
    await chat.getByRole("button", { name, exact: true }).waitFor();
  const composerPicker = chat.getByRole("button", { name: "Nia model", exact: true });
  const previousModelLabel = await composerPicker.innerText();
  await composerPicker.click();
  await savedChange(
    app,
    "select model in Nia composer",
    () =>
      page
        .locator("[data-model-picker-content]")
        .getByRole("option")
        .and(page.locator(':not([aria-disabled="true"]):not([aria-expanded])'))
        .nth(1)
        .click(),
    (value) =>
      typeof value.modelSelection?.model === "string" &&
      (value.modelSelection.model !== selected.modelSelection.model ||
        value.modelSelection.instanceId !== selected.modelSelection.instanceId),
    "d4Agent",
  );
  await page.waitForFunction((previous) => {
    const picker = document.querySelector(
      'section[aria-label="Nia chat"] button[aria-label="Nia model"]',
    );
    return picker instanceof HTMLButtonElement && !picker.disabled && picker.innerText !== previous;
  }, previousModelLabel);
  await page.locator("[data-model-picker-content]").waitFor({ state: "hidden" });
  const composerModelLabel = await composerPicker.innerText();
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await chat.getByRole("textbox", { name: "Message Nia", exact: true }).waitFor();
    const taskPicker = chat.getByRole("button", { name: "Nia task model", exact: true });
    const taskPickerBounds = await taskPicker.boundingBox();
    NodeAssert.ok(
      taskPickerBounds &&
        taskPickerBounds.x >= 0 &&
        taskPickerBounds.x + taskPickerBounds.width <= width,
    );
    NodeAssert.ok(taskPickerBounds.width >= 128);
    NodeAssert.ok((await taskPicker.innerText()).trim().length > 0);
    if (width === 390) {
      NodeAssert.equal((await taskPicker.innerText()).trim(), "Choose task model");
      await page.screenshot({
        path: NodePath.join(screenshotDir, "nia-composer-390-null-task.png"),
      });
    }
    await taskPicker.click();
    await page.locator("[data-model-picker-content]").waitFor();
    if (width === 390) {
      await page
        .locator("[data-model-picker-content]")
        .getByRole("option")
        .and(page.locator(':not([aria-disabled="true"]):not([aria-expanded])'))
        .first()
        .click();
      NodeAssert.notEqual((await taskPicker.innerText()).trim(), "Choose task model");
      NodeAssert.ok((await taskPicker.innerText()).trim().length > 0);
    } else {
      await page.keyboard.press("Escape");
    }
    await page.locator("[data-model-picker-content]").waitFor({ state: "hidden" });
    const attachBounds = await chat
      .getByRole("button", { name: "Attach files", exact: true })
      .boundingBox();
    NodeAssert.ok(
      attachBounds && attachBounds.x >= 0 && attachBounds.x + attachBounds.width <= width,
    );
    await page.screenshot({ path: NodePath.join(screenshotDir, `nia-composer-${width}.png`) });
    await chat.getByRole("button", { name: "Open routines", exact: true }).click();
    const routines = page.getByRole("dialog").filter({ hasText: "Scheduled jobs" });
    await routines.waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: NodePath.join(screenshotDir, `nia-routines-${width}.png`) });
    await routines.getByRole("button", { name: "Close", exact: true }).click();
    await routines.waitFor({ state: "hidden" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log(
    "PASS real Sidebar pins Nia above Search, hides its project, and opens the dedicated route",
  );
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await chooseEnvironment(page);
  await picker.waitFor();
  NodeAssert.equal(await picker.innerText(), composerModelLabel);
  await picker.click();
  await savedChange(
    app,
    "restore Nia model from Settings",
    () =>
      page
        .locator("[data-model-picker-content]")
        .getByRole("option")
        .and(page.locator(':not([aria-disabled="true"])'))
        .first()
        .click(),
    (value) =>
      value.modelSelection?.model === selected.modelSelection.model &&
      value.modelSelection?.instanceId === selected.modelSelection.instanceId,
    "d4Agent",
  );
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  await agent.click();
  await composerPicker.waitFor();
  NodeAssert.equal(await composerPicker.innerText(), previousModelLabel);
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await chooseEnvironment(page);
  await agentEnabled.waitFor();
  const probes = page.getByRole("switch", { name: "Agent system probes", exact: true });
  await savedChange(
    app,
    "enable system probes",
    () => probes.click(),
    (value) => value.systemProbeEnabled === true,
    "d4Agent",
  );
  console.log("PASS Nia enable and system probe persistence");
  const notifications = page.getByRole("switch", {
    name: "Monitor attention notifications",
    exact: true,
  });
  await savedChange(
    app,
    "enable monitor notifications",
    () => notifications.click(),
    (value) => value.notificationsEnabled === true,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "true");
  NodeAssert.equal(await notifications.getAttribute("aria-checked"), "true");
  NodeAssert.equal(await agentEnabled.getAttribute("aria-checked"), "true");
  NodeAssert.equal(await probes.getAttribute("aria-checked"), "true");
  NodeAssert.notEqual(await picker.innerText(), "Choose model");
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.scrollIntoViewIfNeeded();
  const box = await picker.boundingBox();
  NodeAssert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: NodePath.join(screenshotDir, "monitor-mobile.png") });
  await savedChange(
    app,
    "clear agent model",
    () =>
      page.locator("#agent-monitor").getByRole("button", { name: "Clear", exact: true }).click(),
    (value) => (value.modelSelection ?? null) === null,
    "d4Agent",
  );
  await savedChange(
    app,
    "disable monitor notifications",
    () => notifications.click(),
    (value) => (value.notificationsEnabled ?? false) === false,
  );
  // Server persistence omits values equal to defaults; reload checks their effective values.
  await savedChange(
    app,
    "disable system probes",
    () => probes.click(),
    (value) => (value.systemProbeEnabled ?? false) === false,
    "d4Agent",
  );
  await savedChange(
    app,
    "disable agent chat",
    () => agentEnabled.click(),
    (value) => (value.enabled ?? false) === false,
    "d4Agent",
  );
  await savedChange(
    app,
    "disable monitor",
    () => enabled.click(),
    (value) => (value.enabled ?? false) === false,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await notifications.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await agentEnabled.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await probes.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await picker.innerText(), "Choose model");
  NodeAssert.equal(
    await page.locator('[data-slot="sidebar-inner"]').getByRole("button", { name: "Nia" }).count(),
    0,
  );
  console.log("PASS monitor and Nia disable persistence after reload");
}
