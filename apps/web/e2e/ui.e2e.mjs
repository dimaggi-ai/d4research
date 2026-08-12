// Browser coverage for the surfaces d4research adds on top of upstream t3code.
// Unit tests already cover their logic; these assert the wiring a user actually
// touches — routes render, data reaches the DOM, and nothing throws in console.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  openProject,
  openAuthenticatedPage,
  startIsolatedApp,
  stopIsolatedApp,
} from "./harness.mjs";

const specs = [];
const spec = (name, run) => specs.push({ name, run });

async function startNewLocalThread(page) {
  const priorUrl = page.url();
  // The product deliberately reuses an already-empty draft. Callers clean up
  // unsent state before returning, so that existing draft is an isolated setup
  // surface and does not need a different identity.
  if (/\/draft\//u.test(new URL(priorUrl).pathname)) {
    await page
      .getByRole("button", { name: /send message/i })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    return;
  }
  // Exercise the production keybinding path. The sidebar's new-thread icon is
  // intentionally hover-only on wide layouts and covered by the drawer at the
  // compact breakpoint, so it is not a stable or accessible setup primitive.
  await page.keyboard.press("Control+Shift+N");
  await page.waitForURL((url) => /\/draft\//u.test(url.pathname) && url.href !== priorUrl, {
    timeout: 20_000,
  });
  await page
    .getByRole("button", { name: /send message/i })
    .first()
    .waitFor({
      state: "visible",
      timeout: 20_000,
    });
}

async function stopRunningTurnForIsolation(page) {
  const stop = page.getByRole("button", { name: "Stop generation" }).first();
  const running = await stop
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!running) return;
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Stop generation"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) return;
  await stop.waitFor({ state: "hidden", timeout: 30_000 });
}

spec("app shell pairs and renders d4research branding", async ({ page }) => {
  NodeAssert.equal(await page.locator('[aria-label="d4research"]').count(), 1);
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
  NodeAssert.ok(body.includes("Auto-open task panel"), "expected the task-panel toggle");
  NodeAssert.ok(body.includes("Open Tool Guard settings"), "expected the Tool Guard deep link");
});

spec("settings search reaches the tool guard page", async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: /search settings/i }).fill("tool guard");
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/settings\/tool-guard/, { timeout: 15_000 });
});

