import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";
import { createPairingUrl } from "./harness.mjs";
import { runProductionBrowserSuite } from "./production-browser-harness.mjs";

async function bootFailure({ page, app }, persistent) {
  let requests = 0;
  const retried = Promise.withResolvers();
  await page.route("**/assets/main-*.js", (route) => {
    requests++;
    if (requests === 2) retried.resolve();
    return persistent || requests === 1 ? route.abort("failed") : route.continue();
  });
  await page.goto(createPairingUrl(app, persistent ? "persistent" : "transient"), {
    waitUntil: "domcontentloaded",
  });
  if (persistent) {
    const deadline = setTimeout(
      () => retried.reject(new Error("Startup did not retry within 20s")),
      20000,
    );
    try {
      await retried.promise;
    } finally {
      clearTimeout(deadline);
    }
    await page.waitForFunction(
      () =>
        document.querySelector("#boot-error") &&
        sessionStorage.getItem("t3code:chunk-load-reloaded") === "1",
    );
    await page.waitForLoadState("load");
    await page
      .locator("#boot-error")
      .getByRole("button", { name: "Reload", exact: true })
      .waitFor();
  } else {
    await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
    NodeAssert.equal(await page.locator("#boot-error").count(), 0);
  }
  NodeAssert.equal(requests, 2, "Failed imports must retry exactly once");
}

async function retireWorker({ page, context, app }) {
  await page.goto(`${app.webUrl}/manifest.webmanifest`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("d4-regression-draft", "keep my unsent work");
    return Promise.all([caches.open("t3code-static-old"), caches.open("unrelated-cache")]);
  });
  // Install an actual old controller whose navigation fetch rejects, then update
  // it to the shipped retirement worker. A fresh worker install misses this bug.
  const legacyWorker = (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: { "Cache-Control": "no-store" },
      body: `self.__legacyFixture = true;
      self.addEventListener("install", () => self.skipWaiting());
      self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
      self.addEventListener("fetch", event => {
        if (new URL(event.request.url).pathname === "/broken-navigation") {
          event.respondWith(Promise.reject(new TypeError("Load failed")));
        }
      });`,
    });
  await context.route("**/service-worker.js", legacyWorker);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
      );
    }
  });
  const failedPage = await context.newPage();
  NodeAssert.equal(await context.serviceWorkers()[0].evaluate(() => self.__legacyFixture), true);
  await NodeAssert.rejects(failedPage.goto(`${app.webUrl}/broken-navigation`), /net::ERR_FAILED/);
  await failedPage.close();
  await context.unroute("**/service-worker.js", legacyWorker);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error("Legacy registration missing");
    let timer;
    const activated = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Retirement worker did not activate within 10s")),
        10000,
      );
      registration.addEventListener(
        "updatefound",
        () => {
          const worker = registration.installing;
          if (!worker) return reject(new Error("Update did not create an installing worker"));
          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") resolve();
            if (worker.state === "redundant")
              reject(new Error("Retirement worker failed to activate"));
          });
        },
        { once: true },
      );
    });
    try {
      await Promise.all([registration.update(), activated]);
    } finally {
      clearTimeout(timer);
    }
  });
  NodeAssert.equal(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
    0,
  );
  NodeAssert.deepEqual(await page.evaluate(() => caches.keys()), ["unrelated-cache"]);
  // Close/reopen the page in the same browser profile, preserving cookies/storage.
  await page.goto(createPairingUrl(app, "reopened"), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  await reopened.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  NodeAssert.deepEqual(
    await reopened.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      controlled: !!navigator.serviceWorker.controller,
      draft: localStorage.getItem("d4-regression-draft"),
    })),
    { registrations: 0, controlled: false, draft: "keep my unsent work" },
  );
}

export const pwaRecoverySpecs = [
  { name: "transient-startup-recovery", run: (fixture) => bootFailure(fixture, false) },
  { name: "persistent-startup-stops-retrying", run: (fixture) => bootFailure(fixture, true) },
  { name: "stale-worker-upgrade-and-reopen", run: retireWorker },
];

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  await runProductionBrowserSuite(pwaRecoverySpecs);
}
