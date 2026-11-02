import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function settingsScopeLayout({ page, app, screenshotDir }) {
  const projectName = "Tablet verification project with a deliberately long descriptive name";
  const workspace = NodePath.join(app.baseDir, "scope-layout-workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  const bin =
    process.env.T3_PWA_TEST_SERVER_BIN ??
    NodePath.resolve(import.meta.dirname, "../../server/dist/bin.mjs");
  NodeChildProcess.execFileSync(
    process.execPath,
    [bin, "project", "add", workspace, "--base-dir", app.baseDir, "--title", projectName],
    { timeout: 20000, stdio: "pipe" },
  );
  await page.goto(`${app.webUrl}/settings/dev-pipelines`, { waitUntil: "domcontentloaded" });
  const project = page.getByRole("button", { name: /^Project scope:/ });
  const environment = page.getByRole("button", { name: /^Environment scope:/ });
  await project.waitFor();
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [744, 390],
    [768, 1024],
    [820, 1180],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width, height });
    await project.scrollIntoViewIfNeeded();
    for (const control of [project, environment]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      NodeAssert.ok(
        box && box.x >= 0 && box.x + box.width <= width,
        `Scope control must fit ${width}px: ${JSON.stringify(box)}`,
      );
      await control.click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      const menuBox = await menu.boundingBox();
      NodeAssert.ok(
        menuBox &&
          menuBox.x >= 0 &&
          menuBox.x + menuBox.width <= width &&
          menuBox.y >= 0 &&
          menuBox.y + menuBox.height <= height,
        `Scope menu must fit ${width}x${height}: ${JSON.stringify(menuBox)}`,
      );
      await page.keyboard.press("Escape");
    }
    await project.click();
    await page.getByRole("menuitemradio", { name: projectName, exact: true }).click();
    await page
      .getByRole("button", { name: `Project scope: ${projectName}`, exact: true })
      .waitFor();
    const selected = await project.boundingBox();
    NodeAssert.ok(
      selected && selected.x >= 0 && selected.x + selected.width <= width,
      `Long project name must fit ${width}px: ${JSON.stringify(selected)}`,
    );
    NodeAssert.ok(new URL(page.url()).searchParams.has("project"), "Selection must change scope");
    await page.screenshot({ path: NodePath.join(screenshotDir, `scope-${width}x${height}.png`) });
    await project.click();
    await page.getByRole("menuitemradio", { name: "All projects", exact: true }).click();
    NodeAssert.equal(new URL(page.url()).searchParams.has("project"), false);
    console.log(`PASS scope controls, menus, selection and reset at ${width}x${height}`);
  }
  await page.goto(`${app.webUrl}/settings/scheduled-tasks`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New task", exact: true });
  await dialog.waitFor();
  for (const [width, height] of [
    [320, 568],
    [390, 260],
    [744, 390],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height });
    for (const name of ["Project", "Workspace"]) {
      const control = dialog.getByRole("combobox", { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      NodeAssert.ok(
        box && box.x >= 0 && box.x + box.width <= width,
        `Task ${name} must fit ${width}px: ${JSON.stringify(box)}`,
      );
      await control.click();
      await page.getByRole("listbox").waitFor();
      await page.keyboard.press("Escape");
    }
    for (const name of ["Every interval", "On webhook", "At a time"]) {
      const option = dialog.getByRole("button", { name, exact: true });
      await option.scrollIntoViewIfNeeded();
      const box = await option.boundingBox();
      NodeAssert.ok(
        box && box.x >= 0 && box.x + box.width <= width,
        `Schedule ${name} must fit ${width}px: ${JSON.stringify(box)}`,
      );
      await option.click();
      NodeAssert.equal(await option.getAttribute("aria-pressed"), "true");
    }
    await page.screenshot({ path: NodePath.join(screenshotDir, `task-${width}x${height}.png`) });
    console.log(`PASS task dropdowns and schedule choices at ${width}x${height}`);
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