spec(
  "global and chat skills persist, stay isolated, and render without transport markup",
  async ({ page, webUrl, workspace, baseDir, agentHome }) => {
    const skillPath = NodePath.join(agentHome, ".agents/skills/e2e-default/SKILL.md");

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await page.goto(`${webUrl}/settings/skills`, { waitUntil: "domcontentloaded" });
    const toggle = page
      .getByRole("switch", { name: "Enable e2e-default globally for all chats" })
      .first();
    await toggle.waitFor({ state: "visible", timeout: 20_000 });
    await toggle.click();
    await page.getByText("1 of 12 global skills enabled", { exact: false }).waitFor({
      timeout: 20_000,
    });

    const settingsPath = NodePath.join(baseDir, "userdata/settings.json");
    let persistedSettings;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      if (persistedSettings.skills?.enabledByDefault?.includes("e2e-default")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.deepEqual(persistedSettings.skills?.enabledByDefault, ["e2e-default"]);
    const agySkillsConfig = JSON.parse(
      await NodeFSP.readFile(NodePath.join(agentHome, ".gemini/config/skills.json"), "utf8"),
    );
    NodeAssert.ok(
      agySkillsConfig.entries?.some(
        (entry) => entry?.path === NodePath.join(agentHome, ".agents/skills"),
      ),
      "startup reconciliation must register the canonical skill root for Agy",
    );

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);
    await page.getByTestId("composer-editor").pressSequentially("prove default skill delivery");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Global: e2e-default", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });

    const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const sent = database
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(typeof sent?.text, "string");
      NodeAssert.ok(sent.text.includes('<enabled_skills version="2"'));
      NodeAssert.ok(sent.text.includes(skillPath));
      NodeAssert.ok(sent.text.includes("prove default skill delivery"));
    } finally {
      database.close();
    }
    const userBubble = page.locator('[data-message-role="user"]').last();
    NodeAssert.ok(!(await userBubble.innerText()).includes("<enabled_skills"));
    NodeAssert.ok(!(await userBubble.innerText()).includes(skillPath));
    await stopRunningTurnForIsolation(page);

    // Reverse state is part of the feature: disabling stops the next-turn tax.
    await page.goto(`${webUrl}/settings/skills`, { waitUntil: "domcontentloaded" });
    const enabledToggle = page
      .getByRole("switch", { name: "Enable e2e-default globally for all chats" })
      .first();
    await enabledToggle.waitFor({ state: "visible", timeout: 20_000 });
    NodeAssert.equal(await enabledToggle.getAttribute("aria-checked"), "true");
    await enabledToggle.click();
    await page.getByText("0 of 12 global skills enabled", { exact: false }).waitFor({
      timeout: 20_000,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      if (persistedSettings.skills?.enabledByDefault?.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.deepEqual(persistedSettings.skills?.enabledByDefault ?? [], []);

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);
    await page.locator('[data-chat-session-skills-trigger="true"]').click();
    const sessionSkill = page.locator('[data-chat-session-skill="e2e-default"]');
    await sessionSkill.waitFor({ state: "visible", timeout: 20_000 });
    NodeAssert.equal(await sessionSkill.getAttribute("data-chat-session-skill-scope"), "off");
    await sessionSkill.click();
    await page.getByRole("button", { name: "1 skill configured for this chat" }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      const selected = Object.values(persistedSettings.skills?.enabledByThread ?? {}).some(
        (names) => Array.isArray(names) && names.includes("e2e-default"),
      );
      if (selected) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.ok(
      Object.values(persistedSettings.skills?.enabledByThread ?? {}).some(
        (names) => Array.isArray(names) && names.includes("e2e-default"),
      ),
      "expected the draft thread id to persist its chat-specific skill before send",
    );

    await page.getByTestId("composer-editor").pressSequentially("prove chat skill delivery");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("Chat: e2e-default", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.waitForURL((url) => !/\/draft\//u.test(url.pathname), { timeout: 20_000 });
    const sessionThreadUrl = page.url();
    const sessionThreadId = decodeURIComponent(
      new URL(sessionThreadUrl).pathname.match(/\/([^/]+)\/?$/u)?.[1] ?? "",
    );
    NodeAssert.ok(sessionThreadId.length > 0, "expected a canonical thread id after send");
    persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
    NodeAssert.deepEqual(
      persistedSettings.skills?.enabledByThread?.[sessionThreadId],
      ["e2e-default"],
      `expected the session skill under canonical thread ${sessionThreadId}; keys: ${Object.keys(
        persistedSettings.skills?.enabledByThread ?? {},
      ).join(", ")}`,
    );
    const disabledDatabase = new NodeSqlite.DatabaseSync(
      NodePath.join(baseDir, "userdata/state.sqlite"),
      { readOnly: true },
    );
    try {
      const sent = disabledDatabase
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.ok(sent?.text.includes("prove chat skill delivery"));
      NodeAssert.ok(sent.text.includes('session-names="%5B%22e2e-default%22%5D"'));
      NodeAssert.ok(sent.text.includes(skillPath));
    } finally {
      disabledDatabase.close();
    }

    // A second chat must not inherit the session selection.
    await startNewLocalThread(page);
    await page.getByTestId("composer-editor").pressSequentially("prove chat skill isolation");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("prove chat skill isolation", { exact: false }).first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const isolationDatabase = new NodeSqlite.DatabaseSync(
      NodePath.join(baseDir, "userdata/state.sqlite"),
      { readOnly: true },
    );
    try {
      const sent = isolationDatabase
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(sent?.text, "prove chat skill isolation");
    } finally {
      isolationDatabase.close();
    }
    await stopRunningTurnForIsolation(page);
    persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
    NodeAssert.deepEqual(
      persistedSettings.skills?.enabledByThread?.[sessionThreadId],
      ["e2e-default"],
      "creating another chat must not remove the original chat's session skills",
    );

    // Reloading the original chat retains the selection, and removing it
    // deletes the map entry rather than leaving a hidden one-way state.
    await page.goto(sessionThreadUrl, { waitUntil: "domcontentloaded" });
    await page.locator('[data-chat-session-skills-trigger="true"]').click();
    const restoredSkill = page.locator('[data-chat-session-skill="e2e-default"]');
    await restoredSkill.waitFor({ state: "visible", timeout: 20_000 });
    try {
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-chat-session-skill="e2e-default"]')
            ?.getAttribute("data-chat-session-skill-scope") === "session",
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      throw new Error(
        `session skill did not restore; route=${page.url()} expected=${sessionThreadUrl} ` +
          `scope=${await restoredSkill.getAttribute("data-chat-session-skill-scope")} ` +
          `persisted=${JSON.stringify(
            persistedSettings.skills?.enabledByThread?.[sessionThreadId] ?? null,
          )}`,
      );
    }
    NodeAssert.equal(await restoredSkill.getAttribute("data-chat-session-skill-scope"), "session");
    NodeAssert.equal(await restoredSkill.getAttribute("aria-checked"), "true");
    await restoredSkill.click();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      const selected = Object.values(persistedSettings.skills?.enabledByThread ?? {}).some(
        (names) => Array.isArray(names) && names.includes("e2e-default"),
      );
      if (!selected) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.ok(
      !Object.values(persistedSettings.skills?.enabledByThread ?? {}).some(
        (names) => Array.isArray(names) && names.includes("e2e-default"),
      ),
      "expected removing the chat skill to delete its persisted selection",
    );
    await stopRunningTurnForIsolation(page);
  },
);

spec(
  "dev pipeline settings persist into the composer Build picker",
  async ({ page, webUrl, workspace, baseDir }) => {
    await page.goto(`${webUrl}/settings/dev-pipelines`, { waitUntil: "domcontentloaded" });
    const prompt = page.getByRole("textbox", { name: "Dev pipeline prompt" });
    await prompt.waitFor({ state: "visible", timeout: 20_000 });

    await page.getByRole("combobox", { name: "Dev pipeline" }).click();
    await page.getByRole("option", { name: /add pipeline/i }).click();
    await page.getByRole("textbox", { name: "New dev pipeline name" }).fill("e2e-review");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 20_000 });
    NodeAssert.equal(
      await page.getByRole("combobox", { name: "Dev pipeline" }).innerText(),
      "e2e-review",
      "expected the newly created pipeline to become active before editing",
    );

    const pipelinePrompt =
      "STEP 1 — PLAN\nDirective: !codex:gpt-5.6-sol:e2e-rules.md\nFALLBACK directive: !junie:gpt-5.6-sol";
    await prompt.fill(pipelinePrompt);
    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e-rules.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Review the real boundary and report exact verification output."),
    });
    await page.getByText("e2e-rules.md", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    // Pipeline prompts commit on blur. Playwright's explicit blur avoids
    // Radix focus-management differences between headed and headless runs.
    await prompt.evaluate((element) => element.blur());
    const settingsPath = NodePath.join(baseDir, "userdata/settings.json");
    let persistedSettings;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      persistedSettings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      const persistedPipeline = persistedSettings.dev?.scenarios?.find(
        (scenario) => scenario.name === "e2e-review",
      );
      if (
        persistedSettings.dev?.activeScenario === "e2e-review" &&
        persistedPipeline?.pipelinePrompt === pipelinePrompt &&
        persistedPipeline?.promptFiles?.[0]?.name === "e2e-rules.md"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.equal(persistedSettings.dev?.activeScenario, "e2e-review");
    NodeAssert.equal(
      persistedSettings.dev?.scenarios?.find((scenario) => scenario.name === "e2e-review")
        ?.pipelinePrompt,
      pipelinePrompt,
      "expected blur to persist the exact pipeline prompt before reload",
    );
    NodeAssert.deepEqual(
      persistedSettings.dev?.scenarios?.find((scenario) => scenario.name === "e2e-review")
        ?.promptFiles,
      [
        {
          name: "e2e-rules.md",
          content: "Review the real boundary and report exact verification output.",
        },
      ],
      "expected the real file input to persist scenario-scoped prompt content",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.querySelector('[role="combobox"][aria-label="Dev pipeline"]')?.textContent ===
        "e2e-review",
      undefined,
      { timeout: 20_000 },
    );
    NodeAssert.equal(
      await page.getByRole("combobox", { name: "Dev pipeline" }).innerText(),
      "e2e-review",
      "expected the custom pipeline selection to survive a settings reload",
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('textarea[aria-label="Dev pipeline prompt"]')
          ?.value.includes("!codex:gpt-5.6-sol") === true,
      undefined,
      { timeout: 20_000 },
    );
    NodeAssert.ok(
      (await page.getByRole("textbox", { name: "Dev pipeline prompt" }).inputValue()).includes(
        "!codex:gpt-5.6-sol",
      ),
      "expected the custom pipeline prompt to survive a settings reload",
    );
    await page.getByText("e2e-rules.md", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });

    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await page.getByRole("combobox", { name: "Build mode" }).click();
    await page.getByRole("option", { name: "e2e-review", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Dev pipeline: e2e-review" })
      .waitFor({ state: "visible", timeout: 20_000 });
    NodeAssert.ok(
      (await page.locator("body").innerText()).includes("!dev:e2e-review"),
      "expected choosing a dev pipeline to arm its !dev trigger in the composer",
    );

    await page.getByTestId("composer-editor").pressSequentially("fix the e2e regression");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText("fix the e2e regression", { exact: false }).first().waitFor({
      state: "visible",
      timeout: 20_000,
    });

    const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const sent = database
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(typeof sent?.text, "string");
      // The visible event log stays authoritative and readable. Expansion is
      // a provider-boundary concern, covered by ProviderCommandReactor tests.
      NodeAssert.ok(sent.text.startsWith("!dev:e2e-review"));
      NodeAssert.ok(sent.text.includes("fix the e2e regression"));
      NodeAssert.ok(
        !sent.text.includes("Dev pipeline protocol (non-negotiable):"),
        "persisted history must keep the compact user trigger, not the provider-only protocol",
      );
    } finally {
      database.close();
    }
    await stopRunningTurnForIsolation(page);
  },
);

spec(
  "compact composer exits Plan when a dev pipeline is selected",
  async ({ page, webUrl, workspace }) => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);
    await page.setViewportSize({ width: 560, height: 800 });

    const more = page.getByRole("button", { name: "More composer controls" });
    await more.waitFor({ state: "visible", timeout: 20_000 });
    await more.click();
    const planItem = page.getByRole("menuitemradio", { name: "Plan", exact: true });
    await planItem.click();
    NodeAssert.equal(await planItem.getAttribute("aria-checked"), "true");
    // Both Dev and Research ship a scenario named "default". The Dev group is
    // rendered first; select its row and then prove the dev trigger below.
    const devDefault = page.getByRole("menuitemradio", { name: "default", exact: true }).first();
    await devDefault.waitFor({ state: "visible", timeout: 20_000 });
    await devDefault.click();
    NodeAssert.equal(await devDefault.getAttribute("aria-checked"), "true");
    NodeAssert.equal(
      await page
        .getByRole("menuitemradio", { name: "Chat", exact: true })
        .getAttribute("aria-checked"),
      "true",
      "arming a dev pipeline must leave native Plan mode",
    );

    // Reverse state is equally important: entering native Plan after a dev
    // pipeline was armed must remove the prompt trigger, not run both modes.
    const reversePlanItem = page.getByRole("menuitemradio", { name: "Plan", exact: true });
    if (!(await reversePlanItem.isVisible().catch(() => false))) await more.click();
    await reversePlanItem.click();
    NodeAssert.equal(await reversePlanItem.getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    NodeAssert.ok(
      !(await page.locator("body").innerText()).includes("!dev:default"),
      "entering native Plan must disarm the compact dev pipeline",
    );

    await more.click();
    await page.getByRole("menuitemradio", { name: "default", exact: true }).first().click();
    await page.keyboard.press("Escape");
    NodeAssert.ok(
      (await page.locator("body").innerText()).includes("!dev:default"),
      "the compact selection must arm the same trigger as the wide picker",
    );
    await more.click();
    await page.getByRole("menuitemradio", { name: "Build", exact: true }).click();
    await page.keyboard.press("Escape");
    NodeAssert.ok(
      !(await page.locator("body").innerText()).includes("!dev:default"),
      "leaving Build mode must remove the pipeline trigger from the draft",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
  },
);

spec(
  "large paste and dropped text files survive reload and send as bubbles",
  async ({ page, webUrl, workspace, baseDir }) => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);
    const editor = page.getByTestId("composer-editor");

    const largePaste = `incident start\n- Heading:\n${"x".repeat(2_100)}\nincident end`;
    await editor.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    }, largePaste);
    const pastedChip = page.getByText(/Pasted text \(4 lines\)/).first();
    await pastedChip.waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: /Remove Pasted text/ }).click();
    await pastedChip.waitFor({ state: "hidden" });

    // Fill all bounded attachment slots, then prove the ninth large paste is
    // preserved inline instead of being prevented and silently discarded.
    for (let index = 0; index < 8; index += 1) {
      await editor.evaluate((element, slot) => {
        const data = new DataTransfer();
        data.setData("text/plain", `slot-${slot}\n${"s".repeat(2_100)}`);
        element.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
        );
      }, index);
    }
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label^="Remove Pasted text"]').length === 8,
      undefined,
      { timeout: 10_000 },
    );
    const overflowPaste = `ninth paste must survive\n${"n".repeat(2_100)}`;
    await editor.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
    }, overflowPaste);
    await page.waitForFunction(
      (text) =>
        document.querySelector('[data-testid="composer-editor"]')?.textContent?.includes(text),
      "ninth paste must survive",
      { timeout: 10_000 },
    );
    NodeAssert.equal(
      await page.getByRole("button", { name: /Remove Pasted text/ }).count(),
      8,
      "the ninth paste must remain inline rather than being accepted by the bounded chip store",
    );
    for (let index = 0; index < 8; index += 1) {
      await page
        .getByRole("button", { name: /Remove Pasted text/ })
        .first()
        .click();
    }
    await editor.press("Control+A");
    await editor.press("Backspace");

    const droppedBody = "# Drop\n- Heading:\nbody that used to split the legacy parser";
    await editor.evaluate((element, body) => {
      const data = new DataTransfer();
      data.items.add(new File([body], "dropped.md", { type: "text/markdown" }));
      data.items.add(new File([body], "dropped.md", { type: "text/markdown" }));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    }, droppedBody);
    await page.getByText("dropped.md", { exact: true }).first().waitFor({ state: "visible" });
    NodeAssert.equal(
      await page.getByText("dropped.md", { exact: true }).count(),
      2,
      "identical files must remain two distinct composer chips",
    );
    const sendButton = page
      .locator('[data-chat-composer-form="true"] button[type="submit"]')
      .last();
    await sendButton.waitFor({ state: "visible", timeout: 20_000 });
    NodeAssert.equal(
      await sendButton.getAttribute("aria-label"),
      "Send message",
      "an attachment-only draft must be sendable",
    );
    NodeAssert.equal(await sendButton.isEnabled(), true, "the attachment send must enable");
    const draftUrl = page.url();
    await sendButton.click();
    await page.waitForURL((url) => url.href !== draftUrl && !/\/draft\//u.test(url.pathname), {
      timeout: 30_000,
    });
    await page.getByText("dropped.md", { exact: true }).last().waitFor({
      state: "visible",
      timeout: 20_000,
    });

    const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const sent = database
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(typeof sent?.text, "string");
      NodeAssert.ok(sent.text.includes('<pasted_context version="2">'));
      NodeAssert.ok(sent.text.includes(droppedBody));
      NodeAssert.equal(
        sent.text.split(droppedBody).length - 1,
        2,
        "both identical attachment bodies must survive the production send path",
      );
    } finally {
      database.close();
    }
    await stopRunningTurnForIsolation(page);

    await startNewLocalThread(page);
    const reloadBody = "# Persisted\n- Heading:\nbody restored after a full page reload";
    await page.getByTestId("composer-editor").evaluate((element, body) => {
      const data = new DataTransfer();
      data.items.add(new File([body], "reload.md", { type: "text/markdown" }));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    }, reloadBody);
    await page.getByText("reload.md", { exact: true }).first().waitFor({ state: "visible" });
    await page.waitForFunction(
      () => localStorage.getItem("t3code:composer-drafts:v1")?.includes("reload.md") === true,
      undefined,
      { timeout: 20_000 },
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("reload.md", { exact: true }).first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Remove reload.md" }).click();
    await page.getByText("reload.md", { exact: true }).waitFor({ state: "hidden" });
  },
);

