import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { createPairingUrl } from "./harness.mjs";
import { runProductionBrowserSuite } from "./production-browser-harness.mjs";

async function saveFolder(page, app, value) {
  const input = page.getByRole("textbox", { name: "Notes folder", exact: true });
  await input.waitFor();
  let watcher;
  let timer;
  const saved = new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const settings = JSON.parse(
          await NodeFSP.readFile(NodePath.join(app.baseDir, "userdata/settings.json"), "utf8"),
        );
        if ((settings.research?.notesFolder ?? "") === value) resolve();
      } catch {}
    };
    watcher = NodeFS.watch(NodePath.join(app.baseDir, "userdata"), () => void check());
    timer = setTimeout(() => reject(new Error("Notes folder persistence exceeded 10s")), 10000);
  });
  try {
    await input.fill(value);
    await input.press("Tab");
    await saved;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

export async function notesFlows({ page, context, app, screenshotDir }) {
  await context.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("open", () => {
          window.__notesSocket = this;
        });
      }
    };
  });
  await page.goto(createPairingUrl(app, "notes-fixture"), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  const workspace = NodePath.join(app.baseDir, "notes-workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  const ids = await page.evaluate(async (workspaceRoot) => {
    const socket = window.__notesSocket;
    let nextId = 910000;
    const request = async (tag, payload) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const receive = (event) => {
          const packet = JSON.parse(event.data);
          if (packet._tag !== "Exit" || Number(packet.requestId) !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
          if (packet.exit._tag === "Success") resolve();
          else reject(new Error(JSON.stringify(packet.exit)));
        };
        const timer = setTimeout(() => {
          socket.removeEventListener("message", receive);
          reject(new Error("Notes fixture RPC timeout"));
        }, 10000);
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ _tag: "Request", id, tag, headers: [], payload }));
      });
    };
    const projectId = crypto.randomUUID();
    await request("projects.mutate", {
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "notes-workspace",
      workspaceRoot,
    });
    const create = async (title) => {
      const threadId = crypto.randomUUID();
      await request("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId,
        projectId,
        createdBy: "user",
        creationSource: "web",
        title,
        modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      return threadId;
    };
    return [await create("Notes populated fixture"), await create("Notes empty fixture")];
  }, workspace);
  await page.getByRole("treeitem", { name: "Notes empty fixture, notes-workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open thread notes", exact: true }).waitFor();
  const environmentId = new URL(page.url()).pathname.split("/")[1];
  const route = (id) => `${app.webUrl}/${environmentId}/${id}`;
  let pointerBlocked = false;
  const openNotes = async (id) => {
    await page.goto(route(id), { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Open thread notes", exact: true });
    try {
      await button.click({ timeout: 1500 });
    } catch (error) {
      pointerBlocked = true;
      await NodeFSP.writeFile(
        NodePath.join(screenshotDir, "notes-pointer-error.txt"),
        String(error),
      );
      await page.screenshot({ path: NodePath.join(screenshotDir, "notes-pointer-blocked.png") });
      console.log(
        "FAIL Notes pointer activation: header control intercepts click; continuing with keyboard",
      );
      await button.focus();
      await page.keyboard.press("Enter");
    }
    return page.getByRole("dialog");
  };
  let dialog = await openNotes(ids[1]);
  await dialog.getByText("No research artifacts in this thread.", { exact: true }).waitFor();
  await dialog
    .getByText("Notes export is disabled. Set a Notes folder in Settings → Research.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: NodePath.join(screenshotDir, "notes-disabled-empty.png") });
  console.log("PASS Notes disabled and empty on real thread");
  await page.keyboard.press("Escape");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    dialog = await openNotes(ids[1]);
    await dialog.getByText("No research artifacts in this thread.", { exact: true }).waitFor();
    await page.screenshot({ path: NodePath.join(screenshotDir, `notes-pointer-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  console.log("PASS Notes pointer access at widths 390, 768, and 1440");
  await page.goto(`${app.webUrl}/settings/research?machine=${encodeURIComponent(environmentId)}`, {
    waitUntil: "domcontentloaded",
  });
  const folder = NodePath.join(app.baseDir, "notes-export");
  await NodeFSP.mkdir(folder);
  await saveFolder(page, app, folder);
  await page.reload({ waitUntil: "domcontentloaded" });
  NodeAssert.equal(
    await page.getByRole("textbox", { name: "Notes folder", exact: true }).inputValue(),
    folder,
  );
  await page.screenshot({ path: NodePath.join(screenshotDir, "notes-settings-persisted.png") });
  console.log("PASS Notes Settings path saved to disk and survives reload");
  dialog = await openNotes(ids[1]);
  await dialog.getByText(folder, { exact: true }).waitFor();
  NodeAssert.equal(await dialog.getByRole("alert").count(), 0);
  await page.keyboard.press("Escape");
  await page.goto(`${app.webUrl}/settings/research?machine=${encodeURIComponent(environmentId)}`, {
    waitUntil: "domcontentloaded",
  });
  const missing = NodePath.join(app.baseDir, "missing-notes-folder");
  await saveFolder(page, app, missing);
  dialog = await openNotes(ids[1]);
  await dialog
    .getByText("The Notes folder is unavailable. Existing workspace artifacts are listed below.", {
      exact: true,
    })
    .waitFor();
  await dialog
    .getByRole("alert")
    .getByText("Notes folder is unavailable. Check its path and permissions.", { exact: true })
    .waitFor();
  await page.screenshot({ path: NodePath.join(screenshotDir, "notes-unavailable.png") });
  console.log("PASS unavailable destination surfaced in Notes");
  await page.keyboard.press("Escape");
  const artifact = "steps/001-step1-v1-fixture.md";
  const text = "FIRST_PAGE_SYNTHETIC\n" + "a".repeat(70000) + "\nLAST_PAGE_SYNTHETIC";
  const runDir = NodePath.join(workspace, "research-runs", ids[0]);
  await NodeFSP.mkdir(NodePath.join(runDir, "steps"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(runDir, artifact), text);
  await NodeFSP.writeFile(
    NodePath.join(runDir, "ledger.jsonl"),
    JSON.stringify({
      seq: 1,
      threadId: ids[0],
      at: new Date().toISOString(),
      runId: `${ids[0]}:synthetic`,
      step: "1",
      visit: 1,
      requestedTarget: "fixture",
      resolvedTarget: "fixture",
      substituted: false,
      outcome: "success",
      durationMs: 0,
      chars: text.length,
      truncated: false,
      artifact,
      contentHash: NodeCrypto.createHash("sha256").update(text).digest("hex"),
    }) + "\n",
  );
  dialog = await openNotes(ids[0]);
  await dialog.getByRole("button", { name: `Read note ${artifact}`, exact: true }).click();
  const pre = dialog.locator("pre");
  await pre.getByText(/^FIRST_PAGE_SYNTHETIC/).waitFor();
  const first = await pre.innerText();
  NodeAssert.equal(first, text.slice(0, first.length));
  NodeAssert.ok(first.length < text.length);
  NodeAssert.equal(
    await dialog.getByRole("button", { name: "Previous", exact: true }).isDisabled(),
    true,
  );
  let collected = first;
  for (let n = 0; n < 10 && collected.length < text.length; n++) {
    const previousLength = collected.length;
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    await dialog.getByText(new RegExp(`^${previousLength.toLocaleString()}–`)).waitFor();
    collected += await pre.innerText();
  }
  NodeAssert.equal(collected, text);
  NodeAssert.equal(
    await dialog.getByRole("button", { name: "Next", exact: true }).isDisabled(),
    true,
  );
  await dialog.getByRole("button", { name: "Previous", exact: true }).click();
  await dialog.getByText(new RegExp(`^${first.length.toLocaleString()}–`)).waitFor();
  NodeAssert.equal(await pre.innerText(), text.slice(first.length, first.length * 2));
  await page.screenshot({ path: NodePath.join(screenshotDir, "notes-populated-pagination.png") });
  console.log(
    "PASS real ledger list/read and all Next pages reconstruct exact artifact; Previous reachable",
  );
  await page.keyboard.press("Escape");
  dialog = await openNotes(ids[1]);
  await dialog.getByText("No research artifacts in this thread.", { exact: true }).waitFor();
  NodeAssert.equal(await dialog.locator("pre").count(), 0);
  NodeAssert.equal(await dialog.getByRole("button", { name: /^Read note / }).count(), 0);
  console.log("PASS changing threads clears selected artifact and scopes empty list");
  await page.keyboard.press("Escape");
  await page.goto(`${app.webUrl}/settings/research?machine=${encodeURIComponent(environmentId)}`, {
    waitUntil: "domcontentloaded",
  });
  await saveFolder(page, app, "");
  await page.reload({ waitUntil: "domcontentloaded" });
  NodeAssert.equal(
    await page.getByRole("textbox", { name: "Notes folder", exact: true }).inputValue(),
    "",
  );
  console.log("PASS clear Notes folder persists after reload");
  const bin = process.env.T3_PWA_TEST_SERVER_BIN ?? NodePath.resolve("apps/server/dist/bin.mjs");
  const grant = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        bin,
        "auth",
        "pairing",
        "create",
        "--base-dir",
        app.baseDir,
        "--base-url",
        app.webUrl,
        "--scope",
        "orchestration:read",
        "--json",
      ],
      { encoding: "utf8", timeout: 15000 },
    ),
  );
  const restricted = await context.browser().newContext();
  try {
    await restricted.addInitScript(() =>
      localStorage.setItem(
        "t3code:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-09-09T00:00:00.000Z" }),
      ),
    );
    const reader = await restricted.newPage();
    reader.setDefaultTimeout(10000);
    await reader.goto(grant.pairUrl, { waitUntil: "domcontentloaded" });
    await reader.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
    await reader.goto(route(ids[0]), { waitUntil: "domcontentloaded" });
    const denied = reader.getByRole("button", { name: "Open thread notes", exact: true });
    await denied.waitFor();
    NodeAssert.equal(await denied.isDisabled(), true);
    await reader.screenshot({
      path: NodePath.join(screenshotDir, "notes-read-permission-denied.png"),
    });
    await reader.goto(
      `${app.webUrl}/settings/research?machine=${encodeURIComponent(environmentId)}`,
      { waitUntil: "domcontentloaded" },
    );
    const setting = reader.getByRole("textbox", { name: "Notes folder", exact: true });
    await setting.waitFor();
    NodeAssert.equal(await setting.isDisabled(), true);
    console.log("PASS real restricted grant disables Notes and Notes-folder editing");
  } finally {
    await restricted.close();
  }
  NodeAssert.equal(
    pointerBlocked,
    false,
    "Notes header button must accept pointer clicks without Open Files interception",
  );
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runProductionBrowserSuite([{ name: "notes-settings-and-artifacts", run: notesFlows }]);
}
