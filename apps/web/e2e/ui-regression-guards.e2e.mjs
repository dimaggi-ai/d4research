import * as NodeAssert from "node:assert/strict";
import { createPairingUrl } from "./harness.mjs";
import { mobileQueueWhileRunning } from "./mobile-queue.spec.mjs";
import { composerSurfaceOcclusion } from "./composer-surface.spec.mjs";
import { mobileStatusBarReachability } from "./mobile-sidebar.spec.mjs";
import { panelCloseReachability } from "./panel-close.spec.mjs";
import { sidebarHeaderSafeArea } from "./sidebar-header.spec.mjs";
import { pwaRecoverySpecs } from "./pwa-recovery.e2e.mjs";
import { runProductionBrowserSuite } from "./production-browser-harness.mjs";

async function withBrokenCss(fixture, css, run, expectedFailure) {
  await fixture.context.route("**/assets/*.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n${css}` });
  });
  await fixture.page.goto(createPairingUrl(fixture.app, "mutation-check"), {
    waitUntil: "domcontentloaded",
  });
  await fixture.page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  await NodeAssert.rejects(run(fixture), expectedFailure);
}

await runProductionBrowserSuite([
  {
    name: "guard-catches-clipped-research-label",
    run: (fixture) =>
      withBrokenCss(
        fixture,
        ".sidebar-brand { display: block !important; }",
        sidebarHeaderSafeArea,
        /\[Research\] is clipped/,
      ),
  },
  {
    name: "guard-catches-missing-mobile-queue",
    run: async (fixture) => {
      await fixture.context.route("**/assets/*.css", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: `${await response.text()}\n[data-chat-composer-form] button[type=submit] { display: none !important; }`,
        });
      });
      await NodeAssert.rejects(mobileQueueWhileRunning(fixture), /Send message/);
    },
  },
  {
    name: "guard-catches-ipad-header-overlap",
    run: (fixture) =>
      withBrokenCss(
        fixture,
        '[data-slot="sidebar-inner"] { padding-top: 0 !important; }',
        sidebarHeaderSafeArea,
        /Sidebar logo overlaps status bar/,
      ),
  },
  {
    name: "guard-catches-transparent-composer",
    run: (fixture) =>
      withBrokenCss(
        fixture,
        '[data-slot="composer-shell"]::before { background: transparent !important; backdrop-filter: none !important; }',
        composerSurfaceOcclusion,
        /History bleeds through composer/,
      ),
  },
  {
    name: "guard-catches-status-bar-overlap",
    run: (fixture) =>
      withBrokenCss(
        fixture,
        "[data-sidebar-control] { top: 0 !important; }",
        mobileStatusBarReachability,
        /Sidebar toggle overlaps status bar/,
      ),
  },
  {
    name: "guard-catches-missing-panel-close",
    run: (fixture) =>
      withBrokenCss(
        fixture,
        '[data-right-panel-tabbar] [aria-label="Toggle right panel"] { display: none !important; }',
        panelCloseReachability,
        /data-right-panel-tabbar.*Toggle right panel/s,
      ),
  },
  {
    name: "guard-catches-stuck-worker-registration",
    run: async (fixture) => {
      // Worker updates bypass context.route. Inject the observable failure at
      // the registration API instead of pretending we changed the worker code.
      await fixture.context.addInitScript(() => {
        const original = navigator.serviceWorker.getRegistrations.bind(navigator.serviceWorker);
        navigator.serviceWorker.getRegistrations = async () => {
          const registrations = await original();
          return registrations.length ? registrations : [{ active: null }];
        };
      });
      const spec = pwaRecoverySpecs.find((spec) => spec.name === "stale-worker-upgrade-and-reopen");
      await NodeAssert.rejects(spec.run(fixture), /1 !== 0/);
    },
  },
]);
