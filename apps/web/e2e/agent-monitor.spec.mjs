import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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

export async function agentMonitorSettings({ page, app, screenshotDir }) {
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await page
    .getByText("Choose one environment to configure d4 Agent.", { exact: true })
    .locator("..")
    .getByRole("button")
    .click();
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
  const picker = page.getByRole("button", { name: "d4 Agent model", exact: true });
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
  console.log("PASS d4 Agent model persistence");
  const agentEnabled = page.getByRole("switch", { name: "Enable d4 Agent", exact: true });
  await savedChange(
    app,
    "enable agent chat",
    () => agentEnabled.click(),
    (value) => value.enabled === true,
    "d4Agent",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  const sidebar = page.locator('[data-slot="sidebar-inner"]');
  const agent = sidebar.getByRole("button", { name: "d4 Agent", exact: true });
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
  const chat = page.getByRole("region", { name: "d4 Agent chat", exact: true });
  await chat.waitFor();
  // The real agent-owned project has the same title as its dedicated entry.
  NodeAssert.equal(await sidebar.getByText("d4 Agent", { exact: true }).count(), 1);
  await sidebar.getByRole("combobox", { name: "Filter threads by project", exact: true }).click();
  const projectSearch = page.getByRole("combobox", { name: "Search projects", exact: true });
  await projectSearch.waitFor();
  await projectSearch.fill("d4 Agent");
  await page.getByText("No matching projects.", { exact: true }).waitFor();
  NodeAssert.equal(await page.getByRole("option", { name: "d4 Agent", exact: true }).count(), 0);
  await projectSearch.press("Escape");
  for (const name of ["Initialize Git", "Add project script", "Open in Files"])
    NodeAssert.equal(await chat.getByRole("button", { name, exact: true }).count(), 0);
  console.log(
    "PASS real Sidebar pins d4 Agent above Search, hides its project, and opens the dedicated route",
  );
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await agentEnabled.waitFor();
  const probes = page.getByRole("switch", { name: "Agent system probes", exact: true });
  await savedChange(
    app,
    "enable system probes",
    () => probes.click(),
    (value) => value.systemProbeEnabled === true,
    "d4Agent",
  );
  console.log("PASS d4 Agent enable and system probe persistence");
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
  console.log("PASS monitor and d4 Agent disable persistence after reload");
}
