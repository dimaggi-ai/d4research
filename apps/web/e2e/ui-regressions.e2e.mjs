import { createPairingUrl } from "./harness.mjs";
import { branding } from "./branding.spec.mjs";
import { mobileQueueWhileRunning } from "./mobile-queue.spec.mjs";
import { composerSurfaceOcclusion } from "./composer-surface.spec.mjs";
import { mobileSidebarReachability, mobileStatusBarReachability } from "./mobile-sidebar.spec.mjs";
import { panelCloseReachability } from "./panel-close.spec.mjs";
import { sidebarHeaderSafeArea } from "./sidebar-header.spec.mjs";
import { pwaRecoverySpecs } from "./pwa-recovery.e2e.mjs";
import { runProductionBrowserSuite } from "./production-browser-harness.mjs";

function authenticated(run) {
  return async (fixture) => {
    await fixture.page.goto(createPairingUrl(fixture.app, "ui-regression"), {
      waitUntil: "domcontentloaded",
    });
    await fixture.page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
    await run(fixture);
  };
}

await runProductionBrowserSuite([
  { name: "consistent-branding-and-loading", run: branding },
  ...pwaRecoverySpecs,
  { name: "mobile-queue-while-running", run: mobileQueueWhileRunning },
  { name: "sidebar-header-safe-area", run: authenticated(sidebarHeaderSafeArea) },
  { name: "composer-history-occlusion", run: authenticated(composerSurfaceOcclusion) },
  { name: "sidebar-footer-reachability", run: authenticated(mobileSidebarReachability) },
  { name: "status-bar-safe-areas", run: authenticated(mobileStatusBarReachability) },
  { name: "panel-close-and-maximize", run: authenticated(panelCloseReachability) },
]);
