import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
let startIsolatedApp, openAuthenticatedPage, openProject, stopIsolatedApp;

const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const results = [];
const scriptSha256 = NodeCrypto.createHash("sha256")
  .update(await NodeFSP.readFile(NodeURL.fileURLToPath(import.meta.url)))
  .digest("hex");
const harnessSha256 = NodeCrypto.createHash("sha256")
  .update(await NodeFSP.readFile(new URL("./harness.mjs", import.meta.url)))
  .digest("hex");
const startedAt = Date.now();
const serverBin = process.env.T3_PWA_TEST_SERVER_BIN
  ? NodePath.resolve(process.env.T3_PWA_TEST_SERVER_BIN)
  : undefined;
const onlyRoutes = process.env.QA_ROUTES?.split(",");
const scratchRoot = process.env.QA_SCRATCH ?? NodeOS.tmpdir();
const routes = [];
const visitedPages = new Map();
const visitedRoutes = new Set();
const requiredMainSurfaces = [
  "project add and open",
  "palette keyboard shortcut",
  "new thread and composer",
  "composer controls",
  "sidebar",
  "Nia",
  "notes",
];
const mainSurfaces = new Map();
let traversalCompleted = false;
let budgetGap = null;
let budgetRow = null;
const coverageGaps = [];
const out = process.env.QA_OUT
  ? NodePath.resolve(process.env.QA_OUT)
  : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d4-qa-report-"));
await NodeFSP.mkdir(out, { recursive: true });
const scratch = await NodeFSP.mkdtemp(NodePath.join(scratchRoot, "d4-qa-runtime-"));
const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  // standalone browser harness has no Effect runtime.
  (NodeOS.platform() === "darwin"
    ? NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright")
    : NodePath.join(NodeOS.homedir(), ".cache/ms-playwright"));
