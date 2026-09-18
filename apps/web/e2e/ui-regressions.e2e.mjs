import { createPairingUrl } from "./harness.mjs";
import { branding, onboardingBranding } from "./branding.spec.mjs";
import { darkPalette } from "./dark-palette.spec.mjs";
import { reconnectBanner } from "./reconnect-banner.spec.mjs";
import { sidebarFooterSurface } from "./sidebar-footer-surface.spec.mjs";
import { mobileQueueWhileRunning } from "./mobile-queue.spec.mjs";
import { missingThreadRedirect } from "./missing-thread.spec.mjs";
import { idleAgentsAndAudio } from "./idle-agents-audio.spec.mjs";
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
  { name: "missing-thread-redirects-to-draft", run: missingThreadRedirect },
  { name: "mobile-queue-while-running", run: mobileQueueWhileRunning },
  { name: "idle-agents-and-unrequested-audio", run: idleAgentsAndAudio },
  { name: "sidebar-header-safe-area", run: authenticated(sidebarHeaderSafeArea) },
  { name: "composer-history-occlusion", run: authenticated(composerSurfaceOcclusion) },
  { name: "sidebar-footer-reachability", run: authenticated(mobileSidebarReachability) },
  { name: "status-bar-safe-areas", run: authenticated(mobileStatusBarReachability) },
  { name: "panel-close-and-maximize", run: authenticated(panelCloseReachability) },
  { name: "dark-palette-and-light-mode", run: authenticated(darkPalette) },
  { name: "single-reconnect-banner", run: reconnectBanner },
  { name: "sidebar-footer-surface", run: authenticated(sidebarFooterSurface) },
  { name: "onboarding-d4-branding", run: authenticated(onboardingBranding) },
]);