spec(
  "send cannot race a text attachment that is still being read",
  async ({ page, webUrl, workspace, baseDir }) => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);
    const editor = page.getByTestId("composer-editor");
    await editor.pressSequentially("summarize the delayed attachment");

    const delayedBody = "delayed body that must belong to this exact turn";
    await editor.evaluate((element, body) => {
      const file = new File([body], "delayed.md", { type: "text/markdown" });
      Object.defineProperty(file, "text", {
        value: () =>
          new Promise((resolve) => {
            globalThis.__resolveDelayedTextAttachment = () => resolve(body);
          }),
      });
      const data = new DataTransfer();
      data.items.add(file);
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    }, delayedBody);

    const sendButton = page
      .locator('[data-chat-composer-form="true"] button[type="submit"]')
      .last();
    await sendButton.click();
    await page.getByText("Still reading an attached text file.", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    NodeAssert.ok(
      (await editor.innerText()).includes("summarize the delayed attachment"),
      "the blocked send must preserve the prompt in the current draft",
    );

    await page.evaluate(() => globalThis.__resolveDelayedTextAttachment?.());
    await page.getByText("delayed.md", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const draftUrl = page.url();
    await sendButton.click();
    await page.waitForURL((url) => url.href !== draftUrl && !/\/draft\//u.test(url.pathname), {
      timeout: 30_000,
    });
    await page.getByText("delayed.md", { exact: true }).last().waitFor({
      state: "visible",
      timeout: 20_000,
    });

    const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const sent = database
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(typeof sent?.text, "string");
      NodeAssert.ok(sent.text.includes("summarize the delayed attachment"));
      NodeAssert.ok(sent.text.includes(delayedBody));
    } finally {
      database.close();
    }
    await stopRunningTurnForIsolation(page);
  },
);