const clean = (value) =>
  String(value)
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[URL redacted]")
    .replace(
      /\b(token|secret|password|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
const dangerous =
  /\b(delete|remove|reset|uninstall|sign[ -]?out|log[ -]?out|revoke|updat(?:e|es)|restart|install|restore|clear|purge|disconnect|forget|terminate|kill|discard|accept|reject)\b/i;
const selector =
  'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="switch"], [role="checkbox"], [role="combobox"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [contenteditable="true"]';
let app,
  session,
  page,
  stopping = false,
  acquiring = true,
  cleanupPromise;
let activePage = "startup",
  activeControl = "boot";
const errors = new Map();
let transportFailure = false;
let pageFailure = null;
let currentContext = null;
const externalServices = new Set();
const scannedOverlays = new Set();
const themeEditorControls = new Set();
const sharedChrome = new Set();
let routeDeadline = Infinity;
let routeBudgetReported = false;
const routeTimings = [];
const sampling = [];
const sampledControls = new Set();
const samplingGroups = new Map();

async function record(status, control, reason, pageName = activePage) {
  const row = { page: clean(pageName), control: clean(control), status, reason: clean(reason) };
  if (status === "fail")
    row.classification = /Maximum update depth|Minified React error|pageerror/.test(
      reason + control,
    )
      ? "app bug"
      : "bot bug";
  if (
    status === "fail" &&
    pageName === "/settings/appearance" &&
    /^button: Preview apps\/web\/src\//.test(control) &&
    reason === "No observable effect after clicking the control"
  ) {
    row.classification = "app bug";
    row.sources = [
      "apps/web/src/components/settings/SettingsFontPreviews.tsx:38",
      "apps/web/src/components/ComposerPromptEditorTiptap.tsx:270",
      "apps/web/src/components/composerContextPresentation.tsx:86",
    ];
    row.reason +=
      "; the font preview provides no actions context, so the visible Preview button calls the default no-op openMention handler";
  }
  results.push(row);
  if (status === "fail") {
    row.screenshot = `failure-${String(results.length).padStart(5, "0")}.png`;
    try {
      if (!page || page.isClosed() || new URL(page.url()).pathname === "/pair")
        throw new Error("Browser page unavailable");
      await page.screenshot({
        path: NodePath.join(out, row.screenshot),
        timeout: 5000,
        mask: [page.locator('input[type="password"], [data-qa-secret]')],
      });
      row.evidence = `failure-${String(results.length).padStart(5, "0")}.txt`;
      await NodeFSP.writeFile(
        NodePath.join(out, row.evidence),
        clean(await page.locator("body").innerText()).slice(0, 50000),
      );
    } catch (error) {
      row.screenshot = null;
      row.screenshotError = clean(error.message);
    }
  }
  console.log(`${status.toUpperCase()} ${row.page} :: ${row.control} :: ${row.reason}`);
  return row;
}
async function attempt(control, run) {
  if (stopping) return false;
  activeControl = control;
  try {
    await run();
    if (activePage === "main" && requiredMainSurfaces.includes(control))
      mainSurfaces.set(control, true);
    return true;
  } catch (error) {
    if (stopping || transportFailure || pageFailure === activePage) return false;
    await record("fail", control, error.message);
    return false;
  }
}
async function flushErrors() {
  for (const error of errors.values()) {
    if (error.row || error.recording) continue;
    error.recording = true;
    error.row = await record("fail", error.control, error.message, error.page);
    error.row.occurrences = error.count;
  }
}
async function ready() {
  if (new URL(page.url()).pathname.startsWith("/settings/")) {
    const content = page.locator('[data-workspace-area="settings"]');
    await content.waitFor({ timeout: 15000 });
    await page.waitForFunction(
      () => {
        const area = document.querySelector('[data-workspace-area="settings"]');
        return (
          area &&
          area.querySelector('h1,h2,h3,section,[role="switch"],p') &&
          !/^(Loading|Connecting)[.…\s]*$/i.test(area.textContent.trim())
        );
      },
      undefined,
      { timeout: 15000 },
    );
    if (new URL(page.url()).pathname === "/settings/providers")
      await content
        .getByRole("button", { name: "Add provider", exact: true })
        .first()
        .waitFor({ timeout: 15000 });
  } else if (new URL(page.url()).pathname === "/usage") {
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor({ timeout: 15000 });
  } else {
    await page
      .locator('[data-sidebar="sidebar"]')
      .filter({ visible: true })
      .first()
      .waitFor({ timeout: 10000 });
    if (/\/(draft|thread)\//.test(new URL(page.url()).pathname)) {
      await page.locator('[data-chat-composer-form="true"]').waitFor({ timeout: 10000 });
    }
  }
}
async function visit(route) {
  await flushErrors();
  activePage = route;
  pageFailure = null;
  activeControl = "page content";
  await page.goto(new URL(route, app.webUrl).href, { waitUntil: "domcontentloaded" });
  await ready();
}
async function inventory(scope) {
  return scope.locator(selector).evaluateAll((elements) => {
    const counts = new Map();
    return elements
      .filter(
        (el) =>
          el.getClientRects().length &&
          !el.closest('[aria-hidden="true"]') &&
          getComputedStyle(el).visibility !== "hidden",
      )
      .map((el) => {
        const visibleLabel = el.cloneNode(true);
        visibleLabel
          .querySelectorAll('[aria-hidden="true"], [hidden], svg')
          .forEach((node) => node.remove());
        const label =
          el.getAttribute("aria-label") ||
          (el.getAttribute("aria-labelledby") || "")
            .split(" ")
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim() ||
          Array.from(el.labels ?? [])
            .map((l) => l.textContent)
            .join(" ")
            .trim() ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          (() => {
            const walker = document.createTreeWalker(visibleLabel, NodeFilter.SHOW_TEXT);
            const words = [];
            while (walker.nextNode()) words.push(walker.currentNode.textContent);
            return words.join(" ").trim();
          })() ||
          el.getAttribute("name") ||
          "(unlabelled)";
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || tag;
        const region = el.closest('[role="tabpanel"],section,[role="dialog"]');
        const contextKey =
          region?.querySelector("h1,h2,h3")?.textContent || region?.getAttribute("role") || "";
        const normalizedLabel = label.replace(/\s+/g, " ").trim();
        const key = `${contextKey}|${tag}|${role}|${normalizedLabel}`;
        const ordinal = counts.get(key) ?? 0;
        counts.set(key, ordinal + 1);
        const id =
          el.getAttribute("data-qa-control") || `qa-${Math.random().toString(36).slice(2)}`;
        el.setAttribute("data-qa-control", id);
        const nativeAttribute = [
          "data-chat-session-skill",
          "data-testid",
          "aria-label",
          "placeholder",
          "name",
        ].find((attr) => el.getAttribute(attr));
        const nativeSelector = nativeAttribute
          ? `${tag}[${nativeAttribute}=${JSON.stringify(el.getAttribute(nativeAttribute))}]`
          : null;
        return {
          internal:
            el.matches("input,textarea,select") &&
            (getComputedStyle(el).opacity === "0" ||
              getComputedStyle(el).clip !== "auto" ||
              getComputedStyle(el).clipPath !== "none" ||
              (el.getBoundingClientRect().width <= 1 && el.getBoundingClientRect().height <= 1)),
          installAction:
            Boolean(el.closest('[aria-labelledby="acp-registry-search-heading"]')) &&
            /^Add /.test(normalizedLabel),
          shape: (() => {
            if (
              location.pathname.endsWith("/threads") &&
              /^(Amount|Time|Unit|When|Increase|Decrease)$/.test(normalizedLabel)
            )
              return `snooze preset ${role} ${normalizedLabel}`;
            if (
              location.pathname.endsWith("/providers") &&
              role === "button" &&
              /^Select /.test(normalizedLabel) &&
              el.closest('[data-slot="settings-row"]')
            )
              return "provider instance rows";
            if (
              el.closest('[aria-labelledby="acp-registry-search-heading"]') &&
              /^Add /.test(normalizedLabel)
            )
              return "registry installation rows";
            if (
              role === "option" &&
              el
                .closest('[role="dialog"]')
                ?.querySelector('[placeholder="Search commands, projects, and threads..."]')
            )
              return "command palette rows";
            if (/^note\s*: qa-proposal-/.test(normalizedLabel)) return "proposal rows";
            if (role === "menuitemcheckbox") return "checkbox menu rows";
            if (role === "menuitemradio") {
              const menu = el.closest('[role="menu"]');
              const owner = document.getElementById(menu?.getAttribute("aria-labelledby") ?? "");
              return `radio menu rows: ${owner?.getAttribute("aria-label")?.split(":")[0] ?? owner?.textContent?.trim() ?? contextKey}`;
            }
            if (/^(Send orb|Stop orb) /.test(normalizedLabel))
              return normalizedLabel.split(" ").slice(0, 2).join(" ") + " color rows";
            if (tag === "a" && /^https?:/.test(el.getAttribute("href") ?? ""))
              return "external links";
            if (el.closest("article") && location.pathname.endsWith("open-source-licenses"))
              return `${role} license rows`;
            if (/^Use .+ (light|dark) mode$/.test(normalizedLabel))
              return normalizedLabel.replace(/^Use .+ (light|dark) mode$/, "$1 theme rows");
            if (/^Use .+ theme/.test(normalizedLabel)) return "theme title rows";
            if (/^Duplicate /.test(normalizedLabel)) return "theme duplicate rows";
            if (el.closest("[data-model-slug]"))
              return `${role}|${el.getAttribute("type")}|${normalizedLabel
                .replace(/^(Move ).+ (up|down)$/, "$1$2")
                .replace(/^Display name for .+$/, "Display name")
                .replace(/^(Show|Hide|Add|Remove) .+$/, "$1 model")}|model rows`;
            if (/^Edit (when clause|shortcut) for /.test(normalizedLabel))
              return normalizedLabel.match(/^Edit (when clause|shortcut)/)[0];
            if (el.closest("[data-theme-color-role]"))
              return `${role}|${el.getAttribute("type")}|${normalizedLabel
                .replace(/^(Show|Hide) .+ usage$/, "$1 color usage")
                .replace(/^Choose .+ color$/, "Choose color")
                .replace(/^.+ hex value$/, "hex value")}|theme color rows`;
            return null;
          })(),
          modelSlug: el.closest("[data-model-slug]")?.getAttribute("data-model-slug") ?? null,
          nativeSelector,
          id,
          domPath: (() => {
            const parts = [];
            let node = el;
            while (node && node !== document.body) {
              const peers = Array.from(node.parentElement?.children ?? []).filter(
                (x) => x.tagName === node.tagName,
              );
              parts.unshift(
                `${node.tagName.toLowerCase()}:nth-of-type(${peers.indexOf(node) + 1})`,
              );
              node = node.parentElement;
            }
            return `body > ${parts.join(" > ")}`;
          })(),
          label: normalizedLabel,
          tag,
          role,
          ordinal,
          key,
          type: el.getAttribute("type"),
          numeric: el.matches(
            '[type="range"],[type="number"],[inputmode="numeric"],[inputmode="decimal"],[role="spinbutton"]',
          ),
          href: el.getAttribute("href"),
          target: el.getAttribute("target"),
          expanded: el.getAttribute("aria-expanded"),
          popup: el.getAttribute("aria-haspopup"),
          disabled: el.matches(":disabled,[aria-disabled=true]"),
          readonly: el.readOnly,
          context: el.closest("section")?.textContent?.slice(0, 500) ?? "",
        };
      })
      .filter((item) => !item.internal);
  });
}
async function locate(item, scope) {
  const mark = async (loc) => {
    await loc.evaluate((el, id) => el.setAttribute("data-qa-control", id), item.id);
    return loc;
  };
  if (item.modelSlug) {
    const row = scope.locator(`[data-model-slug=${JSON.stringify(item.modelSlug)}]`);
    await row.waitFor({ state: "visible", timeout: 2000 });
    const direction = item.label.match(/^Move .+ (up|down)$/)?.[1];
    if (direction) {
      const move = row.locator(`button[aria-label^="Move "][aria-label$=" ${direction}"]`);
      await move.waitFor({ state: "visible", timeout: 2000 });
      return mark(move);
    }
    if (/^Display name for /.test(item.label))
      return mark(row.locator('input[aria-label^="Display name for "]'));
    if (/^Show .+ in the model picker$/.test(item.label)) return mark(row.getByRole("switch"));
  }
  const dynamicPrefix =
    (/^Use .+ theme(?:, currently active)?$/.test(item.label)
      ? item.label.replace(/, currently active$/, "")
      : null) ??
    item.label.match(
      /^(Filter threads by project|Project scope:|Environment scope:|Thread details:|Provider, step 1|Identity, step 2|Config, step 3)/,
    )?.[1];
  if (dynamicPrefix) {
    const dynamic = scope.locator(`[aria-label^=${JSON.stringify(dynamicPrefix)}]`);
    await dynamic.waitFor({ state: "visible", timeout: 2000 });
    return mark(dynamic);
  }
  if (activePage === "/usage" && item.popup === "menu" && !item.nativeSelector) {
    const trigger = page.locator(item.domPath);
    if ((await trigger.count()) === 1 && (await trigger.getAttribute("aria-haspopup")) === "menu")
      return mark(trigger);
  }
  if (item.role === "combobox" && !item.nativeSelector) {
    const structural = page.locator(item.domPath);
    if (
      (await structural.count()) === 1 &&
      (await structural.getAttribute("role")) === "combobox" &&
      (await structural.isVisible())
    )
      return mark(structural);
  }
  if (item.nativeSelector) {
    const native = scope.locator(item.nativeSelector);
    if ((await native.count()) === 0)
      await native
        .first()
        .waitFor({ state: "visible", timeout: 1500 })
        .catch(() => {});
    if ((await native.count()) === 1) return mark(native);
  }
  const role = item.tag === "a" ? "link" : item.role;
  if (
    [
      "button",
      "link",
      "combobox",
      "switch",
      "tab",
      "radio",
      "option",
      "menuitem",
      "menuitemradio",
      "menuitemcheckbox",
    ].includes(role)
  ) {
    const semantic = scope.getByRole(role, { name: item.label, exact: true });
    if ((await semantic.count()) === 0)
      await semantic
        .first()
        .waitFor({ state: "visible", timeout: 1500 })
        .catch(() => {});
    if ((await semantic.count()) > item.ordinal) return mark(semantic.nth(item.ordinal));
  }
  const existing = page.locator(`[data-qa-control="${item.id}"]`);
  if ((await existing.count()) === 1) return existing;
  if (["input", "textarea", "select"].includes(item.tag) || item.role === "combobox") {
    const structural = page.locator(item.domPath);
    if (
      (await structural.count()) === 1 &&
      (item.role !== "combobox" || (await structural.getAttribute("role")) === "combobox")
    )
      return mark(structural);
  }
  const match = (await inventory(scope)).find(
    (candidate) => candidate.key === item.key && candidate.ordinal === item.ordinal,
  );
  NodeAssert.ok(match, `Control disappeared: ${item.label}`);
  return page.locator(match.domPath);
}
async function state(loc, property) {
  return loc.evaluate(
    (el, prop) =>
      prop === "checked"
        ? (el.getAttribute("aria-checked") ?? String(el.checked))
        : prop === "expanded"
          ? el.tagName === "SUMMARY"
            ? String(el.parentElement.open)
            : el.getAttribute("aria-expanded")
          : prop === "value"
            ? (el.value ?? el.textContent)
            : prop === "text"
              ? el.innerText.trim()
              : el.getAttribute(prop),
    property,
  );
}
async function expectState(loc, property, expected, different = false) {
  const end = Date.now() + 2000;
  let actual;
  do {
    actual = await state(loc, property).catch(() => undefined);
    if (actual !== undefined && (different ? actual !== expected : actual === expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < end);
  NodeAssert.fail(
    `Control ${property}: expected ${different ? "different from " : ""}${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
  );
}
async function expectObserved(read, expected, message) {
  const deadline = Date.now() + 3000;
  let actual;
  do {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  NodeAssert.deepEqual(actual, expected, message);
}
function dependency(item) {
  if (
    item.tag === "a" &&
    item.href &&
    new URL(item.href, app.webUrl).origin === new URL(app.webUrl).origin
  )
    return null;
  const label = item.label;
  if (
    activePage === "/settings/source-control" &&
    /^Use a separate (review guide|source control writer) model$/.test(label)
  )
    return "Dedicated source-control model selection requires an available provider model; provider CLIs and credentials are absent from the disposable HOME";
  if (item.role === "menuitemcheckbox") return null;
  if (/^Send (orb |shortcut$)/i.test(label)) return null;
  if (
    /^(Dracula|Catppuccin|Nord|Tokyo Night)$/.test(label) &&
    activePage === "/settings/appearance"
  )
    return "Open VSX theme registry service is unavailable in the isolated fixture";
  if (/^(Inspect API|Recent operations)$/i.test(label)) return "Meko MCP service is not configured";
  if (
    label === "Environment disconnected" ||
    (label === "Enable a provider in Settings" && item.type === "submit" && item.disabled)
  )
    return "Provider CLI and provider credentials are absent from the disposable HOME";
  if (item.type === "password" || /^(api key|access token|password|secret)\b/i.test(label))
    return "Provider credential is absent from the disposable HOME";
  if (
    /^(sign in|log in|authenticate|continue with |send|submit|run |execute|start |enable nia|triage an issue)/i.test(
      label,
    )
  )
    return "Provider CLI and provider credentials are absent from the disposable HOME";
  if (/^(connect\b|pair\b|machine over ssh|EAS Simulator)/i.test(label))
    return "Remote environment or SSH service is not configured";
  if (/ollama/i.test(label)) return "Ollama service is not configured";
  if (/^(microphone|record|dictat)/i.test(label))
    return "Microphone capture OS capability is not provisioned in the isolated browser";
  if (/^(open.*editor|open keybindings)/i.test(label))
    return "Native desktop editor OS capability is not provisioned in the isolated browser";
  if (/^open.*folder/i.test(label))
    return "Native desktop file manager OS capability is not provisioned in the isolated browser";
  if (/^(retry monitor|refresh resource|refresh process)/i.test(label))
    return "Mission Control service is not configured";
  if (/^(refresh limits|refresh provider)/i.test(label))
    return "Provider CLI and provider credentials are absent from the disposable HOME";
  if (/^check versions/i.test(label))
    return "External package registry service is unavailable in the isolated fixture";
  if (/^verify/i.test(label) && activePage.includes("tool-guard"))
    return "Tool Guard service is not configured";
  if (item.role === "switch" || item.type === "checkbox") {
    if (/enable nia|agent monitor/i.test(label))
      return "Nia provider credentials are absent from the disposable HOME";
    if (/Tool Guard/i.test(label)) return "Tool Guard service is not configured";
    if (/voice server/i.test(label)) return "Voice server service is not configured";
    if (/MCP server/i.test(label)) return "MCP server service is not configured";
    if (/remote tunnel/i.test(label)) return "Remote tunnel service is not configured";
  }
  return null;
}
async function exerciseUsagePriceSave(scope, reopen) {
  const model = "qa-price-fixture";
  const input = scope.getByRole("textbox", { name: `Input price for ${model}`, exact: true });
  if (!(await input.count())) {
    await scope.getByRole("button", { name: "Add model price", exact: true }).click();
    await scope.getByLabel("New model ID", { exact: true }).last().fill(model);
    await input.fill("1.25");
    await scope
      .getByRole("textbox", { name: `Output price for ${model}`, exact: true })
      .fill("2.5");
  } else {
    await input.fill((Number(await input.inputValue()) + 1).toString());
  }
  const expected = Number(await input.inputValue());
  await scope.getByRole("button", { name: "Save changes", exact: true }).click();
  const settingsPath = NodePath.join(app.baseDir, "userdata", "settings.json");
  await expectObserved(
    async () =>
      JSON.parse(await NodeFSP.readFile(settingsPath, "utf8")).usagePriceOverrides?.[model]
        ?.inputCostPerMillionTokens,
    expected,
    "Save changes did not persist the fixture model price",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready();
  await reopen();
  await expectState(
    scope.getByRole("textbox", { name: `Input price for ${model}`, exact: true }),
    "value",
    String(expected),
  );
  return record(
    "pass",
    "button: Save changes",
    "Valid disposable model price saved and verified in settings and after reload",
  );
}
async function scan(scope, seen = new Set(), depth = 0, reopen) {
  await scope.waitFor({ state: "visible" });
  const startUrl = page.url();
  const contextId = Symbol("scan");
  currentContext = contextId;
  const reset = async () => {
    if (currentContext === contextId && page.url() === startUrl && (await scope.isVisible()))
      return;
    if (reopen) await reopen();
    else {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await ready();
    }
    currentContext = contextId;
  };
  const ensureOpen = async () => {
    if (await scope.isVisible()) return;
    if (reopen?.openOnly) await reopen.openOnly();
    else await reset();
  };
  const discovered = await inventory(scope);
  const omitted = new Map();
  const items = discovered.filter((item) => {
    const key = `${item.key}|${item.ordinal}`;
    const fullKey = `${activePage}|${key}`;
    if (seen.has(key) || sampledControls.has(fullKey)) return false;
    if (!item.shape) return true;
    const groupKey = `${activePage}|${item.shape}`;
    let group = samplingGroups.get(groupKey);
    if (!group) {
      group = {
        page: activePage,
        shape: item.shape,
        retained: new Set(),
        omitted: new Set(),
        row: null,
      };
      samplingGroups.set(groupKey, group);
    }
    if (group.retained.has(fullKey)) return true;
    if (group.retained.size < 3) {
      group.retained.add(fullKey);
      return true;
    }
    group.omitted.add(fullKey);
    sampledControls.add(fullKey);
    omitted.set(groupKey, group);
    return false;
  });
  for (const group of omitted.values()) {
    const reason = `First 3 controls retained; ${group.omitted.size} repeated controls not exercised (external links are never activated)`;
    if (group.row) group.row.reason = reason;
    else group.row = await record("sampled", group.shape, reason);
  }
  const themeEditor = await scope.evaluate(
    (el) =>
      el.matches("[data-theme-editor-panel]") || Boolean(el.closest("[data-theme-editor-panel]")),
  );
  for (const item of items) {
    if (Date.now() > routeDeadline) {
      const remaining = items
        .filter((i) => !seen.has(`${i.key}|${i.ordinal}`))
        .map((i) => `${i.role}: ${i.label}`);
      if (!routeBudgetReported) {
        routeBudgetReported = true;
        budgetGap = { page: activePage, reason: "Route time budget exceeded", controls: remaining };
        coverageGaps.push(budgetGap);
        budgetRow = await record(
          "fail",
          "route time budget",
          `Remaining controls: ${remaining.join("; ")}`,
        );
      } else {
        budgetGap.controls = [...new Set([...budgetGap.controls, ...remaining])];
        budgetRow.reason = clean(`Remaining controls: ${budgetGap.controls.join("; ")}`);
      }
      break;
    }
    if (/^(Project scope:|Environment scope:)/.test(item.label)) {
      const sharedKey = item.label.split(":")[0];
      if (sharedChrome.has(sharedKey)) continue;
      sharedChrome.add(sharedKey);
    }
    if (stopping || pageFailure === activePage) {
      coverageGaps.push({
        page: activePage,
        reason: stopping
          ? "Run stopped after a root failure or deadline"
          : "Page crashed; subsequent controls were not attempted",
        controls: items
          .filter((i) => !seen.has(`${i.key}|${i.ordinal}`))
          .map((i) => `${i.role}: ${i.label}`),
      });
      break;
    }
    const key = `${item.key}|${item.ordinal}`;
    const familyKey = `${item.role}|${item.label}|${item.ordinal}`;
    if (seen.has(key) || (themeEditor && themeEditorControls.has(familyKey))) continue;
    if (themeEditor) themeEditorControls.add(familyKey);
    seen.add(key);
    const name = `${item.role}: ${item.label}${item.ordinal ? ` [${item.ordinal + 1}]` : ""}`;
    const succeeded = await attempt(name, async () => {
      if (
        item.installAction ||
        dangerous.test(item.label) ||
        /^(continue with|sign in|log in|authenticate)|^Add .*to favorites$|^Add to favorites$/i.test(
          item.label,
        ) ||
        (item.href &&
          (new URL(item.href, app.webUrl).origin !== new URL(app.webUrl).origin ||
            item.target === "_blank"))
      )
        return record(
          "skipped-destructive",
          name,
          item.installAction
            ? "Registry Add prepares a provider executable; installation action was not activated"
            : "Destructive or external control; not activated",
        );
      if (/^(Attach files|Attach|Choose files)$/i.test(item.label) && item.tag === "button") {
        await reset();
        const control = await locate(item, scope);
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 3000 }),
          control.click(),
        ]);
        await chooser.setFiles([]);
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Browser file chooser opened and was cancelled without selecting a file",
        );
      }
      if (
        item.label === "Add color" ||
        (item.label === "Custom hex accent color" &&
          (await scope.getByRole("button", { name: "Add color", exact: true }).count()))
      )
        return record(
          "skipped-destructive",
          name,
          "Adding an initially unset accent would require the forbidden Clear color action to restore it; not activated",
        );
      const required = dependency(item);
      if (
        item.label === "Environment disconnected" &&
        !results.some((result) => result.control === "Submit availability label") &&
        (await page.locator("body").innerText()).includes(
          "Enable a provider in Settings to send a message",
        )
      ) {
        const finding = await record(
          "fail",
          "Submit availability label",
          "The submit button's accessible label says Environment disconnected while the connected app asks the user to enable a provider",
        );
        finding.classification = "app bug";
        finding.sources = [
          "apps/web/src/components/chat/ChatComposer.tsx:7510",
          "apps/web/src/components/chat/ComposerPrimaryActions.tsx:285",
        ];
      }
      if (required) return record("blocked", name, required);
      await reset();
      const loc = await locate(item, scope);
      currentContext = null;
      if (!(await loc.isVisible()))
        throw new Error("Bot could not replay the control's visible discovery state");
      if (item.label === "Create theme" && !themeEditor) {
        await loc.click();
        const editor = page.locator('[data-theme-editor-panel][role="dialog"]');
        await editor.waitFor();
        const field = editor.getByRole("textbox").first();
        await field.fill("QA temporary theme");
        const create = editor.getByRole("button", { name: "Create theme", exact: true });
        NodeAssert.equal(await create.isEnabled(), true, "A theme name must enable creation");
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await editor.waitFor({ state: "hidden" });
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Theme editor opened; entering a name enabled creation; Cancel closed it without saving",
        );
      }
      if (item.label === "Search open-source licenses" && item.tag === "button") {
        await loc.click();
        const search = scope.locator(`input[aria-label=${JSON.stringify(item.label)}]`);
        await search.waitFor();
        await search.fill("qa-no-such-license-839274");
        await scope.getByText("No licenses match", { exact: false }).waitFor();
        await search.fill("");
        await search.press("Escape");
        await search.waitFor({ state: "hidden" });
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Search opened, filtered licenses to no matches, and closed with the full list restored",
        );
      }
      if (item.label === "Prompt font preview") {
        const original = await state(loc, "value");
        const originalButtons = await loc.locator("button").allTextContents();
        await loc.click();
        await loc.press("ControlOrMeta+End");
        await page.keyboard.insertText(" qa");
        await expectState(loc, "value", original + " qa");
        await loc.press("Backspace");
        await loc.press("Backspace");
        await loc.press("Backspace");
        await expectState(loc, "value", original);
        NodeAssert.deepEqual(
          await loc.locator("button").allTextContents(),
          originalButtons,
          "Prompt preview embedded controls were not preserved",
        );
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Appended and removed text through the editor; embedded skill and file controls preserved",
        );
      }
      if (
        item.label.startsWith("Remote link ") &&
        (await loc.getAttribute("aria-pressed")) === "true" &&
        (await scope.getByRole("button", { name: /^SSH / }).count()) === 0
      )
        return record(
          "blocked",
          name,
          "SSH alternative requires the Electron desktop SSH OS bridge; this browser exposes only the already-selected Remote link mode",
        );
      if (item.label === "Replay panel animation preview") {
        const panel = loc.locator(":scope > span").first();
        const original = await panel.getAttribute("class");
        await loc.click();
        await expectState(panel, "class", original, true);
        await loc.click();
        await expectState(panel, "class", original);
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Preview panel width class changed and reverse click restored it",
        );
      }
      if (activePage === "/settings/skills" && item.label === "Share e2e-default") {
        const [response] = await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/skills/share" &&
              response.request().method() === "POST",
            { timeout: 5000 },
          ),
          loc.click(),
        ]);
        const payload = await response.json();
        NodeAssert.ok(response.ok(), `Fixture skill sharing failed: ${payload.message}`);
        const target = NodePath.resolve(payload.targetPath);
        NodeAssert.ok(
          target.startsWith(NodePath.resolve(app.baseDir) + NodePath.sep),
          "Shared skill escaped the isolated app",
        );
        const source = NodePath.join(app.agentHome, ".agents", "skills", "e2e-default");
        NodeAssert.notEqual(target, source, "Share unexpectedly overwrote the source fixture");
        try {
          NodeAssert.equal(
            await NodeFSP.readFile(NodePath.join(target, "SKILL.md"), "utf8"),
            await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8"),
          );
        } finally {
          await NodeFSP.rm(target, { recursive: true, force: true });
        }
        currentContext = null;
        return record(
          "pass",
          name,
          "Share created the fixture skill at the reported isolated target; contents matched and the test-created target was removed",
        );
      }
      const scopeNotice = loc.locator('xpath=ancestor::div[p[@role="status"]][1]');
      if (
        item.tag === "button" &&
        item.label.includes(app.baseDir + NodePath.sep) &&
        (await scopeNotice.count()) === 1
      ) {
        const originalUrl = page.url();
        try {
          await loc.click();
          await page.waitForURL(
            (url) =>
              url.pathname === new URL(originalUrl).pathname &&
              Boolean(url.searchParams.get("project")),
            { timeout: 3000 },
          );
          await ready();
          NodeAssert.notEqual(
            page.url(),
            originalUrl,
            "Project scope notice did not select the project",
          );
        } finally {
          await page.goto(originalUrl, { waitUntil: "domcontentloaded" });
          await ready();
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Disposable project selected through its scope notice; original scope restored",
        );
      }
      if (
        activePage.startsWith("/settings/") &&
        item.tag === "button" &&
        /(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.test(item.label) &&
        (await scopeNotice.count()) === 1
      ) {
        const originalUrl = page.url();
        try {
          await loc.click();
          await page.waitForURL(
            (url) =>
              url.pathname === new URL(originalUrl).pathname &&
              Boolean(url.searchParams.get("machine")),
            { timeout: 3000 },
          );
          const selectedUrl = page.url();
          NodeAssert.notEqual(
            selectedUrl,
            originalUrl,
            "Environment notice did not change the selected machine",
          );
          await ready();
          NodeAssert.equal(
            await scopeNotice.count(),
            0,
            "Environment notice remained after selecting its owner",
          );
        } finally {
          await page.goto(originalUrl, { waitUntil: "domcontentloaded" });
          await ready();
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Environment selected in the machine URL parameter; owning settings opened and previous scope restored",
        );
      }
      if (
        item.label === "Background policy details" ||
        item.label.startsWith("The browser may claim some shortcuts") ||
        (activePage === "/settings/diagnostics" &&
          /^(CPU|Memory|CPU Time|Samples|Slow Spans) details$/.test(item.label))
      ) {
        await page.mouse.move(0, 0);
        await loc.hover();
        await loc.focus();
        const tooltip = page.locator('[data-slot="tooltip-popup"]').filter({ visible: true });
        await tooltip.waitFor({ timeout: 2000 });
        NodeAssert.ok((await tooltip.innerText()).trim(), "Policy tooltip exposed no details");
        await loc.blur();
        await page.mouse.move(0, 0);
        await tooltip.waitFor({ state: "hidden", timeout: 2000 });
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Hover displayed policy details and moving the pointer away dismissed them",
        );
      }
      if (
        item.label === "Add theme" &&
        (await scope.getByRole("textbox", { name: "Theme JSON", exact: true }).count()) === 1
      ) {
        const json = scope.getByRole("textbox", { name: "Theme JSON", exact: true });
        const original = await json.inputValue();
        const originallyDisabled = await loc.isDisabled();
        try {
          await json.fill("{ invalid qa json");
          await loc.click();
          const error = scope.getByRole("alert");
          await error.waitFor({ timeout: 2000 });
          NodeAssert.ok(
            (await error.innerText()).trim(),
            "Invalid theme submission exposed no validation error",
          );
          await json.fill(
            JSON.stringify({ version: 1, name: "QA draft theme", appearance: "dark", colors: {} }),
          );
          NodeAssert.equal(await loc.isEnabled(), true, "JSON draft did not enable submission");
        } finally {
          await json.fill(original);
          NodeAssert.equal(await json.inputValue(), original, "Theme JSON draft was not restored");
          NodeAssert.equal(
            await loc.isDisabled(),
            originallyDisabled,
            "Theme submission availability was not restored",
          );
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Invalid JSON submission displayed an error; a syntactically valid JSON draft enabled submission; original draft restored. Saving a theme was not exercised",
        );
      }
      const disabledMove = item.label.match(/^Move (.+) (up|down)$/);
      if ((await loc.isDisabled()) && disabledMove && activePage === "/settings/providers") {
        const modelRow = loc.locator("xpath=ancestor::*[@data-model-slug][1]");
        const opposite = modelRow.locator(
          `button[aria-label^="Move "][aria-label$=" ${disabledMove[2] === "up" ? "down" : "up"}"]`,
        );
        const rows = loc
          .locator("xpath=ancestor::*[@data-model-slug][1]/../..")
          .locator("[data-model-slug]");
        const order = () =>
          rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-model-slug")));
        const originalOrder = await order();
        if ((await opposite.count()) === 1 && (await opposite.isEnabled())) {
          let moved = false;
          try {
            await opposite.click();
            moved = true;
            const expected = [...originalOrder];
            const slug = await loc
              .locator("xpath=ancestor::*[@data-model-slug][1]")
              .getAttribute("data-model-slug");
            const index = originalOrder.indexOf(slug);
            const other = index + (disabledMove[2] === "up" ? 1 : -1);
            [expected[index], expected[other]] = [expected[other], expected[index]];
            await expectObserved(order, expected, "Opposite model move did not swap adjacent rows");
            const target = await locate(item, scope);
            NodeAssert.equal(
              await target.isEnabled(),
              true,
              "Opposite move did not enable the target direction",
            );
            await target.click();
            await expectObserved(
              order,
              originalOrder,
              "Target model move did not restore original order",
            );
            moved = false;
          } finally {
            if (moved && JSON.stringify(await order()) !== JSON.stringify(originalOrder))
              await (await locate(item, scope)).click();
            await expectObserved(order, originalOrder, "Model order restoration failed");
          }
          currentContext = contextId;
          return record(
            "pass",
            name,
            "Opposite move changed row order and enabled this direction; target move restored exact original model order",
          );
        }
        return record(
          "fail",
          name,
          "Both model move directions are disabled; the fixture has no movable adjacent model in the same visibility/favorite group",
        );
      }
      if (
        (await loc.isDisabled()) &&
        ["Refresh history", "Refresh trace diagnostics"].includes(item.label)
      ) {
        await page.waitForFunction(
          (id) => {
            const el = document.querySelector(`[data-qa-control="${id}"]`);
            return el && !el.matches(":disabled,[aria-disabled=true]");
          },
          item.id,
          { timeout: 5000 },
        );
      }
      if (
        activePage === "/settings/second-brain" &&
        prepareSecondBrainFixture.state &&
        ["Reindex", "Lint", "Regenerate INDEX", "Refresh", "Previous", "Next"].includes(item.label)
      ) {
        await exerciseSecondBrainFixtureControl(item, loc, scope);
        currentContext = contextId;
        return;
      }
      if (
        activePage === "/settings/snap-shot" &&
        item.label === "Enable snapshots" &&
        (await loc.isDisabled()) &&
        !(await page.evaluate(() => Boolean(window.desktopBridge)))
      )
        return record(
          "blocked",
          name,
          "Electron desktop capture bridge OS capability is absent in headless Chromium; SnapShots is desktop-only",
        );
      if (
        activePage === "/settings/source-control" &&
        item.label === "Git availability" &&
        (await loc.isDisabled())
      ) {
        const original = await state(loc, "checked");
        if (original === "false")
          return record(
            "blocked",
            name,
            "Git executable is unavailable to the isolated server's version probe",
          );
        NodeAssert.equal(original, "true", "Git availability did not expose its discovery state");
        NodeAssert.notEqual(
          // standalone fixture uses the host platform without an Effect runtime.
          NodeOS.platform(),
          "win32",
          "Git availability shim requires a POSIX shell fixture",
        );
        const unavailable = NodePath.join(scratch, "git-unavailable");
        const scanButton = scope.getByRole("button", {
          name: /^(Scan|Rescan server environment)$/,
        });
        NodeAssert.equal(
          await scanButton.count(),
          1,
          "Git fixture needs the real environment rescan control",
        );
        const verifyAvailability = async (expected) => {
          await page.waitForFunction(
            (value) =>
              document
                .querySelector('[role="switch"][aria-label="Git availability"]')
                ?.getAttribute("aria-checked") === value,
            expected,
            { timeout: 8000 },
          );
          await expectState(
            scope.getByRole("switch", { name: "Git availability", exact: true }),
            "checked",
            expected,
          );
        };
        let created = false;
        try {
          await NodeFSP.writeFile(unavailable, "", { flag: "wx" });
          created = true;
          await scanButton.click();
          await verifyAvailability("false");
        } finally {
          if (created) {
            await NodeFSP.unlink(unavailable);
            await scanButton.click();
            await verifyAvailability(original);
          }
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Rescan observed the isolated Git version probe become unavailable; clearing its failure marker and rescanning restored availability",
        );
      }
      if (
        activePage === "/settings/source-control" &&
        / availability$/.test(item.label) &&
        (await loc.isDisabled()) &&
        (await state(loc, "checked")) === "false"
      ) {
        const row = loc.locator("xpath=ancestor::div[.//p][1]");
        const evidence = await row.innerText();
        const provider = item.label.replace(/ availability$/, "");
        if (/not authenticated|sign in|configure credentials|no token|no accounts/i.test(evidence))
          return record(
            "blocked",
            name,
            `${provider} host authentication credentials are absent; its discovery row reports unauthenticated status`,
          );
        if (/not available on this server|not found|not installed/i.test(evidence))
          return record(
            "blocked",
            name,
            `${provider} host CLI service is unavailable; the real discovery row reports it is not available on this server`,
          );
      }
      if (
        activePage === "/settings/source-control" &&
        item.label === "Save" &&
        (await loc.isDisabled())
      ) {
        const form = loc.locator("xpath=ancestor::form[1]");
        if ((await form.count()) === 1) {
          const token = form.getByLabel("Token", { exact: true });
          if (
            (await token.count()) === 1 &&
            (await token.evaluate((el) => el.value.trim().length === 0)) &&
            /No token saved;/i.test(await form.innerText())
          )
            return record(
              "blocked",
              name,
              "Source-control host token credential is absent: the credential draft is empty and the form reports no saved token",
            );
        }
      }
      if (/^(Decrease|Increase)$/.test(item.label) && (await loc.isDisabled())) {
        const group = loc.locator("xpath=..");
        const input = group.locator("input");
        const opposite = group.getByRole("button", {
          name: item.label === "Decrease" ? "Increase" : "Decrease",
          exact: true,
        });
        if ((await input.count()) === 1 && (await opposite.isEnabled())) {
          const original = await input.inputValue();
          try {
            await opposite.click();
            await expectState(input, "value", original, true);
            await loc.click();
            await expectState(input, "value", original);
          } finally {
            if ((await input.inputValue()) !== original) {
              await input.fill(original);
              await input.blur();
            }
            await expectState(input, "value", original);
          }
          currentContext = contextId;
          return record(
            "pass",
            name,
            "Opposite numeric step enabled this boundary control; this control restored the original value",
          );
        }
      }
      if (activePage === "/settings/scheduled-tasks" && item.label === "New task") {
        await loc.click();
        const draft = page.getByRole("dialog", { name: "New task", exact: true });
        await draft.waitFor({ timeout: 3000 });
        const exercised = new Set();
        const withinBudget = async (remaining) => {
          if (Date.now() <= routeDeadline) return true;
          if (!routeBudgetReported) {
            routeBudgetReported = true;
            budgetGap = {
              page: activePage,
              reason: "Route time budget exceeded",
              controls: remaining,
            };
            coverageGaps.push(budgetGap);
            budgetRow = await record(
              "fail",
              "route time budget",
              `Remaining controls: ${remaining.join("; ")}`,
            );
          } else {
            budgetGap.controls = [...new Set([...budgetGap.controls, ...remaining])];
            budgetRow.reason = clean(`Remaining controls: ${budgetGap.controls.join("; ")}`);
          }
          return false;
        };
        const chooseDraftOption = async (target, popup) => {
          if ((await target.getAttribute("data-slot")) === "combobox-item") await target.click();
          else {
            await target.focus();
            await target.press("Enter");
          }
          await popup.waitFor({ state: "hidden", timeout: 2000 });
          await draft.waitFor({ state: "visible", timeout: 2000 });
        };
        const exerciseDraft = async () => {
          const draftControls = await inventory(draft);
          for (const control of draftControls) {
            if (
              !(await withinBudget(
                draftControls
                  .filter((entry) => !exercised.has(`${entry.role}|${entry.label}|${entry.type}`))
                  .map((entry) => `New task draft: ${entry.label}`),
              ))
            )
              break;
            const identity = `${control.role}|${control.label}|${control.type}`;
            if (
              exercised.has(identity) ||
              /^(Cancel|Close|At a time|Once|Every interval|On webhook)$/.test(control.label)
            )
              continue;
            exercised.add(identity);
            await attempt(`New task draft: ${control.role}: ${control.label}`, async () => {
              const field = await locate(control, draft);
              if (control.label === "Create task")
                return record(
                  "skipped-destructive",
                  `New task draft: ${control.label}`,
                  "Task creation was not submitted; no scheduled task was persisted or executed",
                );
              if (dangerous.test(control.label))
                return record(
                  "skipped-destructive",
                  `New task draft: ${control.label}`,
                  "Destructive draft action was not activated",
                );
              NodeAssert.equal(
                await field.isDisabled(),
                false,
                "Draft control is disabled; its fixture precondition was not satisfied",
              );
              if (["input", "textarea"].includes(control.tag)) {
                const original = await field.inputValue();
                const value = await field.evaluate((el) => {
                  if (el.type === "time") return el.value === "12:34" ? "13:34" : "12:34";
                  if (el.type === "datetime-local") return "2099-01-02T12:34";
                  if (el.type === "number") {
                    const min = el.min === "" ? 1 : Number(el.min);
                    const max = el.max === "" ? min + 100 : Number(el.max);
                    const current = Number(el.value);
                    return String(current === min ? Math.min(max, min + 1) : min);
                  }
                  return el.value + " qa draft";
                });
                NodeAssert.notEqual(
                  value,
                  original,
                  "Draft fixture did not choose a different value",
                );
                try {
                  await field.fill(value);
                  await expectState(field, "value", value);
                } finally {
                  await field.fill(original);
                  await expectState(field, "value", original);
                }
              } else if (
                control.role === "switch" ||
                (await field.getAttribute("aria-pressed")) !== null
              ) {
                const attr = control.role === "switch" ? "aria-checked" : "aria-pressed";
                const original = await field.getAttribute(attr);
                // Weekdays are independent toggles; selecting a peer does not deselect this day.
                try {
                  await field.click();
                  await expectState(field, attr, original === "true" ? "false" : "true");
                  if (control.label === "Require signature" && original === "false")
                    await exerciseDraft();
                } finally {
                  if ((await field.getAttribute(attr)) !== original) await field.click();
                  await expectState(field, attr, original);
                }
              } else if ((await field.getAttribute("data-chat-provider-model-picker")) !== null) {
                await field.click();
                try {
                  const empty = page.getByText("No models found", { exact: true });
                  await empty.waitFor({ timeout: 3000 });
                  return record(
                    "blocked",
                    `New task draft: ${control.label}`,
                    "Model picker reports No models found; provider CLIs and credentials are absent from the isolated environment",
                  );
                } finally {
                  await page.keyboard.press("Escape");
                  await expectState(field, "aria-expanded", "false");
                  await draft.waitFor({ state: "visible" });
                }
              } else if (control.role === "combobox") {
                const original = await field.innerText();
                await field.click();
                const popup = page.getByRole("listbox").filter({ visible: true }).last();
                await popup.waitFor({ timeout: 2000 });
                const options = popup.getByRole("option");
                await options.first().waitFor({ timeout: 3000 });
                const count = await options.count();
                NodeAssert.ok(count > 0, "Draft combobox has no options in the isolated fixture");
                const selected = await options.evaluateAll((els) =>
                  els.findIndex(
                    (el) =>
                      el.getAttribute("aria-selected") === "true" ||
                      el.hasAttribute("data-selected"),
                  ),
                );
                if (count === 1) {
                  await chooseDraftOption(options.first(), popup);
                  NodeAssert.equal(
                    await field.innerText(),
                    original,
                    "Singleton choice changed its displayed value",
                  );
                  return record(
                    "pass-not-applicable",
                    `New task draft: ${control.label}`,
                    "Popup opened with exactly one option; no alternative-value transition exists (1 option)",
                  );
                }
                NodeAssert.ok(
                  selected >= 0,
                  "Combobox has no identifiable original selection to restore safely",
                );
                const alternatives = Array.from({ length: count }, (_, index) => index).filter(
                  (index) => index !== selected,
                );
                const sampled = alternatives.slice(0, 3);
                let exercisedOptions = 0;
                for (const index of sampled) {
                  if (
                    !(await withinBudget([`New task draft: ${control.label} option ${index + 1}`]))
                  )
                    break;
                  await chooseDraftOption(options.nth(index), popup);
                  exercisedOptions++;
                  NodeAssert.notEqual(
                    await field.innerText(),
                    original,
                    "Draft selection did not change",
                  );
                  if (control.label === "Workspace" || /^Filter .* test$/.test(control.label))
                    await exerciseDraft();
                  await field.click();
                  await popup.waitFor({ state: "visible", timeout: 2000 });
                }
                await chooseDraftOption(options.nth(selected), popup);
                NodeAssert.equal(
                  await field.innerText(),
                  original,
                  "Draft selection was not restored",
                );
                if (alternatives.length > exercisedOptions)
                  await record(
                    "sampled",
                    `New task draft: ${control.label}`,
                    `${exercisedOptions} alternative options exercised; ${alternatives.length - exercisedOptions} alternatives not exercised`,
                  );
                if (exercisedOptions < sampled.length) return;
              } else if (control.label === "Add filter") {
                const before = await draft
                  .getByRole("textbox", { name: /^Filter \d+ path$/ })
                  .count();
                await field.click();
                NodeAssert.equal(
                  await draft.getByRole("textbox", { name: /^Filter \d+ path$/ }).count(),
                  before + 1,
                  "Add filter did not reveal a new filter row",
                );
                await exerciseDraft();
                return record(
                  "pass",
                  "New task draft: Add filter",
                  "Added one unsaved filter and reported its controls individually; Cancel discards the row; Remove was not used",
                );
              } else if (
                (await field.getAttribute("data-chat-provider-model-picker")) !== null ||
                control.label === "Base branch"
              ) {
                await field.click();
                const popup = page
                  .locator('[role="dialog"], [role="menu"], [role="listbox"]')
                  .filter({ visible: true })
                  .last();
                await popup.waitFor({ state: "visible", timeout: 2000 });
                NodeAssert.notEqual(
                  await popup.getAttribute("id"),
                  await draft.getAttribute("id"),
                  "Picker exposed no separate popup",
                );
                NodeAssert.ok(
                  (await popup.innerText()).trim(),
                  "Picker exposed no options or availability evidence",
                );
                await field.press("Escape");
                await popup.waitFor({ state: "hidden", timeout: 2000 });
                await draft.waitFor({ state: "visible", timeout: 2000 });
                return record(
                  "pass",
                  `New task draft: ${control.label}`,
                  "Picker opened with visible content and was dismissed without selecting or executing; option selection was not exercised",
                );
              } else {
                throw new Error(
                  "Draft control has no verified interaction; no task was saved or run",
                );
              }
              return record(
                "pass",
                `New task draft: ${control.label}`,
                "Unsaved draft value changed and was restored in the open dialog; persistence was not exercised",
              );
            });
          }
        };
        try {
          await exerciseDraft();
          for (const mode of ["Once", "Every interval", "On webhook"]) {
            if (!(await withinBudget([`New task draft: schedule ${mode}`]))) break;
            const toggle = draft.getByRole("button", { name: mode, exact: true });
            if ((await toggle.count()) !== 1) continue;
            await attempt(`New task draft: schedule ${mode}`, async () => {
              NodeAssert.equal(
                await toggle.isDisabled(),
                false,
                "Schedule mode is disabled in this fixture",
              );
              await toggle.click();
              await expectState(toggle, "aria-pressed", "true");
              await exerciseDraft();
              await draft.getByRole("button", { name: "At a time", exact: true }).click();
              await expectState(
                draft.getByRole("button", { name: "At a time", exact: true }),
                "aria-pressed",
                "true",
              );
              return record(
                "pass",
                `New task draft: schedule ${mode}`,
                "Schedule mode selected and fixed-time mode restored; discovered conditional draft controls reported separately",
              );
            });
          }
        } finally {
          await draft.getByRole("button", { name: "Cancel", exact: true }).click();
          await draft.waitFor({ state: "hidden", timeout: 2000 });
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "New task dialog opened, draft interactions reported individually, and cancelled without creating or executing a task; persistence was not exercised",
        );
      }
      if (
        activePage === "/settings/devices" &&
        ["Device hub", "Agent device access"].includes(item.label)
      ) {
        const hub = scope.getByRole("switch", { name: "Device hub", exact: true });
        const target = scope.getByRole("switch", { name: item.label, exact: true });
        const originalHub = await state(hub, "checked");
        const original = await state(target, "checked");
        const changed = original === "true" ? "false" : "true";
        const settled = async (label) => {
          console.log(`WAIT ${activePage} :: ${label} configuration completion (45s deadline)`);
          await page.waitForFunction(
            (label) => {
              const control = document.querySelector(`[role="switch"][aria-label="${label}"]`);
              return control && !control.matches(":disabled,[aria-disabled=true]");
            },
            label,
            { timeout: 45000 },
          );
        };
        const set = async (control, label, value) => {
          await settled(label);
          if ((await state(control, "checked")) !== value) await control.click();
          await expectState(control, "checked", value);
          // Reloading while configure is pending cancels its tool installation RPC.
          await settled(label);
        };
        try {
          if (item.label === "Agent device access") await set(hub, "Device hub", "true");
          await set(target, item.label, changed);
          await page.reload({ waitUntil: "domcontentloaded" });
          await ready();
          await expectState(target, "checked", changed);
          const settings = JSON.parse(
            await NodeFSP.readFile(NodePath.join(app.baseDir, "userdata", "settings.json"), "utf8"),
          );
          NodeAssert.equal(
            String(
              settings[
                item.label === "Device hub" ? "enableDeviceSupport" : "enableAgentDeviceAccess"
              ],
            ),
            changed,
          );
        } finally {
          await set(target, item.label, original);
          if (item.label === "Agent device access") await set(hub, "Device hub", originalHub);
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Device configuration settled; changed setting verified on disk and after reload; original switches restored",
        );
      }
      if (activePage === "/usage" && item.label === "Save changes") {
        return exerciseUsagePriceSave(scope, reset);
      }
      if ((await loc.isDisabled()) || item.readonly) {
        if (activePage === "/settings/browser")
          return record(
            "blocked",
            name,
            "Electron desktop browser bridge OS capability is unavailable in headless Chromium",
          );
        if (item.label === "Enable network access")
          return record(
            "blocked",
            name,
            "Electron desktop server exposure OS capability is unavailable in headless Chromium",
          );
        if (item.label === "Add hub") {
          const hubUrl = scope.getByRole("textbox", { name: "Hub URL", exact: true });
          const key = scope.locator("#usage-source-key");
          if (
            (await hubUrl.count()) === 1 &&
            (await key.count()) === 1 &&
            (!(await hubUrl.inputValue()).trim() || !(await key.inputValue()).trim())
          )
            return record(
              "blocked",
              name,
              "CLIProxyAPI hub endpoint and management credential are absent from the isolated fixture",
            );
        }
        if (item.label === "Agent device access") {
          const hub = scope.getByRole("switch", { name: "Device hub", exact: true });
          if ((await hub.count()) === 1 && (await hub.getAttribute("aria-checked")) === "false")
            return record(
              "blocked",
              name,
              "Device hub service is disabled; agent device access requires an enabled hub",
            );
        }
        if (activePage === "/settings/second-brain") {
          if (["Reindex", "Regenerate INDEX"].includes(item.label)) {
            const folder = scope.getByRole("textbox", { name: "Second brain folder", exact: true });
            if ((await folder.count()) === 1 && !(await folder.inputValue()).trim())
              return record(
                "fail",
                name,
                "Local fixture has no Second brain folder; this maintenance action requires a configured local folder, not an external service",
              );
          }
          if (["Previous", "Next"].includes(item.label))
            return record(
              "fail",
              name,
              "Proposal pagination is at its boundary; fixture lacks proposal pages to exercise and restore this transition",
            );
        }
        return record(
          "fail",
          name,
          "Bot fixture did not satisfy the control's disabled or read-only precondition",
        );
      }
      if (activePage === "/settings/keybindings" && item.label === "Add keybinding") {
        await loc.click();
        const cancel = scope.getByRole("button", { name: "Cancel new keybinding", exact: true });
        await cancel.waitFor();
        const field = scope.getByPlaceholder("Unassigned");
        await field.waitFor();
        await field.press("Control+Alt+Shift+9");
        NodeAssert.ok(
          (await field.inputValue()).trim(),
          "New keybinding did not capture a shortcut",
        );
        await cancel.click();
        await cancel.waitFor({ state: "hidden" });
        currentContext = contextId;
        return record(
          "pass",
          name,
          "New keybinding form opened and captured a shortcut; Cancel dismissed it without saving",
        );
      }
      const shortcutEditor =
        activePage === "/settings/keybindings"
          ? item.label.match(/^Edit (when clause|shortcut) for /)?.[1]
          : null;
      if (shortcutEditor && scannedOverlays.has(`${activePage}|Edit ${shortcutEditor}`)) {
        const originalUrl = page.url();
        const count = await page.getByRole("dialog").count();
        await loc.click();
        await page.waitForFunction(
          (previous) => document.querySelectorAll('[role="dialog"]').length > previous,
          count,
          { timeout: 2000 },
        );
        const dialogId = await page.getByRole("dialog").last().getAttribute("id");
        const dialog = page.locator(`[id=${JSON.stringify(dialogId)}]`);
        const cancel = dialog.getByRole("button", { name: /^(Cancel|Close)$/ }).first();
        if (await cancel.isVisible()) await cancel.click();
        else await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden", timeout: 2000 });
        NodeAssert.equal(
          page.url(),
          originalUrl,
          "Closing shortcut editor changed the settings route",
        );
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Shortcut editor opened and cancelled; settings route preserved",
        );
      }
      if (
        item.role === "switch" ||
        item.role === "checkbox" ||
        item.type === "checkbox" ||
        item.role === "menuitemcheckbox"
      ) {
        const original = await state(loc, "checked");
        NodeAssert.ok(
          ["true", "false"].includes(original),
          "Bot needs a restoration fixture for mixed state",
        );
        const changed = original === "true" ? "false" : "true";
        try {
          if (item.role === "menuitemcheckbox") {
            await loc.focus();
            await loc.press("Enter");
          } else await loc.click();
          if (!(await scope.isVisible()))
            await (reopen?.openOnly ? reopen.openOnly() : ensureOpen());
          await expectState(await locate(item, scope), "checked", changed);
          if (depth === 0) {
            await reset();
            await expectState(await locate(item, scope), "checked", changed);
          }
          if (depth < 2) {
            const known = new Set(discovered.map((i) => `${i.key}|${i.ordinal}`));
            const revealed = (await inventory(scope)).filter(
              (i) => !known.has(`${i.key}|${i.ordinal}`),
            );
            if (revealed.length)
              await scan(scope, known, depth + 1, async () => {
                await reset();
                const toggle = await locate(item, scope);
                if ((await state(toggle, "checked")) !== changed) await toggle.click();
              });
          }
        } finally {
          if (!transportFailure && pageFailure !== activePage) {
            await reset();
            const restore = await locate(item, scope);
            if ((await state(restore, "checked")) !== original) {
              if (item.role === "menuitemcheckbox") {
                await restore.focus();
                await restore.press("Enter");
              } else await restore.click();
            }
            if (!(await scope.isVisible()))
              await (reopen?.openOnly ? reopen.openOnly() : ensureOpen());
            await expectState(await locate(item, scope), "checked", original);
            currentContext = contextId;
          }
        }
        return record(
          "pass",
          name,
          depth === 0
            ? "State changed, survived reload, and was restored"
            : "State changed and was restored after reopening its overlay",
        );
      }

      if (item.role === "menuitemradio" || item.role === "radio") {
        const group = loc.locator(
          'xpath=ancestor::*[@role="radiogroup" or @data-slot="menu-radio-group" or @data-slot="radio-group"][1]',
        );
        const hasGroup = (await group.count()) === 1;
        const radioScope = hasGroup ? group : scope;
        const allOptions = radioScope.getByRole(item.role, { includeHidden: true });
        const selected = radioScope.getByRole(item.role).filter({ visible: true });
        const options = await selected.evaluateAll((els) =>
          els.map((el) => ({
            label: (
              el.getAttribute("aria-label") ||
              (() => {
                const copy = el.cloneNode(true);
                copy
                  .querySelectorAll('[aria-hidden="true"], [hidden], svg')
                  .forEach((node) => node.remove());
                const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
                const words = [];
                while (walker.nextNode()) words.push(walker.currentNode.textContent);
                return words.join(" ");
              })()
            )
              .replace(/\s+/g, " ")
              .trim(),
            checked: el.getAttribute("aria-checked"),
            disabled: el.getAttribute("aria-disabled") === "true",
          })),
        );
        const original = options.find((option) => option.checked === "true");
        NodeAssert.ok(original, "Bot could not identify the radio group's original selection");
        if (hasGroup && options.length === 1 && (await allOptions.count()) === 1)
          return record(
            "pass-not-applicable",
            name,
            "Not applicable: explicit radio group contains exactly one option, already selected; no alternative exists",
          );
        const target =
          original.label === item.label
            ? options.find(
                (option) =>
                  option.label !== original.label &&
                  !option.disabled &&
                  !dangerous.test(option.label) &&
                  !dependency({ ...item, label: option.label }),
              )
            : options.find((option) => option.label === item.label);
        NodeAssert.ok(target, "Bot cannot transition a radio group with no alternative");
        const byLabel = (label) => scope.getByRole(item.role, { name: label, exact: true });
        try {
          await byLabel(target.label).click();
          currentContext = null;
          await (reopen?.openOnly ? reopen.openOnly() : ensureOpen());
          await expectState(byLabel(target.label), "checked", "true");
        } finally {
          if (!transportFailure && pageFailure !== activePage) {
            currentContext = null;
            await (reopen?.openOnly ? reopen.openOnly() : ensureOpen());
            if ((await state(byLabel(original.label), "checked")) !== "true")
              await byLabel(original.label).click();
            currentContext = null;
            await (reopen?.openOnly ? reopen.openOnly() : ensureOpen());
            await expectState(byLabel(original.label), "checked", "true");
          }
        }
        return record(
          "pass",
          name,
          "Radio selection changed, reopened selection verified, and original restored",
        );
      }
      if (item.tag === "select") {
        const original = await loc.inputValue();
        const options = await loc
          .locator("option")
          .evaluateAll((els) =>
            els.map((el) => ({ value: el.value, label: el.textContent, disabled: el.disabled })),
          );
        for (const option of options.filter((option) => option.disabled))
          await record(
            "fail",
            `${name} / option: ${option.label}`,
            "Bot fixture did not enable this disabled option; it was not activated",
          );
        NodeAssert.ok(
          options.some((option) => option.value !== original && !option.disabled),
          "Bot has no alternative option to exercise in this select",
        );
        const alternatives = options.filter(
          (option) => option.value !== original && !option.disabled,
        );
        const sampled = alternatives.slice(0, 3);
        if (alternatives.length > sampled.length)
          await record(
            "sampled",
            name,
            `First ${sampled.length} of ${alternatives.length} alternative options sampled; ${alternatives.length - sampled.length} alternatives not exercised`,
          );
        for (const option of sampled) {
          if (dangerous.test(option.label)) {
            await record(
              "skipped-destructive",
              `${name} / ${option.label}`,
              "Destructive option; not activated",
            );
            continue;
          }
          try {
            await loc.selectOption(option.value);
            await expectState(loc, "value", option.value);
            const known = new Set(discovered.map((i) => `${i.key}|${i.ordinal}`));
            if (
              depth < 2 &&
              (await inventory(scope)).some((i) => !known.has(`${i.key}|${i.ordinal}`))
            )
              await scan(scope, known, depth + 1, async () => {
                await reset();
                await (await locate(item, scope)).selectOption(option.value);
              });
          } finally {
            await (await locate(item, scope)).selectOption(original);
            await expectState(await locate(item, scope), "value", original);
          }
          await record(
            "pass",
            `${name} / ${option.label}`,
            "Option selected and original restored",
          );
        }
        currentContext = contextId;
        return;
      }
      if (item.modelSlug && /^Display name for /.test(item.label)) {
        const row = scope.locator(`[data-model-slug=${JSON.stringify(item.modelSlug)}]`);
        const visibility = row.getByRole("switch");
        const originalVisibility = await state(visibility, "checked");
        const original = await loc.inputValue();
        const changed = original ? `${original} qa` : "QA model draft";
        try {
          await loc.fill(changed);
          await loc.blur();
          await expectState(await locate(item, scope), "value", changed);
        } finally {
          const field = await locate(item, scope);
          await field.fill(original);
          await field.blur();
          await expectState(await locate(item, scope), "value", original);
          await expectState(visibility, "checked", originalVisibility);
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Model display name committed and restored using its stable slug; row visibility remained unchanged",
        );
      }
      if (item.type === "range") {
        const original = await loc.inputValue();
        const maximum = await loc.getAttribute("max");
        const key =
          maximum !== null && Number(original) >= Number(maximum) ? "ArrowLeft" : "ArrowRight";
        try {
          await loc.press(key);
          await expectState(loc, "value", original, true);
        } finally {
          if ((await loc.inputValue()) !== original)
            await loc.press(key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft");
          await expectState(loc, "value", original);
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Keyboard step changed the slider value; reverse step restored it",
        );
      }
      if (
        item.tag === "input" ||
        item.tag === "textarea" ||
        (item.role !== "combobox" && (await loc.getAttribute("contenteditable")) === "true")
      ) {
        if (item.type === "file")
          return record(
            "blocked",
            name,
            "Native file picker OS capability is unavailable in headless Chromium",
          );
        const original = await state(loc, "value");
        if (/hex value|hex accent|picker RGB value/i.test(item.label) && !original.trim())
          return record(
            "skipped-destructive",
            name,
            "Restoring an initially unset color requires the forbidden reset action; field not edited",
          );
        const parseNumeric = (raw) => Number(String(raw).replace(/[,\s\u00a0\u202f]/g, ""));
        const originalNumber = item.numeric ? parseNumeric(original) : null;
        let value =
          item.type === "time"
            ? `${String((Number(original.slice(0, 2)) + 1) % 24).padStart(2, "0")}:${original.slice(3, 5) || "00"}`
            : item.type === "color" || /hex/i.test(item.label)
              ? "#123456"
              : /url|endpoint/i.test(item.label)
                ? "http://127.0.0.1:9"
                : /path|directory|folder/i.test(item.label)
                  ? app.workspace
                  : original.trim()
                    ? `${original} qa`
                    : "qa control edit";
        const numericValue = async () =>
          parseNumeric(await state(await locate(item, scope), "value"));
        let restoreValue = item.numeric ? String(originalNumber) : original;
        try {
          if (item.numeric) {
            NodeAssert.ok(
              Number.isFinite(originalNumber),
              "Numeric field has no finite original value",
            );
            const bounds = await loc.evaluate((el) => ({
              min: el.getAttribute("min") ?? el.getAttribute("aria-valuemin"),
              max: el.getAttribute("max") ?? el.getAttribute("aria-valuemax"),
              step: el.getAttribute("step"),
            }));
            if (bounds.min !== null || bounds.max !== null || item.type === "number") {
              const minimum = bounds.min === null ? -Infinity : Number(bounds.min);
              const maximum = bounds.max === null ? Infinity : Number(bounds.max);
              const step = Number(bounds.step) || 1;
              const candidate = [originalNumber + step, originalNumber - step].find(
                (number) => number >= minimum && number <= maximum,
              );
              NodeAssert.ok(
                Number.isFinite(candidate),
                "Numeric input has no alternative step within its bounds",
              );
              value = String(candidate);
              await loc.fill(value);
            } else {
              // Base UI keeps bounds and step in context, so its key handler chooses a valid value.
              const stepAndWait = async (key) => {
                await loc.press(key);
                const end = Date.now() + 1500;
                while ((await numericValue()) === originalNumber && Date.now() < end)
                  await new Promise((resolve) => setTimeout(resolve, 30));
              };
              await stepAndWait("ArrowUp");
              if ((await numericValue()) === originalNumber) await stepAndWait("ArrowDown");
              value = String(await numericValue());
              // A decimal text box has no stepper, so a typed value is its only real edit.
              if (Number(value) === originalNumber && item.role !== "spinbutton") {
                value = String(originalNumber + 1);
                restoreValue = original;
                await loc.fill(value);
              }
            }
            NodeAssert.ok(
              Number.isFinite(Number(value)),
              "Numeric edit produced a nonfinite value",
            );
            NodeAssert.notEqual(
              Number(value),
              originalNumber,
              "Numeric field exposed no valid alternative",
            );
            await (await locate(item, scope)).blur();
            const end = Date.now() + 2000;
            while ((await numericValue()) !== Number(value) && Date.now() < end)
              await new Promise((resolve) => setTimeout(resolve, 30));
            NodeAssert.equal(
              await numericValue(),
              Number(value),
              "Numeric value did not survive blur",
            );
          } else {
            await loc.fill(value);
            await expectState(await locate(item, scope), "value", value);
          }
        } finally {
          const restored = await locate(item, scope);
          await restored.fill(restoreValue);
          await restored.blur();
          if (item.numeric) {
            const end = Date.now() + 2000;
            while ((await numericValue()) !== originalNumber && Date.now() < end)
              await new Promise((resolve) => setTimeout(resolve, 30));
            NodeAssert.equal(
              await numericValue(),
              originalNumber,
              "Original numeric value was not restored",
            );
          } else await expectState(await locate(item, scope), "value", original);
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Edited value observed and original restored before leaving the field",
        );
      }
      if (item.role === "combobox") {
        const triggerLabel = await loc.getAttribute("aria-label");
        const comboTrigger = async () => {
          if (triggerLabel) {
            const named = scope.getByRole("combobox", { name: triggerLabel, exact: true });
            if ((await named.count()) === 1) return named;
          }
          return locate(item, scope);
        };
        const closeSelect = async () => {
          const trigger = await comboTrigger();
          const popupId = await trigger.getAttribute("aria-controls");
          if ((await trigger.getAttribute("aria-expanded")) === "true")
            await page.keyboard.press("Escape");
          await expectState(await comboTrigger(), "aria-expanded", "false");
          if (popupId)
            await page
              .locator(`[id=${JSON.stringify(popupId)}]`)
              .waitFor({ state: "hidden", timeout: 2000 });
        };
        if (item.label === "Thread notifications")
          await session.context.grantPermissions(["notifications"]);
        await loc.click();
        const options = page.getByRole("option").filter({ visible: true });
        const visible = await options
          .first()
          .waitFor({ timeout: 1500 })
          .then(() => true)
          .catch(() => false);
        if (!visible) {
          await closeSelect();
          if (/opener|editor/.test(item.label))
            return record(
              "blocked",
              name,
              "Native editor OS capability is unavailable in headless Chromium",
            );
          throw new Error(
            "Bot expected select options, but the real control exposed no option role",
          );
        }
        const choices = await options.evaluateAll((els) =>
          els.map((el) => ({
            label: el.textContent.trim(),
            selected:
              el.getAttribute("aria-selected") === "true" || el.hasAttribute("data-selected"),
            disabled: el.getAttribute("aria-disabled") === "true",
          })),
        );
        const original = choices.find((choice) => choice.selected)?.label;
        NodeAssert.ok(original, "Bot could not identify the original selected option");
        for (const choice of choices.filter((choice) => choice.disabled))
          await record(
            "fail",
            `${name} / option: ${choice.label}`,
            "Bot fixture did not enable this disabled option; it was not activated",
          );
        if (choices.length === 1 && choices[0].selected && !choices[0].disabled) {
          await closeSelect();
          currentContext = contextId;
          return record(
            "pass-not-applicable",
            name,
            "Real popup contains exactly one selected option; no alternative selection exists",
          );
        }
        NodeAssert.ok(
          choices.some((choice) => choice.label !== original && !choice.disabled),
          "Bot has no alternative option to exercise in this combobox",
        );
        await closeSelect();
        const alternatives = choices.filter(
          (choice) => choice.label !== original && !choice.disabled,
        );
        const sampled = alternatives.slice(0, 3);
        if (alternatives.length > sampled.length)
          await record(
            "sampled",
            name,
            `First ${sampled.length} of ${alternatives.length} alternative options sampled; ${alternatives.length - sampled.length} alternatives not exercised`,
          );
        for (const choice of sampled) {
          const optionName = `${name} / ${choice.label}`;
          if (dangerous.test(choice.label)) {
            await record("skipped-destructive", optionName, "Destructive option; not activated");
            continue;
          }
          const reason = dependency({ ...item, label: choice.label });
          if (reason) {
            await record("blocked", optionName, reason);
            continue;
          }
          const optionByLabel = async (label) => {
            const available = page.getByRole("option").filter({ visible: true });
            await available.first().waitFor();
            const labels = await available.evaluateAll((els) =>
              els.map((el) => el.textContent.trim()),
            );
            NodeAssert.equal(
              labels.filter((value) => value === label).length,
              1,
              "Option label is ambiguous or absent",
            );
            return available.nth(labels.indexOf(label));
          };
          let changed = false;
          try {
            await (await comboTrigger()).click();
            changed = true;
            const target = await optionByLabel(choice.label);
            if ((await target.getAttribute("data-slot")) === "combobox-item") await target.click();
            else {
              await target.focus();
              await target.press("Enter");
            }
            if (
              /^Add (pipeline|scenario)/.test(choice.label) ||
              (item.label === "Background activity profile" && choice.label === "Advanced")
            ) {
              const opened = page.getByRole("dialog").filter({ visible: true }).last();
              await opened.waitFor();
              const dialog = page.locator(
                `[id=${JSON.stringify(await opened.getAttribute("id"))}]`,
              );
              if (choice.label === "Advanced") {
                NodeAssert.ok(
                  (await dialog.innerText()).toLowerCase().includes("background activity"),
                  "Advanced background policy dialog did not render",
                );
                await dialog.getByRole("button", { name: "Done", exact: true }).click();
              } else {
                const input = dialog.getByRole("textbox").first();
                await input.fill("qa-temporary");
                NodeAssert.equal(await input.inputValue(), "qa-temporary");
                await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
              }
              await dialog.waitFor({ state: "hidden" });
              changed = false;
              await record(
                "pass",
                optionName,
                choice.label === "Advanced"
                  ? "Advanced policy dialog opened and Done closed it without changing its settings"
                  : "Action option opened its creation dialog; draft name entered and dialog cancelled without saving",
              );
              continue;
            }
            await closeSelect();
            await (await comboTrigger()).click();
            await expectState(await optionByLabel(choice.label), "aria-selected", "true");
            await closeSelect();
          } finally {
            await closeSelect();
            if (changed) {
              await (await comboTrigger()).click();
              const originalOption = await optionByLabel(original);
              if ((await originalOption.getAttribute("data-slot")) === "combobox-item")
                await originalOption.click();
              else {
                await originalOption.focus();
                await originalOption.press("Enter");
              }
              await closeSelect();
              await (await comboTrigger()).click();
              await expectState(await optionByLabel(original), "aria-selected", "true");
              await closeSelect();
            }
          }
          await record(
            "pass",
            optionName,
            "Selected option verified in the reopened popup; original restored",
          );
        }
        currentContext = contextId;
        return;
      }
      if (item.tag === "summary" || (item.expanded !== null && !item.popup)) {
        const original = await state(loc, "expanded");
        await loc.click();
        await expectState(
          await locate(item, scope),
          "expanded",
          original === "true" ? "false" : "true",
        );
        if (activePage === "/settings/open-source-licenses" && original === "false") {
          const notice = loc.locator("xpath=ancestor::article[1]").locator("pre");
          await notice.waitFor();
          NodeAssert.ok((await notice.innerText()).trim(), "Expanded license has no notice text");
        }
        if (depth < 2 && original === "false" && activePage !== "/settings/open-source-licenses")
          await scan(
            scope,
            new Set(discovered.map((i) => `${i.key}|${i.ordinal}`)),
            depth + 1,
            async () => {
              await reset();
              await (await locate(item, scope)).click();
            },
          );
        const current =
          page.url() === startUrl && (await scope.isVisible())
            ? await locate(item, scope).catch(() => null)
            : null;
        if (current && (await current.isVisible())) {
          if ((await state(current, "expanded")) !== original) await current.click();
          await expectState(await locate(item, scope), "expanded", original);
          currentContext = contextId;
        } else await reset();
        return record(
          "pass",
          name,
          "Disclosure opened and closed; original expansion state restored",
        );
      }
      if (/^(increase|decrease)\b/i.test(item.label)) {
        const field = loc.locator("xpath=..").locator("input").first();
        if (await field.count()) {
          const original = await field.inputValue();
          try {
            await loc.click();
            await expectState(field, "value", original, true);
          } finally {
            await field.fill(original);
            await field.blur();
            await expectState(field, "value", original);
          }
          currentContext = contextId;
          return record("pass", name, "Numeric button changed its field; original value restored");
        }
      }
      if (item.label === "Resize Sidebar") {
        const container = loc
          .locator('xpath=ancestor::*[@data-slot="sidebar"][1]')
          .locator('[data-slot="sidebar-container"]');
        const original = await container.evaluate((el) => el.getBoundingClientRect().width);
        const drag = async (delta) => {
          const bounds = await loc.boundingBox();
          NodeAssert.ok(bounds, "Sidebar resize rail has no visible bounds");
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
          try {
            await page.mouse.move(
              bounds.x + bounds.width / 2 + delta,
              bounds.y + bounds.height / 2,
              { steps: 4 },
            );
          } finally {
            await page.mouse.up();
          }
        };
        try {
          await drag(60);
          NodeAssert.notEqual(
            await container.evaluate((el) => el.getBoundingClientRect().width),
            original,
            "Sidebar width did not change after dragging",
          );
        } finally {
          const width = await container.evaluate((el) => el.getBoundingClientRect().width);
          if (width !== original) await drag(original - width);
        }
        NodeAssert.ok(
          Math.abs(
            (await container.evaluate((el) => el.getBoundingClientRect().width)) - original,
          ) < 1,
          "Sidebar width was not restored",
        );
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Pointer drag changed sidebar width and reverse drag restored it",
        );
      }
      const move = item.label.match(/^Move (.+) (up|down)$/);
      if (move) {
        const row = loc.locator("xpath=ancestor::*[@data-model-slug][1]");
        const slug = await row.getAttribute("data-model-slug");
        const rows = row.locator("xpath=../..").locator("[data-model-slug]");
        const order = () =>
          rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-model-slug")));
        const original = await order();
        const expected = [...original];
        const index = original.indexOf(slug);
        const other = index + (move[2] === "up" ? -1 : 1);
        [expected[index], expected[other]] = [expected[other], expected[index]];
        try {
          await loc.click();
          await expectObserved(order, expected, "Model action did not swap adjacent rows");
        } finally {
          if (JSON.stringify(await order()) !== JSON.stringify(original))
            await row
              .locator(
                `button[aria-label^="Move "][aria-label$=" ${move[2] === "up" ? "down" : "up"}"]`,
              )
              .click();
          await expectObserved(order, original, "Model order was not restored");
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Adjacent model order changed; opposite move restored exact original order",
        );
      }
      const themeTitle = item.label.match(/^Use (.+) theme(?:, currently active)?$/);
      const themeMode = item.label.match(/^Use (.+) (light|dark) mode$/);
      if (themeTitle || themeMode) {
        const label = (themeTitle || themeMode)[1];
        const modes = themeTitle ? ["light", "dark"] : [themeMode[2]];
        const circle = (theme, mode) =>
          scope.getByRole("button", { name: `Use ${theme} ${mode} mode`, exact: true });
        const original = await scope
          .locator('button[aria-label^="Use "][aria-pressed="true"]')
          .evaluateAll((els) =>
            els
              .map((el) => el.getAttribute("aria-label"))
              .filter((name) => /^Use .+ (light|dark) mode$/.test(name)),
          );
        try {
          for (const mode of modes) {
            const target = circle(label, mode);
            if ((await target.getAttribute("aria-pressed")) === "true") {
              const peers = scope.getByRole("button", {
                name: new RegExp(`^Use .+ ${mode} mode$`),
              });
              const alternative = (await peers.all()).filter(Boolean);
              let found = false;
              for (const peer of alternative) {
                if ((await peer.getAttribute("aria-pressed")) === "false") {
                  await peer.click();
                  await expectState(target, "aria-pressed", "false");
                  found = true;
                  break;
                }
              }
              NodeAssert.ok(
                found,
                `No alternative ${mode} theme exists for a selection transition`,
              );
            }
          }
          await (await locate(item, scope)).click();
          for (const mode of modes) await expectState(circle(label, mode), "aria-pressed", "true");
        } finally {
          for (const name of original)
            await scope.getByRole("button", { name, exact: true }).click();
          for (const name of original)
            await expectState(
              scope.getByRole("button", { name, exact: true }),
              "aria-pressed",
              "true",
            );
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Theme selection changed the light/dark ownership controls; original owners restored",
        );
      }
      if (
        (activePage === "/settings/diagnostics" && item.label === "Refresh trace diagnostics") ||
        (activePage === "/usage" && ["Refresh usage", "Refresh history"].includes(item.label)) ||
        (activePage === "/settings/source-control" && item.label === "Rescan server environment")
      ) {
        await loc.evaluate((el) => {
          window.__qaRefresh = { busy: false, done: false };
          window.__qaRefreshObserver = new MutationObserver((records) => {
            if (el.disabled || records.some((record) => record.oldValue !== null))
              window.__qaRefresh.busy = true;
            if (!el.disabled && window.__qaRefresh.busy) window.__qaRefresh.done = true;
          });
          window.__qaRefreshObserver.observe(el, {
            attributes: true,
            attributeFilter: ["disabled"],
            attributeOldValue: true,
          });
        });
        try {
          await loc.click();
          await page.waitForFunction(() => window.__qaRefresh.done, undefined, { timeout: 5000 });
          NodeAssert.equal(await loc.isEnabled(), true);
        } finally {
          await page.evaluate(() => window.__qaRefreshObserver?.disconnect());
        }
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Refresh entered its pending state and completed with the control enabled again",
        );
      }
      if (activePage === "/settings/providers" && /^(Enable|Disable) all$/.test(item.label)) {
        const owner = loc.locator("xpath=ancestor::div[.//*[@data-model-slug]][1]");
        await owner.evaluate((el, id) => el.setAttribute("data-qa-model-list", id), item.id);
        const box = page.locator(`[data-qa-model-list=${JSON.stringify(item.id)}]`);
        const switches = box.locator('[role="switch"]:not(:disabled):not([aria-disabled="true"])');
        const original = await switches.evaluateAll((els) =>
          els.map((el) => ({
            name: el.getAttribute("aria-label"),
            slug: el.closest("[data-model-slug]").getAttribute("data-model-slug"),
            checked: el.getAttribute("aria-checked"),
          })),
        );
        const settingsPath = NodePath.join(app.baseDir, "userdata", "settings.json");
        const readSaved = async () =>
          JSON.parse(await NodeFSP.readFile(settingsPath, "utf8")).providerModelPreferences ?? {};
        const hidden = (saved, provider) => saved[provider]?.hiddenModels ?? [];
        const canonical = (saved) =>
          JSON.stringify(
            Object.entries(saved)
              .map(([provider, prefs]) => [provider, [...(prefs.hiddenModels ?? [])].sort()])
              .filter(([, models]) => models.length)
              .sort(([a], [b]) => a.localeCompare(b)),
          );
        const initialSaved = await readSaved();
        const persistedAfter = async (action, predicate) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          const events = NodeFSP.watch(NodePath.dirname(settingsPath), {
            signal: controller.signal,
          });
          const nextEvent = events.next();
          try {
            await action();
            let saved = await readSaved();
            if (predicate(saved)) return saved;
            await nextEvent;
            saved = await readSaved();
            if (predicate(saved)) return saved;
            for await (const _event of events) {
              saved = await readSaved();
              if (predicate(saved)) return saved;
            }
            throw new Error("Provider visibility persistence was not observed within 5 seconds");
          } finally {
            clearTimeout(timer);
            controller.abort();
            await nextEvent.catch(() => {});
          }
        };
        let provider;
        const changed = item.label === "Enable all" ? "true" : "false";
        try {
          const changedSaved = await persistedAfter(
            () => loc.click(),
            (saved) => canonical(saved) !== canonical(initialSaved),
          );
          const providers = [
            ...new Set([...Object.keys(initialSaved), ...Object.keys(changedSaved)]),
          ].filter(
            (key) =>
              JSON.stringify([...hidden(initialSaved, key)].sort()) !==
              JSON.stringify([...hidden(changedSaved, key)].sort()),
          );
          NodeAssert.equal(
            providers.length,
            1,
            "Bulk action must persist visibility for exactly one provider",
          );
          provider = providers[0];
          await expectObserved(
            () => switches.evaluateAll((els) => els.map((el) => el.getAttribute("aria-checked"))),
            original.map(() => changed),
            "Bulk model visibility did not update every row",
          );
        } finally {
          if (!provider) {
            for (const state of original) {
              const toggle = box.getByRole("switch", { name: state.name, exact: true });
              if ((await toggle.getAttribute("aria-checked")) !== state.checked)
                await toggle.click();
              await expectState(toggle, "checked", state.checked);
            }
            throw new Error(
              "Bulk mutation did not identify its persisted provider; original UI visibility restored",
            );
          }
          await persistedAfter(
            () =>
              box
                .getByRole("button", {
                  name: item.label === "Enable all" ? "Disable all" : "Enable all",
                  exact: true,
                })
                .click(),
            (saved) =>
              original.every(
                (state) => hidden(saved, provider).includes(state.slug) === (changed === "true"),
              ),
          );
          await expectObserved(
            () => switches.evaluateAll((els) => els.map((el) => el.getAttribute("aria-checked"))),
            original.map(() => (changed === "true" ? "false" : "true")),
            "Inverse bulk action did not reach the UI before per-model restoration",
          );
          for (const state of original) {
            const toggle = box.getByRole("switch", { name: state.name, exact: true });
            if ((await toggle.getAttribute("aria-checked")) !== state.checked)
              await persistedAfter(
                () => toggle.click(),
                (saved) =>
                  hidden(saved, provider).includes(state.slug) === (state.checked === "false"),
              );
            await expectState(toggle, "checked", state.checked);
          }
        }
        NodeAssert.equal(
          canonical(await readSaved()),
          canonical(initialSaved),
          "Saved provider visibility differs from the original before the next control",
        );
        currentContext = contextId;
        return record(
          "pass",
          name,
          "Bulk model visibility changed every row; original per-model visibility restored and confirmed in isolated persisted settings",
        );
      }
      const selectedAttribute = await loc.evaluate(
        (el) =>
          ["aria-pressed", "aria-selected", "aria-checked", "aria-current"].find((attr) =>
            ["true", "step", "page"].includes(el.getAttribute(attr)),
          ) ?? null,
      );
      if (selectedAttribute && !["menuitemradio", "option"].includes(item.role)) {
        let peer;
        for (let level = 1; level <= 4 && !peer; level++) {
          const candidates = loc
            .locator(`xpath=${"../".repeat(level).replace(/\/$/, "")}`)
            .locator(
              selectedAttribute === "aria-current"
                ? "button:not([aria-current])"
                : `[${selectedAttribute}="false"]`,
            );
          for (const candidate of await candidates.all()) {
            const label =
              (await candidate.getAttribute("aria-label")) ?? (await candidate.innerText());
            if (
              (await candidate.isVisible()) &&
              (await candidate.isEnabled()) &&
              !dangerous.test(label) &&
              !dependency({ ...item, label }) &&
              ((await candidate.getAttribute(selectedAttribute)) === "false" ||
                selectedAttribute === "aria-current")
            ) {
              peer = candidate;
              break;
            }
          }
        }
        if (peer) {
          try {
            await peer.click();
            await expectState(
              await locate(item, scope),
              selectedAttribute,
              selectedAttribute === "aria-current" ? null : "false",
            );
          } finally {
            await (await locate(item, scope)).click();
          }
          await expectState(
            await locate(item, scope),
            selectedAttribute,
            selectedAttribute === "aria-current" ? "step" : "true",
          );
          return record(
            "pass",
            name,
            "Selected control changed through a peer and was selected again",
          );
        }
      }
      const beforeUrl = page.url();
      const beforeOverlays = await page
        .locator('[role="dialog"], [role="menu"], [role="listbox"]')
        .count();
      const beforeLocal = await page.evaluate(() => ({ ...localStorage }));
      const before = await loc.evaluate((el) => ({
        selected: el.getAttribute("aria-selected"),
        checked: el.getAttribute("aria-checked"),
        pressed: el.getAttribute("aria-pressed"),
        state: el.getAttribute("data-state"),
        html: (() => {
          const box =
            el.closest('[role="tabpanel"],section,form,[role="dialog"]') ?? el.parentElement;
          return JSON.stringify({
            text: box.innerText,
            controls: Array.from(
              box.querySelectorAll(
                "input,textarea,select,[aria-selected],[aria-checked],[aria-pressed]",
              ),
            ).map((x) => [
              x.value,
              x.getAttribute("aria-selected"),
              x.getAttribute("aria-checked"),
              x.getAttribute("aria-pressed"),
            ]),
          });
        })(),
      }));
      if (/^copy /i.test(item.label)) {
        await session.context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.evaluate(() => navigator.clipboard.writeText("qa clipboard sentinel"));
      }
      // These verbs only open local UI or adjust a local setting. Unknown actions fail coverage rather than run speculatively.
      const safe =
        / details$|Show where this value comes from$|^Send orb |^note\s*: qa-proposal-|^Past \d+h|^\d+ days|^(Day|Week|Month)$/.test(
          item.label,
        ) ||
        item.popup ||
        item.tag === "a" ||
        ["tab", "radio", "menuitemradio", "option", "menuitem"].includes(item.role) ||
        /^(close|cancel|back|next|previous|add|new|edit|configure|condition$|group$|negate |setup required|inspect app colors|minimize the theme editor|expand the theme editor|light$|dark$|enter manually|local ACP command|remote link|choose|browse|open|show|view|select|use|follow|copy|duplicate|create theme|import theme$|dismiss notification|continue|save|apply|done|cost|tokens|limits|current limits|trends|refresh$|increase|decrease|blue$|teal$|green$|amber$|orange$|red$|pink$|violet$|stop orb|replay panel|preview |settings$|usage$|system monitor$|pull requests$|\d+[mh]$|provider,|identity,|config,)/i.test(
          item.label,
        );
      NodeAssert.ok(safe, "Bot has no reviewed interaction for this action");
      await loc.click();
      const changed = await page
        .waitForFunction(
          ({ id, domPath, before, beforeUrl, beforeOverlays }) => {
            if (location.href !== beforeUrl) return true;
            if (
              document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')
                .length !== beforeOverlays
            )
              return true;
            const el =
              document.querySelector(`[data-qa-control="${id}"]`) ??
              document.querySelector(domPath);
            if (!el || !el.getClientRects().length) return true;
            const container =
              el.closest('[role="tabpanel"],section,form,[role="dialog"]') ?? el.parentElement;
            return (
              el.getAttribute("aria-selected") !== before.selected ||
              el.getAttribute("aria-checked") !== before.checked ||
              el.getAttribute("aria-pressed") !== before.pressed ||
              el.getAttribute("data-state") !== before.state ||
              JSON.stringify({
                text: container.innerText,
                controls: Array.from(
                  container.querySelectorAll(
                    "input,textarea,select,[aria-selected],[aria-checked],[aria-pressed]",
                  ),
                ).map((x) => [
                  x.value,
                  x.getAttribute("aria-selected"),
                  x.getAttribute("aria-checked"),
                  x.getAttribute("aria-pressed"),
                ]),
              }) !== before.html
            );
          },
          { id: item.id, domPath: item.domPath, before, beforeUrl, beforeOverlays },
          { timeout: 1200 },
        )
        .then(() => true)
        .catch(() => false);
      const clipboardChanged =
        /^copy /i.test(item.label) &&
        (await page.evaluate(() => navigator.clipboard.readText())) !== "qa clipboard sentinel";
      if (!changed && !clipboardChanged) {
        if (
          before.selected === "true" ||
          before.checked === "true" ||
          before.pressed === "true" ||
          before.state === "active"
        )
          throw new Error("Bot needs a peer-transition fixture for the initially selected control");
        throw new Error("No observable effect after clicking the control");
      }
      const afterOverlays = await page
        .locator('[role="dialog"], [role="menu"], [role="listbox"]')
        .count();
      if (afterOverlays > beforeOverlays && depth < 2) {
        const opened = page
          .locator('[role="dialog"], [role="menu"], [role="listbox"]')
          .filter({ visible: true })
          .last();
        const kind = await opened.evaluate((el) => ({
          role: el.getAttribute("role"),
          slot: el.getAttribute("data-slot"),
        }));
        const overlay = page
          .locator(
            `[role=${JSON.stringify(kind.role)}]${kind.slot ? `[data-slot=${JSON.stringify(kind.slot)}]` : ""}:not([aria-label="Settings"])`,
          )
          .last();
        const sharedEditor =
          activePage === "/settings/keybindings" &&
          /^Edit (when clause|shortcut) for /.test(item.label)
            ? item.label.match(/^Edit (when clause|shortcut)/)[0]
            : null;
        const signature = sharedEditor
          ? `${activePage}|${sharedEditor}`
          : activePage +
            "|" +
            (await inventory(overlay)).map((i) => `${i.role}|${i.label}|${i.type}`).join(";");
        if (!scannedOverlays.has(signature)) {
          scannedOverlays.add(signature);
          const openOnly = async () => {
            await ensureOpen();
            const trigger = await locate(item, scope);
            if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
            await overlay.waitFor({ timeout: 3000 });
          };
          const reopenOverlay = async () => {
            await reset();
            await openOnly();
          };
          reopenOverlay.openOnly = openOnly;
          await scan(overlay, new Set(), depth + 1, reopenOverlay);
        }
      } else if (
        /^(Select |Use |Follow |Cost|Tokens|Limits|Current limits|Trends)/i.test(item.label) &&
        depth < 1 &&
        page.url() === beforeUrl
      ) {
        await scan(
          scope,
          new Set(discovered.map((i) => `${i.key}|${i.ordinal}`)),
          depth + 1,
          async () => {
            await reset();
            await (await locate(item, scope)).click();
          },
        );
      }
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      }, beforeLocal);
      currentContext = null;
      await reset();
      return record(
        "pass",
        name,
        "Target state, local content, navigation, or overlay changed; initial UI context reopened",
      );
    });
    await flushErrors();
    const last = results.at(-1);
    if (
      !succeeded &&
      last?.status === "fail" &&
      /Control disappeared|Bot could not replay/.test(last.reason)
    ) {
      coverageGaps.push({
        page: activePage,
        reason: `Scanner could not replay its context after ${name}`,
        controls: items
          .filter((i) => !seen.has(`${i.key}|${i.ordinal}`))
          .map((i) => `${i.role}: ${i.label}`),
      });
      break;
    }
  }
}
async function prepareSecondBrainFixture() {
  const scope = page.locator('[data-workspace-area="settings"]');
  const folder = scope.getByRole("textbox", { name: "Second brain folder", exact: true });
  if (!(await folder.count())) {
    const notice = scope.locator('p[role="status"]').locator("xpath=..");
    const owner = notice.getByRole("button").first();
    await owner.click();
    await folder.waitFor({ timeout: 3000 });
  }
  const vault = NodePath.join(app.baseDir, "qa-second-brain");
  await NodeFSP.mkdir(vault, { recursive: true });
  const canonicalVault = await NodeFSP.realpath(vault);
  const canonicalBase = await NodeFSP.realpath(app.baseDir);
  NodeAssert.ok(
    canonicalVault.startsWith(`${canonicalBase}${NodePath.sep}`),
    "Second-brain fixture escaped isolated app directory",
  );
  await NodeFSP.mkdir(NodePath.join(vault, "notes"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(vault, "notes", "qa-fixture.md"),
    "# QA fixture\n\nDisposable local note for maintenance verification.\n",
  );
  const dbPath = NodePath.join(app.baseDir, "userdata", "second-brain.sqlite");
  const dbInfo = await NodeFSP.lstat(dbPath);
  NodeAssert.ok(
    dbInfo.isFile() && !dbInfo.isSymbolicLink(),
    "Expected harness-created second-brain database",
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    const insert = db.prepare(
      "INSERT OR REPLACE INTO proposals(id,vault,actor,state,fingerprint,document) VALUES(?,?,?,?,?,?)",
    );
    for (let n = 1; n <= 21; n++) {
      const path = `qa-proposal-${String(n).padStart(3, "0")}.md`;
      const proposal = {
        id: `qa-proposal-${n}`,
        vault: canonicalVault,
        actor: "qa-fixture",
        state: "pending",
        path,
        kind: "note",
        operation: "create",
        content: `# QA proposal ${n}\n`,
        expectedHash: null,
        rationale: "Disposable pagination fixture",
        evidence: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        reviewedAt: null,
        reason: null,
      };
      const fingerprint = JSON.stringify([
        path,
        proposal.operation,
        proposal.content,
        null,
        null,
        null,
        null,
      ]);
      insert.run(
        proposal.id,
        proposal.vault,
        proposal.actor,
        proposal.state,
        fingerprint,
        JSON.stringify(proposal),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  await folder.fill(canonicalVault);
  await folder.blur();
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready();
  NodeAssert.equal(
    await folder.inputValue(),
    canonicalVault,
    "Disposable second-brain folder did not persist",
  );
  await scope
    .getByRole("button", { name: "note: qa-proposal-021.md", exact: true })
    .waitFor({ timeout: 5000 });
  prepareSecondBrainFixture.state = { vault: canonicalVault, dbPath };
  await record(
    "pass",
    "second-brain fixture",
    "Disposable local folder configured through the UI; 21 pending proposals seeded in the harness database and first page rendered",
  );
}

async function exerciseSecondBrainFixtureControl(item, loc, scope) {
  const fixture = prepareSecondBrainFixture.state;
  const name = `${item.role}: ${item.label}`;
  if (item.label === "Refresh") {
    const { DatabaseSync } = await import("node:sqlite");
    const proposalButtons = scope.getByRole("button", { name: /^note\s*:\s*qa-proposal-\d+\.md$/ });
    const original = await proposalButtons.allTextContents();
    NodeAssert.equal(original.length, 20, "Refresh fixture requires its original 20-proposal page");
    const id = "qa-refresh-proof";
    const path = "qa-refresh-proof.md";
    const proposal = {
      id,
      vault: fixture.vault,
      actor: "qa-fixture",
      state: "pending",
      path,
      kind: "note",
      operation: "create",
      content: "# QA refresh proof\n",
      expectedHash: null,
      rationale: "Disposable refresh fixture",
      evidence: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      reviewedAt: null,
      reason: null,
    };
    const mutate = (insert) => {
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA busy_timeout=1000");
        if (insert) {
          NodeAssert.equal(
            db.prepare("SELECT count(*) AS count FROM proposals WHERE id=?").get(id).count,
            0,
            "Refresh fixture proposal already exists",
          );
          db.prepare(
            "INSERT INTO proposals(id,vault,actor,state,fingerprint,document) VALUES(?,?,?,?,?,?)",
          ).run(
            id,
            fixture.vault,
            proposal.actor,
            proposal.state,
            JSON.stringify([path, proposal.operation, proposal.content, null, null, null, null]),
            JSON.stringify(proposal),
          );
        } else {
          db.prepare("DELETE FROM proposals WHERE id=? AND vault=? AND actor=?").run(
            id,
            fixture.vault,
            proposal.actor,
          );
        }
      } finally {
        db.close();
      }
    };
    const proof = scope.getByRole("button", { name: /^note\s*:\s*qa-refresh-proof\.md$/ });
    NodeAssert.equal(
      await proof.count(),
      0,
      "Refresh fixture was already visible before insertion",
    );
    mutate(true);
    try {
      await loc.click();
      await proof.waitFor({ timeout: 3000 });
      NodeAssert.equal(
        await proposalButtons.count(),
        19,
        "Refreshed first page did not include the new proposal alongside 19 original records",
      );
    } finally {
      mutate(false);
      await loc.click();
      await proof.waitFor({ state: "hidden", timeout: 3000 });
      await scope
        .getByRole("button", { name: /^note\s*:\s*qa-proposal-021\.md$/ })
        .waitFor({ timeout: 3000 });
      NodeAssert.deepEqual(
        await proposalButtons.allTextContents(),
        original,
        "Refresh did not restore the exact original proposal page after fixture cleanup",
      );
    }
    return record(
      "pass",
      name,
      "Refresh displayed a newly seeded local proposal; removing it and refreshing restored the exact original 20-proposal page",
    );
  }
  if (["Previous", "Next"].includes(item.label)) {
    const proposalButtons = scope.getByRole("button", { name: /^note: qa-proposal-\d+\.md$/ });
    const original = await proposalButtons.allTextContents();
    NodeAssert.equal(
      original.length,
      20,
      "Pagination fixture must start on its first 20-proposal page",
    );
    const next = scope.getByRole("button", { name: "Next", exact: true });
    const previous = scope.getByRole("button", { name: "Previous", exact: true });
    try {
      await next.click();
      await scope
        .getByRole("button", { name: "note: qa-proposal-001.md", exact: true })
        .waitFor({ timeout: 3000 });
      NodeAssert.equal(
        await proposalButtons.count(),
        1,
        "Second proposal page did not contain its remaining record",
      );
      await previous.click();
      await scope
        .getByRole("button", { name: "note: qa-proposal-021.md", exact: true })
        .waitFor({ timeout: 3000 });
      NodeAssert.deepEqual(
        await proposalButtons.allTextContents(),
        original,
        "Previous did not restore the exact original proposal page",
      );
    } finally {
      if (await previous.isEnabled()) {
        await previous.click();
        await scope
          .getByRole("button", { name: "note: qa-proposal-021.md", exact: true })
          .waitFor({ timeout: 3000 });
      }
    }
    return record(
      "pass",
      name,
      "Next displayed the remaining proposal on page two; Previous restored the exact original 20-proposal page",
    );
  }
  if (item.label === "Lint") {
    await loc.click();
    await scope.getByText(/qa-fixture\.md.*missing_frontmatter/).waitFor({ timeout: 5000 });
    return record(
      "pass",
      name,
      "Lint reported missing_frontmatter for the deliberately plain Markdown fixture",
    );
  }
  if (item.label === "Reindex") {
    const { DatabaseSync } = await import("node:sqlite");
    const readGeneration = () => {
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        return Number(
          db.prepare("SELECT generation FROM vaults WHERE root=?").get(fixture.vault)?.generation ??
            0,
        );
      } finally {
        db.close();
      }
    };
    const original = readGeneration();
    await NodeFSP.writeFile(
      NodePath.join(fixture.vault, "qa-reindex-proof.md"),
      `# QA reindex proof\n\n${Date.now()}\n`,
    );
    await loc.click();
    await page.waitForFunction(
      (before) => {
        const label = Array.from(document.querySelectorAll("dt")).find(
          (el) => el.textContent.trim() === "Generation",
        );
        return Number(label?.nextElementSibling?.textContent) > before;
      },
      original,
      { timeout: 5000 },
    );
    NodeAssert.ok(readGeneration() > original, "Reindex did not advance the persisted generation");
    return record(
      "pass",
      name,
      "Reindex advanced both displayed and persisted local index generation after adding a disposable note",
    );
  }
  if (item.label === "Regenerate INDEX") {
    const indexPath = NodePath.join(fixture.vault, "INDEX.md");
    const stale = "<!-- generated by d4 second brain; do not edit -->\n# QA stale index\n";
    await NodeFSP.writeFile(indexPath, stale);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const watcher = NodeFSP.watch(fixture.vault, { signal: controller.signal });
    const updated = (async () => {
      for await (const event of watcher) {
        if (event.filename !== "INDEX.md") continue;
        const content = await NodeFSP.readFile(indexPath, "utf8");
        if (content !== stale && content.includes("QA fixture")) return content;
      }
      throw new Error("Regenerate INDEX produced no matching file update");
    })();
    try {
      await loc.click();
      const content = await updated;
      NodeAssert.ok(
        content.startsWith("<!-- generated by d4 second brain; do not edit -->"),
        "Generated index has no ownership marker",
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await updated.catch(() => {});
    }
    return record(
      "pass",
      name,
      "Regenerate INDEX replaced stale disposable index content with a generated index containing the fixture note",
    );
  }
  throw new Error(`Unsupported second-brain fixture control: ${item.label}`);
}

async function exerciseNotes() {
  const returnUrl = page.url();
  const workspace = NodePath.join(app.baseDir, "qa-notes");
  await NodeFSP.mkdir(workspace, { recursive: true });
  await session.context.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("open", () => {
          window.__qaSocket = this;
        });
      }
    };
  });
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__qaSocket?.readyState === WebSocket.OPEN, undefined, {
    timeout: 10000,
  });
  const threadId = await page.evaluate(async (workspaceRoot) => {
    const socket = window.__qaSocket;
    let nextId = 910000;
    const request = (tag, payload) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
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
          reject(new Error("Notes fixture RPC exceeded 10 seconds"));
        }, 10000);
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ _tag: "Request", id, tag, headers: [], payload }));
      });
    const projectId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    await request("projects.mutate", {
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "qa-notes",
      workspaceRoot,
    });
    await request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId,
      createdBy: "user",
      creationSource: "web",
      title: "QA notes fixture",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return threadId;
  }, workspace);
  await page.getByRole("treeitem", { name: /^QA notes fixture,/ }).click();
  const notes = page.getByRole("button", { name: "Open thread notes", exact: true });
  await notes.waitFor();
  await notes.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByText("No research artifacts in this thread.", { exact: true }).waitFor();
  await record(
    "pass",
    "notes: open empty notes",
    "Stopped fixture thread opened Notes without running a provider",
  );
  const artifact = "steps/001-step1-v1-fixture.md";
  const content = "QA_NOTES_FIRST\n" + "n".repeat(70000) + "\nQA_NOTES_LAST";
  const runDir = NodePath.join(workspace, "research-runs", threadId);
  await NodeFSP.mkdir(NodePath.join(runDir, "steps"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(runDir, artifact), content);
  await NodeFSP.writeFile(
    NodePath.join(runDir, "ledger.jsonl"),
    JSON.stringify({
      seq: 1,
      threadId,
      at: new Date().toISOString(),
      runId: `${threadId}:synthetic`,
      step: "1",
      visit: 1,
      requestedTarget: "fixture",
      resolvedTarget: "fixture",
      substituted: false,
      outcome: "success",
      durationMs: 0,
      chars: content.length,
      truncated: false,
      artifact,
      contentHash: NodeCrypto.createHash("sha256").update(content).digest("hex"),
    }) + "\n",
  );
  await dialog.getByRole("button", { name: "Refresh notes", exact: true }).click();
  const read = dialog.getByRole("button", { name: `Read note ${artifact}`, exact: true });
  await read.waitFor();
  await record(
    "pass",
    "notes: Refresh notes",
    "Refreshing exposed the synthetic artifact added after the dialog opened",
  );
  await read.click();
  const pre = dialog.locator("pre");
  await pre.getByText(/^QA_NOTES_FIRST/).waitFor();
  const first = await pre.innerText();
  NodeAssert.equal(first, content.slice(0, first.length));
  await record(
    "pass",
    "notes: read artifact",
    "The displayed first page matches the synthetic note exactly",
  );
  const chunks = [first];
  let collected = first;
  for (let turn = 0; turn < 10 && collected.length < content.length; turn++) {
    const offset = collected.length;
    await dialog.getByRole("button", { name: "Next", exact: true }).click();
    await dialog.getByText(new RegExp(`^${offset.toLocaleString()}–`)).waitFor();
    const chunk = await pre.innerText();
    NodeAssert.equal(chunk, content.slice(offset, offset + chunk.length));
    chunks.push(chunk);
    collected += chunk;
  }
  NodeAssert.equal(collected, content);
  await record("pass", "notes: Next", "Successive pages reconstruct the complete synthetic note");
  const previousOffset = chunks.slice(0, -2).join("").length;
  await dialog.getByRole("button", { name: "Previous", exact: true }).click();
  await dialog.getByText(new RegExp(`^${previousOffset.toLocaleString()}–`)).waitFor();
  NodeAssert.equal(await pre.innerText(), chunks.at(-2));
  await record(
    "pass",
    "notes: Previous",
    "The preceding page matches the previously read chunk exactly",
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await record("pass", "notes: close", "Escape closed the Notes dialog");
  await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
}

async function prepareGitFixture() {
  const gitFixture = NodePath.join(scratch, "fixture-repository");
  NodeChildProcess.execFileSync(
    "git",
    ["clone", "--shared", "--no-checkout", "--quiet", root, gitFixture],
    { timeout: 10000, stdio: "pipe" },
  );
  await NodeFSP.rename(NodePath.join(gitFixture, ".git"), NodePath.join(app.workspace, ".git"));
  await NodeFSP.rm(gitFixture, { recursive: true, force: true });
  for (const branch of ["main", "qa-alternate"]) {
    NodeChildProcess.execFileSync(
      "git",
      ["-C", app.workspace, "update-ref", `refs/heads/${branch}`, "HEAD"],
      { timeout: 5000, stdio: "pipe" },
    );
  }
}

async function report() {
  const totals = Object.fromEntries(
    ["pass", "fail", "blocked", "skipped-destructive", "sampled", "pass-not-applicable"].map(
      (status) => [status, results.filter((r) => r.status === status).length],
    ),
  );
  const blockedReasons = Object.fromEntries(
    [...new Set(results.filter((r) => r.status === "blocked").map((r) => r.reason))].map(
      (reason) => [
        reason,
        results.filter((r) => r.status === "blocked" && r.reason === reason).length,
      ],
    ),
  );
  const missingRoutes = [...routes, "/usage"].filter((route) => !visitedRoutes.has(route));
  const missingMainSurfaces = requiredMainSurfaces.filter((surface) => !mainSurfaces.get(surface));
  const runCompleted =
    traversalCompleted &&
    !onlyRoutes &&
    !stopping &&
    missingRoutes.length === 0 &&
    missingMainSurfaces.length === 0;
  const complete = runCompleted && coverageGaps.length === 0;
  const data = {
    complete,
    runCompleted,
    missingRoutes,
    missingMainSurfaces,
    coverageGaps,
    sampling: [
      ...sampling,
      ...Array.from(samplingGroups.values())
        .filter((g) => g.omitted.size)
        .map((g) => ({
          page: g.page,
          shape: g.shape,
          retained: g.retained.size,
          notExercised: g.omitted.size,
        })),
      ...results
        .filter(
          (r) =>
            r.status === "sampled" && /alternative options (?:sampled|exercised)/.test(r.reason),
        )
        .map((r) => ({ page: r.page, shape: r.control, details: r.reason })),
    ],
    routeTimings,
    timestamp: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    bundle: serverBin,
    scriptSha256,
    harnessSha256,
    routes,
    totals,
    blockedReasons,
    results,
  };
  await NodeFSP.writeFile(NodePath.join(out, "report.json"), JSON.stringify(data, null, 2) + "\n");
  const cell = (v) => clean(v).replaceAll("|", "\\|").replaceAll("\n", " ");
  const table = (rows) =>
    [
      "| Page | Control | Status | Classification | Reason | Screenshot | Evidence |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (r) =>
          `| ${[r.page, r.control, r.status, r.classification ?? "", r.reason, r.screenshot ?? "", r.evidence ?? ""].map(cell).join(" | ")} |`,
      ),
    ].join("\n");
  await NodeFSP.writeFile(
    NodePath.join(out, "report.md"),
    `# QA results\n\nCompleted route run: ${runCompleted}. Planned traversal complete: ${complete}. Repeated-control sampling and unexercised counts are listed below. Duration: ${data.durationSeconds} seconds.\n\n${Object.entries(
      totals,
    )
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ")}\n\n## Blocked reasons\n\n${Object.entries(blockedReasons)
      .map(([reason, count]) => `- ${count}: ${reason}`)
      .join(
        "\n",
      )}\n\n## Failures\n\n${table(results.filter((r) => r.status === "fail"))}\n\n## Sampling\n\n${JSON.stringify(data.sampling, null, 2)}\n\n## Coverage gaps\n\n${JSON.stringify({ missingRoutes, missingMainSurfaces, coverageGaps }, null, 2)}\n\n## All results\n\n${table(results)}\n`,
  );
  console.log(`TOTALS ${JSON.stringify(totals)}\nREPORT ${out}`);
  if (totals.fail) process.exitCode = 1;
}
async function cleanup() {
  cleanupPromise ??= (async () => {
    const settled = await Promise.allSettled([
      session?.browser.close(),
      app ? stopIsolatedApp(app) : undefined,
    ]);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  await record("fail", "interrupted", signal);
  if (!acquiring) await cleanup().catch((e) => record("fail", "cleanup", e.message));
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
const deadline = setTimeout(() => void stop("14-minute run deadline exceeded"), 14 * 60 * 1000);
try {
  for (const file of (await NodeFSP.readdir(NodePath.join(root, "apps/web/src/routes"))).sort()) {
    if (!/^_chat\.settings\..*\.tsx$/.test(file)) continue;
    const source = await NodeFSP.readFile(NodePath.join(root, "apps/web/src/routes", file), "utf8");
    const match = source.match(/createFileRoute\(["']\/_chat(\/settings\/[^"']+)["']\)/);
    NodeAssert.ok(match, `Cannot discover settings route in ${file}`);
    routes.push(match[1]);
  }
  // The dev runner and Vite read repository env files even with a clean environment.
  // Suppress those reads in child Node processes without reading or changing the files.
  const preload = NodePath.join(scratch, "no-dotenv.mjs");
  await NodeFSP.writeFile(
    preload,
    String.raw`import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const blocked = (p) => /(?:^|[/\\])\.env(?:\.[^/\\]*)?$/.test(String(p));
const empty = (options) => typeof options === "string" || options?.encoding ? "" : Buffer.alloc(0);
const readSync = fs.readFileSync;
fs.readFileSync = function(p, options) { return blocked(p) ? empty(options) : readSync.call(this, p, options); };
const exists = fs.existsSync;
fs.existsSync = (p) => !blocked(p) && exists(p);
const read = promises.readFile;
promises.readFile = async function(p, options) { return blocked(p) ? empty(options) : read.call(this, p, options); };
const callbackRead = fs.readFile;
fs.readFile = function(p, options, callback) {
  if (!blocked(p)) return callbackRead.apply(this, arguments);
  const cb = typeof options === "function" ? options : callback;
  queueMicrotask(() => cb(null, empty(options)));
};
syncBuiltinESMExports();
`,
  );
  const sentinel = NodePath.join(scratch, ".env.qa-sentinel");
  await NodeFSP.writeFile(sentinel, "QA_SENTINEL=must-not-load");
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--import",
      NodeURL.pathToFileURL(preload).href,
      "--input-type=module",
      "-e",
      `import fs from 'node:fs'; import p from 'node:fs/promises'; import assert from 'node:assert/strict'; const f=process.argv[1]; assert.equal(fs.existsSync(f),false); assert.equal(fs.readFileSync(f,'utf8'),''); assert.equal(await p.readFile(f,'utf8'),'');`,
      sentinel,
    ],
    { timeout: 10000, env: { PATH: process.env.PATH }, stdio: "pipe" },
  );
  await NodeFSP.unlink(sentinel);
  const keep = new Set([
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TERM",
  ]);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  const providerShims = NodePath.join(scratch, "bin");
  await NodeFSP.mkdir(providerShims);
  for (const executable of [
    "codex",
    "claude",
    "cursor-agent",
    "agent",
    "opencode",
    "grok",
    "agy",
    "antigravity",
    "gemini",
    "muse",
    "junie",
    "pi",
  ]) {
    await NodeFSP.writeFile(NodePath.join(providerShims, executable), "#!/bin/sh\nexit 127\n", {
      mode: 0o700,
    });
  }
  const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  let realGit;
  for (const directory of process.env.PATH.split(NodePath.delimiter)) {
    const candidate = NodePath.join(directory, "git");
    try {
      await NodeFSP.access(candidate, 1);
      if ((await NodeFSP.stat(candidate)).isFile()) {
        realGit = candidate;
        break;
      }
    } catch {}
  }
  NodeAssert.ok(realGit, "Git fixture needs a real executable for delegation");
  // macOS caches xcrun's Git path; the wrapper must exist before the first probe.
  await NodeFSP.writeFile(
    NodePath.join(providerShims, "git"),
    `#!/bin/sh\nif [ "$1" = "--version" ] && [ -f ${quoteShell(NodePath.join(scratch, "git-unavailable"))} ]; then exit 127; fi\nexec ${quoteShell(realGit)} "$@"\n`,
    { mode: 0o700 },
  );
  process.env.PATH = `${providerShims}${NodePath.delimiter}${process.env.PATH}`;
  // Keep macOS path_helper from moving real providers ahead of disposable shims.
  await NodeFSP.writeFile(
    NodePath.join(scratch, ".zprofile"),
    `export PATH=${quoteShell(process.env.PATH)}\n`,
  );
  Object.assign(process.env, {
    ZDOTDIR: scratch,
    HOME: scratch,
    USERPROFILE: scratch,
    XDG_CONFIG_HOME: NodePath.join(scratch, "config"),
    XDG_DATA_HOME: NodePath.join(scratch, "data"),
    XDG_CACHE_HOME: NodePath.join(scratch, "cache"),
    TMPDIR: scratch,
    CODEX_HOME: NodePath.join(scratch, "codex"),
    CLAUDE_CONFIG_DIR: NodePath.join(scratch, "claude"),
    GEMINI_HOME: NodePath.join(scratch, "gemini"),
    GROK_HOME: NodePath.join(scratch, "grok"),
    XDG_STATE_HOME: NodePath.join(scratch, "state"),
    AGENT_CLI_CREDENTIAL_STORE: "memory",
    DO_NOT_TRACK: "1",
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
    T3CODE_DEV_SEED: "0",
    NODE_OPTIONS: `--import=${NodeURL.pathToFileURL(preload).href}`,
  });
  ({ startIsolatedApp, openAuthenticatedPage, openProject, stopIsolatedApp } =
    await import("./harness.mjs"));
  console.log("BOOT isolated production app; complete-run deadline 14 minutes");
  NodeAssert.ok(
    serverBin,
    "Set T3_PWA_TEST_SERVER_BIN to a freshly built isolated production bundle",
  );
  app = await startIsolatedApp({ serverBin });
  await NodeFSP.writeFile(
    NodePath.join(out, "processes.json"),
    JSON.stringify({ botPid: process.pid, appPid: app.child.pid }),
  );
  if (stopping) throw new Error("Stopped during startup");
  session = await openAuthenticatedPage(app, "qa-bot");
  page = session.page;
  acquiring = false;
  if (stopping) throw new Error("Stopped during authentication");
  page.setDefaultTimeout(2000);
  page.setDefaultNavigationTimeout(30000);
  const errorEvent = (control, message) => {
    if (stopping && !/ERR_NETWORK_CHANGED/.test(message)) return;
    if (
      /ERR_NETWORK_CHANGED|Failed to fetch dynamically imported module|Importing a module script failed/.test(
        message,
      )
    ) {
      if (transportFailure) return;
      transportFailure = true;
      stopping = true;
      control = "transport root failure";
      message =
        "Browser transport failed; remaining control checks were stopped to avoid a cascade: " +
        message;
    }
    if (/net::ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(message)) return;
    if (/Maximum update depth|Minified React error #185/.test(message)) {
      if (pageFailure === activePage) return;
      pageFailure = activePage;
      control = "pageerror root";
    }
    const redacted = clean(message);
    const key = `${activePage}|${control}|${redacted}`;
    const existing = errors.get(key);
    if (existing) {
      existing.count++;
      if (existing.row) existing.row.occurrences = existing.count;
      return;
    }
    errors.set(key, {
      page: activePage,
      control: `${activeControl}: ${control}`,
      message: redacted,
      count: 1,
    });
  };
  for (const message of session.consoleErrors) errorEvent("startup console", message);
  page.on("console", (message) => {
    if (message.type() === "error") errorEvent("console", message.text());
  });
  page.on("pageerror", (error) => errorEvent("pageerror", error.message));
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).origin === new URL(app.webUrl).origin)
      errorEvent(
        "requestfailed",
        `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
      );
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && new URL(response.url()).origin === new URL(app.webUrl).origin)
      errorEvent("HTTP", `${response.status()} ${new URL(response.url()).pathname}`);
  });
  await session.context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== new URL(app.webUrl).origin) {
      if (!externalServices.has(url.hostname)) {
        externalServices.add(url.hostname);
        await record(
          "blocked",
          "external service request",
          `External HTTP service ${url.hostname} is unavailable in the isolated fixture`,
        );
      }
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  if (onlyRoutes) {
    await openProject(page, app.workspace);
    await ready();
  }
  if (!onlyRoutes) {
    routeDeadline = Date.now() + 110000;
    activePage = "main";
    await attempt("project add and open", async () => {
      await openProject(page, app.workspace);
      await ready();
      await record(
        "pass",
        "project add and open",
        "Fixture project opened through the real UI; composer visible",
      );
    });
    await attempt("palette keyboard shortcut", async () => {
      // Project creation leaves the palette's directory mode in memory.
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      await page.getByTestId("composer-editor").first().blur();
      await page.keyboard.press("ControlOrMeta+k");
      const search = page.getByPlaceholder("Search commands, projects, and threads...");
      await search.waitFor({ timeout: 5000 });
      const paletteUrl = page.url();
      await scan(page.getByRole("dialog").last(), new Set(), 1, async () => {
        await page.goto(paletteUrl, { waitUntil: "domcontentloaded" });
        await page.getByTestId("composer-editor").first().waitFor();
        await page.keyboard.press("ControlOrMeta+k");
        await search.waitFor();
      });
      await page.keyboard.press("Escape");
      await search.waitFor({ state: "hidden" });
      await record("pass", "palette keyboard shortcut", "Palette opened by shortcut and closed");
    });
    await attempt("new thread and composer", async () => {
      await ready();
      const composer = page.getByTestId("composer-editor").first();
      await composer.waitFor();
      const previousUrl = page.url();
      const original = await composer.innerText();
      let nextUrl;
      try {
        await composer.fill("qa unsent draft fixture");
        await page
          .getByRole("button", { name: "New thread", exact: true })
          .click({ modifiers: ["Shift"] });
        await page.waitForURL((url) => url.href !== previousUrl && /\/draft\//.test(url.pathname));
        nextUrl = page.url();
        await composer.waitFor();
        NodeAssert.equal((await composer.innerText()).trim(), "");
      } finally {
        await page.goto(previousUrl, { waitUntil: "domcontentloaded" });
        await composer.waitFor();
        if (original.trim()) await composer.fill(original);
        else {
          await composer.press("ControlOrMeta+a");
          await composer.press("Backspace");
        }
        NodeAssert.equal((await composer.innerText()).trim(), original.trim());
      }
      await record(
        "pass",
        "new thread",
        "New draft route and empty composer observed; previous draft restored without submitting",
      );
      await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
      await composer.waitFor();
    });
    await attempt("composer controls", async () => {
      await openProject(page, app.workspace);
      await scan(page.locator('[data-chat-composer-form="true"]'));
      await record(
        "blocked",
        "provider turn",
        "Provider executables are disabled; no credentials or external service fixture",
      );
    });
    await attempt("sidebar", async () => {
      await ready();
      await scan(page.locator('[data-sidebar="sidebar"]').filter({ visible: true }).first());
    });
    await attempt("Nia", async () => {
      const originalUrl = page.url();
      try {
        await page.goto(new URL("/settings/general", app.webUrl).href, {
          waitUntil: "domcontentloaded",
        });
        await ready();
        const notice = page.getByText("Choose one environment to configure Nia.", { exact: true });
        if (await notice.isVisible())
          await notice.locator("xpath=..").getByRole("button").first().click();
        await page
          .getByRole("switch", { name: "Enable Nia", exact: true })
          .waitFor({ timeout: 5000 });
        await record(
          "pass",
          "Nia settings",
          "Nia environment settings opened and the real Enable Nia control rendered",
        );
      } finally {
        await page.goto(originalUrl, { waitUntil: "domcontentloaded" });
        await ready();
      }
      await record(
        "blocked",
        "Nia provider execution",
        "Nia provider credentials are absent from the disposable HOME",
      );
    });
    await attempt("notes", exerciseNotes);
  }
  for (const route of onlyRoutes
    ? onlyRoutes.filter((route) => routes.includes(route) || route === "/usage")
    : [...routes, "/usage"]) {
    if (stopping) break;
    if (onlyRoutes && !onlyRoutes.includes(route)) continue;
    const routeStarted = Date.now();
    routeDeadline =
      routeStarted +
      (route === "/settings/appearance"
        ? 180000
        : route === "/settings/providers" || route === "/settings/devices"
          ? 120000
          : route === "/settings/keybindings"
            ? 60000
            : route === "/settings/general"
              ? 65000
              : route === "/settings/access"
                ? 65000
                : route === "/settings/second-brain" ||
                    route === "/settings/threads" ||
                    route === "/usage"
                  ? 90000
                  : route === "/settings/maintenance" || route === "/settings/scheduled-tasks"
                    ? 60000
                    : 30000);
    routeBudgetReported = false;
    await attempt(`route ${route}`, async () => {
      if (route === "/settings/scheduled-tasks") await prepareGitFixture();
      await visit(route);
      visitedRoutes.add(route);
      if (route === "/settings/second-brain") await prepareSecondBrainFixture();
      const canonicalPath = new URL(page.url()).pathname;
      if (visitedPages.has(canonicalPath)) {
        await record(
          "pass",
          "page content",
          `Redirected to ${canonicalPath}; control results are under ${visitedPages.get(canonicalPath)}`,
        );
        return;
      }
      visitedPages.set(canonicalPath, route);
      const scope = route.startsWith("/settings/")
        ? page.locator('[data-workspace-area="settings"]')
        : page.getByRole("dialog", { name: "Usage", exact: true });
      NodeAssert.ok((await scope.innerText()).trim(), "Page has no real content");
      await record(
        "pass",
        "page content",
        "Content rendered; control outcomes reported separately",
      );
      if (/\/(providers|connections|tool-guard|usage)$/.test(route)) {
        await record(
          "blocked",
          "service functionality",
          route.includes("tool-guard")
            ? "Tool Guard service is not configured"
            : route.includes("connections")
              ? "Remote environment or SSH service is not configured"
              : "Provider CLI and provider credentials are absent from the disposable HOME",
        );
      }
      if (route === "/usage") {
        const prices = page.getByRole("dialog", { name: "Custom model prices", exact: true });
        const openPrices = async () => {
          await scope.getByRole("button", { name: "All environments", exact: true }).click();
          await page.getByRole("menuitem", { name: "Model prices", exact: true }).click();
          await prices.waitFor();
        };
        await attempt("button: Save changes", async () => {
          try {
            await openPrices();
            await exerciseUsagePriceSave(prices, openPrices);
          } finally {
            if (await prices.isVisible()) {
              await prices.getByRole("button", { name: "Close", exact: true }).click();
              await prices.waitFor({ state: "hidden" });
            }
          }
        });
      }
      await scan(scope);
    });
    routeTimings.push({ route, durationSeconds: (Date.now() - routeStarted) / 1000 });
  }
  traversalCompleted = !stopping;
} catch (error) {
  await record("fail", activeControl, error.message);
} finally {
  clearTimeout(deadline);
  await flushErrors();
  await cleanup().catch((error) => record("fail", "cleanup", error.message));
  await report();
}
