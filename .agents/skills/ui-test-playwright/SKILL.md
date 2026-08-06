---
name: ui-test-playwright
description: Drive the d4research web app in a real browser with Playwright — run the e2e suite, add specs, or explore the running UI interactively to verify a change or reproduce a bug. Use when asked to "test the UI", "check it in the browser", "add a UI test", "verify it renders", or when a change touches routes, panels, settings, or the composer.
---

# Browser testing with Playwright

Unit tests (`vp test run`) cover logic; this skill covers what a user actually
sees. Prefer it whenever a claim would otherwise be "the code looks right".

## Run the existing suite

```bash
cd apps/web && vp run test:e2e          # or: node e2e/ui.e2e.mjs
T3_E2E_HEADED=1 node e2e/ui.e2e.mjs     # watch it drive the browser
```

The suite boots its own isolated stack (temp base dir, ports 3931/5931), pairs a
browser, runs every spec against one shared context, and tears everything down.
It never touches `~/.t3` or a running production server, so it is safe to run
while the user is working.

## Explore the UI interactively

Reuse the harness instead of hand-rolling setup:

```js
import {
  startIsolatedApp,
  openAuthenticatedPage,
  openProject,
  stopIsolatedApp,
} from "./apps/web/e2e/harness.mjs";

const app = await startIsolatedApp();
const { page, browser, consoleErrors } = await openAuthenticatedPage(app);
await openProject(page, app.workspace);
// ...drive the page, then:
await browser.close();
await stopIsolatedApp(app);
```

`playwright-core` is a devDependency of `apps/web`; import it from there. Browsers
live in `~/.cache/ms-playwright`.

## Add a spec

Append to `apps/web/e2e/ui.e2e.mjs`:

```js
spec("what the user should see", async ({ page, webUrl, workspace }) => {
  await page.goto(`${webUrl}/settings/general`, { waitUntil: "domcontentloaded" });
  await page.getByText("Context compression").waitFor({ timeout: 20_000 });
  NodeAssert.ok((await page.locator("body").innerText()).includes("Handoff"));
});
```

Specs share one browser context and run in order, so leave the UI in a neutral
state (close popovers) and never assume a previous spec's route.

## Selector rules learned the hard way

- **Accessible name beats visible text.** The Monitor control renders the word
  "Monitor" but is labelled `aria-label="Open local tools"` — `getByRole` matches
  the label. When a role query fails, dump the truth rather than guessing:
  ```js
  await page
    .locator("button[aria-label]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  ```
- **`count()` is a snapshot, not a wait.** Sampling it mid-navigation silently
  takes the wrong branch. Use `waitFor({ state: "visible" })`.
- **Some controls are always present.** "Add project" lives in the sidebar
  permanently, so it cannot tell you whether a project exists — check the route
  instead.
- **A route resolving is not the UI being ready.** After `waitForURL`, wait for a
  control that only exists in the target view (e.g. `Send message`).
- **Open popovers make the rest of the page inert**, hiding it from role queries.
  Close them before the next assertion.

## Reporting

State pass/fail per spec and paste the failure text. Screenshots
(`page.screenshot({ path })`) are worth capturing for layout claims — read the
image back before describing what it shows. Never report a UI behaviour as
verified unless a spec or a screenshot actually demonstrates it.

## Boundaries

- Do not point the harness at the user's real `~/.t3` state or the production
  server on port 3773.
- Do not restart `t3code.service` to test something; boot an isolated app.
- Treat pairing URLs as secrets: they are single-use and must not appear in
  final responses, commits, or logs.
