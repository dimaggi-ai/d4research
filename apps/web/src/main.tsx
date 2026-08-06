import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { shouldRegisterServiceWorkerForLocation } from "./serviceWorkerRegistration";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

if (
  "serviceWorker" in navigator &&
  (window.isSecureContext || location.hostname === "localhost") &&
  // A newly activated worker claims the page and reloads it. During pairing
  // that reload lands mid-exchange: the server has already consumed the
  // one-time token, the response (and its session cookie) is discarded, and
  // the token can never be used again. Register after pairing instead.
  shouldRegisterServiceWorkerForLocation(new URL(window.location.href))
) {
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      // Offline caching is an enhancement, not a requirement. Registration
      // fails outright on an origin whose certificate the browser does not
      // trust (a raw LAN IP behind a self-signed CA), and an uncaught
      // rejection there reads like an app fault rather than a missing nicety.
      .catch((cause: unknown) => {
        console.warn("Service worker registration skipped.", cause);
      });
  });
}
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
