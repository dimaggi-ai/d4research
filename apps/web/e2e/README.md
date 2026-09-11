# UI and PWA regression gate

Run `vp run test:ui-regressions` from the repository root against a freshly built
server and web client. In an isolated checkout, build them with
`vp run --filter d4research build`. Do not rebuild the server artifacts underneath
a running development session just to run tests.

The suite starts its own server with disposable state and a free port. It does
not connect to the live instance or write to its database. To test an existing
isolated build, set `T3_PWA_TEST_SERVER_BIN` to that build's `apps/server/dist/bin.mjs`.
The server serves the client bundled alongside it, not the current source files.

Install the pinned browser with
`node apps/web/node_modules/playwright-core/cli.js install chromium`. Linux CI also
uses `--with-deps`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing
compatible Chromium executable.

Coverage includes failed startup imports, stale service-worker upgrades and
reopening, footer reachability, status-bar safe areas, and closing both panels,
including a maximized right panel. These tests exercise the production bundle;
the normal web unit-test command does not run them.

`vp run test:ui-regression-guards` deliberately injects known failures and requires
the corresponding tests to reject them. CI runs these checks too, so removing an
important assertion cannot silently turn a regression test into a passing smoke test.

Each case has a 90-second deadline. Failures produce a nonzero exit status.
Screenshots, traces, console logs, server logs, and `results.json` go to the printed
artifact directory, or to `T3_UI_ARTIFACT_DIR` when set. CI uploads these artifacts
even when a test fails.

The **UI and PWA regressions** CI job builds fresh artifacts and runs on pull
requests and the existing scheduled/manual CI triggers. Make that check required
in repository rules to prevent merging a failing change. Adding the workflow
does not change repository rules or protect a manual deployment by itself.

Chromium safe-area emulation is not installed-iPhone verification. Changes to
viewport metadata, authentication proxies, or service-worker delivery still need
an installed iPhone PWA check: open, rotate, show/dismiss the keyboard, close both
panels, close the app, and reopen it. A passing Safari tab is not equivalent.