spec(
  "oversized Memo failure releases send and a retry persists a bounded reference",
  async ({ page, webUrl, workspace, baseDir, consoleErrors }) => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await startNewLocalThread(page);

    const oversized = "memo overflow\n".padEnd(132_277, "m");
    const attachOversizedFile = async () => {
      const editor = page.getByTestId("composer-editor");
      await editor.evaluate((element, text) => {
        const data = new DataTransfer();
        data.items.add(new File([text], "oversized.md", { type: "text/markdown" }));
        element.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      }, oversized);
      await page.getByRole("button", { name: "Remove oversized.md" }).waitFor({
        state: "visible",
        timeout: 20_000,
      });
      return editor;
    };
    const sendButton = () =>
      page.locator('[data-chat-composer-form="true"] button[type="submit"]').last();

    const firstEditor = await attachOversizedFile();
    await firstEditor.pressSequentially("summarize the complete attachment");
    let failMemoRequest = true;
    await page.route("**/api/memory/attachment", async (route) => {
      if (failMemoRequest) {
        failMemoRequest = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, message: "Simulated Memo persistence failure." }),
        });
        return;
      }
      await route.continue();
    });

    await sendButton().click();
    await page.getByText("Simulated Memo persistence failure.", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
    const expectedMemoErrorIndex = consoleErrors.findIndex((message) =>
      /status of 503 \(Service Unavailable\)/i.test(message),
    );
    if (expectedMemoErrorIndex >= 0) consoleErrors.splice(expectedMemoErrorIndex, 1);
    NodeAssert.ok(
      (await firstEditor.innerText()).includes("summarize the complete attachment"),
      "a failed Memo write must preserve the draft",
    );
    NodeAssert.equal(
      await sendButton().isEnabled(),
      true,
      "the failed send must release its latch",
    );

    await page.getByRole("button", { name: "Remove oversized.md" }).click();
    const failedDraftUrl = page.url();
    await sendButton().click();
    await page
      .waitForURL((url) => url.href !== failedDraftUrl && !/\/draft\//u.test(url.pathname), {
        timeout: 30_000,
      })
      .catch(async (cause) => {
        throw new Error(
          `the same-page retry did not commit; url=${page.url()} body=${(await page.locator("body").innerText()).slice(-1_000)}`,
          { cause },
        );
      });
    await stopRunningTurnForIsolation(page);

    await startNewLocalThread(page);
    const secondEditor = await attachOversizedFile();
    await secondEditor.pressSequentially("use Memo for the complete attachment");
    const memoDraftUrl = page.url();
    await sendButton().click();
    await page
      .waitForURL((url) => url.href !== memoDraftUrl && !/\/draft\//u.test(url.pathname), {
        timeout: 30_000,
      })
      .catch(async (cause) => {
        throw new Error(
          `the real-Memo send did not commit; url=${page.url()} body=${(await page.locator("body").innerText()).slice(-1_000)}`,
          { cause },
        );
      });
    await page.getByText("Full text saved to local Memo", { exact: true }).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    const database = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/state.sqlite"), {
      readOnly: true,
    });
    try {
      const sent = database
        .prepare(
          "SELECT text FROM projection_thread_messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1",
        )
        .get();
      NodeAssert.equal(typeof sent?.text, "string");
      NodeAssert.ok(sent.text.includes("<memo_document>"));
      NodeAssert.ok(sent.text.includes("Characters: 132277"));
      NodeAssert.ok(sent.text.includes('connector="local"'));
      NodeAssert.ok(sent.text.length < 120_000, "the provider payload must stay below its limit");
      NodeAssert.ok(!sent.text.includes(oversized), "the full document must not be sent inline");
    } finally {
      database.close();
    }
    await stopRunningTurnForIsolation(page);
  },
);

