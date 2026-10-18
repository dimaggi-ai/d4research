import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

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
        if (matches(settings.handoff?.contextCompression ?? {})) resolve();
      } catch {}
    };
    watcher = NodeFS.watch(directory, () => {
      void check();
    });
    timer = setTimeout(
      () => reject(new Error("Handoff settings were not saved within 10s")),
      10000,
    );
  });
  try {
    await change();
    await saved;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

export async function handoffSettings({ page, app, screenshotDir }) {
  await page.goto(`${app.webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  const mode = page.getByRole("combobox", { name: "Automatic handoff", exact: true });
  await mode.waitFor();
  NodeAssert.match(await mode.innerText(), /Bounded history/);
  await mode.click();
  await savedChange(
    app,
    () => page.getByRole("option", { name: "Direct (no compaction)", exact: true }).click(),
    (value) => value.mode === "direct",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await mode.waitFor();
  await mode.getByText("Direct (no compaction)", { exact: true }).waitFor();
  NodeAssert.match(await mode.innerText(), /Direct/);
  await page.screenshot({ path: NodePath.join(screenshotDir, "handoff-direct.png") });
  await mode.click();
  await savedChange(
    app,
    () => page.getByRole("option", { name: "Smart compaction", exact: true }).click(),
    (value) => value.mode === "smart",
  );
  const judge = page.getByRole("textbox", { name: "Judge model", exact: true });
  await savedChange(
    app,
    () => judge.fill("bonsai2-27b:latest"),
    (value) => value.judgeModel === "bonsai2-27b:latest",
  );
  await savedChange(
    app,
    () =>
      page
        .getByRole("textbox", { name: "Second judge model", exact: true })
        .fill("local-test-judge"),
    (value) => value.secondaryJudgeModel === "local-test-judge",
  );
  await savedChange(
    app,
    () =>
      page
        .getByRole("textbox", { name: "Second judge endpoint", exact: true })
        .fill("http://127.0.0.1:9000"),
    (value) => value.secondaryJudgeBaseUrl === "http://127.0.0.1:9000",
  );
  await page.getByText("Max output characters", { exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await judge.waitFor();
  NodeAssert.equal(await judge.inputValue(), "bonsai2-27b:latest");
  NodeAssert.equal(
    await page.getByRole("textbox", { name: "Second judge model", exact: true }).inputValue(),
    "local-test-judge",
  );
  NodeAssert.equal(
    await page.getByRole("textbox", { name: "Second judge endpoint", exact: true }).inputValue(),
    "http://127.0.0.1:9000",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await mode.scrollIntoViewIfNeeded();
  const box = await mode.boundingBox();
  NodeAssert.ok(
    box && box.x >= 0 && box.x + box.width <= 390,
    "mode picker fits the phone viewport",
  );
  await page.screenshot({ path: NodePath.join(screenshotDir, "handoff-smart-mobile.png") });
  await mode.click();
  await savedChange(
    app,
    () => page.getByRole("option", { name: "Bounded history", exact: true }).click(),
    (value) => (value.mode ?? "bounded") === "bounded",
  );
  await judge.waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await mode.waitFor();
  NodeAssert.match(await mode.innerText(), /Bounded history/);
}
