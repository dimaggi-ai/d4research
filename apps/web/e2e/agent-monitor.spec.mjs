import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

async function savedChange(app, change, matches) {
  const directory = NodePath.join(app.baseDir, "userdata");
  let watcher;
  let timer;
  const saved = new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const settings = JSON.parse(
          await NodeFSP.readFile(NodePath.join(directory, "settings.json"), "utf8"),
        );
        if (matches(settings.agentMonitor ?? {})) resolve(settings.agentMonitor);
      } catch {}
    };
    watcher = NodeFS.watch(directory, () => {
      void check();
    });
    timer = setTimeout(
      () => reject(new Error("Monitor settings were not saved within 10s")),
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
    .getByText("Choose one environment to configure its monitor.", { exact: true })
    .locator("..")
    .getByRole("button")
    .click();
  const enabled = page.getByRole("switch", { name: "Monitor threads", exact: true });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "false");
  await savedChange(
    app,
    () => enabled.click(),
    (value) => value.enabled === true,
  );
  console.log("PASS monitor enable and persistence");
  await page.getByText("No threads need attention.", { exact: true }).waitFor();
  const picker = page.getByRole("button", { name: "Saved monitor model", exact: true });
  await picker.click();
  const selected = await savedChange(
    app,
    () =>
      page
        .locator("[data-model-picker-content]")
        .getByRole("option")
        .and(page.locator(':not([aria-disabled="true"])'))
        .first()
        .click(),
    (value) => typeof value.modelSelection?.model === "string",
  );
  NodeAssert.ok(selected.modelSelection.instanceId);
  console.log("PASS monitor model persistence");
  const notifications = page.getByRole("switch", {
    name: "Monitor attention notifications",
    exact: true,
  });
  await savedChange(
    app,
    () => notifications.click(),
    (value) => value.notificationsEnabled === true,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "true");
  NodeAssert.equal(await notifications.getAttribute("aria-checked"), "true");
  NodeAssert.notEqual(await picker.innerText(), "Choose model");
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.scrollIntoViewIfNeeded();
  const box = await picker.boundingBox();
  NodeAssert.ok(box && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: NodePath.join(screenshotDir, "monitor-mobile.png") });
  await savedChange(
    app,
    () =>
      page.locator("#agent-monitor").getByRole("button", { name: "Clear", exact: true }).click(),
    (value) => (value.modelSelection ?? null) === null,
  );
  await savedChange(
    app,
    () => notifications.click(),
    (value) => (value.notificationsEnabled ?? false) === false,
  );
  await savedChange(
    app,
    () => enabled.click(),
    (value) => (value.enabled ?? false) === false,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await enabled.waitFor();
  NodeAssert.equal(await enabled.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await notifications.getAttribute("aria-checked"), "false");
  NodeAssert.equal(await picker.innerText(), "Choose model");
}
