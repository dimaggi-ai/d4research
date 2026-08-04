import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:7341";
const chromePath = process.env.CHROME_PATH ?? "/opt/google/chrome/chrome";
const debugPort = 19228;
const profile = mkdtempSync(join(tmpdir(), "t3research-chrome-"));
const screenshotPath = process.env.T3RESEARCH_UI_SCREENSHOT || "";

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    `${baseUrl}/setup`,
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (cause) {
      lastError = cause;
      await delay(100);
    }
  }
  throw lastError ?? new Error("Timed out.");
}

try {
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const pages = await response.json();
    const candidate = pages.find((entry) => entry.type === "page");
    if (!candidate?.webSocketDebuggerUrl) throw new Error("Chrome page is not ready.");
    return candidate;
  }, 10_000);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await call("Page.enable");
  await retry(
    async () => {
      const state = await evaluate("document.readyState");
      const text = await evaluate("document.body.innerText");
      if (
        state !== "complete" ||
        !text.includes("Local deterministic QA") ||
        !text.includes("Local SQLite") ||
        !text.includes("Meko Cloud")
      ) {
        throw new Error("Installation UI has not populated providers and memory connectors.");
      }
      return true;
    },
    10_000,
  );

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#providers .row')].find((entry) => entry.innerText.includes('Local deterministic QA'));
    const button = row?.querySelector('button');
    if (!button) throw new Error('Provider test button missing.');
    button.click();
  })()`);
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      const row = [...document.querySelectorAll('#providers .row')].find((entry) => entry.innerText.includes('Local deterministic QA'));
      const label = row?.querySelector('button')?.textContent;
      if (label === 'Ready') { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Provider probe did not become ready.')); }
    }, 50);
  })`, true);

  const generatedTag = await evaluate(`(() => {
    const chip = [...document.querySelectorAll('#agent-suggestions button')].find((entry) => entry.textContent === 'Ollama local');
    if (!chip) throw new Error('Suggested Ollama agent is missing.');
    chip.click();
    document.querySelector('#research-question').value = 'Verify guided syntax.';
    document.querySelector('#deep-research-tag').click();
    return document.querySelector('#research-question').value;
  })()`);
  if (generatedTag !== '#deep-research [ollama-local] Verify guided syntax.') {
    throw new Error(`Unexpected generated tag: ${generatedTag}`);
  }

  const rotationSuffix = Date.now();
  const rotationName = `Browser rotation ${rotationSuffix}`;
  const rotationId = `browser-rotation-${rotationSuffix}`;
  await evaluate(`(() => {
    const form = document.querySelector('#provider-form');
    form.elements.name.value = ${JSON.stringify(rotationName)};
    form.elements.driver.value = 'mock';
    form.elements.model.value = 'deterministic-v1';
    form.requestSubmit();
  })()`);
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      const text = document.querySelector('#providers')?.textContent || '';
      if (text.includes(${JSON.stringify(rotationName)})) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) {
        clearInterval(timer);
        const notice = document.querySelector('#notice')?.textContent || '';
        reject(new Error('Provider installation did not appear. notice=' + notice + ' providers=' + text.slice(0, 500)));
      }
    }, 50);
  })`, true);

  const title = `Browser QA ${Date.now()}`;
  await evaluate(`(() => {
    const form = document.querySelector('#run-form');
    form.elements.title.value = ${JSON.stringify(title)};
    form.elements.providerId.value = 'local-mock';
    form.elements.depth.value = 'quick';
    form.elements.question.value = ${JSON.stringify(`#deep-research [local-mock, ${rotationId}] Prove the browser installation workflow works.`)};
    form.requestSubmit();
  })()`);
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      const detail = document.querySelector('#detail')?.innerText || '';
      const detailCard = document.querySelector('#detail-card');
      if (!detailCard?.hidden && detail.includes(${JSON.stringify(title)}) && detail.includes('awaiting_approval') && detail.includes(${JSON.stringify(rotationId)})) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Research plan did not appear.')); }
    }, 50);
  })`, true);

  await evaluate(`(() => {
    const form = document.querySelector('#chat-form');
    form.elements.text.value = 'Continue this planned run.';
    form.requestSubmit();
  })()`);
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      const text = document.querySelector('#messages')?.innerText || '';
      if (text.includes('Shared-context chat reply')) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Shared-context chat reply did not appear.')); }
    }, 50);
  })`, true);

  if (screenshotPath) {
    const capture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));
  }
  console.log(JSON.stringify({ ok: true, providerProbe: "ready", providerInstall: "saved", providerChain: ["local-mock", rotationId], researchPlan: "awaiting_approval", chat: "completed", title }));
  socket.close();
} finally {
  chrome.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(2_000)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