spec("podcast transport works in a real browser", async ({ page }) => {
  await page.evaluate(async () => {
    const container = document.createElement("div");
    container.id = "podcast-player-e2e";
    document.body.append(container);
    const fixture = await import("/e2e/PodcastPlayerFixture.tsx");
    fixture.mountPodcastPlayerFixture(container);
  });

  const fixture = page.locator("#podcast-player-e2e");
  await fixture.getByText("one.wav", { exact: true }).waitFor({ state: "visible" });
  NodeAssert.equal(await fixture.getByText("1/2", { exact: true }).count(), 1);
  NodeAssert.equal(
    await fixture.getByRole("button", { name: "Previous audio" }).isDisabled(),
    true,
  );
  NodeAssert.equal(await fixture.getByRole("button", { name: "Next audio" }).isEnabled(), true);

  await fixture.getByRole("button", { name: "Next audio" }).click();
  await fixture.getByText("two.wav", { exact: true }).waitFor({ state: "visible" });
  NodeAssert.equal(await fixture.getByText("2/2", { exact: true }).count(), 1);
  NodeAssert.equal(await fixture.getByRole("button", { name: "Previous audio" }).isEnabled(), true);
  NodeAssert.equal(await fixture.getByRole("button", { name: "Next audio" }).isDisabled(), true);

  const speed = fixture.getByRole("button", { name: "Playback speed" });
  await speed.click();
  NodeAssert.equal(await speed.innerText(), "1.25×");
  for (let index = 0; index < 4; index += 1) await speed.click();
  NodeAssert.equal(await speed.innerText(), "1×", "the advertised playback rates must wrap");

  const audio = fixture.locator("audio");
  await page.waitForFunction(
    () => {
      const element = document.querySelector("#podcast-player-e2e audio");
      return element instanceof HTMLAudioElement && Number.isFinite(element.duration);
    },
    undefined,
    { timeout: 10_000 },
  );
  await fixture.getByRole("button", { name: "Forward 15 seconds" }).click();
  NodeAssert.ok(
    (await audio.evaluate((element) => element.currentTime)) > 2.5,
    "forward must clamp to the real track duration instead of stale React state",
  );
  await fixture.getByRole("button", { name: "Back 15 seconds" }).click();
  NodeAssert.equal(await audio.evaluate((element) => element.currentTime), 0);
  await fixture.getByRole("slider", { name: "Seek" }).fill("1.5");
  NodeAssert.ok(
    Math.abs((await audio.evaluate((element) => element.currentTime)) - 1.5) < 0.15,
    "seek must update the real audio element",
  );

  const play = fixture.getByRole("button", { name: "Play", exact: true });
  await play.waitFor({ state: "visible" });
  await play.click();
  await fixture.getByRole("button", { name: "Pause", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await fixture.getByRole("button", { name: "Pause", exact: true }).click();
  await fixture.getByRole("button", { name: "Play", exact: true }).waitFor({ state: "visible" });

  await fixture.getByRole("button", { name: "Remove audio artifact" }).click();
  await fixture.getByText("one.wav", { exact: true }).waitFor({ state: "visible" });
  NodeAssert.equal(await fixture.getByText(/\/2$/, { exact: false }).count(), 0);
  NodeAssert.equal(await fixture.getByRole("button", { name: "Next audio" }).count(), 0);

  await page.evaluate(async () => {
    const fixtureModule = await import("/e2e/PodcastPlayerFixture.tsx");
    fixtureModule.unmountPodcastPlayerFixture();
    document.querySelector("#podcast-player-e2e")?.remove();
  });
});

spec(
  "skills settings rejects local repository URLs through the real route",
  async ({ page, webUrl, consoleErrors }) => {
    await page.goto(`${webUrl}/settings/skills`, { waitUntil: "domcontentloaded" });
    const input = page.getByRole("textbox", { name: "Skill repository URL" }).first();
    await input.waitFor({ state: "visible", timeout: 20_000 });
    await input.fill("file:///tmp/not-a-repository");
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/skills/install") && response.request().method() === "POST",
      { timeout: 20_000 },
    );
    const priorConsoleErrorCount = consoleErrors.length;
    await page.getByRole("button", { name: "Install", exact: true }).first().click();
    const response = await responsePromise;
    NodeAssert.equal(response.status(), 400, "local filesystem URLs must fail at the server route");
    await page.getByText("Expected an https or ssh git URL.").first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    // Chromium reports an expected 4xx fetch as a generic console resource
    // error. The response and rendered error above are asserted explicitly, so
    // remove only the message emitted during this deliberately rejected call.
    consoleErrors.splice(
      priorConsoleErrorCount,
      consoleErrors.length - priorConsoleErrorCount,
      ...consoleErrors
        .slice(priorConsoleErrorCount)
        .filter((message) => !/status of 400 \(Bad Request\)/i.test(message)),
    );
  },
);

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

spec(
  "tasks panel opens from local tools for a fresh thread",
  async ({ page, webUrl, workspace }) => {
    await page.goto(webUrl, { waitUntil: "domcontentloaded" });
    await openProject(page, workspace);
    await page
      .getByRole("button", { name: /open local tools/i })
      .first()
      .click();
    await page.getByRole("menuitem", { name: /^Tasks/ }).click();
    await page.getByText("No active plan yet.", { exact: true }).waitFor({
      state: "visible",
      timeout: 20_000,
    });
  },
);

// The Ollama preset is the only path from a stock install to Ollama-served
// models, so assert against the *live* daemon roster rather than the bundled
// fallback list — a stale hardcoded roster is exactly the bug this guards.
// The file preview panel is a lazily loaded chunk — the surface that broke
// when a stale tab fetched renamed chunks and got index.html back. Opening a
// real file end-to-end proves the chunk loads and the file actually renders.
spec("files panel opens a workspace file", async ({ page, webUrl, workspace }) => {
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await openProject(page, workspace);

  const addSurface = page.getByRole("button", { name: /add panel surface/i }).first();
  if (await addSurface.isVisible().catch(() => false)) {
    await addSurface.click();
    await page.getByRole("menuitem", { name: /files/i }).first().click();
  } else {
    // A closed panel exposes Files through the persistent local-tools menu.
    await page.getByRole("button", { name: /open local tools/i }).click();
    await page.getByRole("menuitem", { name: /^Files/ }).click();
  }

  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("*")).some((element) =>
        element.shadowRoot?.querySelector('[data-item-path="README.md"]'),
      ),
    undefined,
    { timeout: 20_000 },
  );
  const clicked = await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) {
      const button = element.shadowRoot?.querySelector('[data-item-path="README.md"]');
      if (button instanceof HTMLElement) {
        button.click();
        return true;
      }
    }
    return false;
  });
  NodeAssert.equal(clicked, true, "expected the shadow-root file row to be clickable");
  // The fixture README's heading is rendered by another web component, so
  // assert composed text rather than pretending Playwright pierces shadow DOM.
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("e2e fixture") ||
      Array.from(document.querySelectorAll("*")).some((element) =>
        element.shadowRoot?.textContent?.includes("e2e fixture"),
      ),
    undefined,
    { timeout: 20_000 },
  );
});

spec(
  "Ollama preset lists live cloud models on a Claude instance",
  async ({ page, webUrl, baseDir }) => {
    const liveTags = await fetch("http://127.0.0.1:11434/api/tags")
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const cloudModels = (liveTags?.models ?? [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === "string" && /:cloud$|-cloud$/.test(name));
    if (cloudModels.length === 0) {
      console.log("SKIP Ollama preset — no local daemon or no :cloud tags");
      return;
    }

    await page.goto(`${webUrl}/settings/providers`, { waitUntil: "domcontentloaded" });
    // The action lives inside the Claude instance's collapsed details. The
    // disclosure is labelled "Show <name> details" (not "Details"), and expanding
    // a card flips its label to "Hide ...", so never index into the match list —
    // the indices shift underneath you. Target Claude by name.
    await page
      .getByRole("button", { name: "Show Claude details" })
      .first()
      .click({ timeout: 20_000 });
    const presetButton = page.getByTestId("ollama-preset-button").first();
    await presetButton.waitFor({ state: "visible", timeout: 20_000 });
    await presetButton.click();

    const hint = page.getByTestId("ollama-preset-hint").first();
    await hint.waitFor({ state: "visible", timeout: 20_000 });
    const hintText = await hint.innerText();
    NodeAssert.ok(
      /Discovered \d+ Ollama model/.test(hintText),
      `expected a discovery hint, saw: ${hintText}`,
    );

    const settingsPath = NodePath.join(baseDir, "userdata/settings.json");
    let found = [];
    for (let attempt = 0; attempt < 50 && found.length === 0; attempt += 1) {
      const persisted = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
      const configuredModels = new Set(
        Object.values(persisted.providerInstances ?? {}).flatMap(
          (instance) => instance?.config?.customModels ?? [],
        ),
      );
      found = cloudModels.filter((model) => configuredModels.has(model));
      if (found.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    NodeAssert.ok(
      found.length > 0,
      `expected a live :cloud model in persisted provider settings; looked for ${cloudModels.join(", ")}`,
    );
    console.log(`  (matched live cloud models: ${found.join(", ")})`);
  },
);

async function main() {
  const requestedSpec = process.env.T3_E2E_SPEC?.trim().toLowerCase();
  const selectedSpecs = requestedSpec
    ? specs.filter(({ name }) => name.toLowerCase().includes(requestedSpec))
    : specs;
  if (selectedSpecs.length === 0) {
    throw new Error(`No e2e spec matches T3_E2E_SPEC=${process.env.T3_E2E_SPEC}`);
  }
  const app = await startIsolatedApp();
  let session;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= Promise.all([
      session?.browser.close().catch(() => {}),
      stopIsolatedApp(app),
    ]).then(() => undefined);
    return cleanupPromise;
  };
  let signalExitCode = null;
  const stopAfterSignal = (exitCode) => {
    if (signalExitCode !== null) return;
    signalExitCode = exitCode;
    void cleanup();
  };
  const onInterrupt = () => stopAfterSignal(130);
  const onTerminate = () => stopAfterSignal(143);
  // Detached dev-server process groups outlive the parent unless signals are
  // handled explicitly. Keep interrupted local/CI runs as isolated as passes.
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const failures = [];
  try {
    session = await openAuthenticatedPage(app);
    for (const { name, run } of selectedSpecs) {
      if (signalExitCode !== null) break;
      try {
        // Specs share the expensive isolated app/browser, but never each
        // other's responsive state or open popovers. Specs navigate explicitly
        // when they need a fresh route; avoid reconnecting the config stream
        // and refreshing every provider merely to reset visual state.
        await session.page.setViewportSize({ width: 1440, height: 900 });
        await session.page.keyboard.press("Escape");
        await run({
          ...session,
          webUrl: app.webUrl,
          workspace: app.workspace,
          baseDir: app.baseDir,
          agentHome: app.agentHome,
        });
        console.log(`PASS ${name}`);
      } catch (cause) {
        if (signalExitCode !== null) break;
        failures.push(name);
        console.error(`FAIL ${name}\n  ${cause instanceof Error ? cause.message : cause}`);
      }
    }
    if (signalExitCode === null) {
      const unexpected = session.consoleErrors.filter(
        (message) => !/favicon|manifest|401|WebSocket/i.test(message),
      );
      if (unexpected.length > 0) {
        failures.push("console clean");
        console.error(`FAIL console clean\n  ${unexpected.slice(0, 3).join("\n  ")}`);
      } else {
        console.log("PASS console clean");
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await cleanup();
  }

  if (signalExitCode !== null) {
    process.exitCode = signalExitCode;
    return;
  }

  console.log(`\n${selectedSpecs.length + 1 - failures.length}/${selectedSpecs.length + 1} passed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
