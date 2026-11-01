# Fork Changes

## Follow-up upstream synchronization — 2026-10-29 (dd14848153)

- Merge 13 further upstream commits through `dd148481531a0a090780a2ade20588566db099a2`.
  Review 24 overlapping paths and reconcile four conflicts. Adopt concurrent SQLite
  readers, scoped recovery/run-preparation reads, smaller checkpoint payloads with full
  totals, faster sidebar/startup queries, parallel Git status, fewer idle/background
  queries, provider discovery/request caching, reconnect permission retries and iOS tabs.
- Preserve the fork dashboards, project rail, multi-root Files/diff viewer, account usage,
  Claude isolation, Terra 6.1, mobile relay and bundled SSH updates. Keep the generic
  `DiffTreeFile` tree input in `apps/web/src/lib/turnDiffTree.ts` while adopting complete
  checkpoint totals in changed-file cards. Retain the SQLite writer fairness logic and
  fork settlement guards/defaults alongside the new reader pool and idle-sweep behavior.
- Reserve migration 78 for upstream's `073_ActiveTurnItemIndexes.ts` in
  `apps/server/src/persistence/Migrations.ts`; preserve released slots 1–77, upgrade
  fixtures and the npm launcher's expected release migration metadata. Retain both fork
  settlement regression cases and upstream's settings-change-during-sweep case.
- New heap attribution in `apps/server/src/observability/HeapAttribution.ts` annotates local
  traces. It does not enable external collection: analytics/client tracing remain no-ops
  and OTLP trace/metric/log endpoints stay disabled in the fork configuration.
- Keep project-delete retry assertions deterministic by awaiting the existing metadata
  enrichment completion signal before taking the deletion snapshot in
  `apps/server/src/project/ProjectService.test.ts`; faster reads exposed that fixture race.
- Validation: all changed-file checks pass: 975 tests across 46 files, 15 changed-file
  React Compiler cases, all 32 affected package typechecks, formatting/lint, both knip
  passes and generated GraphQL. Isolated Chromium verifies both dashboard layouts,
  navigation/read state, custom filters, phone viewport, Contrast, the native Files
  editor and diff test-file filtering. Package/stage the arm64 app without restarting
  the desktop app or remote servers.

## Upstream synchronization — 2026-10-29 (08a463e299)

- Merge 130 upstream commits through `08a463e29976617134de01e9341f898bc881d0eb`,
  retaining both histories. Review 113 overlapping paths and reconcile 19 conflicts.
  Adopt 0.1.5, Electron 44.10, provider usage fallback and refresh, scratch-thread project
  promotion, timeline performance improvements, diff test-file filtering, configurable
  thread details, scoped secret-provider settings and release-track migration safety.
- Preserve dashboards and Appearance choices, project settlement/groups/order/colors,
  the expanded composer, action orb, native multi-root Files viewer, worktree selection,
  editor navigation/undo, recorded tool-call diffs, and the resizable diff tree. Integrate
  upstream's Hide test files control into `apps/web/src/components/DiffPanel.tsx` without
  replacing the fork viewer with upstream's separate explorer.
- Keep Terra 6.1, Claude account/config isolation, agent-visible usage, continuous usage
  bars, memory/workspace/peer tools, mobile desktop relay and bundled SSH server updates.
  Preserve secondary-workspace cleanup protection and settlement-triggered cleanup while
  adopting upstream's deferred worktree deletion. Analytics/client tracing remain no-ops;
  OTLP exports and endpoint probes stay disabled.
- Integrate explicit Stable/Nightly switching into `ServerUpdateAction.tsx` and the
  sidebar update planner while keeping automatic same-version bundle fingerprint checks
  and thread continuation. Explicit release switches bypass automatic bundle selection;
  normal packaged SSH updates bypass npm publication checks. Keep registry queries behind
  manual release actions or an explicitly opened track dialog, and keep shared-primary
  hosts distinct from the app's own local server.
- Preserve released migration slots 1–77 in `apps/server/src/persistence/Migrations.ts`.
  Make `scripts/build-npm-launcher.ts` read that registered manifest for release safety
  metadata instead of upstream filename ids. Retain strict context-budget checks with
  Claude 10,240 bytes, Codex 11,964 bytes and MCP schemas 62,101 bytes. Adapt incoming tests
  to fork branch prefixes, privacy opt-ins, source-control fixtures and macOS filesystems.
- Validation: the 207-file suite passes 4,547 cases, and changed-file React Compiler
  coverage passes 127 cases. Formatting/lint, both knip passes, generated GraphQL, dependency
  patches and all 36 affected package typechecks pass after the final fixture corrections.
  Isolated Chromium verifies both dashboard layouts, thread navigation/read state, custom
  project filters, a phone viewport, Contrast, the native Files editor and diff test-file
  filtering in both directions. A regression case reproduces explicit track switches selecting the wrong bundled build; all ten
  server-update browser cases pass after the fix. Native lint requires unavailable
  SwiftLint/ktlint/detekt; the real MCP eval requires an unavailable API key, and its dry
  run succeeds. Package/stage the arm64 app without restarting local or remote processes.

## Upstream synchronization — 2026-10-28 (9826dbb990)

- Merge 157 upstream commits through `9826dbb9904b2591bfbf60d1317486b59132f56b`,
  retaining both histories. Review 255 overlapping paths and reconcile 76 conflicts.
  Adopt bounded thread-history paging, recorded tool-call diffs, linked-environment
  delegation, pending-question recovery, grouped composer controls and effort labels,
  device-pool support, mobile workflows and native merge controls, and release fixes.
- Preserve the fork's dashboards, settled/grouped project rail and manual ordering,
  custom appearance and action orb, always-expanded composer, native Files tree,
  checkout recovery, multiple workspace roots, editor navigation/undo and Git history.
  Integrate tool-call diffs into the resizable diff tree and keep preview word-wrap
  overrides local. Restore the Contrast control alongside the retained contrast setting.
- Keep Terra 6.1, isolated Claude accounts, agent-visible usage, continuous usage bars,
  memory/workspace/peer tools, phone relay, and packaged SSH environment updates.
  Preserve the fork's settlement/retention defaults and update continuation capability.
  Analytics and client tracing remain no-ops; OTLP exports and endpoint probes stay disabled.
- Preserve released database migration slots; assign upstream peer-link migrations
  slots 75–77 in `apps/server/src/persistence/migrations.ts`. Connect upstream remote
  delegation to the fork's peer services in `apps/server/src/server.ts`, retaining
  permission checks and stale worker-question recovery.
- Keep all fork model instructions alongside upstream's device and delegation guidance
  in `packages/provider-core/src/server/orchestrationInstructions.ts`. The measured strict
  context budget is Claude 10,240 bytes, Codex 11,964 bytes and MCP tool schemas 62,001 bytes.
- Keep Claude skill discovery in the explicitly selected account config directory, and
  keep open-PR protection when adopting upstream settlement tests. Update the fork's
  fixtures to the current context-menu roles, tool-call actions and worktree prefix.
  Timeline restoration waits through deferred virtualizer layout and does not stall on
  unresolved scroll promises; an existing scrolling test covers both promise outcomes.
- Validation: changed-file formatting/lint, both knip passes, generated GraphQL, dependency
  patches and all 36 affected package typechecks pass. The 650-file test run passes 9,012
  cases; its remaining early-navigation assertion now waits for restoration, and all 107
  cases in the timeline/guest/rail recheck pass. Isolated Chromium checks cover dashboard
  layouts, real thread navigation and visits, custom project filters, the phone viewport,
  Contrast, a free Replay turn, and the native Files tree/editor. Native lint is blocked by
  missing SwiftLint/ktlint/detekt. The real MCP eval requires an unavailable API key;
  its dry run succeeds. Package/stage the arm64 app without restarting local or remote apps.

## Upstream synchronization — 2026-10-27 (d1c4b52b7c)

- Merge 138 upstream commits through `d1c4b52b7c7c7e1b7637ec47e4c959ff0c2d8d99`
  into the fork, retaining both histories. Review 120 overlapping files and reconcile
  36 conflicts. Adopt 0.1.3, the FX provider, compact MCP schemas, delegated-run fixes,
  settings page organization, Files save sessions/revisioned queries, mobile navigation
  and lifecycle updates, and desktop startup/release improvements.
- Preserve dashboards and Appearance choices, settled/grouped project rail, manual ordering,
  expanded composer and action orb, custom colors/type/chat width, native Files tree and
  checkout recovery, editor navigation/undo, Claude account isolation, agent-visible account
  usage, continuous usage bars, desktop phone gateway and packaged SSH environment updates.
  Analytics remains a no-op; upstream failed-batch retries do not enable collection.
- Move fork settlement controls and settled-thread retention into Threads settings, retain
  Never as the default and open-PR protection, and move the full idle compaction controls
  into Providers. Retain fork worktree cleanup precedence and retention defaults. Keep
  Terra 6.1 and its CLI requirement, using upstream release-date-based new badges.
- Keep fork memory, workspace, peer messaging and usage tools in the condensed MCP server.
  Retain their agent instructions alongside upstream instructions. The strict context-budget
  fixture explicitly includes these extra capabilities: Claude 9,962 bytes, Codex 10,508
  bytes, tool schemas 58,389 bytes. Preserve exact-size checks and model eval tooling.
- Integrate Markdown frontmatter masking into the fork preview while preserving checkbox
  offsets. Adapt directory invalidation and asset tests to selected checkouts and the native
  tree, and protect file dragging from opening a preview. Drop obsolete outer Pierre drag/context
  handlers; the native tree owns these events. Keep mobile checkout and merge-back
  controls compatible with upstream React Compiler coverage.
- Validation: `check:changed aadc9af1cf` passes all 4,954 tests in 244 files, 36 affected
  package typechecks, formatting, generated GraphQL and patch checks. Its lint and unused-export
  findings are fixed; final changed-file lint and both knip rechecks pass. Another 46 fork
  preservation cases, 30 dashboard/rail/relay/Claude/privacy/idle-compaction cases and 25 fork
  tools/SSH cases pass. The real MCP model eval was attempted but requires an unavailable
  `ANTHROPIC_API_KEY`; its dry run succeeds. Native lint was attempted; SwiftLint, ktlint and
  detekt are unavailable locally. Build/stage the arm64 desktop app without restarting local
  or remote applications.

## Upstream connector follow-up — 2026-10-26 (b6994c5499)

- Include the additional upstream commit published during validation, through
  `b6994c549977dd194d38f95902fcfac0445d8fa1`. Adopt its pinned cloudflared 2026.10.4
  URLs and matching checksums in `packages/shared/src/relayClient.ts`, retaining the
  fork's existing connector selection, opt-ins and privacy policy.
- Validation: scoped `check:changed HEAD` passes formatting, lint, both knip passes,
  all 29 affected package typechecks and 14 relay-client cases. Build a packaged arm64
  desktop artifact; installation/restart and remote mutations are outside this request.

## Upstream follow-up and Codex Terra 6.1 — 2026-10-26 (220eb73524)

- Merge all ten upstream commits after `3f9448747b` through `220eb73524`, retaining
  both histories and the separately published iOS fork changes. Review automatic
  merges in `PullRequestsPage.tsx` and `ProviderSettingsForm.test.ts`: retain project
  group scoping, fork-specific provider configuration and existing regression coverage.
- Adopt explicit provider setup flows, stable editable provider rows, single-commit
  color dragging, PR confirmation cleanup, bounded PR cache ownership, mobile composer
  sizing and shared media/file-jump lifecycles. Dashboard layouts, Files/worktree recovery,
  settled/grouped project rail, account usage tools, Claude isolation, idle compaction,
  desktop-host gateways and bundled SSH updates retain their fork implementations.
  No incoming changes touch the disabled analytics/OTLP owners.
- Register `gpt-6.1-terra` as a current Codex model in the bundled catalog and legacy
  classification overlay. Announce its documented Codex CLI minimum of `0.159.0` through
  the existing update-required picker path. Bump manifest freshness so an older cached
  manifest cannot mask this release. Use Codex-discovered reasoning/speed capabilities
  and preserve selected/default models. Web, desktop and native mobile share this catalog.
- Repair a protocol regression exposed by the fork checks: host gateways now issue the
  new `/rpc` and `/media` tickets locally with their proper audience, rather than forwarding
  ticket minting to the remote host. Upstream RPC connections request a remote RPC ticket,
  with the legacy endpoint used only for a 404. Keep phone credentials scoped to the paired
  host, intersected grants, revocation and backward compatibility. The existing two-server
  regression fails before the fix with a host-token signature mismatch; it passes afterward
  with live HTTP/WebSocket forwarding, audience checks and an older-server fallback.
- Source owners: `apps/server/src/provider/model-manifest.json`, `connections/SharedEnvironments.ts`,
  client-runtime resolver fixture and upstream-owned settings/PR/mobile files. User guidance:
  `providers-codex.md`.
- Validation: `check:changed bb48ca95cb` passes: 386 tests across 27 files, 34 affected
  package typechecks, formatting, lint, both knip passes, generated GraphQL and unused-patch
  checks. Another 24 Codex/catalog cases pass; targeted dashboard, settlement, Files checkout,
  SSH runtime, native discovery, Claude-home and privacy cases pass. A read-only runtime probe
  validates the actual Terra manifest, older-CLI hint, wire ID and discovered reasoning choices.
  `lint:mobile` was attempted but SwiftLint, ktlint and detekt are unavailable; no native
  Swift/Kotlin source changed. Rebuild the packaged local Mac app for later installation;
  leave running applications and all remote servers untouched.

## Fork branch reconciliation — 2026-10-26

- Bring the published iOS navigation/thread-control commit `e08b3741ca` into the
  newer upstream-integrated checkout. Retain its project drawer, scoped thread colors,
  compact header, terminal/scripts and merge-back controls. Preserve the newer mobile
  scroll container, filter gutters, family hydration and workspace-detail navigation.
- Remove only unreachable leftovers from the previous upstream merge: the unused
  directory loader (the mounted native tree uses `projectFilesQueryState` and
  `ExpandedDirectory`), the unused sortable animation helper and a private config export.
  Keep the Files renderer, directory invalidation and no-animation sortable behavior.
- Validation: frozen-lockfile dependency installation and `check:changed bb48ca95cb`: 155
  tests in five files, 34 affected package typechecks, formatting, lint, both knip passes,
  generated GraphQL and unused-patch checks pass. No application or remote server is restarted.

## iOS project drawer and desktop-style thread controls — 2026-10-24

- Replace native environment/project filter menus in the compact thread list and split-view
  sidebar with `ProjectNavigationPanel`, a React Native drawer with environment filters,
  project search, saved project icons, and environment labels. Swipe right from the left gutter
  to open projects; close with a left swipe, backdrop, or close button. Existing grouped scopes
  and host-scoped project references retain multi-environment discovery and filtering.
- Add device-local thread colors in `ThreadColorPicker` and mobile preferences, available from
  a row's context menu and the More screen, including read-only connections. The mobile and web
  clients share the palette and color validation in `packages/shared/src/accentColors.ts`.
- Reduce the iOS chat header to Files and More. More opens the existing detail surface directly
  and includes terminal sessions, project scripts, thread color, Git actions, and merge-back.
  `useThreadProjectTools` and `useThreadMergeBack` share those actions with the existing routes.
- Keep the desktop's existing saved active/pinned ordering. Regression coverage verifies that
  message activity cannot reshuffle active threads and matching IDs on different hosts remain
  distinct, and that project filtering retains each host's saved icon.
- Validation: `vp run check:changed` (format, lint, knip, affected typechecks and adjacent tests),
  focused preference/color and terminal-launch regressions. Device-panel UI verification is
  unavailable because agent device access is disabled on this environment.

## Daily upstream integration — 2026-10-26 (3f9448747b)

- Merge all 326 incoming upstream commits through
  `3f9448747bb8848050dc2cacf83affa6f94a66a1` into fork parent
  `cef955f9fe89eddc2b8418275d293b6f59d6d54c`, retaining both histories.
  Review the 311 overlapping paths, including automatic merges, and resolve 99
  conflicted paths individually. Reconcile heavily reindented files with an
  indentation-normalized three-way comparison before reviewing their remaining hunks.
- Integrate upstream's default design, Settings/Usage overlays, guest sharing,
  document/archive/database/font/large-text previews, bounded shell/history transport,
  workspace snapshot subscriptions, DPoP route audiences and lifecycle refactors.
  Keep the native Files renderer and its directory watcher helper instead of restoring
  the superseded Pierre tree. Retain per-repository checkout recovery, saved collapse/
  expansion/resize, dirty editors, navigation/Structure/Commit/Git History and deletion/undo.
  New document assets use the selected checkout, and their metadata revisions participate
  in the fork's visible-file watcher and ten-second validation path.
- Move custom chat width, chat font size and theme-aware accent application into the
  startup appearance owner. Keep project rail groups/settled shortcuts/status dots/colors,
  manual order, numbered slots, picker sizing, dashboard navigation and root-owned panel
  shortcuts. Combine upstream paged settled shelves and route reveal with group scopes
  and manual active-thread order. Keep native communication sheets classified as overlays.
- Retain the independent one-second timeline recovery deadline with upstream's shared
  viewport navigation and measured-end settling. Missing saved rows, invalid offsets and
  stalled scroll promises recover to the latest content; explicit navigation cancels recovery.
  Keep remembered follow mode for drafts and existing threads, downward-wheel rearming,
  zero-jump repair, first assistant text outside settled folds, mixed-work labels and stable
  imported identities. The editor's caret handler still scrolls only the prompt editor.
- Trace mounted `ChatView` → `ChatComposer` → `ComposerPrimaryActions`: Orb mounts
  `ComposerActionOrb`, saved send color covers Send/Resume/Queue/Steer, and saved stop color
  covers ordinary and pending-input Stop. Classic stays selectable. Existing chats and draft
  heroes keep forced mobile expansion, disabled scroll/focus collapse, custom width, one-line
  minimum and keyboard/viewport handling. Ordinary sends never compact first.
- Preserve the validated initial preparing run as the sole ordinary primary-checkout
  binding/clearing exception: only queued follow-ups, no provider session, pending question
  or background work. Keep Claude HOME/config isolation, account-history workers and observed
  worker effort hooks; discard only the incoming unused duplicate history-worker implementation.
  Account/source/model usage remains separate, with alphabetical colored pools, continuous bars
  and compact trends. Mounted CLI resume still creates V2 native-session references, and
  project-root/multi-root Markdown links still route to the explorer.
- Keep project notes/workspace/peer/connected-usage MCP services, shared-host gateways,
  bundled fork SSH updates and durable response watches connected. Adapt shared gateways to
  the RPC ticket audience. Keep the project-aware idle-compaction worker and overrides as the
  sole policy. Adapt the dashboard to upstream's meaningful-run shell projection, including
  historical system-created compactions in its SQL filter. Routine compactions stay quiet;
  failures remain visible. Keep real background work as Monitoring; guest requests stay in the
  inbox and light the rail input dot. Retain Never-default settlement, open-PR inactivity
  protection and monitor settlement guards.
- External analytics/OTLP and endpoint probes remain disabled. Provider version/manifest/
  periodic-refresh, desktop update and Keychain opt-ins, stable desktop storage and encrypted
  local connections remain active. Released migration IDs 1–74 stay unchanged. Multiwork and
  machine sync remain retired; older usage/sync helpers remain superseded.
- Adopt the new Effect function diagnostics without changing service behavior or existing Git/
  SSH span ownership. Keep the existing React Compiler exception list; new refs/dependency/
  memoization diagnostics on those same files report as warnings. Retained filesystem/editor
  effects state their external synchronization reason; simple root/selection resets derive
  during render rather than adding synchronization effects.
- Validation: frozen-lockfile installation succeeded with lifecycle scripts disabled, using
  pnpm 12.14.0 from a temporary copy because the host launcher referenced a missing file.
  Scoped typechecks passed for 33 workspaces: server/web/mobile/desktop and marketing, contracts/shared/
  client-runtime, all nine provider packages, both Effect protocol packages, all nine source-
  control packages, SSH, Tailscale, relay, scripts and the lint plugin. Initial integration and
  newly enforced diagnostic failures were corrected. Non-failing Effect suggestions remain.
  Checks use native tsc-rs 0.8.0 on host Node 24.15.0; the repository pins Node 26.12.1.
  Changed-file lint initially scanned 2,707 code files; integration lint passes with zero errors
  and 76 advisory warnings, including legacy styling, refs and dependency findings. Integration
  sources are formatted. Source whitespace checks pass; 2,538 findings in incoming vendored
  highlighting C/headers and 23 dependency-patch context lines remain verbatim. Tests were
  neither independently added nor executed; incoming cases and existing fixtures were
  retained/adapted and typechecked only.
- No builds, packaging, dev servers, browser/device/runtime checks, app installation/restart,
  process stops, installed-app/live-userdata access, push, PR, external messages, subagents,
  other-worktree/main edits or schedule changes. Static checks do not establish visual behavior,
  native compilation or runtime performance.

## Native mobile environments through the desktop host — 2026-10-24

- Native mobile now discovers the connected desktop host's shared catalog and registers temporary
  gateway connections for its other environments, including SSH-managed Mac mini servers. Reuse
  normal shell/thread synchronization and navigation; preserve environments paired directly on the
  phone. Removing/disabling the parent or denying discovery withdraws its shared entries; temporary
  network failures retain the last catalog for reconnect. Discovery is bounded to ten seconds.
- Share URL construction with the web client. Native gateway targets refer to the existing paired
  host credential instead of persisting remote credentials. Check the host identity and origin
  before issuing authenticated gateway requests; retain the gateway prefix for HTTP/WebSocket
  and descriptor access. Desktop/server publication and delegated permission enforcement remain
  authoritative. No upstream relay, new pairing per remote, or remote credential export is added.
- Native connection settings label these routes as shared and keep host-managed addresses and
  removal controls read-only. Source owners: mobile `connection/{runtime,shared-environments}.ts`,
  connection/settings rows, client-runtime `connection/{model,resolver,sharedEnvironmentRoutes}.ts`,
  and web shared-route discovery. The existing host browser flow stays supported.
- Regression reproduces the unauthenticated native gateway failure on the prior code. Focused
  cases cover native catalog discovery, HTTP/WebSocket authentication, host identity/origin checks,
  permission denial, temporary outages, recursion prevention, and existing server proxy grants.
  A controlled-clock lifecycle case exercises initial discovery, outage retention, permission
  revocation and host disablement. Device-panel tools are unavailable here, so no native device
  UI verification was performed. `lint:mobile` was attempted but its Swift/Kotlin tools are missing.
  Per owner instruction, this task commits/pushes only; no build, install or restart is performed.

## Compact project-rail actions — 2026-10-24

- Replace the stacked/footer controls with one ellipsis **Project actions** button in both rail
  widths. Reuse the existing themed rail menu for project/group creation, expanding/collapsing
  groups, showing/hiding names and hiding the rail. Include settled projects as a submenu with
  the existing open/restore actions. Keep new-group editing anchored to the persistent button.
- Owners: `components/sidebar/ProjectRail.tsx` and `projectRailMenus.ts`. Web and desktop share
  this rail; native mobile is unaffected. No provider, server or contract changes.
- Validation: adapt the eight existing rail browser cases to the consolidated menu; retain
  settlement persistence, selection and restoration coverage. Isolated full-app checks cover
  both widths, keyboard access, project/group creation entry points and hiding persistence;
  before/after captures provide the visual proof.

## Bundled server update entry points and reconnect ownership — 2026-10-24

- Resolve the installed desktop's bundled SSH runtime in the shared server update action, so
  Connections, composer notices and bulk actions upload the fork instead of copying an upstream
  `npx` relaunch command. Reuse SSH route resolution with the bottom-left updater, including
  alternate routes. Connections also offers an update for a changed payload at the same version.
- Serialize remote launch and bundled activation with the same lifecycle lock. Reconnects during
  an update defer until it finishes, preventing a second launcher from taking the server port and
  leaving the SSH-managed PID record stale. External servers retain their existing update path.
- Owners: `state/bundledServerUpdate*`, `ServerUpdateAction.tsx`, `SavedEnvironmentRows.tsx`,
  `sidebar/useUpdateEverything.ts`, `packages/ssh/src/bundledRuntime.ts` and `tunnel.ts`.
- Regression cases reproduce both the upstream command fallback and competing reconnect on the
  prior revision; focused Chromium and isolated subprocess fixtures verify the corrected paths.

## Cross-environment thread dashboard — 2026-10-24

- Add `/dashboard` with the approved Status board and Project lanes layouts, selected through
  the device-local **Dashboard layout** setting in Appearance. Use themed custom Select menus
  for all filters, with saved project favicons/icons in the project selector and thread cards.
- Aggregate existing quiet thread shells across environments without opening every transcript.
  Preserve logical project grouping and environment-scoped thread identities. Separate active
  foreground turns, background monitoring and unread completions; retain actionable failures and
  pending approvals/input. Server visit watermarks remain authoritative, including mark-unread,
  with local fallback only for older servers. Routine compaction completions stay quiet.
- Cards navigate through the normal environment/thread route and select the owning sidebar
  project without changing settlement. Archived/deleted threads and subagent duplicates stay
  out of the deck. Unread results remain until read; optional Recently reviewed covers 24 hours.
  Offline environments show last-known activity explicitly. Add Dashboard above All projects
  in both rail widths, mobile web navigation and the command palette; preserve Back behavior.
- Owners: `components/dashboard/`, `routes/dashboard.tsx`, the project rail/sidebar navigation,
  Appearance settings/search, and `ClientSettingsSchema`. Web and packaged desktop share the
  dashboard; native mobile keeps its existing thread UI. Existing thread APIs remain available
  to agents; no new server mutation or background polling is introduced.
- Validation: `check:changed HEAD` passes with 151 tests in seven files, all 30 affected
  package typechecks, formatting, lint and both knip passes. Browser component cases cover
  custom project/environment menus, combined filters, scoped navigation, server visit updates,
  rail placement and layout selection. An isolated full app with a pruned read-only copy of
  real data verifies Mark unread → Ready → normal thread visit → Recently reviewed, project
  selection, both layouts, Appearance persistence after reload, icon menus and 390px layout.
  The live app, its data and the Mac mini server are not used for these mutations.

## Upstream follow-up integration — 2026-10-24 (bf5c483cbe)

- Merge six newer upstream commits through `bf5c483cbe298032fe5f97b05f31f8458aab0031`
  into `bb215abd7184b0c5beb0eb7d8d63ab8ab65fe945`, retaining both histories. Review all
  14 overlapping paths and resolve both conflicts in favor of the fork's behavior.
- Keep `IdleCompactionWorker.ts` as the sole timer and ordinary sends free of compact-first
  dispatch. Adopt upstream's single compaction row, failure detail and quiet routine notifications
  across web/desktop/mobile, carrying its metadata through the fork's worker and dispatch guards.
  Add `idleTimeout` attribution so configurable fork timeouts are not mislabeled as cache expiry.
  Recognize historical system-created fork compactions in both SQL and in-memory shell projections;
  manual commands remain distinct and failed compactions still notify (`orchestrationV2.ts`,
  `ProjectionStore.ts`, `userMessage.ts`).
- Retain first assistant text outside settled folds, mixed-work disclosure and independent
  conversation-position recovery. Accept GitCafe latest-check selection and mobile icons, HTML
  preview theme selection, foreign-key-safe dev snapshots and mobile Markdown block renderers.
  Adapt incoming timeline fixtures to the fork's renderer and the pre-V2 snapshot fixture to
  released fork migration 59; no migration IDs or live database state are changed.
  Files/worktree recovery, project rail settlement/groups, account usage, Claude history isolation,
  bundled fork SSH updates and disabled external analytics/OTLP remain connected.
- Validation: frozen-lockfile installation passed on pinned Node 26.12.1/pnpm 12.14.0. The new
  historical-compaction contract and SQL/memory projection cases both fail before the integration
  fix and pass afterward. `check:changed bb215abd71` passes: 716 tests across 24 files
  (three existing skips), all 33 affected package typechecks, formatting, lint, both knip passes,
  generated GraphQL and unused-patch checks. Existing advisory lint/Effect suggestions remain.
  Running applications and servers are not rebuilt or restarted by this merge.

## Daily upstream integration — 2026-10-24 (d53873b6a4)

- Merge all 60 incoming commits through `d53873b6a4799e87afd63c8d288ef0089f5a3748`
  into fork parent `414e1e30a32e844163365bc3f89ec7f14434251b` with a real merge,
  preserving both histories. Review the upstream changes and all 90 overlapping paths,
  including automatic merges; resolve the 14 conflicted paths individually.
- Adopt upstream's shared forge definitions, host-owned PR capabilities/media/listing/SSH
  behavior, host terminology and filter search. Adapt the fork's repository-grouped PR
  overview to the live client registry and keep its explicit Open on host action, now
  using the registry's host name. Keep two-hour terminal-link removal connected to its
  shared timestamp helper after identity helpers move into registry-bound modules
  (`threadPullRequestsOverview.ts`, `pullRequestLinkContextMenu.ts`, `PullRequestSyncReactor.ts`).
- Register indexed message search as migration **74**, preserving released fork IDs 1–73,
  project memory/usage history and atomic preview-ledger translation. Accept local thread
  ranking/open counters, message jumps and accessibility announcements without enabling
  external analytics. Keep the fork's four typed WebSocket registration groups and add
  the host-filter RPC and generic source-control media asset path (`Migrations.ts`, `ws.ts`).
- Integrate deleted-parent/subagent checkout cleanup while retaining archived and secondary
  repository ownership, fresh settlement/activity checks, settle-now precedence, expiry,
  dirty/ignored-file protection and session/terminal guards (`storageCleanup.ts`). The
  validated initial preparing run remains the sole ordinary busy-guard exception: only
  queued follow-ups, no provider session, pending question or background work.
- Accept Muse transcript usage and current Codex plan names. Extend the fork's usage label
  fallback for Muse while preserving account/source/model identity, isolated Claude HOME/
  config directories, alphabetical colored pooled limits, continuous bars and compact
  account trends (`usageMerge.ts`). Retain fork CLI-specific Git fixtures alongside the
  incoming forge-neutral harness; adapt imported migration and local-telemetry expectations.
- Trace mounted `ChatView` → `ChatComposer` → `ComposerPrimaryActions`: Orb mounts
  `ComposerActionOrb`, with saved send color for Send/Resume/Queue/Steer and saved stop
  color for normal and pending-input Stop; Classic remains available. Existing chats and
  draft heroes retain forced mobile expansion, disabled scroll/focus collapse, custom
  widths, one-line minimum and viewport/keyboard handling. Ordinary sends never compact
  first. Independent one-second recovery/bottom following, first assistant text outside
  settled folds, mixed-work labels and stable imported-thread folds remain connected.
  Native mobile retains measured composer/inset guards alongside upstream navigation,
  Duo layout and UI-thread keyboard-aware question-card sizing.
- Trace project rail/groups/settled shortcuts/status dots/colors, slots/manual ordering/
  picker sizing; per-repository Files/checkout recovery, saved collapse/resize/expansion,
  revision/dirty-editor protection, deletion/undo, editor navigation/Structure/Commit/Git
  History and global panel shortcuts. CLI resume remains mounted with V2 native refs;
  project-root/multi-root Markdown links still open the explorer. Project notes/workspace/
  peer/connected-usage MCP tools, communication viewer/shared-host routing, durable response
  watches, project-aware compaction/current native usage/quota guards, worker effort hooks,
  automatic limit recovery and Never-default settlement remain live. Multiwork and machine
  sync remain retired; superseded usage/sync helpers are not restored.
- Keep external analytics/OTLP disabled, including unpackaged desktop runs. Provider
  refresh/version/manifest requests, desktop updates and Keychain retain opt-in gates;
  stable desktop identity, encrypted local connections and bundled fork SSH updates remain
  connected. Incoming exporter metadata never installs an exporter.
- Validation: frozen-lockfile installation passed with lifecycle scripts disabled (pnpm
  12.14.0). All **29 scoped typechecks** passed: server/web/mobile/desktop, relay,
  contracts/shared/client-runtime, all nine provider packages, all nine source-control
  packages, SSH, Tailscale and scripts. Initial failures from the Muse label, moved
  terminal-link helper imports and retained CLI-fixture decoder dependencies were fixed;
  affected scopes passed reruns. An early relay check saw an incompletely installed
  Alchemy dependency and passed after installation completed. Non-failing Effect
  suggestions remain. Checks use native tsc-rs 0.8.0 on Node 24; the repository pins
  Node 26.12.1.
- Changed-file lint passed for **590 code files**, with **zero errors and 154 advisory
  warnings** in the initial scan (React dependencies/memoization, styling and unused
  bindings among others). Integration follow-ups passed; the final two-file server
  scan retains one existing unused-binding warning. Integration files were formatted
  and complete source/document/patch whitespace checks pass.
- No tests independently added or executed. No builds, packaging, dev servers, browser/
  device/runtime checks, installed-app/live-userdata access, process stops, push, PR,
  external messages, subagents, main/other-worktree edits or schedule changes. Static
  integration does not establish runtime, native compilation or visual behavior.

## Daily upstream integration — 2026-10-23 (66ee628e08)

- Merge all 68 incoming commits through `66ee628e0875b2b735b199f42e6151e347833637`
  into fork parent `1e54d6170a931e37290d39f1df7a60bcdd6c8cd8` with a real merge,
  preserving both histories. Review the incoming changes and all 92 overlapping paths,
  including automatic merges; resolve the 17 conflicted paths individually.
- Keep ordinary Send/Resume/Queue/Steer free of compact-first dispatch. Upstream's instructed
  `/compact` fix needs no extra dispatch here: an explicit command already runs once through
  the ordinary path (`ChatView.logic.ts`). Retain the project-aware idle-compaction worker,
  native-context measurements, project overrides and quota-recovery/dispatch guards.
- Integrate upstream screen-reader announcements alongside the fork's timeline typography,
  independent one-second position recovery, bottom following, first assistant text outside
  settled folds, mixed-work labels and stable imported-thread identities (`MessagesTimeline.tsx`).
  Live `ChatView` → `ChatComposer` → `ComposerPrimaryActions` still mounts `ComposerActionOrb`
  for Orb, with the saved send color for Send/Resume/Queue/Steer and saved stop color for
  ordinary and pending-input Stop. Classic remains available. Existing chats and draft heroes
  retain forced mobile expansion, disabled scroll/focus collapse, custom widths and viewport/
  keyboard handling; native mobile keeps measured composer layout with upstream Android fixes.
- Retain disabled external analytics/OTLP, the disabled exporter settings/probe, network refresh/
  manifest/version opt-ins, update and Keychain gates, stable desktop identity and encrypted local
  connections. Decode upstream endpoint-source metadata without enabling effective URLs.
  Remove the obsolete launch-update environment hook along with upstream's launch notifications;
  explicit bundled SSH runtime updates, reconnect staging and remote-work preservation remain live.
- Keep the fork's four typed RPC registration groups while adding upstream's subagent transcript
  filter to both replay and live shell streams (`ws.ts`). Preserve the validated initial preparing
  run as the only ordinary primary-checkout busy-guard exception, with queued-only follow-ups
  and no provider session, pending input or background work. Register upstream's stop-request
  index as migration **73**, leaving released fork IDs 1–72 and preview translation unchanged.
- Accept managed Codex native token renewal/profile binding, delegated Stop and process cleanup,
  Claude child approval feedback, proxy usage headers, inherited Codex request accounting,
  PR-check refresh/rate-limit fixes and thread-title instructions. Preserve Claude HOME/config
  isolation, worker runtime effort hooks, account/source/model usage rows, alphabetical colored
  pooled limits, continuous bars and compact account trends. Retain current settings patch APIs;
  remove residual assertions for upstream's deleted, unused settings-mismatch helper.
- Trace live mounts/services for project rail/groups/settled shortcuts/status dots/colors, project
  slots/order/picker sizing, native Files/per-repository checkout recovery and collapse/resize/
  expansion state, revision/dirty-editor protection, deletion/undo, Structure/Commit/Git History,
  navigation and global panel shortcuts. V2 CLI resume remains mounted; project-root/multi-root
  Markdown links route to the explorer. Project notes/workspace/peer/connected-usage MCP tools,
  communication viewer/shared-host routing, durable response watches, Never-default settlement,
  two-hour terminal-PR unlinking and guarded cleanup remain connected. Multiwork and machine sync
  stay retired; superseded usage/sync helpers are not restored.
- Validation: frozen-lockfile installation passed with lifecycle scripts disabled. Formatting
  passed for 309 changed files; changed-file lint passed for 286 code files with zero errors
  and 60 advisory warnings (React/style/unused-binding and existing test-polling findings).
  Scoped typechecks passed for all 29 affected workspaces/dependents: server, web, mobile,
  desktop, contracts/shared/client-runtime, both Effect protocol packages, all eight provider
  packages, seven source-control packages, SSH, Tailscale, relay, scripts and the lint plugin.
  Initial failures from deleted-helper references and a missing token-broker fixture dependency
  were corrected; failed/unfinished scopes passed reruns. Non-failing Effect suggestions remain.
  Checks use native tsc-rs 0.8.0 and host
  Node 24.18.0; the repository pins Node 26.12.1. No runtime/native compilation or visual
  behavior was validated. No independently added or executed tests; incoming fixtures are
  retained/adapted, including migration expectations, duplicate declarations and an existing
  provider-probe polling loop changed to await its status stream. No builds,
  packaging, dev servers, browser/device/runtime verification, installed-app/live-userdata access,
  process stops, push, PR, external messages, subagents, main/other-worktree edits or schedule changes.

## Bundled fork updates for SSH environments — 2026-10-22

- macOS desktop packages include a self-contained server archive and a SHA-256 manifest in
  `resources/server-runtime`. The sidebar offers the installed app's exact payload for connected,
  authorized SSH environments on its supported architecture, including forks with the same version
  but a different payload fingerprint. It does not substitute an upstream npm/GitHub runtime.
- SSH reconnect stages missing payloads and reuses a healthy running server. Restarting the desktop
  therefore leaves the remote's work running until its update action is selected. App shutdown
  closes its local SSH forwards without stopping the remote; explicit disconnect retains the stop.
  An explicit
  update checks the environment identity and managed PID/port, verifies the archive and executable,
  preserves the previous runner/database snapshot and rolls back a trial that fails readiness.
  The client then requires the requested build identity on the reconnected server.
- Existing web/mobile update paths and unrelated external servers remain under their existing
  owners. The packaged runtime currently targets macOS and its bundled architecture; an unsupported
  SSH platform is shown as unavailable rather than offered a public replacement.
- Relevant owners: `scripts/build-desktop-artifact.ts`, `packages/ssh/src/bundledRuntime.ts`,
  `packages/ssh/src/tunnel.ts`, desktop SSH IPC/services, `ServerEnvironment.ts`, and the sidebar's
  existing update-everything flow. Validation: `check:changed HEAD` passes with 91 tests in 11 files,
  all 29 affected package typechecks, format, lint, knip and generated GraphQL checks. Seven isolated
  Chromium cases cover update actions; subprocess fixtures cover staging, identity/ownership checks,
  reconnect without activation, successful replacement and failed-trial recovery. This change does
  not install or restart either live environment.

## Upstream integration — 2026-10-22 (f05599504a)

- Merge 254 incoming upstream commits through `f05599504ae10c395a6a39f5e7db31b7810ac239`
  into fork parent `3e9b42341231`, preserving both histories. Review all 210 overlapping paths
  and resolve conflicts individually. Accept upstream's chat/sidebar/settings component extraction,
  provider and Git fixes, SSH runtime cleanup, webhook array filters, Business quota messaging,
  folded agent messages, RTL support and mobile navigation improvements.
- Port the fork's native file preview retention and root identity, Git History controls,
  project grouping/slots/picker sizing, manual thread order and accent colors into the extracted
  owners. Keep settled project shortcuts, complete project pickers, per-root workspace recovery,
  file revisions and dirty-editor protection, custom composer controls/width/typography,
  collapsible images and Slack table copying. Mobile communication sheets adopt upstream's current
  sheet options, and draft file selection keeps its project and directory without a null thread id.
- Keep independent bounded conversation-position recovery in `useTimelinePositionRestore.ts`,
  first assistant text outside settled folds, and the fork's latest-entry work disclosure.
  Combine that policy with upstream's separate folds after a steer; never emit a duplicate or
  empty whole-turn fold after the steer. Citation fixtures use a middle response so they still
  test opening hidden history rather than trying to hide the intentionally visible first reply.
- Ordinary Send/Resume/Queue/Steer never compact first, including upstream's extracted
  `planComposerTurn` path. Retain the existing project-aware compaction worker as the sole timer.
  Decode upstream's legacy/mode fields for compatibility, but hide its competing provider control
  and default native return compaction off. Keep automatic recovery and settlement fork defaults.
- Preserve Claude account/HOME history isolation and custom compaction; project memory,
  workspace/peer communication and connected-environment usage tools remain registered.
  Analytics stays a no-op and effective external OTLP exports stay disabled. Released fork
  migration IDs 1–72 remain unchanged. Upstream's new Node 26.12.1, pnpm 12.14.0 and TypeScript
  drop-in toolchain are adopted; regenerate the lockfile against the merged fork manifests.
- Preserve middle-click tab closing and immediately release the communication viewer on close;
  upstream popup-content retention must not retain its live subscriptions. Canceled client-scope
  edits also unmount on close so reopening starts from the saved permissions. Convert older fork
  browser fixtures to disposable rendering, and rename the previously undiscovered editor
  navigation fixture to `.browser.test.tsx`. Remove unused legacy Files/Pierre-tree and V1 resume
  seed helpers; native Files, editable previews and V2 CLI-session resume remain mounted.
- Keep worker effort tied to observed SDK runtime hooks, without inferring it from a parent or
  Agent launch arguments; update older fixtures to test that policy alongside the positive hook
  regression. Retain startup provider discovery while periodic refreshes and version lookups stay
  opt-in. Keep the fork's conservative local-file retention and independent panel maximization.
  Mark unused implementation exports private without changing RPC groups or their wire methods.
- Keep the fork's cumulative review previews consistent between overview and individual files,
  including untracked files when comparing against the base. Update cleanup fixture snapshots for
  the new archive response, isolate their worktree rules from the fork's independent settled-thread expiry, and keep test
  provider version lookups explicitly opted in. Retain the isolated Claude SDK probe executable
  when accepting upstream's test-fixture pruning.
- Keep fork-specific regression tests during upstream's test pruning and update retained fixtures
  for the extracted APIs. Focused unit/service checks and isolated Chromium checks cover the
  preserved behaviors; scoped typechecks cover all four clients, contracts, shared and client-runtime.
  Validation includes the 264-file fork-delta sweep and a 64-file integration follow-up; all reported
  failures are corrected and pass focused reruns. Formatting, changed-file lint, knip, generated
  GraphQL and all 32 affected package typechecks pass. Existing advisory style warnings remain.
  This merge does not rebuild, install or restart either running environment.

## Continuous usage bars without pace markers — 2026-10-20

- Remove the vertical even-spending ticks and their transparent gaps from individual and pooled
  usage bars on web/desktop and native mobile. Remove the marker-only resize subscriptions and
  obsolete marker tests (`UsageLimits.tsx`, `UsageLimitsPooled.tsx`, mobile `UsageLimitsSection.tsx`).
  Keep quota fills, reset estimates/hatching, account colors, reset-credit controls and pace
  information in account details. Future upstream merges must preserve the continuous bars.
- Validation: five existing pooled-limits Chromium checks pass; web/mobile typechecks and
  changed-file lint pass. Removed tests specific to the retired ticks and gap geometry.

## Settled projects in quick access — 2026-10-20

- The project rail's context menu adds **Settle project**. A device-local persisted list hides
  those shortcuts only; project records, running threads, the sidebar project dropdown and
  new-thread project selection retain every project. Opening a settled project keeps it settled.
  An archive button lists settled projects and provides an explicit **Unsettle project** submenu
  (`ProjectRail.tsx`, `projectRailMenus.ts`, `projectRailGroupsStore.ts`).
- Hide empty rail groups while retaining group membership and the complete manual-order model.
  Restoration returns the project to that layout. Keyboard/context-menu moves skip hidden
  projects while preserving them in saved groups; the settled menu remains reachable when every
  project is settled. Older group preferences hydrate with no projects settled
  (`projectRailGroups.logic.ts`). Web and packaged desktop share this client-only behavior;
  mobile has no separate project rail and keeps its existing complete project lists.
- Validation: 23 focused unit tests and seven isolated Chromium component checks pass, including
  persistence/rehydration, selection without restoration, explicit restoration, all-settled state
  and moves around settled members. Converted the existing rail browser fixtures to disposable
  rendering. Web typechecking and changed-file lint pass, with one existing style warning.
  Running installed desktop/server processes remain unchanged; the rebuilt update is staged for
  later activation at the owner's request.

## Upstream integration and staged desktop update — 2026-10-20 (fe27e8e3dc)

- Merge all 28 new upstream commits through `fe27e8e3dc` into fork parent `ad205edae7`.
  Reviewed the 23 overlapping paths; resolved seven conflicted files individually. Keep the
  released fork migration IDs 1–71 and register webhook deduplication/coalescing as migration 72.
  A new real SQLite upgrade regression preserves project memory and account-colored usage
  history while applying only the new migration (`persistence/Migrations.ts`, `Migrations.test.ts`).
- Adopt webhook filters, replay/coalescing, settings serialization repair, REST GitCafe support,
  mobile navigation/composer/update fixes, Markdown alignment/scrollbars and usage pace ticks.
  Preserve alphabetical account columns, account colors at zero allowance and the Trends view.
  Convert the conflicted browser fixtures to disposable rendering while retaining native Files,
  Git History and the fork's work-log/scroll-recovery behavior. Correct stale test expectations
  for alphabetical ordering, conservative local-file retention and Claude's same-account history
  fallback; these do not change the fork's runtime policies.
- Verified the native Files/worktree recovery services, Claude profile/HOME isolation, custom
  compaction, project memory/communication/connected-usage MCP tools, composer customization and
  privacy boundaries remain connected. Saved collector URL strings remain ordinary settings;
  effective CLI configuration still disables every OTLP export and analytics remains a no-op.
- Validation: frozen-lockfile install; nine scoped typechecks (server, web, desktop, mobile,
  contracts, shared, client-runtime, GitCafe provider and scripts); **848 tests passed, one
  skipped** across 28 focused files. Changed-file lint passes with existing advisory warnings.
  Browser/UI and native mobile runtime verification were not performed. Build the arm64 DMG and
  stage its verified bundle alongside the active installation; activation requires a later owner
  restart request (`docs/operations/local-fork-macos-build.md`).

## Daily upstream integration — 2026-10-20 (67c0fc0cda)

- Merge target `67c0fc0cdaf963b103518862dd7b68a9c758ecf2`, fork parent
  `adcc8c845f8d6ea95f1f9473a5b5fbfc0d3e6e48`. Merges all 613 incoming commits
  after `34c5a6d446` with both histories intact. Reviewed upstream changes and the
  fork delta, including all 232 overlapping paths and automatic merges. Resolved
  80 conflicted files individually; no blanket strategy was used.
- Keep the fork's configurable Claude/Codex automatic compaction and project overrides
  as the single active policy, superseding upstream's separate cache-expiry beta toggle
  and timer. Retain current native context measurements, actual-result/quota-recovery
  guards, deterministic receipts and dispatch-time eligibility checks. Adopt upstream's
  pending-merge-back and disabled-provider guards; candidate discovery uses the SQLite
  reader worker, while dispatch rechecks remain serialized (`IdleCompaction.ts`,
  `IdleCompactionWorker.ts`, `Orchestrator.ts`, `runtimeLayer.ts`, General/Maintenance settings).
  Ordinary Send/Resume/Queue/Steer still never compact first.
- Claude native forks preserve account/config-directory and HOME isolation, including
  source history in another checkout of the same account. The SDK fast path is allowed
  only when resolved account directories match the host; custom profiles use the history
  worker, with source, packaged and executable entry points. Both paths retain the copied
  head-message identity for upstream's first-run rollback fix. Task-list recovery uses the
  selected account environment too. Worker effort hooks and child-specific model/effort
  ingestion remain connected (`ClaudeAdapterV2.ts`, `claudeHistoryWorker.ts`, `ClaudeDriver.ts`).
- Preserve native Files, multi-repository/worktree selectors and recovery, saved root
  collapse/resize and checkout expansion, deletion/undo, dirty-editor/revision protection,
  exact-root/sibling-worktree previews and editor navigation/Structure/Commit/Git History.
  Upstream's successful missing-file response still triggers sibling-worktree recovery.
  Adapt upstream's ignored-folder expand-all guard to the native renderer. Diff collapse
  now uses upstream's session store while retaining the fork's repository selector and
  list/detail layout; reopening refreshes both the file list and selected patch. Keep
  root/multi-root Markdown explorer routing and add upstream repository-prefix recovery
  only after confirming the literal path is absent. Math rendering and TeX clipboard
  support coexist with Slack table copying, custom typography and collapsible images
  (`DiffPanel.tsx`, Files components, `ChatMarkdown.tsx`, Markdown helpers).
- New usage/cache/tier fields retain account/source/model identity and isolated history
  scans, alphabetical pooled-account ordering, account accents and compact provider
  trends. New foreground thread dependencies show Waiting; real background work remains
  Monitoring, with idle empty sessions Ready and approvals/errors retaining priority.
  Quiet PR polling retains a fresh host check before two-hour terminal-link removal.
  Never-default exclusive settlement, open-PR protection, archived/shared/secondary-root
  cleanup ownership and guarded thread expiry remain live. Register the new Codex usage
  index and settlement timestamp repair as migrations 70 and 71; released IDs 1–69 and
  atomic upstream-preview translation remain unchanged.
- External analytics/OTLP stay disabled. The new analytics owner API is a no-op; remove
  startup/login owner reads and disable client account/device hashing, ID storage and URL
  announcements. Version lookup still gates the new installer-specific path before any
  remote lookup. Provider refresh/manifest, desktop updates and Keychain retain opt-in
  gates; stable desktop identity and encrypted local connection persistence remain active.
  Typed WebSocket registration additionally splits workspace/files/peer methods to keep
  the expanded protocol's inferred service requirements concrete (`ws.ts`, analytics,
  connection capabilities, `maintenanceResolver.ts`). MCP replacement credentials still
  revoke the same thread's previous grant while retaining other idle records for renewal.
- Traced live mounts: `ChatView` → `ChatComposer` → `ComposerPrimaryActions` mounts
  `ComposerActionOrb` for Orb, with saved send color for Send/Resume/Queue/Steer and saved
  stop color for ordinary and pending-input Stop. Classic remains selectable. Existing
  chats and draft heroes retain forced mobile expansion, disabled scroll/focus collapse,
  one-line prompt minimum, keyboard/viewport handling and custom message/composer width.
  Independent one-second scroll recovery/bottom following, first assistant text outside
  settled folds, mixed-work disclosure labels and stable imported-thread identities remain.
  Mounted V2 CLI resume, project rail/groups/status dots/colors, numbered slots/manual order/
  picker sizing, app accent, global panel shortcuts and right-click tab closing remain.
  Primary checkout binding/clearing still requires the validated initial preparing run with
  queued-only follow-ups and no provider session, question or background work. Project
  memory/workspace/peer/usage MCP registration, shared host routes, connected-environment
  quota reads, communication viewer and durable peer-response watches remain connected.
  Multiwork and machine sync remain retired; legacy usage/sync helpers remain superseded.
  Upstream's explicit Add to another machine flow does not restore the removed sync service.
- Validation: frozen-lockfile dependency installation succeeded with lifecycle scripts disabled.
  Scoped `tsc-rs --noEmit` passed for server, web, mobile, desktop, contracts, shared,
  client-runtime, provider-core, both Effect protocol packages, the seven provider/registry packages,
  all seven source-control packages, SSH, Tailscale, relay, the lint plugin and scripts
  (29 scopes). Non-failing Effect diagnostics remain. Changed-file lint scanned 1,465 files:
  306 warnings and two errors; both errors were corrected. A 76-file integration rerun
  passed with 106 warnings and no errors; the final WebSocket fixture and Files-query
  follow-ups also passed (the query retains five dependency warnings). Warnings include
  existing style, unused-binding and React dependency findings; no warning-free claim is made.
  Integration files were formatted. Source whitespace checks pass; 57 whitespace findings
  inside incoming dependency-patch context remain verbatim to preserve patch integrity.
  No tests were independently added or run; imported test fixtures/expectations were adapted
  for the fork's services and migration sequence. No builds, packaging, dev servers, runtime
  UI checks, app installation/restart, process stops or live-userdata access were performed.
  Fork preservation was reviewed through source, contracts and live call sites; runtime,
  native compilation and visual behavior were not validated in this task.

## Claude conversation forks respect account history, 2026-10-19

- Native Claude forks run the existing history worker with the selected provider instance's
  environment. The SDK's process-global history lookup no longer reads the server's default
  account instead of a custom `CLAUDE_CONFIG_DIR` or `HOME`; concurrent profiles stay isolated
  (`ClaudeAdapterV2.ts`). Node/desktop builds use the sibling worker entry and standalone
  executables use the existing hidden history subcommand.
- If the source session is absent from the current checkout's project directory, search the
  selected account's other project directories. Preserve the requested message cursor and never
  fall back to another account (`claudeHistoryWorker.ts`). This allows forks after checkout
  changes or removal of the original worktree.
- Validation: eight focused query-runner/native-fork/MCP-channel tests pass, including real SDK
  forks of concurrent account fixtures, HOME overrides, cursor truncation and missing-session
  account isolation. The two positive account regressions fail against unchanged HEAD. Four
  subagent-effort tests in the wider adapter file also fail against unchanged HEAD. An isolated
  copy of the reported source transcript successfully forks at the requested assistant message;
  live history is not modified. Server typechecking and changed-file lint pass (one existing
  unused-binding warning).

## Daily upstream integration — 2026-10-19 (34c5a6d446)

- Merge target `34c5a6d4461ff7be2c1a059c3c51c3496c1e14df`, fork parent
  `29f3285ac6fefafdda06633381a800478ed40ed8`. Integrates all 343 incoming commits
  with a real merge and both histories intact. Reviewed the upstream changes and
  fork differences, including all 121 paths changed on both sides and automatic
  merges; resolved the 26 conflicted paths individually.
- Preserve the native Files tree, deletion/undo, editor navigation, multi-root
  selectors, selected checkout recovery, independent collapse/resize persistence,
  and file-revision/dirty-editor protection. Accept upstream Markdown task edits,
  browser reveal capability and PDF previews; propagate workspace mutation identity
  into the rendered Markdown surface. The new PDF asset helper retains the shared
  host's environment gateway prefix instead of routing to the host's default environment
  (`FileBrowserPanel.tsx`, `FilePreviewPanel.tsx`, `packages/shared/src/preview.ts`).
  Adapt the fork-only history/editor navigation consumers to upstream's direct
  `updateClientSettings` API; use the shared merge glyph and inset focus ring.
- Claude's capability probe retries transient failures and can reuse capabilities
  only for the same account organization, without treating failed/fallback probes
  as fresh usage. Reset-credit/account lookup and empty-transcript recovery follow
  the CLI's configured `HOME` and `CLAUDE_CONFIG_DIR`; custom accounts must not fall
  back to the process's default account. Worker effort hooks and child-specific
  model/effort ingestion remain live (`ClaudeDriver.ts`, `ClaudeAdapterV2.ts`).
- Keep stable alphabetical account columns, account accents, account/model history
  identity and independent trend rows while accepting weekly-exhaustion suppression,
  bounded refill estimates and new provider usage fields. The current pooled Limits
  UI remains authoritative; superseded account-limit components are not restored
  (`packages/shared/src/usageLimits.ts`, web/native usage components and user guide).
- Register upstream's PR-link canonicalization as migration **69**, retaining every
  released fork migration ID and the preview-history translation. Adapt the imported
  migration expectations to the fork sequence. Thread forks drop upstream PR watches
  and fork peer-response watches. Preserve two-hour terminal-PR unlinking, open-PR
  inactivity protection, Never-default settlement, settled checkout cleanup and
  guarded thread expiry (`Migrations.ts`, `ThreadForkService.ts`,
  `PullRequestSyncReactor.ts`, `ThreadSettlementService.ts`, `storageCleanup.ts`).
- Retain the no-op analytics boundary even with upstream's new feature instrumentation:
  no analytics identifier, event buffer, delivery or flush is enabled. Update the
  existing analytics architecture guidance to state this policy. Disabled OTLP/relay
  export, opt-in provider/manifest network refresh and automatic updates, local
  encrypted connection storage and persistent desktop identity remain connected.
- Keep private per-root guidance, project memory, workspace/peer communication and
  connected-environment quota MCP tools registered and injected into provider sessions.
  Merge their instructions into upstream's separate Codex additional-context entries;
  all six orchestration sections remain below the 4,000-byte entry cap (largest source
  section 2,185 bytes). Keep the validated initial preparation run as the sole busy-guard
  exception: it can bind/clear its checkout with queued follow-ups, but cannot bypass
  active provider sessions, background work or pending input. Project-scoped automatic
  compaction remains scheduled and rechecks eligibility and real quota recovery.
- Trace live client mounts: `ChatView` → `ChatComposer` → `ComposerPrimaryActions` still
  mounts `ComposerActionOrb` for Orb, uses the saved send color for send/resume/queue/
  steer and saved stop color for both ordinary and pending-input Stop; Classic remains
  selectable. Existing chats and draft heroes share unconditional mobile expansion,
  without scroll/focus collapse. Preserve independent scroll recovery/bottom following,
  custom chat width, first assistant text outside settled folds, mixed-work disclosure
  labels and upstream's stable imported-thread identity. `ResumeSessionsSection` is
  mounted and creates V2 native-session references; project-root Markdown links open
  the explorer. Native mobile retains keyboard/inset guards and measured composer
  width while accepting upstream's compiler/draft subscription changes and precise
  iOS 27.1 SDK gate. Project rail groups/status dots/colors/slots, app accents, right
  panel shortcuts, Git History/Commit/Structure surfaces, communication viewer and
  per-root workspace controls remain reachable. Explicitly retired Multiwork and
  machine sync stay retired; obsolete helpers do not replace their active successors.
- Validation: frozen-lockfile dependency installation passed with lifecycle scripts
  disabled. Repaired stale `vitest-browser-react` peer references left by the automatic
  React 19.3 lockfile merge; package versions/integrity remain pinned. Scoped
  `tsc-rs --noEmit` passed for all **25 affected workspaces**: the four app surfaces,
  contracts/shared/client-runtime, affected provider/ACP/source-control/SSH/Tailscale
  packages, relay, lint plugin and scripts. Server/web rechecks passed after the final
  integration corrections. Changed-file lint passed for **722 files**, with **0 errors
  and 311 warnings** (React dependencies/state/refs, existing styling, unused bindings,
  and other advisory rules); typechecks also emit non-failing Effect suggestions.
  Resolved files were formatted. Whitespace checks pass except two whitespace-bearing
  context lines in the incoming dependency patch, retained verbatim for patch matching.
- No tests were authored or executed; incoming tests were retained and conflicting
  expectations adapted only. No app/native builds, browser/device/runtime verification,
  packaging, dev servers, installed-app changes, process stops or live-userdata access.
  No push, PR, external messages, subagents, main/other-worktree edits or schedule changes.
  Native compilation and visual/behavioral runtime validation remain unperformed by
  the owner's daily-merge constraint; these checks establish static integration only.

## Usage limits across connected environments, 2026-10-18

- Quota MCP reads now include the other environments connected through the desktop/web app by
  default. The prior server-only implementation could report a token-only Mini Claude instance as
  unsupported while the laptop's work/personal accounts had current windows. Every provider/source
  is labelled with its environment; a single unsupported entry never implies all Claude accounts
  are unsupported. Optional `includeConnected:false` requests a local-only read explicitly.
- The app relays the destination's existing provider refresh, `server.getConfig` read and initial
  usage-hub config-stream snapshot (hub data is not in `server.getConfig`), projecting
  only the same safe quota/account fields. It does not create provider sessions, copy credentials,
  or recursively query peers. Disconnected, mismatched, missing-relay and failed reads report
  incomplete coverage with notices; unavailable quotas are never fabricated as zero or safe.
- Sources: `apps/server/src/usage/UsageSnapshots.ts`, `apps/web/src/lib/peerRelayHost.ts`,
  `peerUsageLimits.ts`, `packages/shared/src/usageMcpSnapshot.ts`, usage/peer contracts, and shared
  provider instructions. Token/cost history remains scoped to its own server.
- Validation: 42 focused MCP, peer relay, client quota read and provider-instruction tests pass.
  Regression coverage includes unsupported Mini Claude plus valid laptop work/personal windows,
  incomplete discovery/read coverage, explicit local-only reads and mismatched environment replies.
  Scoped server/web/mobile/contracts/shared typechecks and changed-file lint pass; frozen install
  preserves the dependency lockfile.

## Agent access to Usage page data, 2026-10-18

- Added read-only `t3_usage_limits_read` and `t3_usage_read` MCP tools for Claude, Codex and every
  provider using T3 MCP. They reuse the provider registry, usage hub snapshots and transcript/account
  scanner behind the Usage pages. Quota windows stay separate by configured provider instance or
  hub account, with timestamps, reset times and explicit missing/probe-failure states. Optional
  refresh uses the existing provider/hub probes; reads do not redeem credits or switch accounts.
- History returns the page's token/cost/source/pricing data, defaults to today in UTC and supports
  date/time-zone/hourly windows and waiting for slow source refreshes. History reads its own server;
  quota reads include connected environments as described above. Both require normal orchestration
  read access and support read-only clients.
- Shared provider instructions teach agents to use these tools when native usage detection is
  absent, including Claude. Shared tool presentation keeps their activity readable on every client.
- Sources: `packages/contracts/src/usageMcp.ts`, `apps/server/src/usage/UsageSnapshots.ts`,
  `apps/server/src/mcp/toolkits/usage/`, MCP registration and shared orchestration instructions.
- Validation: 63 focused tests pass, including authenticated Claude tool discovery, MCP reads,
  separate accounts/hubs, explicit refresh, missing/probe-failed readings, JSON-safe optional
  snapshot fields, source attribution and time-zone defaults. Scoped typechecks pass for contracts,
  shared, provider-core, server, client-runtime, web and mobile; changed TypeScript lint passes.

## Files checkout recovery, 2026-10-18

- Discover checkout choices through each repository's configured root, rather than its selected
  worktree. A removed worktree previously hid the Files picker and prevented the server from
  selecting a live sibling checkout. Keep the selected directory visible until an explicit choice.
- Workspace inspection and selection share this recovery behavior across web/desktop, mobile and
  MCP. Selection still validates repository membership, protects active primary work and preserves
  independent secondary selections. Branch selection can create a checkout from the configured root.
- Sources: `apps/web/src/components/files/FileWorktreeToolbar.tsx`,
  `apps/server/src/workspace/ThreadWorkspaces.ts` and their component/MCP regression tests.
- Compared Files components, workspace services and shared thread workspace selection against the
  pre-sync fork: those implementations survived the October 18 merges unchanged. The reported
  directory no longer exists; this change repairs the recovery path without recreating that checkout.
- Validation: Chromium regression reproduced the hidden picker before the fix; server regressions
  reproduced failed primary/secondary recovery. All 111 focused Files/workspace tests pass, covering recovery,
  pagination, active-work protection, independent repositories, file revisions and editor retention.
  Web/server typechecks and scoped lint pass (existing styling/React warnings remain).
  Integrated Browser-panel verification is unavailable because its tools are absent in this session.

## Provider discovery after a macOS shell timeout, 2026-10-18

- If the desktop login-shell probe fails or times out, add existing `~/.local/bin`,
  `/opt/homebrew/bin` and `/usr/local/bin` directories after the inherited and launchctl PATH.
  A system-only launchd PATH previously hid native Claude and Homebrew Codex installations after
  restart. Successful shell hydration keeps its existing behavior and account settings are unchanged.
- Sources: `apps/desktop/src/shell/DesktopShellEnvironment.ts` and its test.
- Validation: the new regression failed before the fix; all 23 shell environment tests now pass,
  along with desktop typecheck and scoped lint. The fallback test covers a system-only launchctl
  PATH, preserves inherited entries and omits nonexistent installation directories.

## Headless relay telemetry remains disabled, 2026-10-18

- The headless CLI and environment server now pass no collector configuration to relay tracing,
  matching web and mobile. Their cloud tracing layers previously accepted runtime or embedded
  collector credentials despite the fork's disabled analytics and ordinary OTLP exports.
- Sources: `apps/server/src/cloud/relayTracing.ts`, `relayTracing.test.ts`.
- Validation: both new tests reproduced an HTTP export before the fix and no export afterward,
  with a fully configured collector. All 20 focused tests for server relay tracing, analytics,
  desktop collector overrides and mobile tracing pass. The running local and Mac mini servers
  had no relay telemetry environment credentials, and neither installed server build had embedded
  collector credentials. Scoped server typecheck and lint pass. This source change needs a rebuild
  before installation.

## Daily upstream integration — 2026-10-18 (3ff5b3c82a)

- Merge target `3ff5b3c82a62baddc0c2b1b227e9d3a06190c426`, fork parent
  `8789f653f968f344895c7bd3b658ae9bfa67075d`. Merges all nine upstream commits
  after `c52453717a` with both histories intact. Reviewed all incoming production
  changes and all ten paths modified on both sides, including automatic merges.
- Resolved the timeline conflict by moving shared row context into each rendered row
  and passing it through the list's extra data, as upstream requires for thread-switch
  performance. Retained the fork's `data-messages-timeline-row-frame` sizing hooks and
  `chat-timeline-system-scale`, independent one-second recovery and bottom following.
  First assistant text outside settled folds, mixed-work disclosure labels and stable
  imported-thread identities remain connected (`apps/web/src/components/chat/MessagesTimeline.tsx` and its logic).
- Accepted workflow-opening blocks on web/desktop and native mobile, the optional wire
  marker and retained opening message in bounded history. Claude workflow members now
  project incremental thinking/tool/answer transcripts using account-scoped config paths;
  worker effort observation hooks and child-specific selection ingestion remain intact.
  The other nine overlapping files retain identical fork added/removed lines against
  upstream. SQLite index/startup changes, unchanged-preview identity preservation and
  cached PR link normalization integrate without changing fork storage or PR policies.
- Traced live callers: saved-color Arcane Send/Resume/Queue/Steer and ordinary/pending-input
  Stop with Classic available; forced mobile expansion for existing chats and drafts,
  disabled scroll/focus collapse, ordinary sending without compact-first actions, custom
  width and web/native keyboard layout; project rail/groups/status dots/colors, slots,
  ordering and picker sizing; per-repository Files/worktree selectors, persisted collapse/
  expansion/resize, exact-root and sibling-worktree previews, revision validation and dirty
  editor protection, deletion/undo, Structure/Commit/Git History and editor navigation;
  global panel shortcuts/right-click tab closing and project-root/multi-root Markdown
  explorer routing; mounted CLI resume using V2 native references.
- Initial checkout binding/clearing still requires the validated preparing run, only queued
  follow-ups, no provider session, question or background work. Ordinary active/background
  work stays protected. Account/source/model usage rows and colored per-account limits/trends
  remain separate. Project memory/workspace/peer MCP, communication viewer/shared host routes,
  durable response watches, idle-compaction project overrides/native usage/quota guards,
  worker-question recovery, cleanup preferences, two-hour terminal-PR unlinking and
  Never-default settlement remain live. Multiwork and machine sync remain retired; legacy
  usage/sync components remain superseded. Disabled external analytics/OTLP, provider
  refresh/version/manifest opt-ins, desktop update/Keychain gates, stable desktop storage
  and locally encrypted connection persistence remain in their active paths.
- Validation: frozen-lockfile installation succeeded with lifecycle scripts disabled.
  Scoped typechecks passed for contracts, shared, client-runtime, provider-core, server,
  web, native mobile and desktop. Non-failing Effect suggestions remain. Lint on 32
  changed TypeScript files passed with zero errors and 60 warnings (unused symbols,
  React refs/effects/memoization and UI styling). Integration formatting and whitespace
  checks passed. These are static checks; runtime/UI behavior was not exercised.
  No tests independently added or run; imported upstream tests are retained. No builds,
  packaging, dev servers, browser/device checks, app operations, live-data operations,
  process stops, push, PR, external messages, subagents, other-worktree/main edits or
  schedule changes.

## Upstream integration 2026-10-18 (c52453717a)

- Merged 14 upstream commits after `13aa882c22`, preserving project rail groups, sibling-worktree
  file links and the existing fork behavior. The first fetch found 375 PR commits in the preceding
  30 hours, of which 13 were missing locally. A final fetch found one additional browser-test
  timing fix, included in a second merge.
- Mobile navigation keeps both the fork's thread communication sheet and upstream's linked
  pull request sheet. Android layout fixes and mobile React Compiler support are included.
- Working threads can be dragged into chat as references again. The sidebar still keeps the
  fork's manual active-thread order and disabled layout animation; working rows cannot be
  reordered into another shelf.
- The linked pull request panel retains repository headers, totals and stack grouping. Its
  fork overview now imports the list helper from shared code after upstream moved it there.
  Relative-time labels use upstream's clock-aware component, including the fork's sync footer.
- Validation: frozen-lockfile installation with lifecycle scripts disabled; web, mobile and
  client-runtime typechecks pass. Focused web/shared/contracts tests pass (1,467), including
  project groups, sidebar dragging/snoozing, PR overview, file previews and web compiler coverage.
  Focused server/mobile/lint-rule tests pass (1,071), including real sibling worktrees, workspace
  files, Android layouts, mobile PR behavior and mobile compiler coverage. Lint on 109 changed
  source files passes with warnings. The final browser-test timing fix also passes web typecheck
  and targeted lint. No browser verification or desktop rebuild was performed.

## Project rail groups, 2026-10-17

- Projects in the rail can be grouped, like tab groups in Chrome and Firefox. A group has a name,
  one of ten colors, and an ordered member list. A project belongs to at most one group, and a
  group that loses its last project disappears. Clicking a group label folds or unfolds it with an
  animation. A folded label shows the project count and the members' status dots, and hovering it
  shows a card with every member and its status. Option-click on a label, or "Show threads from
  this group", scopes the thread sidebar to all of the group's projects.
- The rail has two views. The short view keeps the 52px icon column with tab-group labels. The
  named view shows project names and group headers with a chevron, color, a stack of the first
  three icons when folded, status dots and a count. The footer chevrons, a double-click on the
  rail's right edge, Enter or the arrow keys on that edge, and the rail menu switch views. Dragging
  the edge resizes the named view between 168px and 360px, and dragging it below 110px snaps back
  to the short view. The thread sidebar follows the rail width.
- Right-click menus: a project has Show threads, Add to group or Move to group (with New group),
  Remove from group, Move up and down, Copy path and Project settings. A group has Collapse or
  Expand, Show threads from this group, Rename, Color, Add project, Collapse other groups, Move
  group up and down, and Ungroup. The empty rail has New group, Add project, Expand all, Collapse
  all, Show or Hide names, and Hide project rail. New group from a project menu creates the group at
  once and opens a name and color editor at its label. The footer's New group button opens a form
  with name, color and a project checklist.
- Drag and drop: drop a project on a group label to add it, beside another project to reorder or
  join that project's group, or below the list to move it to the end. Group labels drag as a unit.
  Option-Up and Option-Down move a focused project.
- Settings > Appearance > Project rail picks one of five group styles, `projectRailGroupStyle`:
  Edge (default), Well, Outline, Label or Solid. The picker shows a live preview of each.
- Storage: groups are local to the device, in `t3code:project-rail-groups:v1`. The rail order is
  still the manual project order (`projectOrder`). A group sits where its first member is, and
  every rail move writes the flattened rail order back to `projectOrder`, so the command palette and
  the sidebar picker see the same order. Members whose project is not loaded are kept but hidden.
  The view and width are in `t3code:sidebar:project-rail-layout`. A group scope is stored as
  `rail-group:<id>` in the existing scope key and falls back to all projects once the group is
  gone.
- Sources: `apps/web/src/components/sidebar/ProjectRail.tsx`, `projectRailGroups.logic.ts`,
  `projectRailGroupsStore.ts`, `projectRailMenus.ts`, `ProjectRailGroupPopovers.tsx`,
  `projectRail.css`, `projectRailVisibility.ts`, `components/Sidebar.tsx` (group scope),
  `AppSidebarLayout.tsx` (rail width), `settings/ProjectRailGroupStylePicker.tsx`,
  `packages/contracts/src/settings.ts`.
- Validation: typecheck passes and `vp check` keeps the 14 pre-existing errors. Logic tests cover
  layout, every group operation and storage sanitizing. A browser test folds a group, switches
  views and opens the project menu. The React Compiler coverage test passes.

## File links found in other worktrees, 2026-10-17

- A chat link to a file that is missing in the thread's checkout now looks for the same
  repository path in the repository's other Git worktrees, such as an agent's
  `.claude/worktrees/*` checkout or a sibling checkout on `main`. The preview opens the newest
  copy read-only with a notice naming the worktree and branch, and buttons switch to the other
  copies. Agents often write a report in their own worktree and link it under the main checkout.
- A missing file now reads as "This file does not exist" instead of "could not be accessed".
  The server reports `path_not_found` for missing workspace and absolute paths.
- Sources: `apps/server/src/workspace/SiblingWorktreeFiles.ts` (`projects.locateFile`),
  `GitVcsDriver.listWorktrees`, `WorkspaceFileSystem.ts`, `FilePreviewPanel.tsx`,
  `filePreviewMode.ts`, `projectFilesQueryState.ts`.
- The search runs on the host that owns the project, so a remote environment needs its server
  updated before it finds sibling copies.
- Validation: typecheck passes, `vp check` keeps the 14 pre-existing errors. New server tests
  build a real repository with two linked worktrees. File system, preview and contract tests pass.

## Upstream integration 2026-10-17 (13aa882c22)

- Merged 277 upstream commits in two merges: through `4b1024dafe` (`0288f7a67e`, started by the
  nightly sync, which ran out of credits before committing) and through `13aa882c22`.
- Upstream now applies React Compiler lint rules to every web file. Fork files that still keep
  manual caches or bail out of the compiler are listed in `apps/web/reactCompilerForkExceptions.ts`
  (31 files) and excluded from that lint block in `vite.config.ts`.
  `src/reactCompilerCoverage.test.ts` checks that every other web file compiles without bailouts.
  Remove a file from the list once it compiles cleanly.
- Upstream's `KnownWorkspaces.ts` also accepts the fork's configured secondary repositories and
  their selected checkouts, as long as a selection is a Git-listed worktree of that repository.
  `WorkspaceFileSystem.ts` keeps the external read and watch resolver.
- Upstream moved React tests to a real browser. Fork tests now run there: `MessagesTimeline`
  expects the fork's latest-entry work log and one-second position recovery,
  `ProjectSettingsPanel` mocks the command palette its add-folder control opens, and the agent
  communication dialog test waits for the close animation.
- "Load more branches" in the Files checkout menu keeps the menu open (`closeOnClick={false}`),
  so the next page of branches is visible after loading.
- Upstream migration `063_DropUnusedV1Projections` is fork migration 68. No fork server code
  reads the dropped V1 tables.
- Validation: `vp run typecheck` passes. `vp check` has the same 14 pre-existing errors as
  before the merge. Web tests that failed after the merge were compared with the parent and
  only `ProjectSettingsPanel` was new, now fixed. Migration, doctor and database maintenance
  tests pass (12). Fork-heavy web tests (agent communication, compiler coverage, project
  settings, Files checkout toolbar, timeline) pass, 1139 tests. The full server suite was not
  completed because it ran past 40 minutes.

## Upstream integration — 2026-10-16 (a7025639c0)

- Merged 123 upstream commits through `a7025639c0e16aad3081106c935bf3025f601a1e` onto the
  morning integration `2141b7ced3`. 52 paths changed on both sides. Git stopped on 18 of
  them; the rest merged automatically and were reviewed for dropped fork behavior.
- Upstream now lists web files the React Compiler must compile (`apps/web/reactCompiledFiles.ts`)
  and fails lint on manual memoization and compiler bailouts in them. Fork additions in
  listed files (`ChatView`, `Sidebar`, `CommandPalette`, `BranchToolbar`, `MessagesTimeline`,
  `ChatComposer`, `ProjectSettingsPanel`, `SettingsPanels`, `UsagePage` and others) were
  rewritten as plain values and functions, `useStableCallback`, `useEffectEvent` or
  render-time state resets. `ProjectSettingsPanel` no longer uses try/finally while adding a
  workspace root, because the compiler skips such components.
- `DiffPanel.tsx` and `files/FileBrowserPanel.tsx` keep the fork implementations (multi-repository
  diffs and the native Files tree). Upstream's only change to them was its compiler refactor of
  code the fork replaced. Both are removed from `reactCompiledFiles.ts`: the fork versions
  still memoize by hand and `DiffPanel` writes refs during render.
- Upstream moved right-panel rendering into `chat/RightPanelSurfaceContent.tsx`. The fork's
  Git history surface is a `git-history` case there with multi-root workspaces. Files and file
  previews stay mounted by `ChatView` so open file tabs keep their state, and the new
  component renders nothing for them.
- `ChatView` resets per-thread timeline state (pull request dialog, live follow, scroll-to-bottom)
  during render when the route thread changes and keeps the fork's remembered reading position.
  Upstream's resume-time compaction stays out with the other compact-before-send paths.
- `Sidebar` adopts upstream's `useSidebarThreads` and lookup hooks. Manual thread order,
  project rail/slots/scope, picker height, disabled layout animation, the resume sessions
  section and direct unpinning feed into them. Moving an active thread finishes the
  local-to-shared order migration as before. `CommandPalette` is rebuilt on upstream's
  version with folder selection, "Add as / Part of an existing project" attachment and
  primary-host filtering re-applied.
- Composer: orb buttons keep the saved send/stop colors, the steer tooltip has no compaction
  wording, scroll collapse stays disabled and `min-h-[1lh]` stays on the editor. Usage keeps
  chronological hourly rows on upstream's period and provider hooks. Telemetry export settings
  stay a disabled stub.
- Upstream folded access and T3 Connect management into `AuthStandardClientScopes` and
  removed `AuthAdministrativeScopes`. The fork's Standard preset and pairing default now
  carry those scopes, matching upstream. `connections/SharedEnvironments.test.ts` uses the
  standard set.
- Validation: frozen-lockfile installation with lifecycle scripts disabled and repo-wide
  `vp run typecheck` passed. The React Compiler coverage test passes for every listed file.
  `vp check` reports 14 errors, all in files this merge did not change (`accountLimitsNormalize.ts`,
  `AccountLimits.tsx`, `GitHistoryPanel.tsx`, `DiffFilesTreeNavigator.tsx`,
  `FileWorktreeToolbar.tsx`, `SymbolNavigationDialog.tsx`, `ui/resizable-columns.tsx`): section
  dividers, outset focus rings, native `title` tooltips and a restricted `GitMergeIcon` import.
  Scoped tests for web (2642), server (1510), shared, contracts and client-runtime fail the same
  15 web, 26 server, 4 shared and 2 contracts tests as the `2141b7ced3` parent; client-runtime
  passes. `lint:mobile` ran with swiftlint, ktlint and detekt not installed, so it checked
  nothing. No app builds, dev servers, installed-app or live-data operations, push or main edits.

## Daily upstream integration — 2026-10-16

- Merge target `cfafb4bb54d244e4612f5681aad3832ea64cb0fb`, fork parent
  `5b6a0d86caadaf8d6044c4e6fdbf9b01b626d920`. Integrates the entire upstream
  range after `c079503d07`, preserving both histories. The incoming comment cleanup
  touches thousands of files; reviewed 290 paths changed on both sides, including
  automatic merges, and reconciled 95 conflicting files individually.
- Retained disabled external analytics/OTLP and endpoint probes, provider refresh/version/
  manifest gates, opt-in desktop updates and Keychain access, stable desktop storage and
  encrypted local connections. Released migration IDs and atomic preview translation stay
  intact. Upstream Beta branding and CLI distribution changes do not alter the installed app.
- Shared-worktree cleanup now considers parent/subagent owners together while retaining
  archived ownership, secondary repository selections, settle-now precedence, expiry,
  pending-work/session/terminal guards and fresh settlement checks. Branch synchronization
  adds upstream's expected-branch guard alongside the validated initial-preparation exception;
  ordinary active/background work still cannot change its primary checkout.
- Retained multi-repository Files, exact-root previews, editor navigation/history, Structure/
  Commit views, deletion/undo and saved collapse/expansion/resize state. Upstream folder
  breadcrumbs keep the owning checkout when navigating in place or opening a folder beside
  a file. Host folder browsing remains shallow. PR lists retain repository headers, totals,
  stack structure and touch menus while adopting virtualization and draggable context chips.
- Live composer paths mount the saved-color Arcane renderer for Send/Resume/Queue/Steer and
  normal/pending-input Stop; Classic remains selectable. Existing chats and draft heroes keep
  forced mobile expansion, disabled scroll/focus collapse, short placeholder, custom width and
  keyboard/viewport handling. Compact-before-send proposals remain removed. Independent
  one-second timeline recovery, bottom following, first assistant text outside folds, mixed-work
  labels and imported-thread identities remain connected.
- Project rail/status dots/colors, project grouping/attachments/slots/order/picker sizing,
  root and multi-root Markdown explorer links, V2 CLI resume, Git history/staged-only commit
  generation, panel/editor shortcuts and right-click tab closing remain live. Claude worker
  effort hooks and child-specific selection ingestion remain alongside resumed-child fixes.
  Usage keeps account/source/model identities and compact per-provider trends.
- Project notes/workspace/peer MCP registration, shared host environment routes, permission
  editing, durable response watches, idle-compaction overrides/current native usage/quota
  guards, worker-question recovery, two-hour terminal-PR unlinking and Never-default settlement
  remain connected. Native fork-only communication and compaction components follow the new
  shared UI locations. Multiwork and machine sync remain retired; older usage/sync components
  remain superseded. WebSocket registration keeps all fork RPCs and adds live command-output
  subscriptions and database-storage reporting. Their status streams use a separate typed
  registration group so the larger fork protocol retains concrete Effect requirements.
- Native repository menus now use AppBar types; the composer mounts a single measured control
  host. Full-width folder navigation reveals the selected repository/folder, and host-folder
  drag mentions remain absolute with loaded-entry search and expand-all disabled. The web
  Files tree uses the shared resize observer and inset focus indicators.
- Validation: frozen-lockfile installation succeeded with lifecycle scripts disabled after a
  metadata-timeout retry. Removed the stale duplicate Clerk devDependency while retaining the
  upstream runtime dependency. Scoped typechecks passed for contracts, shared, client-runtime,
  provider-core, provider-acp, effect-acp, provider-grok, source-control-github, server, web,
  mobile, desktop and scripts. Effect suggestions remain non-failing. The 667-file scoped lint
  scan reported 675 warnings (primarily React compiler/dependency rules, unused declarations
  and UI styling); its five blocking findings were corrected and follow-up lint passed.
  Formatting passed for the integration resolutions. Diff whitespace warnings are limited to
  16 imported dependency-patch context lines; those patches remain unchanged. Imported upstream
  tests are retained and existing fixtures reconciled where needed; no tests were independently
  added or run. No app builds,
  packaging, dev servers, browser/device checks, installed-app/live-data operations, process
  stops, push, PR, external messages, subagents, other-worktree/main edits or schedule changes.

## Communication inbox and reading controls — 2026-10-15

- Reworked the communication dialog into the selected inbox layout using existing T3 theme,
  typography, controls, quiet task rows, and divided exchanges. The connection map remains
  available on demand; selection, history loading, live delivery and environment routing are unchanged.
- Messages render Markdown with bounded previews by default, individual expansion, and
  Collapse all / Short previews / Expand all. Collapsed bodies unmount Markdown; previews
  parse at most 1,200 characters and 12 lines. Existing newest-first paging remains intact.
- Web/desktop and phone web share the dialog. Native mobile has equivalent reading modes
  using its existing Markdown renderer. Scope remains the current thread and its related agents.
- Each agent has a colored initial avatar, hashed from its id so the color stays stable. The
  coordinator uses a branch icon. Avatars appear on task rows, the conversation header, map
  nodes, and on both sides of every exchange. Exchanges read as sender → recipient, then
  kind, delivery state, machine and time.
- Expand controls appear only for clipped messages, and clipped previews fade out. Compact rows
  strip Markdown syntax. Statuses read as sentence case through the shared
  `communicationStatusLabel` (`Awaiting input`, not `awaiting_input`). Counts are singular-aware.
  Monitoring states use a readable teal (web) or blue (native) instead of reduced opacity.
- Sources: `apps/web/src/components/chat/AgentCommunication{Dialog,View,Message,Avatar,Map}.tsx`,
  `packages/client-runtime/src/state/threadCommunication.ts` and
  `apps/mobile/src/features/threads/ThreadCommunicationSheet.tsx`.
- Validation: focused web and client-runtime tests; web/mobile typechecks; changed-file lint;
  isolated browser checks of production components with real 3-agent and 280-agent thread
  snapshots at desktop, phone and short-phone sizes, plus a synthetic 6-agent, 2-machine
  snapshot in light and dark themes for the avatar pass. Native device layout not exercised.

## Stable, searchable agent communication — 2026-10-15

- Replaced the web/desktop map's fixed-coordinate, selection-prioritized cards and ambiguous
  one-way links with a coordinator/task tree. Nested agents follow actual parentage; both
  directions have distinct task/message/reply counts. Direct agent exchanges appear separately.
  Full task titles wrap, machine/model/status remain visible, and selection highlights nodes
  without moving them. Missing/cyclic parents remain visible as separate threads.
- Retain discovered participants and recorded messages for the lifetime of the open viewer on
  web and native mobile, even when selecting different detail streams. This fixes agent totals
  shrinking on selection. Live metadata and delivery acknowledgements update existing records;
  the archive clears on close/root change. Only the selected detail sources remain subscribed.
- Task conversations and message feeds use newest-first order. Web has task search by title,
  machine or model, activity timestamps and pages of 50 tasks/30 exchanges. Older exchanges
  append below recent ones. The overview bounds each branch/direct-link list, with explicit
  show-all and focus-selection controls; focusing preserves the overall discovered-agent count.
  Map scrolling and minimum transcript height keep small phone conversations readable.
- Sources: `apps/web/src/components/chat/{AgentCommunicationMap,AgentCommunicationView,
  AgentCommunicationControl}.tsx`, `agentCommunicationStyles.ts`,
  `packages/client-runtime/src/state/threadCommunication.ts` and native
  `apps/mobile/src/features/threads/ThreadCommunicationSheet.tsx`.
- Validation: 18 focused extraction/retention/order and DOM interaction tests passed. An isolated
  Chromium fixture using production components passed desktop (1440×900), phone (390×844) and
  short-phone (320×568) checks, including 75 tasks, search, pagination, stable node positions,
  nested agents, directed counts, explicit focus, collapse and close. Scoped web/native/shared
  runtime typechecks and changed-file lint passed with non-failing warnings. Native UI was
  typechecked, not exercised on a device. No live-data writes, app build, install or restart.

## Neutral activity above the composer — 2026-10-15

- Restored neutral text and icons for command/monitoring activity above the prompt on
  web/desktop and native mobile. The thread-list Monitoring status keeps its dim blue color.
  This corrects the scope of the earlier status-color change; activity tracking and status
  priority are unchanged.
- Sources: `apps/web/src/components/ChatView.tsx` and
  `apps/mobile/src/features/threads/floating-working-control.tsx`.
- Validation: reviewed against the original color-change diff and ran targeted lint and
  formatting checks. No tests, browser checks, rebuild, install or restart.

## Editable client permissions and shared host environments — 2026-10-15

- Authorized clients have an **Edit permissions** dialog in Connections, with Read only,
  Standard and All available presets. Existing cookie, bearer and proof credentials use the
  persisted grant; changes close old sockets and active proxy streams so reconnects see the
  edited grant. Managers cannot grant scopes they lack, edit their current client or revive an
  expired/revoked client. No database migration or manual edits to live user data.
- Phone browsers on the desktop host's tailnet/LAN web address discover the host's connected
  SSH/direct environments automatically. The desktop publishes active authenticated routes to
  its own server; a same-origin streaming HTTP/WebSocket gateway forwards over those routes.
  Remote credentials remain in host memory. No phone SSH, new tunnel, cloud service, pairing
  per remote machine or outbound discovery is introduced. Discovery runs at most every ten
  seconds; publishing follows connection events and retries temporary failures.
- Shared access requires `orchestration:read` and `relay:read` (now labeled **View relay and
  shared environments**), then intersects the phone's permissions with the remote credential.
  Remote servers must advertise delegated-permission support; older servers and proof-only
  routes remain unavailable through the host. Both server builds need updating. The host must
  stay open and connected; native mobile retains its existing direct setup.
- Gateway-aware API, descriptor, asset, preview and device URLs retain the selected environment
  prefix. Shared environments appear as **Shared through host**, are managed by the host, and
  do not replace the actual primary machine or advertise the host's MCP address as the remote's.
- Sources: server `auth/{EnvironmentAuth,SessionStore,http}.ts`, persistence `AuthSessions.ts`,
  `connections/{SharedEnvironments,SharedEnvironmentHttp}.ts`, contracts `auth.ts`,
  `environmentSharing.ts`, `environmentHttp.ts`, web `ClientScopesDialog.tsx`,
  `ConnectionsSettings.tsx`, `connection/{platform,sharedEnvironmentRoutes}.ts`,
  `lib/sharedEnvironmentHost.ts`, shared `environmentGateway.ts` and client-runtime connection,
  endpoint, HTTP and asset helpers. User guidance: `docs/user/remote-access.md`.
- Validation: 128 focused tests passed, including two actual temporary HTTP/WebSocket servers,
  phone cookie and ticket authentication, denied writes, live grant edits/socket cleanup,
  disconnected/outdated host handling, credential isolation, URL routing and dialog interactions.
  Seven scoped typechecks passed (server, web, desktop, native mobile, contracts, shared and
  client-runtime); changed-file lint passed with existing warnings. No browser checks performed.

## Upstream follow-up integration — 2026-10-15 (c079503d07)

- Merged 16 additional commits from upstream `main` through
  `c079503d07` after this morning's `42da166d13` sync, preserving the fork parent
  `a8ac335060`. Reviewed all nine paths modified by both fork and upstream; Git
  merged them without textual conflicts.
- Includes explicit failure when a provider stream ends without a terminal event,
  shutdown interruptions left to restart recovery, Node 26 HTTP/2 disconnect protection,
  bounded PR refresh counts, fewer hosting-CLI probes for unknown hosts, faster native
  workspace search, Windows provider installation fixes and mobile media/list/thread fixes.
- Preserved per-turn multi-repository selections, project guidance/memory and agent MCP
  capabilities in `ProviderSessionManager.ts`. The context-ID helpers moved to the shared
  package without changing fork composer behavior. Minimap text-selection fixes leave
  conversation restoration and bottom following in place. The native Agents sheet retains
  the communication button alongside upstream's guarded new-thread subscriptions.
- The fork's orb buttons, expanded mobile composer, short placeholder, custom widths,
  Monitoring blue, communication viewer, file freshness/worktree selectors, project dots,
  compaction/quota guards, encrypted connections and disabled telemetry remain intact.
  Recovery branch: `spilshchikov/pre-upstream-merge-20261015-c079503d`.
- Validation: frozen-lockfile dependency installation and ten scoped typechecks passed
  (server, web, native mobile, shared, ACP registry, Cursor and four source-control packages).
  Changed-file lint passed with existing warnings; whitespace checks passed. Imported
  upstream tests were retained but not run. No app rebuild, install or restart.

## Daily upstream integration — 2026-10-15

- Merged all 32 upstream commits through
  `42da166d131017335a1158d0b379dd68b8985796` from fork parent
  `edb003b02856ffaf44b00e3c39539ab7c13d336b` with a real merge. Includes
  delegated-question delivery and parent attention, subagents surviving steering,
  smaller command reads, cross-environment dropped-thread snapshots, worktree retention,
  PR-link preferences/branch deletion, cheaper text-generation fallback, update progress,
  bounded usage scans and desktop certificate environment fixes.
- Resolved 12 conflicting files individually and compared all 54 overlapping paths against
  both parents, including automatic merges. Chat callback factories/stable handlers retain
  multi-root file surface identities and dirty-file state, script working directories,
  retained file surfaces and Git History, and shared maximize toggling. The fork's context
  strip setter also uses the stable event-handler boundary. Ordinary sends still have no
  compact-first chip, proposal, queue or dispatch; manual and configured idle compaction remain.
- Monitoring keeps its dim blue label without a timer, alongside upstream's new status icon.
  Child questions/approvals reach parent rows, notifications, snooze gates and project dots;
  real pending background work still earns Monitoring/Working inclusion, while empty idle
  sessions remain Ready. The communication viewer remains mounted in saved-thread details
  at every density and in the native Agents sheet, using bounded on-demand histories.
- Cleanup combines the new optional `worktreeSettledAfterDays` with the fork's existing
  `worktreeOnSettle`: the enabled settle-now rule takes precedence over a delay. Retains
  archived ownership/expiry, secondary-repository selections, active/background/question,
  dirty/ignored-file, branch and terminal guards. Adopts settle-script grace, fresh settlement
  equality checks, live-session checks and workspace leases for restart/rollback. Defaults
  remain settle-now enabled, 14-day thread expiry and protection of ignored files beyond
  `node_modules`. Settings and user guidance explain the precedence and actual defaults;
  manual cleanup availability also includes the fork's settle and expiry rules. Incoming
  retention fixtures explicitly disable settle-now when testing the delayed rule; no
  independent tests were added.
- Traced `ChatComposer` into mounted `ComposerPrimaryActions`/`ComposerActionOrb`: saved send
  color covers Send/Resume/Queue/Steer and saved stop color covers both normal and pending-input
  Stop. Classic remains selectable. Existing chats and draft heroes retain forced mobile
  expansion, disabled scroll/focus collapse, one-line minimum, short mobile placeholder,
  viewport/keyboard handling and custom message/composer width. Timeline restoration keeps
  its independent one-second recovery and bottom following; first assistant text, mixed-work
  labels and stable imported-thread folds remain connected.
- Live callers retain the project rail and simultaneous status dots/colors, project grouping/
  attachments/slots/order and picker height; per-repository Files/worktree selectors and saved
  collapse/expansion/resize, exact-root previews, guarded ten-second revision validation,
  deletion/undo, editor navigation/history/Structure/Commit, staged-only commit generation,
  global panel shortcuts, right-click tab closing and root/multi-root Markdown explorer routing.
  Sidebar CLI resume remains mounted with V2 native references. Initial checkout binding and
  clearing still require the validated preparing run, only queued follow-ups, no provider
  session and no pending question/background work; ordinary busy work stays protected.
- Claude worker effort hooks and child-specific model/effort ingestion remain connected through
  upstream steering changes. Account/source/model rows, isolated HOME/config directories,
  pooled colors and compact provider trends remain separate while new scan pacing is accepted.
  Project notes/workspace/peer MCP registration and relay hosting, durable peer response watches,
  idle-compaction project overrides/current native usage/quota guards, terminal-worker question
  recovery and two-hour terminal-PR unlinking remain live. Multiwork and machine sync stay
  explicitly retired; replaced usage/sync components remain superseded.
- External analytics and OTLP remain disabled. Desktop keeps local tracing without the incoming
  exporter metadata path; server export metadata does not enable its unset collector URLs.
  Provider version/manifest/refresh, auto-update and Keychain opt-ins, stable desktop storage
  and encrypted local connection catalogs remain. New PR actions use the existing permission
  and service paths; branch deletion is explicit, host-side and does not remove local worktrees.
- Integration sources: `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/components/chat/ChatComposer.tsx`, `apps/web/src/components/Sidebar.tsx`,
  `apps/web/src/components/Sidebar.logic.ts`, `apps/mobile/src/features/threads/threadListV2.ts`,
  `packages/client-runtime/src/state/threadInbox.ts`, `apps/server/src/server.ts`,
  `apps/server/src/storageCleanup.ts`, `apps/web/src/components/settings/StorageSettings.tsx`,
  and `apps/desktop/src/app/DesktopObservability.ts`.
- Validation: frozen-lockfile installation and all 14 scoped typechecks passed: server, web,
  native mobile, desktop, client-runtime, contracts, shared, provider-core, provider-muse,
  provider-opencode, source-control-azure-devops, source-control-bitbucket, source-control-github
  and source-control-gitlab. Changed-file lint covered 168 TypeScript files with zero errors
  and 313 warnings (React hooks/refs/state/memoization, unused symbols, styling and other rules).
  Non-failing Effect suggestions remain. Integration formatting and whitespace checks passed.
  These are static checks; runtime/UI behavior and imported/adapted upstream tests were not
  exercised. No tests run, app builds, packaging, dev servers, installed-app/live-data operations,
  process stops, push, PR, external messages, subagents, other-worktree/main edits or schedule changes.

## Agent communication viewer and status colors — 2026-10-14

- Added the production **Agent communication** button to every saved thread's details panel,
  including compact presentations. It opens task conversations with a selectable connection
  map. Native mobile exposes the same viewer from the Agents sheet. Existing threads need no
  setting or migration. This replaces the earlier prototype-only UI gap.
- Shared extraction reads recorded task prompts/results, Claude teammate messages, Codex
  inputs, T3 thread sends and cross-environment deliveries/replies. Native recipient IDs are
  scoped to their parent/environment; outgoing/received receipts deduplicate. Sibling views
  retain parent messages joining their exchange. Ordinary narrative claims are not deliveries.
- Viewer subscriptions exist only while open, and additional task histories load only when
  selected. Existing bounded detail streams supply live updates and earlier-history loading;
  no polling, agent commands, process control or database writes are added. Unavailable remote
  histories show errors alongside available records.
- Thread-list Monitoring labels use slightly dimmer Working blue on web/desktop and native
  mobile. Background status above the composer stays neutral. Communication statuses use blue for
  activity, green for completion, red for failure, amber for attention and indigo for input.
  No continuously animating status indicator is added.
- Sources: `packages/client-runtime/src/state/threadCommunication.ts`,
  `apps/web/src/components/chat/AgentCommunicationControl.tsx`,
  `apps/web/src/components/chat/AgentCommunicationDialog.tsx`,
  `apps/web/src/components/chat/AgentCommunicationView.tsx`,
  `apps/web/src/components/chat/ThreadDetailsPanel.tsx`,
  `apps/web/src/components/chat/ThreadDetailsCard.tsx`,
  `apps/mobile/src/features/threads/ThreadCommunicationSheet.tsx`,
  `apps/mobile/src/features/threads/ThreadAgentsSheet.tsx`, `apps/mobile/src/Stack.tsx`,
  `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/ChatView.tsx`,
  `apps/mobile/src/features/threads/thread-list-v2-items.tsx`, and
  `apps/mobile/src/features/threads/floating-working-control.tsx`.
- Validation: 13 user-authorized focused extraction and DOM interaction tests, scoped client-runtime,
  web/mobile typechecks and changed-file lint. Authorized headless Chromium layout checks use
  real viewer components with isolated fixture data at desktop, phone and short-phone sizes;
  native mobile is typechecked, not exercised on a device. Live app data and processes are untouched.

## Foreground Working and background Monitoring — 2026-10-14

- Shared `resolveThreadWorkPhase` distinguishes active foreground turns from completed/idle
  turns with commands, monitors, child work, PR watches or peer watches. Background-only
  work uses internal `waiting`, displayed as **Monitoring** on web/desktop and native mobile.
  Checkpoint-only waiting remains Working; foreground turns outrank lingering rosters;
  approvals/input and usage limits/errors retain their existing priority.
- Sidebar rows, legacy/status-indicator pills and mobile rows agree. Monitoring has no
  working timer or pill pulse. Working-shelf inclusion and pending-work tracking remain intact;
  project dots continue showing pending processes; separate running/monitoring flags give
  accurate tooltips, including projects with both kinds of activity.
- Read the live database read-only: yb-stress-test's "Triage and Repro Newly Failed Stress Tests"
  had a completed root run plus a command "Wait for the three verification runs", confirming
  the presentation bug. No database changes or runtime process control.
- Validation: 321 user-authorized focused tests passed in six files (shared execution,
  web sidebar, mobile thread list, mobile emphasis, project rail and inbox tracking).
  Scoped web/mobile/client-runtime typechecks and changed-file lint passed with existing
  warnings; whitespace check passed. No browser/native UI checks, build, install or restart.

## Automatic usage-limit recovery default — 2026-10-14

- The existing server-scoped **Auto-resume limited threads** toggle now defaults to On
  when no saved preference exists. Saved opt-outs remain Off. General settings on web/desktop
  and Thread behavior on native mobile explain reset tracking and per-thread cancellation.
- Reuses the durable recovery worker and the reported root-run usage-limit reset; no new
  timer or provider/account polling. Main-thread recovery survives server restarts, needs no
  connected client and retains stable delivery IDs, current-run/account validation, held queues,
  Stop/manual retry/cancel/archive/settlement guards and expired-reset loop protection. Providers
  without a reset time remain manual. Idle compaction's quota-recovery guard is unchanged.
- This changes the settings default, not installed/live preferences or runtime state.
  Validation: scoped server/web/mobile/contracts typechecks and changed-file lint passed;
  whitespace check passed. No tests added or run, build, install or restart.

## Upstream integration — 2026-10-14 (bf8ffe81a6)

- Merged seven new commits through `bf8ffe81a6` after `7ac952c630`: PR filters follow
  sidebar order and exclude Scratch, synchronized PR state, review wording, subagent
  punctuation, Claude progress-text classification and the optional PR inactivity guard.
- Resolved six conflicting files individually. Kept Never-default, exclusive settlement
  modes and open/unknown PR protection; the new guard can additionally keep terminal PR
  threads active in inactivity mode. Kept fork project attachments and legacy project ordering
  while adopting the shared sidebar grouping hook. Preserved both independent test suites.
- Reviewed all 25 incoming paths. Composer animation/mobile expansion/scrolling, status dots,
  Files freshness/worktrees, branch naming, compaction quota guards, encrypted connections,
  disabled tracking and cross-environment agent messaging are retained. No dependency changes.
- Validation: frozen-lockfile dependency alignment, scoped server/web/mobile/contracts/client-runtime
  typechecks and changed-file lint passed (warnings remain); staged whitespace check passed.
  No runtime tests, build, install or restart.

## Daily upstream integration — 2026-10-14

- Merged all 91 upstream commits through
  `7ac952c630ef8a60d14ca8f6a0c7adce33db4bae` from fork parent
  `6b1454c646bb2e42324fa8d1c441eb37620af0a5` with a real merge. Includes SQLite
  reader/checkpoint workers, smaller event/projection writes, notification-history paging,
  connection/relink recovery, live Claude selection changes and steered token accounting,
  attachment sizing, HTML reply zoom/shortcuts and coordinated update reporting.
- Resolved seven conflicts individually and reviewed the 78 overlapping files, including
  automatic merges. `storageCleanup.ts` adopts reader-worker snapshots, lightweight ownership
  rechecks and coalesced automatic sweeps while retaining archived-thread cleanup/expiry,
  settle-triggered removal, fresh settlement checks and secondary-repository ownership guards.
  `ProjectionStore.ts` adds opt-in archived ownership paths to both SQLite and memory stores;
  secondary selections are read as paths rather than loading every thread's history per worktree.
  Adapted incoming snapshot-count expectations for active/archive cleanup and expiry reads;
  no independent test cases were added.
- Analytics remains an unconditional no-op. `ws.ts` keeps the split typed handler registration
  and all fork RPCs, adapting UUID generation to Effect 4.0.4. Updated four additional fork-only
  UUID calls in encrypted connection storage, workspace commands and terminal-PR cleanup.
  `ProjectSettingsPanel.tsx` combines confirmed removal with device-local project attachments.
  Imported action-shortcut fixtures retain the fork's required working-directory field.
  `useUpdateEverything.ts` retains a publication check only after the user requests an update,
  alongside upstream progress, error summaries and relaunch recovery; no mounted npm probe.
  Shared query finality stops terminal-PR refreshes without replacing file reads' waiting-state
  wrapper, disk revisions, selected-panel 10-second validation or dirty-editor protection.
- The new HTML shortcut bridge includes numbered project recall/assignment and editor/Structure
  navigation, plus the root-owned ISO panel shortcuts and Shift+§ alias. It retains upstream
  source/focus/user-activation checks, blocked-command matching and thread-mutation exclusions
  (`files/BrowserDocumentFrame.tsx`). No provider or thread mutation is added to the allowlist.
- Traced `ChatComposer` into the mounted `ComposerPrimaryActions`/`ComposerActionOrb`: saved
  send color covers Send/Resume/Queue/Steer and saved stop color covers normal and pending-input
  Stop; Classic stays available. Existing chats and draft heroes keep forced mobile expansion,
  no scroll/focus collapse, one-line prompt minimum, ordinary sending without compact-first
  proposals, custom chat widths and viewport/keyboard handling. Upstream streamed reasoning
  follows within its own work-log scroller. Timeline recovery/end following, first assistant
  text outside settled folds and mixed-work labels coexist with resumed-subagent/imported folds.
- Live callers retain project rail/status dots and colors, grouping/attachments, slots/order,
  picker sizing and app accents; per-repository Files/worktree selectors, persisted collapse,
  expansion/resize, navigation/history, deletion/undo, staged-only commit context and Git History;
  root/multi-root Markdown explorer routing; and mounted CLI resume using V2 native refs.
  Initial checkout binding/clearing still requires the validated preparing run, only queued
  follow-ups, no provider session and no pending question/background work. Ordinary active and
  background work remain protected. Live Claude effort changes retain worker observation hooks
  and child-specific model/effort ingestion. Account/model usage rows, isolated HOME/config dirs,
  pooled account colors, compact provider trends and history/polling remain connected.
- Project memory/workspace/peer MCP registration, relay hosting and durable response watches
  remain connected. Narrow projection patches and single-PR events preserve fork thread metadata
  and the two-hour terminal-link cleanup. Provider-session release clears only process-owned
  background tasks; peer watches remain independent pending monitors. Idle compaction stays
  opt-in with project overrides, current native-context usage and quota-recovery eligibility;
  terminal-worker question recovery and Never-default settlement remain. Stable desktop storage,
  local catalog encryption, disabled external analytics/OTLP and provider-refresh/version/manifest,
  auto-update/Keychain opt-in gates remain. Multiwork and machine sync stay explicitly retired;
  older usage/sync components remain superseded.
- Validation: frozen-lockfile installation and 20 scoped typechecks passed: server, web, native
  mobile, desktop, relay, contracts, shared, client-runtime, six provider packages, three
  source-control packages, SSH, Tailscale and scripts. Initial server/web compatibility errors
  were corrected and both checks rerun successfully. Changed-file lint covered 358 files with
  zero errors and 380 warnings (React hooks/refs/memoization, unused symbols and styling among
  others); final lint of four integration files passed without warnings. Typechecks retain
  non-failing Effect suggestions. Integration formatting and source/document whitespace checks
  passed. Git's rename-disabled tree whitespace check flags four required blank-context lines
  in upstream's renamed `patches/@effect__vitest@4.0.4.patch`; kept verbatim for patch integrity.
  Runtime/UI behavior and imported/adapted upstream tests were not exercised.
  No tests added independently or run, app builds, packaging, runtime/UI checks, dev servers,
  installed-app/live-data operations, process stops, push, PR, external messages, subagents,
  other-worktree/main edits or schedule changes.

## Agent conversation messages and response watches — 2026-10-14

- Added `t3_peer_threads_list`, `t3_peer_thread_read`, `t3_peer_thread_send`,
  `t3_peer_thread_watch`, `t3_peer_thread_watches`, and `t3_peer_thread_unwatch`.
  Agents can discover and coordinate across environments, including existing direct SSH routes,
  and T3-managed child/sibling agents can use the same paths on their own machine. Parent agents
  can read and join their exchanges. Native subagents retain their provider messaging tools
  (Claude `SendMessage`, Codex `send_input`) and readable imported conversations.
- Reused the existing app relay and normal thread dispatch, with source machine/thread attribution,
  destination permission checks, sender mode ceilings checked under the command lock, stable
  delivery receipts and replay cursors. No shared-file polling or new internet service. The app
  must stay connected to both environments; mobile does not host this relay.
- Agents explicitly choose no watch, one reply, or continuous replies. Watches persist as thread
  metadata, resume after restart/reconnect, and atomically advance their cursor with each notification.
  Stop, archive, settlement and unwatch clear them; forks and newly spawned children do not inherit
  them. A deleted recipient ends the watch with an explanation. Watches count as real pending monitors without restoring the
  empty-idle/session-reference fallback. Bounded long polls leave relay capacity for sends and files.
- Services: `apps/server/src/peers/PeerThreads.ts`, `PeerThreadMessaging.ts`, the existing `Peers`
  transport and MCP peers toolkit; contracts in `packages/contracts/src/peers.ts` and
  `orchestrationV2.ts`. Web/desktop relays invoke the destination through a guarded environment
  command in `apps/web/src/rpc/peerThreads.ts`. Shared/server projections carry the watch roster
  to all clients. Relay connections now require filesystem write and orchestration read/operate
  grants because they can carry conversation requests.
- Isolated integration coverage exercises cross-environment send/read, retry deduplication and
  cursor preservation, replies completed before watch registration, repeated continuous replies
  without duplicate wakes for updates to an already completed run, watch cleanup, recipient deletion, sender permission limits, and local sibling/parent exchanges
  without a relay. No real providers are launched. Focused authorization, client permission,
  pending-work, fork, file relay and MCP registration checks cover the surrounding paths.
  Validation: 99 focused tests passed; all eight affected/client package typechecks passed; targeted
  lint passed with seven pre-existing warnings. Formatting and whitespace checks passed.
- The requested communication interface remains a prototype outside the repository: a button
  beside the subagent list in the thread details panel opens a dialog, with alternative layouts.
  No production layout was selected after the accidental choice was withdrawn. No app build,
  reinstall/restart, remote deployment, live-data write, push or PR was performed.

## Upstream integration — 2026-10-13, manual merge

- Merged all 19 upstream commits through `aef0e9ca401acb40057a286a19de8768809db960`
  from fork parent `b8eb79e35d`, preserving both histories. Includes delegated-task worktree
  isolation, Haiku 5.5 for background text generation, context-handoff previews, slash skill
  search inside messages, Pi completion-gateway tools, snoozed automatic wakes, startup error
  diagnostics, whitespace-preserving Git file paths and database planner improvements.
- Resolved the migration runner and preview expectations by retaining every released fork ID
  and registering upstream's new failure-lookup index as migration 67. Kept the fork's V2
  boundary, compatibility repairs, preview translation and migration-history guards. Adapted
  incoming migration expectations to the fork's 67-entry ledger, without adding new cases.
- Reviewed all production diffs and the 20 overlapping files: original fork added/removed
  lines remain preserved against the new upstream. Delegated worktree preparation uses the
  existing `spilshchikov/` naming and preparation safeguards. Mobile composer expansion and
  keyboard handling, custom chat lanes, scroll recovery/live following, Arcane send/stop
  renderers, Files freshness and per-root selectors, peer tools, idle compaction/quota guards,
  two-hour PR unlinking and encrypted connection storage remain. External analytics/OTLP stay
  disabled; provider refresh, desktop update and Keychain access retain their opt-in gates.
  The idle-session status fix from `b8eb79e35d` is unchanged across rail, web, shared and mobile.
- Dependency installation used the frozen lockfile; accepted upstream's tsc-rs 0.6.0 update.
  Ten scoped typechecks passed (server, web, mobile, desktop, client-runtime, contracts, shared,
  provider-core, provider-pi and provider-opencode). Lint checked 71 changed source/test files:
  zero errors and 217 warnings. Non-failing Effect suggestions remain. Formatting and whitespace
  checks passed. Reports are outside the worktree under `merge-reports/2026-10-13-manual`.
- No tests run, independent tests added, app builds, packaging, reinstall/restart, remote
  deployment, live-data writes, push or PR. The installed local and remote apps retain their
  current builds until the owner requests an update.

## Idle sessions do not count as running work — 2026-10-13

- Read-only diagnosis found empty idle Codex child sessions in local poly and remote rotor.
  Their retained provider-thread references produced an idle runtime; the sidebar interpreted
  that as background waiting and the grouped project rail showed a running dot.
- Web/desktop and native mobile status classifiers now require an active run or a nonempty
  pending-background roster for Working. Empty idle sessions are Ready; the shared Working
  group also leaves them in the inbox. Project-rail aggregation no longer treats the old
  idle-to-Waiting fallback as running (`Sidebar.logic.ts`, `sidebar/projectRail.logic.ts`,
  `threadListV2.ts`, client-runtime `state/threadInbox.ts`).
- Preserve the October 6 fork behavior: real pending commands, monitors, subagents and PR
  watches still show work, including simultaneous running/input project dots. Stored provider
  references, queued-run holds, background rosters, completion markers and remote grouping
  retain their existing behavior. No database cleanup or polling is needed.
- Validation: scoped web, native mobile and client-runtime typechecks passed; lint passed with
  eight existing warnings. Updated the existing empty-idle expectation to Ready. No tests added
  or run, UI checks, live-data writes, app builds, reinstalls or restarts.

## Daily upstream integration — 2026-10-13

- Merged all 19 upstream commits through
  `42160f2925daa3c0d4ef2b95f68a87858972e6a3` from fork parent
  `7f6ab7d7b22c4f2e4778cace3ee65224dcd15d2d` with a real merge. Includes
  tunnel reconnect recovery, native attachment caching and offline PR fallback,
  cached branch-PR Git reads, downgrade replay, migration startup diagnostics,
  Codex lightweight text-generation isolation, HTML link routing and web layout fixes.
- Resolved three conflicts individually. `persistence/Migrations.ts` retains released
  fork IDs, compatibility repairs and atomic upstream-preview translation. Upstream's
  required-V2-history guard runs after that translation, inside the transaction, using
  the fork's V2 boundary at 59. Earlier divergences and unknown later IDs retain warnings;
  no released migration was renamed or renumbered. Adapted incoming migration expectations
  and migration guidance to that boundary without adding independent tests.
- `files/FilePreviewPanel.tsx` keeps its resizable multi-repository preview/explorer,
  Files/Structure/Commit controls, exact-checkout and external-file handling. The actual
  attachment preview passes its thread reference to upstream's HTML link handler, so PR
  links can open beside that chat. Markdown root links still resolve to the explorer.
  `state/npmRelease.ts` retains a user-requested publication check, with upstream's
  tracing-header suppression; no sidebar-mounted or recurring npm request is restored.
  Adapted the incoming npm expectations to the existing one-shot API.
- Reviewed all upstream source changes and the automatic merges. Ten of the thirteen
  overlapping files retain identical fork added/removed lines against upstream; the other
  three are the resolutions above. Claude thinking remains a Thought while actual first
  assistant text stays outside settled folds. Tool collection uses push/reverse with its
  existing order and mixed-work labels; stable imported-thread grouping and independent
  one-second position recovery/end following remain live. Git PR caching confirms terminal
  results against fresh Git state and discovery requests fresh state before persisting;
  fork Never-default settlement and two-hour finished-link removal remain connected.
- Traced `ChatComposer` into `ComposerPrimaryActions`: Arcane mounts with saved send color
  for Send/Resume/Queue/Steer and saved stop color through the shared ordinary and
  pending-input Stop renderer. Classic remains available. `ChatView` keeps forced mobile
  expansion for existing chats and draft heroes, disabled scroll/focus collapse, ordinary
  sending without compact-first actions, custom chat width and mobile viewport handling.
  Native attachment caching does not replace keyboard/composer layout handling.
- Live callers retain project rail/status dots/colors, project slots/grouping/attachments,
  ordering and picker size; per-repository Files/worktree controls and stored collapse,
  expansion and resize state; fresh-file checks/dirty-editor protection, deletion/undo,
  editor navigation/history, global panel shortcuts and right-click tab closing; Git
  history and staged-only commit context; and sidebar CLI resume with V2 native refs.
  Initial checkout binding/clearing still requires the validated preparing run with only
  queued follow-ups, no provider session, question or background work. Ordinary active
  work remains protected. Claude worker hooks and child effort ingestion remain connected.
- Account/source-specific usage model rows, colored pooled limits and compact per-provider
  trends remain mounted. Upstream changes only pace-label alignment, not account aggregation.
  Project notes/workspace MCP, peer file tools/client relay, project compaction overrides,
  quota-recovery eligibility, worker-question recovery, cleanup preferences and stable desktop
  storage/local catalog encryption remain connected. External analytics/OTLP stay disabled;
  provider refresh/version/manifest, auto-update and Keychain remain opt-in. Lightweight
  Codex generation disables MCP/plugins/apps without changing actual agent MCP access.
  Multiwork and machine sync remain explicitly retired; older usage/sync components remain
  superseded rather than restored.
- Validation: frozen-lockfile installation and eight scoped typechecks passed (server, web,
  mobile, desktop, contracts, shared, client-runtime and source-control-bitbucket). Changed-file
  lint covered 57 files with zero errors and 116 warnings (unused symbols, React hooks/ref/
  memoization rules and styling). Typechecks also report non-failing Effect suggestions.
  Formatting and source/document whitespace checks passed. These are static checks; runtime/UI
  behavior and the imported/adapted upstream tests were not exercised.
  No tests added independently or run, app builds, packaging, runtime/UI verification, dev
  servers, installed-app/live-data operations, process stops, push, PR, external messages,
  other-worktree/main edits or schedule changes.

## Personal Team iPhone builds over Tailscale — 2026-10-12

- `apps/mobile/app.config.ts` reads `T3CODE_IOS_PERSONAL_TEAM_ID` through `loadRepoEnv`
  from root `.env` / `.env.local`, selecting the owner's signing team for Personal Team builds
  instead of T3 Tools' `ARK85ZXQ4Z`.
- Register `apps/mobile/plugins/withoutIosPersonalTeamCapabilities.cjs` first: Expo runs
  same-type mods last-registered-first, so it now strips push entitlements after
  `expo-notifications` adds them.
- Also strip associated domains, which Personal Teams cannot sign; `clerk.t3.codes` only
  trusts T3 Tools' bundle IDs. Widget/share extensions and native Sign in with Apple stay omitted.
- Local iPhone setup uses root `.env.local`: `T3CODE_IOS_PERSONAL_TEAM=1`, the owner's team ID,
  `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.pilshchikov.t3code`, and
  `T3CODE_MOBILE_UPDATES_ENABLED=0` to keep official OTA updates off the fork. With no Clerk/relay
  keys, T3 Connect is compiled out; pair directly with the Mac over Tailscale using an
  `http://<tailnet-ip>:<port>` pairing link. See `apps/mobile/README.md`.
- `apps/mobile/modules/t3-native-controls/ios/T3LayoutMetricsView.swift` gates the iOS 27.1 hinge
  and reserved-region APIs on `canImport(UIKit, _version: 9127.1)` instead of
  `compiler(>=6.4)`: Xcode 27.0 ships Swift 6.4 with the 27.0 SDK (UIKit 9127.0.x), which lacks
  them. Older SDKs build without fold metrics.
- Validation: previously verified `APP_VARIANT=production npx expo config --type introspect`
  leaves only `keychain-access-groups` in entitlements. Scoped four-file `vp check` and mobile
  typecheck passed. A device Release build with Xcode 27.0 compiled; signing needs an unlocked keychain.

## Agent tools for files on other environments — 2026-10-12

- The owner asked for agent-driven file exchange between environments, with no UI: Git moves
  tracked work, and agents copy the rest (`.env`, large or ignored files) and check what a
  machine is missing. This is not the removed machine sync. Nothing runs unless an agent calls
  a tool.
- MCP tools `t3_peers_list`, `t3_peer_files_list`, `t3_peer_file_read` and `t3_peer_copy`
  (`apps/server/src/mcp/toolkits/peers.ts`). The agent prompt names them in the
  `<other-machines>` block of `apps/server/src/project/ThreadWorkspaceInstructions.ts`, which
  reaches every provider.
- Servers never connect to each other, so a client connected to both relays. `Peers`
  (`apps/server/src/peers/Peers.ts`) queues each request for a connected relay over
  `peerRelay.connect` and takes the answer from `peerRelay.respond`. The web app answers in
  `apps/web/src/lib/peerRelayHost.ts` by calling `peerFiles.list`, `peerFiles.read` and
  `peerFiles.write` on the other environment. `sameProject` follows the device's grouping,
  hand-made links included (`apps/web/src/peerProjects.ts`). Contracts are in
  `packages/contracts/src/peers.ts`.
- `PeerFiles` (`apps/server/src/peers/PeerFiles.ts`) accepts only paths that resolve inside a
  project folder or thread worktree of its environment, symlinks included. Writes collect in a
  temporary file and rename over the destination, and every copied file is verified by sha256.
  There is no delete and no command execution. Copying needs a full-access caller. The relay
  RPCs need the `filesystem:write` scope, the list and read RPCs `filesystem:read`.
- Limits: files move in 512 KB chunks through the app, a listing stops at 2,000 entries, folder
  copies skip `.git` and `node_modules`, and mobile does not relay. An environment running an
  older server answers `peer_unreachable`.
- Validation: full typecheck passed. `apps/server/src/peers/Peers.test.ts` covers folder and
  file copies both ways, overwrite, path limits and the untracked listing. Not exercised between
  two real machines yet.

## Attach a folder to an existing project — 2026-10-12

- Projects group across machines by Git remote only, so a folder without one always became a
  separate project. The client setting `sidebarProjectLinks` (physical project key to logical
  project key) now records a hand-made attachment and outranks repository matching in
  `deriveLogicalProjectKeyFromSettings` and `buildProjectGroups`
  (`packages/client-runtime/src/state/projectGrouping.ts`, `packages/contracts/src/settings.ts`).
- **Add project** asks, after the machine, whether the folder is its own project or part of an
  existing one, then shows the usual sources (`apps/web/src/components/CommandPalette.tsx`,
  `apps/web/src/hooks/useNewProject.ts`, `apps/web/src/projectLinks.ts`). **Settings → Projects →
  Grouping** attaches an existing project to another and detaches it
  (`apps/web/src/components/settings/ProjectSettingsPanel.tsx`).
- The link is per device, like the existing grouping overrides. Nothing is copied between
  machines. Mobile ignores links.
- Validation: full typecheck and `projectGrouping.test.ts` passed. `vp check` reports the same 13
  lint errors as before.

## Machine sync removed — 2026-10-12

- The fork briefly had a feature that copied a project's repository between connected machines
  (`environmentSync.*` RPCs, a header machine menu, a synced projects folder setting). The owner
  removed it the same day because Git already moves work between machines and the feature added
  too much to maintain. Do not rebuild it.
- Removed by reverting `29b66086b5` and `141b674f41`. Every file they touched now equals its
  earlier state plus upstream's later changes. The upstream **Run on** picker is unchanged. A new
  thread can target any connected machine that already has the same repository as a project.
- Validation: full typecheck and the `ProviderTurnStartService` tests passed. No app restart.

## Upstream integration through df26ef9985 — 2026-10-12

- Merged all 16 upstream commits through `df26ef9985` from fork parent `701fc83169`, preserving
  both histories. Includes renaming built-in models from provider settings, confirmed Claude
  subagent outcomes, Git actions that follow the selected thread, dropped threads attached to
  pending answers, running setup terminals reused by the drawer, updater failure causes in
  diagnostics, and Bitbucket/GitLab head commit fixes.
- The owner asked for the Muse model integration. Upstream has no Muse change in this range.
  `packages/provider-muse` already matched upstream before the merge (native provider, child
  threads for subagents, Muse 1.4.6), and Muse models come from the CLI's own catalog. The
  model renaming above applies to them. Muse usage limits are still open upstream pull requests.
- No conflicts. The fork's delta against upstream is line-for-line identical before and after
  the merge in all 21 files both sides changed, including `ChatView.tsx`, `ChatComposer.tsx`,
  `Sidebar.tsx`, `MessagesTimeline.tsx`, `GitManager.ts` and `GitVcsDriverCore.ts`. The upstream
  delta adds no compact-before-send path, telemetry or new network call.
- Validation: full typecheck passed. Every test file the merge touched passed in web, desktop,
  client-runtime, shared, provider-core, Bitbucket and GitLab.
  Server files `GitManager.test.ts`, `GitVcsDriverCore.test.ts` and `ClaudeAdapterV2.test.ts`
  fail the same 10 tests on the pre-merge tree, four of them upstream branch-name expectations
  that the `spilshchikov/` prefix changes. `vp check` reports the same 13 lint errors as before.
  No app build, reinstall or restart.

## Persistent connections without Keychain prompts — 2026-10-12

- The owner chose persistent local encryption after SSH connection registration failed because
  the fork disables Keychain access. `DesktopConnectionCatalogStore.ts` now falls back to
  AES-256-GCM in `connection-catalog.local.json`, with a randomly generated owner-only key under
  `local-secrets/connection-catalog.key`. Keychain access stays disabled by default.
- Key publication uses a completed private temporary file and a non-replacing hard link, so
  concurrent instances use one complete key. Catalog writes remain atomic and owner-only.
  Missing/invalid keys and authentication failures fail closed; saving does not silently
  regenerate a lost key or overwrite a catalog whose key is missing or invalid. No plaintext
  fallback or network call.
- Existing Keychain-encrypted catalogs remain untouched. A newer local catalog remains
  authoritative if the Keychain opt-in changes, avoiding a rollback to older connection data.
  Explicit catalog clearing removes both catalog files. The desktop IPC and wire format stay
  compatible; encryption helpers live in `app/localCatalogEncryption.ts`.
- SSH already honors per-host `ProxyCommand`, including secondary userspace Tailscale sockets.
  The owner's secondary-tailnet alias was configured and verified locally outside this repo;
  automatic Tailscale discovery still reads the default daemon. Remote-access guidance covers
  multiple SSH routes and backing up the local key with connection data.
- Validation: all 17 focused tests passed across the catalog store and encryption helper,
  covering reopening, authentication failures, missing keys, legacy preservation, concurrent
  key creation, clearing and file permissions. Desktop typecheck and scoped source/test lint
  passed. Checks used temporary data; no live-data writes, app build, reinstall or restart.

## Upstream integration — 2026-10-12

- Merged all 92 upstream commits through `701fc83169611473139c441bc27d5ded9612dc8d`
  from fork parent `ffae452744ec5d6be1dbc3f0cf0e0b82dd860932`, preserving both histories.
  Includes native mobile PR review/offline views and Enriched Markdown, prompt links, terminal
  colors, bounded restart continuations, live-follow recovery, fuller context menus, and updates
  across connected machines/providers. Accepted tsc-rs and its matching Effect tooling.
- Resolved eight conflicts individually and reviewed overlapping automatic merges. Sidebar
  controls retain the separate project rail and macOS inset, plus the mobile swipe/viewport
  handling and upstream sheet-mounted trigger guard. Rail and sidebar keep one persisted scope
  while resolving upstream scratch-project grouping consistently. Numbered slots, colors and
  simultaneous vertical status dots remain mounted; native CLI resume remains available.
- Saved numbered slots resolve their old physical scratch scope through the same grouping
  policy for both keyboard recall and menu number badges. Stored assignments are retained;
  the final shortcut audit and scoped web typecheck/lint cover this integration correction.
- Integrated upstream end-follow persistence and held-timeline protection with the fork's latest
  fallback and restored reading positions. Kept `spilshchikov/` generated branch/worktree naming
  while adopting collision handling that suffixes the blocked namespace component. Updated
  imported expectations and the query harness to retain fork behavior alongside upstream cases;
  no tests were added independently or run.
- The new npm-publication check runs only after the user requests an update, with no mounted
  sidebar probe or recurring registry request. External analytics/OTLP stay disabled; existing
  provider/version/manifest, desktop update and keychain opt-ins remain. Schema-declared secrets
  integrate without replacing fork provider HOME/config-directory isolation.
- Arcane send/stop renderers and saved colors, forced expanded mobile composer, custom chat
  widths, Files multi-root/worktree selectors and guarded 10-second freshness checks, absolute
  file previews, global panel shortcuts, compact per-provider usage trends, idle compaction and
  quota-recovery guards, two-hour terminal-PR unlinking, worker question cleanup and Claude worker
  effort hooks remain connected. Existing database migration assignments are unchanged.
- Validation: frozen-lockfile dependency install; 17 scoped typechecks passed (web, server,
  mobile, desktop, client-runtime, contracts, shared, five provider and five source-control
  packages). Changed-source lint checked 493 files with zero errors (471 warnings remain);
  the new Effect checker also reports non-failing suggestions. Audited unchanged fork renderer,
  usage, Files, workspace, panel, compaction, PR cleanup and projection paths against the parent.
  No runtime/UI checks, app build, packaging, reinstall, restart, live-data writes, push or PR.

## Compact provider-grouped usage trends — 2026-10-11

- Usage → Limits → Trends uses the selected compact design: separate Claude/Codex provider
  sections, one row per account, and short graphs for the main quota windows. Narrow web views
  put the account above the window columns. Account colors and sensitive-name redaction remain.
- Different accounts retain their own windows and measurements. Missing windows show no
  measurements; additional/model-specific limits keep their own expandable graphs. Graphs keep
  reset jumps, dashed gaps, local-day guides, exact-time inspection, and day-grouped measurement
  tables. Keyboard and touch inspection work as well as pointer hover. SVG strokes do not shrink
  with narrower columns, and date labels use regular text so they remain legible on phones.
- Trend rendering is in `apps/web/src/components/usage/UsageLimitTrendRows.tsx`; the existing
  `UsageLimitTrends.tsx` keeps environment queries, period controls, refresh, and empty/error states.
  Fetch cadence and history storage are unchanged. Web and desktop use this view; native mobile
  still has no usage-history screen.
- Validation: web typecheck and scoped lint passed. Browser checks mounted the actual components
  with isolated sample history at 1440, 768, 390 and 320 pixels, covering period controls,
  missing windows, additional limits, measurement tables, redaction, keyboard/touch inspection,
  empty history and horizontal overflow. Before/after screenshots stay outside the worktree.

## Daily upstream integration — 2026-10-11

- Merge target: `f23d0084b6` (229 upstream commits since
  `64972461c0606a4eafdd3cd08056155b6a2fea95`, including the five after the saved
  daily integration target `ed0f7b908b`);
  fork parent: `b5b8afe6a24acb64e856d2bd36e1f007dac5de5a`. Real merge preserves
  both ancestries. Reviewed conflicts individually and overlapping automatic merges.
- Integrated source-control package extraction, GitCafe, review guides, file metadata,
  server-owned setup queues, model preferences, richer account identity and usage readers.
  Existing migration IDs 43–65 remain assigned; the new review-guide migration uses 66.
  Bitbucket clone names keep `spilshchikov-pr-`. Files retain repository-specific selectors,
  expansion/collapse/resize state, editing and exact-checkout navigation. Project-root
  markdown opens the explorer, and sidebar CLI resume remains mounted with V2 native refs.
- Traced the mounted Arcane renderer on send/resume/queue/steer and both Stop paths, with
  saved send/stop colors and Classic available. Existing chats and draft heroes retain
  forced mobile expansion, without scroll/focus collapse. Timeline recovery/bottom following,
  first assistant text outside settled folds, mixed-work labels and imported identity stability
  remain. Custom chat width and project rail/status colors remain connected to the live UI.
  Native mobile combines upstream reserved-region insets with the fork's keyboard handling
  and explicit composer width reset after layout changes.
- Unified upstream persisted per-thread right-panel maximize with the fork's shortcuts,
  toggle and clearing on hide. Kept watcher-driven file caching while seeding upstream
  metadata after reads. Ordinary active/background work still blocks primary checkout changes;
  only the validated initial preparing run may bind/clear it while follow-ups are queued.
- Claude worker observations still update their own effort/model selection, never borrowing
  unknown effort from the parent. Usage readers retain instance IDs, display names, isolated
  Claude HOME/config directories and cached legacy-directory history. New usage fields and
  pooled limits keep account and model rows separate. Project memory/workspace MCP and idle
  compaction, including project overrides and quota-recovery guards, remain wired into V2.
  Multiwork and replaced usage/sync components remain intentionally retired/superseded.
- Analytics/OTLP exports remain disabled, including the new endpoint probe; its settings
  section states that policy. Provider network/update and keychain behavior retain opt-in
  gates. Restored orphaned settle-worktree and settled-thread expiry settings to the cleanup
  service; expiry uses normal deletion with dispatch-time changed/pinned/busy/session guards.
  Upstream cleanup reports and retention choices are integrated, defaulting to keeping ignored
  files beyond `node_modules`; secondary repository selections continue to protect checkouts.
- Completed latest per-project provider enablement with the fork's Git/conflict controls and
  managed setup guard. Adapted account tools to `HostProcess.HomeDirectory` and transcript
  reader result metadata without dropping account/config-directory isolation. Conditional
  settled-thread deletion reads real active run states (including starting/waiting), retaining
  changed/pinned/session/background safeguards. Native Git tooltips use the shared tooltip
  components while keeping conflict actions and status colors.
- Validation: frozen-lockfile installation; 24 scoped typechecks passed (server/web/mobile/
  desktop, shared/contracts/client-runtime, nine provider and eight source-control packages).
  Changed-source lint covered 1,150 files; tooltip/drag utility compatibility errors were fixed
  and targeted rechecking passed (other warnings remain). Source/document whitespace checks
  exclude upstream dependency patches. No tests were added/run, app builds, runtime/UI checks,
  packaging, installed-app/live-data operations, process stops, push or PR.

## Auto-compaction waits for quota recovery and real results — 2026-10-09

- `IdleCompaction.ts` blocks eligibility after a root usage-limit failure on the active
  provider/account until a different completed root provider turn has delivered a completed
  assistant response or tool result after the failure and its reported reset time, when known.
  Reset clocks, reconnects, cancelled requests and synthetic completions cannot clear the block.
  Historical failures remain the durable evidence; no new poll, timer, setting or migration.
- Timeout age includes receipt of the current root's final assistant result. Actual execution
  completion order selects the latest run, so a previously queued command resumed later is
  judged by when it ran. Native background output still does not reset the allowed-background
  timer. Compact turns (including `/compact` with arguments) do not trigger another compaction.
- The existing dispatch-time eligibility check calls this same policy, preventing a scheduled
  compaction from bypassing a limit state that changed before dispatch. Global/project token
  and timeout settings, manual compaction and provider/account isolation remain intact.
- Validation: scoped server typecheck, targeted lint and a read-only SQLite EXPLAIN check of
  query syntax/index use. No tests were added/run, no database mutation, rebuild or restart.

## Automatically unlink finished pull requests — 2026-10-09

- The existing one-minute `PullRequestSyncReactor` sweep automatically unlinks merged/closed
  PRs two hours after the host's merge/close time, including on settled, nonarchived threads.
  No extra polling loop or agent action is required; overdue links are handled after startup.
- Refreshes an expired candidate's host summary before removal so a reopened PR remains linked.
  Host failures/rate limits postpone cleanup. Stack lookup failures do not block confirmed
  terminal-link cleanup. Providers without merge/close timestamps use a persisted first-seen
  terminal timestamp (`ThreadPullRequestSnapshot.terminalObservedAt`), independent of later
  metadata refreshes. Reopening clears that fallback; another close starts a new period.
- The ordinary unlink command gains an optional `ifClosedBefore` guard, checked against the
  current stored snapshot at dispatch. Automatic removals keep a hidden dismissal marker and
  stop PR watches, preventing stack discovery from re-adding finished PRs. Ordinary explicit
  unlink behavior and other linked/open PRs remain unchanged. PRs themselves are not deleted.
- SQLite and memory projection queries include legacy single links, while an explicit empty
  canonical link array continues to mean unlinked. No schema migration is required; the new
  snapshot field is optional JSON metadata.
- Source paths: `PullRequestSyncReactor.ts`, `Orchestrator.ts`, `ProjectionStore.ts`, shared
  `threadPullRequests.ts`, contracts `threadPullRequest.ts`/`orchestrationV2.ts` and the linked
  reviews section of `docs/user/source-control.md`.
- Validation: scoped server/web/mobile/contracts/shared/client-runtime typechecks and targeted
  lint. No tests were added/run, no live database editing, rebuild, reinstall or restart.

## Daily upstream integration — 2026-10-09

- Merge target: `64972461c0` (67 new upstream commits, including the eight after the
  saved daily integration target `a6698271a4`);
  fork parent: `1bc735280b54411505861451119521a95d83a1e9`. Preserves both ancestries
  with a real merge, including upstream provider-package extraction, Pi session-tree rollback,
  model compatibility hints, native prompt prefill, preview profiles and layout fixes.
- Adapted fork-only usage, workspace and MCP imports to the new `provider-core`/shared
  modules. Managed providers use upstream's `ProviderHost` demand/settings service while
  retaining the explicit auto-refresh opt-in. Removed the obsolete `settings.providers`
  shape; `serverSettings.ts` still migrates legacy saved provider configuration into instances,
  preserving Claude HOME/config-directory isolation and explicit enabled choices. Provider
  version/manifest checks, external analytics/OTLP, updates and safe-storage network defaults
  remain disabled unless explicitly enabled where supported.
- Kept the mounted native Files tree, selection/delete/undo, persisted expansion and four
  concurrent initial directory reads. Integrated upstream Open/reveal/Open with actions,
  initial-load folder spinners and draft media previews without replacing the multi-repository
  layout. Restored the documented staged/unstaged file colors and expand-all control to the
  native renderer, which had lost them before this merge. Status refresh follows the active
  tree's existing invalidations. `FileBrowserPanel.tsx`, `NativeProjectFileTree.tsx`.
- Media previews use the exact selected checkout root for established chats as well as drafts;
  retained host/absolute previews, revision caching, dirty-editor protection and selected-panel
  freshness checks. Markdown keeps fork ownership/root/extensionless routing while adopting
  upstream inline repository-qualified paths. Root links still open the explorer. Existing
  upstream preview expectations were reconciled with exact-root behavior; no new tests added.
  `FilePreviewPanel.tsx`, `filePreviewMode.ts`, `markdown-links.ts`.
- Traced live callers for saved-color Arcane send/resume/queue/steer and both Stop paths;
  Classic remains selectable. Kept ordinary sending without compact-first proposals,
  mobile expansion for existing chats and draft heroes, keyboard/safe-area handling,
  scroll recovery/bottom following, first assistant text outside folds, mixed-work labels and
  stable imported-thread identities. Upstream banner/canvas padding still follows custom
  chat width. `ComposerPrimaryActions.tsx`, `ChatComposer.tsx`, `ChatView.tsx`,
  `MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`, `ChatCanvas.tsx`.
- Preserved mounted project rail/status dots and colors, picker/ordering/shortcuts, Files
  per-repository selectors/collapse/resize, Git history/Structure/Commit navigation, native V2
  session resume, primary preparation-run-only checkout binding/clearing, Claude worker effort
  observation, account/source-specific usage and limit rows, project memory/MCP, project idle
  compaction overrides and terminal-worker question cleanup. Upstream pooled Current/Trends
  limits and V2 sync replace their older components intentionally; Multiwork remains retired.
- Completed the new `ModelCatalog`, `ProviderLatestVersions`, `ProviderEventLoggers` and
  `McpProviderSessions` integrations. Workspace session guards read the shared service and
  reject replaced provider credentials. The latest-version service layer gates every provider's
  remote lookup, including Muse release-channel requests, behind the existing default-off
  `T3CODE_ENABLE_PROVIDER_VERSION_CHECKS` setting. Constructor/type fixture updates preserve
  account isolation, stale-session rejection and observed worker effort assertions.
- Validation: frozen-lockfile installation; 16 scoped typechecks (server, web, desktop,
  mobile, contracts, shared, client-runtime, and all nine provider packages) passed. Changed
  source lint covered 688 files; its sole new native-tooltip error was fixed and targeted
  rechecking passed (other warnings remain). Source/document whitespace checks exclude
  upstream dependency patch files. Tests, app builds, runtime/UI verification, packaging,
  reinstall, restart and push were not performed.

## Repair pre-existing worker questions during startup — 2026-10-08

- The terminal-event fix did not migrate message questions left by the previous running
  binary. Two more completed workers created stale requests before that fix was installed;
  restart recovery previously preserved all message-mode requests indiscriminately.
- `ProviderRuntimeRecoveryService.ts` now expires pending message-mode user-input requests
  only when the owning thread is a subagent and its owning run is terminal. Cancels the
  associated node/card, preserves ordinary chat questions, and performs no second write on
  repeated reconciliation. It does not treat a live worker's question as stale.
- `ProjectionStore.ts` recovery reads retain pending request nodes/cards and their owning
  runs even when an owner is older than the latest run or its node is already terminal.
  These are bounded reads through the pending-request index, without polling.
- Validation: 72 recovery/projection/ingestion tests passed, including real SQLite reads
  for a question owned by an older rolled-back run, restart idempotence and primary question
  preservation; server typecheck and targeted lint passed (one test-fixture warning).
  Cleared the two confirmed stale poly/games requests through live dismissal commands;
  no direct SQLite editing, no model turn launched, temporary auth revoked.

## Upstream integration and ordinary sending — 2026-10-08

- Merged 82 upstream commits through `de72286ee5` from fork parent `67c1d5a9dc`.
  Added current-thread/diff search, richer Markdown composition, terminal navigation,
  native Muse provider, usage filtering/loading improvements and upstream mobile/server fixes.
- Explicit owner preference: remove **all compact-before-send proposals** from the composer.
  Removed the wide button and upstream replacement chip, their token/history toggle plumbing,
  and automatic `/compact` dispatch/queueing before a send (`ComposerPrimaryActions.tsx`,
  `ChatComposer.tsx`, `ChatView.tsx`). Send/Resume/Queue/Steer use the ordinary saved-color orb
  or Classic controls. Manual compaction and separately configured idle compaction remain.
  Future upstream merges must preserve this behavior; never silently restore the button,
  chip, default compact-first action, or compaction merely because a session is old.
- Kept file-root/absolute-path resolution, read-only external previews, content-revision
  caching and selected/open-panel 10-second metadata checks. Kept per-repository worktree
  selectors, directory colors/guidance, Files resize/collapse state and Git history navigation.
  Added diff search reveal to the fork's selected-file viewer rather than replacing its layout.
  Shared path helpers coexist with the fork's multi-root Markdown routing.
- Preserved mobile expansion/short placeholder, saved-color send/stop orbs, project rail
  vertical status dots, ISO shortcuts, chat width settings, restore-to-latest/bottom following
  and first assistant text outside folds. Integrated thread find without replacing these.
- Usage keeps per-instance/source labels and colored model/account rows, hourly chronological
  periods and Current/Trends limits while adopting provider filters and progressive loading.
  Transcript scanning retains account identity when extracting upstream's reusable scan helper.
  Existing migration IDs remain unchanged; new snapshot indexes register as migration 65.
- Retained zero external analytics/OTLP export and network opt-in gates, spilshchikov naming,
  project memory, timed compaction/settings, safe workspace handoffs and the completed-worker
  question cleanup from `67c1d5a9dc`. Multiwork remains retired.
- Validation: frozen dependency installation; seven scoped typechecks; changed-source lint
  (460 files, no errors, warnings remain); two targeted regression batches (388 and 254
  passing tests, one overlapping composer file), including an explicit no-compaction-control
  regression. Source/document whitespace checks exclude upstream dependency patches, whose
  whitespace is retained verbatim for patch integrity. No rebuild, reinstall, restart or push.

## Terminal delegated-worker questions — 2026-10-07

- Terminal provider turns clear message-mode user-input requests belonging to subagent
  threads, alongside native questions. Ordinary chats keep message-mode questions after
  a turn ends so users can answer later. SQLite and in-memory/replay projection stores
  use the same rule (`ProjectionStore.ts`).
- The event sink's transaction guard permits those delegated-worker cancellations while
  still preserving answers committed after cleanup normalization (`EventSink.ts`).
- Validation: 49 focused ingestion/projection tests passed, including completed,
  interrupted, failed, cancelled and control terminal paths for ordinary/subagent threads;
  targeted lint and server typecheck. No rebuild or restart performed.
- Cleared four confirmed stale requests from completed poly/games workers through the
  running app's `thread.user-input.dismiss` command. The app persisted normal request,
  node and timeline updates and broadcast them to clients; historical records remain.
  Read-only verification found no pending requests in unarchived, undeleted threads.
  The temporary cleanup auth session was revoked. Permanent prevention requires the next
  app update; the current running binary was left untouched.

## Upstream follow-up integration — 2026-10-07

- Merged five additional upstream commits through `0678e4e23d8675ef88f9ac08e1ae90cfe7d6ef2e`
  from fork parent `a4d289101c`. Preserved fork ancestry, disabled tracking, composer/orbs,
  scrolling, Files freshness/root handling, workspace tools, compaction and project settings.
- Combined overlapping Haiku additions into one model entry, adopting upstream's CLI
  minimum `2.1.293` and ultrathink prompt injection while retaining the fork's thinking toggle
  and medium effort default. Adopted upstream fixed 1M context for Claude 5 profiles;
  existing 5.0 model IDs remain accessible as legacy. Kept GPT-6.1 Sol support.
- Integrated desktop CLI installation/settings and installed-launcher setup commands,
  plus Duo hinge/fold/orientation improvements. The CLI shim stays local; it does not
  enable telemetry, update checking or analytics.
- Validation: four scoped typechecks (server/web/desktop/client-runtime), changed-source
  lint and `git diff --check`. 85 targeted model/CLI/Duo regression tests passed with canonical
  macOS temporary directory (`TMPDIR=/private/tmp`) to avoid `/var` symlink expectation
  mismatches. Packaging/reinstall/restart requested separately after this merge.

## Daily upstream integration — 2026-10-07

- Merge target: `f570bd21663f56ce94c41829d3b7d72886e25a34` (82 upstream commits
  since `9bd1d8009a`); fork parent: `4bbe768de0aa28a71b7114b51e8583024d43c021`.
  Completed the saved daily integration through `611132c171`, then merged the latest
  upstream tip, preserving both fork and upstream ancestry.
- Integrated upstream filesystem/source-control/diagnostic grants with the fork's file editing,
  fetch/index/commit RPCs and multi-repository selectors. The file query retains selected-panel
  watcher/10-second metadata validation and dirty-editor protection, while honoring read grants
  and showing attempted-path errors (`projectFilesQueryState.ts`, `FilePreviewPanel.tsx`,
  `RpcAuthorization.ts`, `clientRpcPermissions.ts`). Adopted the new highlighted editor API;
  explicit environment/checkout/file `editStateKey` retains undo/redo history, with focus-aware
  shortcuts, review annotations, navigation, symbol links, and save coordination still mounted.
- Memory and workspace MCP toolkits now declare access through upstream `McpToolAccess` and
  its nominal registration layer. Thread/project isolation and capability checks remain;
  writing tools also require the live calling provider. Initial-preparation checkout binding
  and clearing keep their validated-run exception, while queued follow-ups and ordinary
  active/background work remain protected (`Orchestrator.ts`, `ThreadLaunchService.ts`,
  `ThreadWorkspaces.ts`, `mcp/toolkits/{memory,workspace}.ts`, `McpHttpServer.ts`).
- Live regression audit: `ComposerPrimaryActions` mounts `ComposerActionOrb` with saved send
  color for send/resume/queue/steer and the new compact-and-send action, and saved stop color
  for ordinary and pending-input Stop; Classic remains available. `ChatView` still forces
  mobile composer expansion for existing chats and draft heroes, and scroll collapse stays
  disabled. Timeline recovery/bottom-following, first assistant text outside settled folds,
  mixed-work labels, and upstream imported-thread grouping remain in the live timeline.
- `ResumeSessionsSection` stays mounted and creates V2 native references; unknown imported
  model names fall back to the provider's advertised model. Root Markdown links still open
  the explorer. Per-project width, project rail/dots/accent/order/slots, per-root Files and
  worktree controls, collapse/resize state, and exact-root media/Markdown previews remain live.
  PR rows retain repository grouping and touch-accessible menus alongside upstream speed actions.
- Adopted reopened-tab shortcuts while moving the fork's ISO section-sign and non-Latin
  shortcut matching into upstream's shared matcher. Setup scripts retain their chosen working
  directories alongside upstream settle scripts. Claude worker effort hooks, separate
  account/model usage rows and collectors, privacy/network gates, project memory guidance,
  and the mounted automatic-compaction worker/settings/project overrides remain connected.
  Multiwork and older usage/sync components remain intentionally retired/superseded as recorded
  below. Welcome and telemetry guidance now describe the fork's disabled external analytics.
- Added Claude Haiku 5.5 to the shared model manifest: `claude-haiku-5-5`, the
  `haiku` alias, fixed 1M context, thinking toggle and low/medium/high/xhigh/max
  effort with medium default. Explicit Haiku 4.5 aliases remain available for old sessions.
  Verified against [Anthropic's model documentation](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
  and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).
  Actual catalog resolution of alias, API ID, context and effort passed; synthetic catalog
  tests stay independent of mutable model names. No provider turn or CLI update was performed.
- Kept existing fork migration IDs unchanged; new upstream MCP app context migration is
  registered as ID 64. Shared exports retain both `threadWorkspaces` and `mcpApp`.
  Added instrumentation labels for all fork RPCs. Bounded handler registration inference
  into two layers while retaining one complete wire protocol, authorization and instrumentation.
  Updated Files permission fixtures and workspace MCP test harnesses for returned tool failures;
  rejection and absence-of-mutation assertions remain intact. Removed stale Effect diagnostics
  suppressions made redundant by upstream's test configuration.
- Validation: frozen dependency installation; seven scoped typechecks (server, web, mobile,
  desktop, contracts, shared, client-runtime); changed-source lint (804 files, zero errors,
  existing warnings remain); `git diff --check`; final targeted regression run: 24 files,
  424 tests passed. Includes Files roots/cache/watch/grants, scrolling, keyboard shortcuts,
  project rail, scripts, model catalog/manifest, compaction, memory/privacy, workspace MCP,
  cleanup, usage collection and WebSocket instrumentation. Earlier migration compatibility,
  orb and worktree selector checks also passed. No app build, UI/browser verification,
  packaging, app restart/reinstall, live-userdata write, push or PR.

This file tracks intentional fork-local changes in `pilshchikov/t3code` that may differ from the
upstream `pingdotgg/t3code` repository. Keep it current when adding, removing, or changing
fork-specific behavior so future upstream syncs are easier to review.

## External file paths and lower-frequency validation, October 6

- Owner requested a 10-second fallback, restricted to the open right panel's selected file.
  Periodic validation now requires an active watch; non-panel file queries do not acquire a
  timer. `ChatView` already passes `rightPanelOpen && selectedSurface` into file activity.
  Hidden panels/tabs and dirty editors stop validation. Watcher/focus/open checks stay immediate.
- Explicit absolute Markdown/inline links retain their target instead of being reinterpreted as
  a configured directory alias. Rendered host Markdown resolves relative links from its real
  containing directory; call sites consistently distinguish that directory from the project root.
  File previews normalize parent-relative/file-URI references without rebasing another checkout
  into the active project (`markdown-links.ts`, `ChatMarkdown.tsx`, `filePath.ts`, `filePreviewMode.ts`).
- File watchers now use the same read-only path resolver as file reads, so external absolute files
  and other worktrees remain readable and refreshable. Acquire the watcher before emitting readiness
  to close the read/watch race (`WorkspaceFileSystem.ts`). Relative traversal and writes retain
  their containment rules; out-of-project previews remain read-only.
- Image/browser assets use their selected filesystem root, including secondary repositories, rather
  than the thread's primary checkout. Outside files use exact host-media assets. A changed disk
  revision renews inode-bound signed URLs after atomic replacements (`FilePreviewPanel.tsx`).
- Passed 156 focused tests across six files (14 selected asset cases; 22 unrelated asset cases skipped),
  server/web typechecks, and scoped lint with existing preview/React warnings. Validation covers
  closed/inactive polling, absolute/other-worktree/parent-relative/file-URI paths, directory alias
  collisions, external Markdown directories, real host-file reads/watches, and media access.
  No installed-app/browser verification, rebuild/reinstall/restart, push or manual live-userdata writes.

## File freshness recovery and fork integration audit, October 6

- Visible file previews validate their disk revision every 10 seconds as a fallback for missed
  filesystem events. Activation, focus, visibility restoration, watcher events and workspace
  mutations also validate. Unchanged text keeps its cached object and editor state; only changed
  disk revisions trigger full reads. Hidden tabs/windows do not poll, and pending local edits
  suspend checks; stale in-flight responses cannot overwrite a newly dirty or switched file.
  Open validation no longer depends on enabling a watcher (`projectFilesQueryState.ts`).
- Images/audio/video/PDF use metadata-only checks and watchers; asset URLs follow the file's disk
  revision instead of depending on an agent/VCS mutation. This avoids retransferring binary data
  merely to check freshness (`FilePreviewPanel.tsx`). Git diff invalidation keeps its own workspace
  mutation identity. Watcher-only freshness was not sufficient protection for an infinite cache.
- Regression coverage exercises the infinite cache policy, same-size external changes with no
  watcher event, unchanged-object retention, reactivation, dirty-editor protection, binary metadata,
  the actual environment query refresh pipeline, and real filesystem reads/atomic replacement.
  Passed 373 focused tests across 17 files, web/client-runtime typechecks and scoped lint (existing
  preview React/style warnings). No installed-app/browser/device verification, rebuild, reinstall,
  restart, push, or manual live-userdata changes.
- Audited live fork callers for orb style/colors, mobile expansion, scroll recovery/live following,
  custom chat width, project rail/status dots, per-repository Files selectors and collapse/resize
  storage, shortcuts and multi-root links, CLI resume, preparation busy guards, memory/workspace MCP,
  compaction/current-context usage, Claude worker effort, account usage, Never-default settlement,
  and disabled external telemetry. These remain connected. Future merges must preserve revision
  fallback checks as well as cache settings; mocked uncached query tests alone miss this failure mode.

## Background work remains visibly working, October 6

- Thread status and the shared Working-group classifier now include all pending background
  operations, including commands left running after the parent reply. Web/desktop and native
  mobile show Working rather than Completed or a muted Waiting state for pending commands,
  monitors, provider subagents, and PR-watch/background tasks. Clearing the roster releases
  the status. Approval/input and failure handling keep their priority.
- Project-rail running dots also inspect the pending roster directly, allowing running and
  input dots to coexist even in the same thread. Root run/session states, completion alerts,
  follow-up dispatch and idle-compaction eligibility are unchanged; display/grouping does not
  invent an active model turn (`Sidebar.logic.ts`, `threadListV2.ts`, `threadInbox.ts`,
  `sidebar/projectRail.logic.ts`).
- Passed 253 focused tests across four files, web/native-mobile typechecks, and scoped lint
  with existing warnings. No app rebuild/reinstall/restart or live-userdata changes.

## Owner branch and worktree naming, October 6

- Default generated branches and temporary worktree branches use `spilshchikov/<name>`;
  generated worktree folder names inherit the owner prefix. Automatic feature-branch fallbacks
  and local cross-repository PR branches use the same namespace. Bitbucket clone instructions
  use `spilshchikov-pr-<number>` instead of tool-branded directory names.
- Settings decode legacy `t3`/`t3code` prefixes into `spilshchikov`, including project overrides
  and patches, so an old stored default cannot restore branding. Retain advanced unbranded custom
  naming choices. Existing temporary branch forms remain recognizable for compatibility.
- Every agent turn's workspace guidance requests `spilshchikov/<task-name>` branches and
  `spilshchikov-<task-name>` worktree directories. Branch-name generation rejects tool branding
  in its prompt and replaces a branded leading namespace in its output. Updated web/native
  settings examples. No existing refs/checkouts or live settings are rewritten.
- Server/web typechecks and scoped lint passed. Focused naming/settings/PR tests passed;
  no app rebuild/reinstall/restart or push as part of this source change.

## Upstream refresh, October 6

- Merged all 11 additional upstream commits through `9bd1d8009a` from fork `beaf5ad903`.
  Includes stalled-run Stop recovery, OpenCode 2 MCP tools, composer notice/typing repairs,
  collision-safe screenshot IDs, versioned JetBrains app detection, clone URL argument safety,
  explicit Bitbucket repository validation, and packaging catalog resolution.
- Reviewed automatically merged Stop/projection and composer paths. Keep initial-workspace busy
  guards, timed compaction/current usage, orb colors/renderer, mobile expansion and disabled scroll
  collapse, conversation recovery, multi-repository Files state, and disabled analytics/network
  telemetry. New queued notices use upstream's attachment slot in the existing fork composer.
- Fixed newly added external-launcher tests still calling the pre-refactor `testLayer` name.
  Frozen-lockfile dependencies, server/web/desktop typechecks, and 117 focused tests across six files
  passed. Scoped lint has no errors (48 existing warnings in changed files); source whitespace passed.
  Owner requested packaged reinstall/restart after this source merge; installation is verified
  separately from these source checks. No push or manual live-userdata writes.

## Upstream sync and disabled external telemetry, October 6

- Merged all 137 upstream commits through `76d3c96fd5`, retaining fork ancestry at `63ba504c65`.
  Adopted Effect 4.0.1 and upstream service/layer naming without disconnecting fork services.
  Integrated worktree location settings, goals, inline HTML, private secret requests, webhook
  automations, PR polling improvements, and desktop connection recovery. Upstream reverted the
  separate compact-before-send behavior; the fork's timed automatic compaction remains intact,
  including the latest-native-context usage repair below.
- Kept the live orb buttons and saved colors, expanded mobile composer and viewport behavior,
  scroll recovery/live following, custom chat width, project rail/dots/colors, context menus,
  CLI resume, multi-repository Files/worktree controls and collapse/resize state, editor navigation,
  staged-only commit context, account-specific usage/limits, and exclusive Never-default settlement.
  Retained workspace preparation identities and busy guards while adding worktree location selection.
- Fork memory/workspace MCP tools now use upstream's nested thread invocation scope and explicitly
  reject callers without a thread credential. Keep account/session isolation and per-turn workspace,
  directory guidance, project memory, and Claude worker effort hooks through provider updates.
- Webhook migrations use fork IDs 62–63; existing released fork IDs remain stable. Genuine upstream
  V2 preview ledgers are detected separately and translated atomically into the fork ledger, including
  missing workspace compatibility, project-memory and usage-history additions. Import progress and
  rollback/retry survive; unknown histories fail without modifying the ledger.
- Preserved non-retaining Files reads with an explicit waiting-state wrapper after the Effect upgrade,
  while adopting upstream signal refresh only when a query is read (`client-runtime/state/runtime.ts`).
- Owner requested no internet tracking. Analytics is now an unconditional no-op with no identifier
  collection, PostHog client, buffering, delivery, or shutdown flush (`telemetry/AnalyticsService.ts`).
  Desktop remote log/span exporters are removed; server effective OTLP URLs are always unset; web
  client/relay tracing and native mobile tracing cannot install network exporters. Environment,
  persisted settings, and cloud build tokens cannot opt these production paths back in. Local
  diagnostic files/resource monitoring and intentional provider/Git/connection traffic remain.
  This supersedes opt-in external telemetry behavior; future merges must preserve these disabled
  paths. Existing update, provider/version/manifest refresh, and keychain gates also remain.
- Validation: frozen-lockfile install passed after reconciling the merged lockfile. Seven scoped
  typechecks passed (server, web, desktop, mobile, contracts, shared, client-runtime). Passed 570
  focused tests across 24 files, including configured-collector privacy checks, preview migrations,
  workspace launch/busy guards, MCP isolation, settlement, compaction, composer/scrolling, Files,
  and query refresh. Scoped lint covered 1,437 changed source files; its one fork test-loop error
  was repaired and edited files rechecked. Existing React/style and other warnings remain.
  No repo-wide checks, app builds, device/browser verification, reinstall/restart, push, or live
  userdata writes. Tracking changes require a new app install before affecting the running app.

## Idle compaction usage repair, October 6

- The server's idle-compaction sweep now reads the latest root provider-turn token usage for the
  active native session, matching the attempt's native identity and root node. The provider-thread
  context snapshot is only a fallback when no matching live measurement exists; it can be stale
  after normal turns and absent for Codex (`orchestration-v2/IdleCompaction.ts`).
- Preserve the independent five-second scheduler sweep, configured idle timeout/token threshold,
  project overrides, dispatch-time eligibility check, and suppression after a compact-only turn.
  Upstream's separate resume-banner compact-before-send behavior is unchanged; its trigger
  is independent of the configurable idle-compaction token threshold.
- Passed 12 focused idle-compaction/scheduler tests, including stale-small/missing snapshots,
  stale-large snapshots after compaction, native identity isolation, and repeat suppression for
  Claude/Codex. Server typecheck and scoped lint passed. No installed-app, settings, or live
  database writes; no rebuild/restart.

## Upstream sync, October 4

- Merged all 70 upstream commits through `4ee6bfd50ef4a089440d5c3662db2298da9cc50e`
  from fork base `2db0d268552127ce30c1faa0c257eb0267b3da43` with a real merge.
  Reviewed conflicts individually and automatically merged code at the fork's live call sites.
- Adopted upstream retryable workspace preparation while retaining the validated preparation-run
  identity for initial binding and cancellation cleanup (`ThreadLaunchService.ts`). Failed recorded
  checkouts remain available for retry; cleanup clears the binding only after removal succeeds.
  The orchestrator still rejects ordinary checkout changes during active sessions, background work,
  or pending input; queued follow-ups alone may wait behind the initial preparation.
- Kept the actual orb renderer mounted in `ComposerPrimaryActions.tsx`: saved send color covers
  send/resume/queue/steer, and saved stop color covers normal and pending-input Stop. Classic stays
  available alongside upstream's morphing queue/steer icons. Existing mobile chats and draft heroes
  keep the expanded composer, keyboard layout, and disabled scroll/focus collapse.
- Integrated upstream lazy tool-output loading, retry controls, and hover timing with the fork's
  first assistant text outside settled folds, mixed-work disclosure labels, scroll recovery/bottom
  following, and stable imported-thread grouping (`MessagesTimeline.tsx`, `ChatView.tsx`).
  `ResumeSessionsSection` remains mounted and creates V2 native-session references; project-root
  markdown links continue to open the explorer.
- Kept the project rail, status dots/colors, custom chat width, manual sidebar ordering, per-root
  Files/worktree selectors, and stored collapse/resize state. Diff and preview panes adopt upstream
  icon changes in their existing fork renderers (`AppSidebarLayout.tsx`, `DiffPanel.tsx`,
  `FilePreviewPanel.tsx`). File deletion still reads its undo snapshot via `readFileOnce`; upstream's
  store-ready scratch-project command coexists with it (`client-runtime/state/projectCommands.ts`).
- Integrated upstream model token shares into account-specific model rows rather than account
  totals (`shared/usageMerge.ts`). Native usage rows now include account identity in both their keys
  and labels (`UsageRouteScreen.tsx`); web model drilldowns, pooled limits/history, and per-account
  Claude probes remain connected. Claude worker effort hooks and account-isolated environments
  survive provider/tool-presentation updates.
- Adopted upstream temporary-index commit-message context without staging the real index. The
  fork's staged-only context remains read-only and separately reachable from the Commit panel
  (`GitVcsDriverCore.ts`, `GitManager.ts`).
- Preserved privacy/network defaults, project memory/workspace MCP services, automatic compaction
  and project overrides, and cleanup preferences. Settlement still defaults to Never with exclusive
  PR/inactivity policies and open-PR protection. Opted-in PR settlement now uses the latest
  user-authored message, so automatic wakes do not hold merged work open; upstream's background
  completion rules distinguish agent work from leftover commands (`ThreadSettlementService.ts`).
  Updated the affected user guidance. Multiwork remains intentionally retired; pooled usage and
  the V2 composer sync indicator remain the replacements for their legacy components.
- Manually completed the cancelled daily sync from its saved merge worktree after fetching and
  confirming that upstream main still points to the same revision.
- Validation: frozen-lockfile dependency installation passed. Contracts, shared, client-runtime,
  mobile, desktop, relay, web, and server scoped typechecks passed. Scoped lint
  passed for 271 changed source files with zero errors and 442 warnings (React dependency/ref and
  compiler rules, unused symbols, and styling among others). Effect style suggestions are also
  reported by typechecks. Source whitespace checks passed; `git diff --check` flags the unchanged
  upstream Alchemy patch context line at `patches/alchemy@2.0.0-beta.79.patch:68`, retained as patch
  syntax. No repo-wide validation was run.
  Passed 624 focused tests across 18 files covering composer/timeline behavior, Files selectors,
  menus, project rail, keybindings, workspace launch, settlement, compaction, cleanup, usage,
  and commit context/index operations (117 unrelated Git cases skipped). No tests were authored.
  No app builds, packaging,
  browser/device verification, dev servers, reinstall/restart, or installed-app/live-userdata writes.

## Fork regression audit, October 3

- Traced documented fork features through their live callers/settings/services after the V2
  migration and latest upstream merge. File presence alone missed regressions; the repairs below
  supersede the earlier preservation claims where those paths were disconnected.
- Mobile web/desktop composer stays expanded in existing conversations as well as new chats.
  `ChatView.tsx` now passes `forceExpandedOnMobile` on every chat, so scrolling or keyboard blur
  cannot hide the prompt and footer. The fork's disabled desktop wheel-collapse remains in place.
- Restored the first assistant message outside settled-turn folds, mixed activity's visible latest
  status and expandable earlier entries, and the missing disclosure labels
  (`MessagesTimeline.logic.ts`, `MessagesTimeline.tsx`). Kept upstream's stable imported-V1 fold
  identities, initiating-prompt timing, persistent resource cards, and failed-tool expansion.
- Project-root markdown links again resolve to `.` and open the explorer; multi-root ownership and
  external paths retain their existing handling (`markdown-links.ts`).
- Restored the scoped project sidebar's **Resume from CLI** section. Selection now creates a V2
  thread with a strong native session reference before navigating, preserving the Claude/Codex
  provider instance and discovered model. Unknown models use that instance's advertised default;
  runtime permissions honor project settings. This replaces the disconnected V1 draft seed path
  (`ResumeSessionsSection.tsx`, `Sidebar.tsx`, client-runtime `operations/commands.ts`). Discovery
  still scans only when the section is expanded; other environments use their own server.
- Fixed the primary-checkout busy guard blocking initial worktree launches and cancellation cleanup.
  `ThreadLaunchService.ts` identifies its preparation run; `Orchestrator.ts` accepts that identity
  only while the initial run is preparing, all other runs are queued, no provider session exists,
  and no question/background work is pending. Stale preparation is rejected under the dispatch
  lock. Ordinary workspace changes retain the busy guard; explicit handoff stays separate.
  The optional command field is in `contracts/orchestrationV2.ts`.
- Checked live paths for orb style/colors, custom chat width, project rail/dots/colors, context
  menus, sidebar order migration, scroll recovery/live following, per-repository worktrees and
  Files collapse/resize/refresh, editor navigation/history/changes, workspace and memory MCP tools,
  compaction overrides, Claude worker effort, account limits/history, settlement, and privacy gates.
  Multiwork remains intentionally retired. Pooled usage and the V2 composer sync indicator remain
  their current replacements; unused legacy components are not features to restore.
- Updated stale test expectations for separate account/model usage rows, retained cleanup settings,
  and fork timeline presentation. Passed 1,231 focused tests across 46 files (including 86 selected
  Claude adapter cases); web, server, and client-runtime typechecks passed. Scoped lint has no errors,
  with existing React/style warnings. Daily merge instructions now explicitly cover these regressions.
  Validation is source/tests, not an installed-app or real-device visual pass. No rebuild, reinstall,
  restart, or live-userdata writes.

## Upstream sync, October 3

- Merged upstream main through `00eb8f6183` (57 commits since `a8927712f8`), including
  ordered run effects/release recovery, PR watches, model reporting, imported-chat scroll
  fixes, Mermaid diagrams, usage breakdowns/performance, and symlink-safe settings saves.
- Kept Claude worker effort hooks while adopting permission-mode reconciliation and actual
  model reporting. Child model and effective effort now update together under the child
  thread lock (`ClaudeAdapterV2.ts`, `ProviderEventIngestor.ts`).
- Combined faster transcript scans and token/speed cost details with per-account labels and
  aggregation. Model drilldowns retain account identity instead of opening the first account
  with the same model (`UsageService.ts`, `usageMerge.ts`, `UsagePage.ts`, `UsageModelDialog.tsx`).
- Kept repository-grouped thread PRs and totals while adding watch controls and MCP tools.
  Runtime instructions retain multi-repository linking guidance. Changes previews adopt the
  full branch-plus-working-tree comparison while retaining repository selectors, lazy files,
  the resizable tree, and file context menus (`ThreadPullRequestsPanel.tsx`, `DiffPanel.tsx`,
  `GitVcsDriverCore.ts`).
- Preserved automatic compaction settings/worker, primary-checkout busy guards, Files collapse
  and resize state, custom chat width, mobile keyboard/composer fixes, project rail/status
  dots/colors, conversation recovery/following, privacy gates, and exclusive settlement policy.
  Upstream's narrower workspace card and imported-thread grouping fix coexist with those paths.
- Validation: frozen lockfile install and server/web/mobile/desktop typechecks passed. Focused
  lint has no errors, with existing style/React warnings. No tests or app UI verification run
  during this merge. No app rebuild, reinstall, or restart. Recovery branch:
  `backup/pre-upstream-20261003`.
- Owner requested daily source merges at 09:00 America/Vancouver. The local macOS launch agent
  `com.pilshchikov.t3code-upstream-sync` prepares each merge in an isolated worktree, reads this
  record, and advances local main only if it is clean and unchanged. Pending work stays on its
  automation branch. Configuration and reports live in `~/.local/share/t3code-upstream-sync`.
  Scheduled runs never push, rebuild, reinstall, or restart; app updates require an explicit ask.

## Automatic context compaction, October 3

- Opt-in automatic compaction for Claude and Codex sessions with measured context usage.
  Dedicated **Automatic compaction** sections in General (web/desktop) and Maintenance
  (native mobile) expose enablement, timeout, token threshold, and whether background work
  may continue. Defaults: off, 5 minutes, 300,000 tokens, background work allowed.
  Each value supports a project override; the UI shows inheritance and overriding projects.
  Shared schemas/settings and environment MCP preference tools expose the same controls
  (`settings.ts`, `IdleCompactionSettings.tsx`, `IdleCompactionFields.tsx`).
- A scheduler compacts between completed parent turns. Native monitors, commands, and
  provider subagents may continue; unknown tasks, T3-managed delegations, active parent
  turns, queued messages, and questions block it. An unloaded provider with outstanding
  work is skipped. With background work enabled, the timer uses parent completion;
  otherwise it waits for all work to finish. Thread visits never reset it. Lifecycle filters,
  serialized dispatch rechecks, and deterministic receipts prevent invalid or repeated
  compaction (`IdleCompaction.ts`, `IdleCompactionWorker.ts`, `Orchestrator.ts`).
- Manual isolated CLI experiments: Claude Code 2.1.288 preserved a native Monitor,
  background Bash command, and background subagent through `/compact`, with events/results
  delivered afterward and unchanged process IDs. Codex 0.160.0 preserved an exec session
  and native subagent through parent `/compact`, then returned their successful results.
  These are provider experiments, not installed-app UI tests. No reinstall/restart.
- Validation: six real SQLite service tests cover background work, timing, settings
  overrides, and blocking states; 298 focused policy/settings tests passed across seven
  files. Server, web, mobile, and desktop typechecks and focused lint passed. Updated
  shared-key expectations and two stale worktree-cleanup expectations in settings tests.

## Upstream sync and repository worktrees, October 2

- Ordinary primary checkout changes are rejected while a turn, pending question,
  or background task is active, before creating a checkout or detaching the provider.
  This fixes `thread_workspace_create/select` terminating their own Claude caller
  and surfacing a generic event-stream error. Secondary repository selectors remain
  available during a turn. The orchestrator rechecks at dispatch, and the branch
  picker no longer sends a separate Stop before a metadata update. Explicit
  `t3_worktree_handoff` opts into a deliberate session handoff and retains its
  continuation behavior. MCP descriptions and per-turn workspace instructions
  explain the distinction (`ThreadWorkspaces.ts`, `Orchestrator.ts`,
  `WorktreeMcpService.ts`, `BranchToolbarBranchSelector.tsx`,
  `packages/shared/src/threadWorkspaces.ts`). Confirmed against two saved failures:
  both followed primary workspace creation and a `Workspace changed.` detach.
  Related upstream issue #14245 remains open. Server/web/mobile/desktop typechecks
  passed; no live reproduction or test runs. Source-only change; no reinstall or restart.

- Files repository collapse choices and tree height proportions are shared across
  file tabs and saved per environment/project, keyed by configured repository
  identity. Folder expansion is saved per checkout; inactive tabs do not reveal
  their selected file and reopen folders. Height splitters keep a full hit area,
  resize the next expanded repository across collapsed sections, and save weights
  on release (`FilePreviewPanel.tsx`, `FileBrowserPanel.tsx`, `NativeProjectFileTree.tsx`).

- Scroll restoration has an independent one-second recovery deadline, including
  fresh thread openings. Streamed row updates cannot restart the budget; a stalled
  virtualizer scroll falls back to the latest message without waiting for its
  promise. Live following also repairs unexpected jumps to zero; explicit user
  navigation still cancels recovery (`MessagesTimeline.tsx`).
- Right-panel maximize buttons and global shortcuts share the same store state.
  Shift+§ matches the settings recorder's canonical binding as well as literal ±,
  including text-input fallback; held shortcut keys are consumed without inserting
  characters (`ChatView.tsx`, `RightPanelShortcuts.tsx`, `keybindings.ts`).

- Restored upstream's `.chat-content-lane` width rule after the merge so messages
  respect the Comfortable/Wide/Full appearance setting alongside the composer
  (`apps/web/src/index.css`). Added Custom chat width in pixels (320–3840),
  persisted per client alongside the presets, with reset controls. Messages and
  composer share the maximum and still fit smaller screens.
- Integrated upstream v2 orchestration, including PR #2829 (`de34391427`), and
  main through `a8927712f8`. Also includes fixes for idle shell project reloads,
  Claude model changes while background agents run, Codex API-key startup warnings,
  steering retaining the newest next-turn model/effort selection, and the Pi/ACP
  Registry settings badge correction and tokenless Codex auth parsing.
- Ported fork project roots, scripts/working directories, workspace and memory MCP,
  per-account limit polling/history, private network defaults, exclusive settlement
  modes, and safe settled-worktree retention onto the v2 services. Existing migration
  ids remain intact; v2 migrations use 59–60 and additive compatibility repair uses 61.
- Files has a separate checkout/branch selector for every configured repository on
  web/desktop and native mobile. Secondary selections persist in v2 thread metadata
  and both shell/detail projections, so switching one never overwrites another.
  Git History follows those selections too. Open text editor tabs retain their draft
  state when another panel is active. Existing project colors, rail status dots,
  mobile composer layout, and conversation scroll anchoring remain fork behavior.
- Agents can inspect/create/select a repository checkout with
  `thread_workspace_inspect`, `thread_workspace_create`, and `thread_workspace_select`.
  Tools are scoped to the invoking session/thread and reject stale sessions or
  conflicting selection updates. Every turn receives selected repository identities,
  absolute checkouts/branches, private directory guidance, project memory guidance,
  and instructions to update the Files selection before editing.
- **Multiwork retired at the owner's request.** New isolated work uses Git worktrees.
  Removed clone choices and creation/list RPCs; saved Multiwork defaults and drafts
  decode to worktree mode. Existing selected clone paths and on-disk directories are
  kept. Legacy clone implementation is dormant; no cleanup or conversion runs on it.
  This supersedes the historical Multiwork section below.
- Claude worker effort hooks now feed v2 subagents and their child threads' own model
  selections. A worker's unknown effort is not copied from the parent. Upstream v2
  represents subagents as child conversations instead of the old Agents panel.
- Validation includes focused server/MCP, migration/restart, provider/effort, Files
  controls, drafts, rail, viewport/scroll, native Files, and contract tests. Migration
  tests use temporary databases. Server/web/mobile/desktop TypeScript checks pass. The installed application and live userdata are untouched.
- Recovery: `backup/pre-upstream-20261002` and the preserved multi-repository WIP stash.

## Claude subagent effort reflects the worker runtime

- The Agents panel receives effort from Claude's `PreToolUse` and `SubagentStop` SDK
  hooks, which report the level actually applied inside each worker. Agent definition
  overrides, environment overrides and model-specific downgrades therefore come from
  Claude itself. T3 no longer substitutes the parent session's effort for an unknown
  worker effort; the label is omitted until Claude reports it.
- Buffer hook values that arrive before `task_started`, and emit metadata-only
  `task.updated` events when effort changes. Repeated levels emit no additional updates;
  progress text, token usage and task status remain intact across web and native mobile.
- Source (before v2): `apps/server/src/provider/Layers/ClaudeAdapter.ts`. Focused adapter/catalog and
  shared subagent-state tests pass (194 tests), and the server typecheck passes. A real
  Claude Code 2.1.285 run against an isolated local simulated API confirmed parent requests
  at medium, a file-defined Sonnet worker at high, and matching hook agent/task ids.
- This source change does not rewrite old recorded labels. Existing provider processes
  need a fresh session launch to receive the hooks. The app was not rebuilt or restarted.

## Upstream sync, September 29

- Merged upstream `main` through `5e83e99c95` (two commits), adding managed ChatGPT
  authentication for Codex and updating the current-model manifest to `gpt-6.1-sol`.
  Model choices and reasoning options still come from the account/provider catalog.
- Preserved the project rail and simultaneous status dots, conversation position recovery and
  live following, per-account usage/history collection, existing Codex home and shadow-home
  setup, and the opt-in gate for provider/version network checks.
- Combined upstream's Codex installation refresh with the fork's usage polling/history layers
  in `apps/server/src/server.ts`; retained account display names in
  `apps/server/src/usage/UsageService.ts` and chat controls in
  `apps/web/src/components/ChatView.tsx`.
- Updated multiwork test expectations to include first-send and setup activity events; enabled
  the fork's explicit network-check opt-in in the new manifest freshness regression test.
- Validation: web/server typechecks and focused web, provider, authentication, usage, manifest,
  and server router tests. The pre-sync fork is retained at `backup/pre-upstream-20260929`.
  The installed desktop app was not rebuilt or restarted.

## Upstream sync, September 28

- Merged upstream `main` through `d2c9281b81` (83 commits), including Claude Sonnet 5.5,
  queued sends for background threads, chat width settings, Bitbucket credential settings,
  provider interruption fixes, and lower server/client memory and idle work.
- Preserved the project rail, simultaneous status dots, conversation position recovery and
  live following, orb composer controls, project slots, privacy defaults, and worktree cleanup.
- Reconciled upstream Usage shortcuts with the fork's project and structure shortcuts. Usage
  period keys win on the Usage page; the structure shortcut still works elsewhere. Settings
  lists all Usage commands in a consistent order, including the fork's `usage.open` command.
- Kept automatic settlement's exclusive modes and default **Never** while adopting upstream's
  narrower database reads. Regression coverage compares full and unsettled reads under both
  inactivity and change-request policies.
- Accepted upstream's offline-server banner correction while retaining the fork's persistent
  version-banner dismissal. Preserved local browser test dependencies alongside upstream jsdom.
- Validation: focused web, provider, settlement, and projection tests plus web/server typechecks.
  Storage cleanup tests use `TMPDIR=/private/tmp` on macOS so their fixtures are real paths,
  matching the cleanup service's deliberate refusal to traverse symlinks.
- The pre-sync fork is retained at `backup/pre-upstream-20260928`; the preceding UI fixes are
  recorded separately in `01516b62ee`. The installed desktop app was not rebuilt or restarted.

## Project rail beside the sidebar

- A column of project icons sits left of the sidebar on desktop, so switching project is one click
  instead of opening the picker first. Each icon is the project's own icon (`ProjectFavicon`, the
  same component the sidebar rows use), with the project name in a tooltip, the current scope
  marked, and an "All projects" entry at the top. Independent dots show running work, green for
  unread completions, and purple for pending input or approval. All three can coexist across
  threads in a project; completion dots clear using the same visit history as thread rows.
  Status dots stack vertically along the right side of each project icon.
- The fixed sidebar toggle is offset by the rail width, including in fullscreen, so it no longer
  overlaps the "All projects" button.
- The rail and the thread sidebar are shown together. Upstream's sidebar panel is `position: fixed`
  at `left: 0`, which covered the rail until the sidebar was collapsed; the panel now starts at
  `--project-rail-width`, which the layout sets to the rail's width while it is visible and to zero
  otherwise. Collapsing the sidebar still hides only the sidebar, leaving the rail in place.
- The rail has its own show and hide buttons, separate from the sidebar toggle: hide from the
  button at the rail's foot, show from a `PanelLeftOpen` button that appears in the sidebar header
  while it is hidden. The choice is remembered per install under
  `t3code:sidebar:project-rail-visible`. Never rendered on mobile, where the sidebar is a sheet.
- On macOS the traffic lights sit over the rail's top, so the first project starts below them
  (`--project-rail-top-inset`, set only for a non-fullscreen desktop window).
- The rail carries `data-app-sidebar`, so it reads the same surface, row and border tokens the
  thread sidebar does instead of the raised card colour, and both columns are one black. Each icon
  sits in a fixed, clipped box so a wide favicon cannot spill onto its neighbours, and the focus
  ring is inset rather than offset, which in a column this narrow would draw on the next project.
- The rail holds the manual project order whatever the sidebar's sort is set to, so an icon keeps
  its place instead of moving as work happens, and dragging one reorders it. Reordering writes the
  same `projectOrder` the sidebar's manual sort reads, through `reorderProjects`. A 4px drag
  threshold keeps a plain click selecting the project.
- Clicking a project sets the sidebar's project scope, the same state the picker writes, so the
  rail and the picker can never disagree. From a settings route it also returns to the thread list.
- The sidebar's logical-project chain (order, grouping, sort) moved into `useSidebarProjectGroups`
  so the rail and the sidebar read one source instead of two copies.
- The project icon picker's default grid grew from 24 to 98 icons; searching still reaches every
  Lucide icon.
- Sources: `apps/web/src/components/sidebar/ProjectRail.tsx`,
  `apps/web/src/components/sidebar/projectRail.logic.ts`,
  `apps/web/src/components/sidebar/useSidebarProjectGroups.ts`,
  `apps/web/src/components/sidebar/projectRailVisibility.ts`,
  `apps/web/src/components/sidebar/SidebarThreadHeader.tsx`,
  `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/projectIconOptions.ts`.
- Validation: web typechecks and the full web suite passes (5,569 tests), including a focused test
  for which projects earn a dot.

## Mobile composer placeholder

- The web composer's normal prompt placeholder reads "Ask anything…" below the `sm`
  breakpoint, including new drafts before a provider session connects and the desktop app at
  narrow widths. This avoids wrapping hints over the composer controls.
- Mobile composer body and toolbar padding is reduced. The fixed mobile app root follows both
  the visual viewport's height and its top offset on resize and scroll; the chat panel inherits
  that height instead of retaining `100svh` when the keyboard opens. Fixed toolbar controls
  share the root's position. The root includes top safe-area padding inside its height;
  keyboard-covered viewports omit the extra bottom safe-area spacer.
- Caret placement scrolls only the prompt editor, preventing ProseMirror from moving the page
  or conversation as it walks outer scroll containers.
- Sources: `apps/web/src/components/chat/ChatComposer.tsx`,
  `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/components/ComposerPromptEditorTiptap.tsx`,
  `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/mobileViewport.ts`,
  `apps/web/src/index.css`.
- Validation: web typecheck, 133 focused unit tests, and an isolated full-app WebKit pass with
  iPhone dimensions and simulated keyboard resize/pan. Existing and new chats preserve visible
  typing, repeated keyboard focus, long-prompt scrolling, and keyboard dismissal. The previous
  packaged frontend reproduces an editor below the simulated visible viewport. This covers
  browser layout; a physical iPhone keyboard has not been verified.

## Conversation position and live following

- Thread switches start with fresh virtualizer measurements and restore the saved row and offset.
  A missing row or a restoration that cannot settle falls back to the latest message.
- Remember the follow mode while streaming, so a temporary gap before a layout correction does
  not reopen the thread in history. Layout corrections do not count as manual upward scrolling.
- Scrolling upward pauses following. Returning to the bottom re-enables it even when the viewport
  never left the near-bottom band; a downward wheel at the bottom also resumes following.
- Sources: `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/components/chat/MessagesTimeline.tsx`.
- Validation: focused rail and timeline unit tests, web typecheck, and targeted lint. No desktop
  build or interactive client verification was performed for this change.

## Arcane orb composer buttons

- October 3 repair: restored the live `ComposerPrimaryActions` connection to
  `ComposerActionOrb` and the three saved appearance settings after the orchestrator merge
  dropped that wiring. Send/resume/queue/steer and both ordinary/pending-input Stop paths
  use the original shader and chosen colors. Classic style keeps upstream artwork behavior.
  Check the actual mounted button paths during future merges; retaining renderer files and
  settings alone does not preserve the feature. Web typecheck and focused lint passed;
  no runtime/UI tests, rebuild, reinstall, or restart in this repair.

- The composer's send and stop buttons are lit glass spheres with plasma churning inside, drawn by
  a small WebGL fragment shader (domain-warped fbm, two depth layers, fresnel rim and meniscus).
  Appearance settings choose between `Arcane orb` and upstream's `Classic` button, and set the
  accent each orb burns with from a preset row or a colour picker.
- All mounted orbs share one animation loop capped at 30fps. The loop stops when the tab is hidden
  and when no orb is on screen, `prefers-reduced-motion` holds the cloud still, and a canvas
  without WebGL falls back to a static gradient.
- Client settings: `composerActionStyle` (default `orb`), `composerOrbSendColor`,
  `composerOrbStopColor`.
- Sources: `apps/web/src/components/chat/composerOrbRenderer.ts`,
  `apps/web/src/components/chat/ComposerActionOrb.tsx`,
  `apps/web/src/components/chat/ComposerPrimaryActions.tsx`,
  `apps/web/src/components/settings/SettingsPanels.tsx`, `packages/contracts/src/settings.ts`.

## Settled threads drop their worktrees, and expire

- `storageCleanup.worktreeOnSettle` (new, on by default here) removes a thread's worktree as soon
  as the thread settles. The branch, the commits and the conversation stay; the checkout goes. The
  sweep's existing guards still apply, so a dirty tree, an unexpected branch, ignored files beyond
  `node_modules`, a live terminal or a running session all cancel the removal, and a thread that
  leaves the settled list before the sweep finishes keeps its worktree.
- `storageCleanup.settledThreadAfterDays` (new, 14 by default) deletes a settled thread and
  everything stored for it that many days after it settled. Deletion goes through the ordinary
  `thread.delete` command, so sessions stop and attachments are removed exactly as a manual delete
  does. Pinned threads are never swept, nor are threads with a running turn, live session,
  background work or a pending approval. Archived threads are swept like active ones.
- Both rules are editable in Storage settings; the worktree rule is project-scopable like the other
  worktree rules, and a project's rules stored before this release read the settle rule as off.
- Sources: `packages/contracts/src/settings.ts`, `packages/shared/src/projectSettings.ts`,
  `packages/shared/src/serverSettings.ts`, `apps/server/src/storageCleanup.ts`,
  `apps/web/src/components/settings/StorageSettings.tsx`.
- Validation: `ThreadSettlementReactor.test.ts` covers the settle rule (removed, and retained when
  the rule is off) and the retention sweep (expired active and archived threads deleted; recent,
  pinned and running threads kept). Every package typechecks; web, contracts and shared suites
  pass. The storage-cleanup tests need a `TMPDIR` that is not a symlink on macOS
  (`TMPDIR=/private/tmp/... vp test run`), otherwise they fail on `realPath` comparisons.

## Upstream sync, September 25

- Merged 55 upstream commits through `7a12aff471`. The previous fork revision is retained as
  `backup/pre-upstream-sync-20260925` at `c692e67b5d`.
- Upstream's per-thread auto-settle lands whole: its menu items, its `setAutoSettle` action, and
  its migration, which runs as 58 here because the fork already used 54 for usage history. The
  fork's opt-in settlement mode still decides whether a settled thread leaves the inbox.
- `BranchToolbar` takes upstream's required `envMode` instead of the fork's optional override.
  Non-primary workspace rows pass their own root's default mode through the same prop, so the
  multi-directory strip behaves as before.
- Usage buckets carry the resolved transcript directory under both names: upstream's `sourcePath`
  and the fork's `sourceId`, which its per-account rows read. Scanners that report a directory
  without an account leave the fork's label and instance fields unset.
- Attached composer banners inset from the composer's edge again. Upstream declares
  `--chat-composer-drawer-inset` on a shell that wraps both the banner stack and the composer;
  this fork's glass host sits inside the composer, so a banner read no value, its width calc was
  invalid, and it stretched to the composer's full width with a mismatched corner. The variable
  now sits on `[data-chat-composer-stack="true"]`, the nearest element holding both.
- Validation: typecheck passes for every package. Web (5,567), mobile, desktop, contracts, shared
  and client-runtime tests pass.

## Usage limit trends read by day, with a crosshair

- The time axis marks every local midnight with a rule and a date label, so days are
  distinguishable at a glance. Ranges of a day or two add hour ticks; longer ranges thin the
  date labels to about eight across the plot.
- Hovering anywhere in the plot snaps a crosshair to the nearest measurement and shows its exact
  time and remaining percent. The old native `<title>` on a 1.5px dot was unreachable in practice.
- The measurements table groups rows under a heading per day and shows the time of day in each
  row, instead of repeating the full date on every row.
- Sources: `apps/web/src/components/usage/UsageLimitTrends.tsx`,
  `apps/web/src/components/usage/usageLimitHistoryAxis.ts`.

## A fixed, one-line composer on upstream's prompt box

- The prompt starts one line tall (`min-h-[1lh]` instead of upstream's `min-h-19.5`) and grows
  with its text. Upstream's composer is otherwise untouched.
- A timeline scroll never rests the composer: `canScrollCollapseComposer` is always false, so the
  height stays put. Upstream's gesture code and the Settings switch stay in place, always
  ineligible, so the next sync has nothing to reconstruct.
- Sources: `apps/web/src/components/ComposerPromptEditorTiptap.tsx`,
  `apps/web/src/components/chat/ChatComposer.tsx`.

## The app's own context menu everywhere

- `localApi.contextMenu.show` always renders the in-app menu, on desktop too. The native Electron
  menu is the operating system's look and drops the icons and section headers the items carry.
  `close` dismisses that menu on every surface.
- Context menus use the visible viewport height rather than a fixed 24rem/70vh cap, so all
  thread actions are visible together when they fit. Scrolling remains only for menus taller
  than the available screen. Colour choices display a small square in the actual palette tone.
- Sources: `apps/web/src/localApi.ts`, `apps/web/src/contextMenuFallback.ts`,
  `packages/contracts/src/ipc.ts`.

## The sidebar project picker keeps the height you drag it to

- The grip sits on the popup's bottom edge, under the slot hint. Dragging it resizes the whole
  popup between 120px and 720px of list, since upstream's 23rem popup cap is lifted to the space
  the positioner reports. A double click returns it to 288px, and the height is remembered per
  browser or desktop install under `t3code:sidebar:project-picker-height`.
- Source: `apps/web/src/components/Sidebar.tsx`.

## Upstream sync, September 24: the composer returns to upstream

- Merged 111 upstream commits through `f26ee083fe`. The previous fork revision is retained as
  `backup/pre-upstream-sync-20260924` at `a1a19ca69e`.
- The prompt box is upstream's again, by request. `ChatComposer`, both prompt editors, the banner
  stack, the stash badge and menu, the tasks badge, the command menu, the footer layout, the
  focus and multiline hooks, and `composerScrollGesture.ts` are taken from upstream as-is. The
  fork's compact layout, pen placeholder, one-line minimum height, inline stash chip, tasks
  drawer, and the removal of scroll resting are all gone.
- Scrolling a conversation rests the composer again, on by default, with upstream's
  **Collapse composer on scroll** switch back in Settings → General. `timelineOverflows` is
  passed to the composer again, and the composer's banner items keep the fork's `urgent`
  ordering flag through a local type in `ChatView.tsx`.
- Kept around the prompt box: the multi-directory workspace chips and the multiwork picker in
  `BranchToolbar*`, the fork's glass composer shell, and the project memory and script controls.
- Upstream now ships Claude Opus 5.5 in its own manifest with the same slug, badge, profile and
  minimum CLI version, so the fork's entry is dropped in favor of theirs. Upstream keeps Opus 5
  out of `currentModels`, which is their call, not a fork change.
- `mod+[` and `mod+]` stay on the fork's editor history. Upstream bound them to its new
  `navigation.back` and `navigation.forward`; those commands remain rebindable, without a
  default chord.
- Upstream's new `shadcn/no-restyle`, `no-arbitrary-values`, `no-raw-colors` and
  `require-static-classes` rules report as warnings for `apps/web/src/**` in this fork. The
  fork's own panels predate them and produce about 210 findings; leaving them as errors would
  bury the 15 that were already failing.
- Validation: typecheck passes for every package. Web (5,540), mobile (1,711), desktop,
  contracts, shared and client-runtime tests pass.

## Claude Opus 5.5 in the bundled model manifest (superseded by upstream, September 24)

- `claude-opus-5-5` is a current Claude model with a `new` badge, ahead of Claude Opus 5, which
  stays current rather than moving to legacy. Claude Code 2.1.280 is the minimum version: its
  baked-in catalog is where the slug, the 1M context window, and fast mode were confirmed.
- Its profile matches Opus 5 except that reasoning defaults to Medium, which is the model's own
  default. Thinking cannot be disabled on Opus 5.5, so effort is the only control.
- `updatedAt` moves forward so a disk cache written by an older manifest is dropped. This fork
  keeps remote manifest refreshes behind `T3CODE_ENABLE_PROVIDER_VERSION_CHECKS`, so the bundled
  file is what the app actually reads. Upstream has not added the model yet.
- Source: `apps/server/src/provider/model-manifest.json`.

## The desktop composer never rests on a timeline scroll (reverted, September 24)

- Scrolling a conversation no longer shrinks the prompt. The wheel and scroll-key gestures, their
  eligibility tracking, and `composerScrollGesture.ts` are removed, so nothing can set the
  desktop resting state. Successive attempts to make the shrink-and-restore tween behave still
  moved the prompt out from under the caret, and the reclaimed row was not worth it.
- `composerCollapseOnScroll` stays in the settings schema so stored values decode, but no client
  reads it and its Settings → General switch is gone. An inherited `true` cannot bring the
  behavior back.
- The phone's collapsed composer row is a separate path and still works. `timelineOverflows` is no
  longer passed to the composer, since only the scroll gesture consumed it.
- Sources: `apps/web/src/components/chat/ChatComposer.tsx`,
  `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`,
  `packages/contracts/src/settings.ts`.

## Composer text stability (reverted, September 24)

- Compact and expanded desktop composer layouts keep the same prompt line height and top inset;
  only the space beneath the prompt contracts. The prompt follows the surface resize without a
  second position animation. The Tiptap editor uses the same one-line minimum height and
  attributes at initialization and on updates.
- Icon-only placeholders resolve to a stable accessibility label, so unrelated chat activity does
  not reapply editor attributes and move the prompt text.
- The height transition no longer observes and retargets itself from body resize events during
  its tween.

## Upstream sync, September 21

- Merged 166 upstream commits through `1de563c149`, after saving the fork at
  `backup/pre-upstream-sync-20260921` (`5db36e9bf7`). This was a source merge only: no app
  install, restart, or push.
- Kept the fork's mobile and desktop composer layout, multi-directory and multiwork controls,
  project-slot shortcuts, multiple-PR panel, file/tree caches, separate Claude accounts,
  retained usage totals, project memory, agent workspace tools, and settled-worktree cleanup.
  Upstream's forced-new-worktree flow now disables previous-worktree and multiwork reuse.
- Adopted upstream's provider tooling, PR viewed-file tracking, text and diff improvements,
  sidebar undo actions, device-update UI, and Effect dependency update. Fork migration IDs
  through 56 remain stable; upstream's PR viewed-file migration runs as 57.
- Reconciled upstream's Claude home semantics with per-account configuration and the fork's
  transcript-history retention. Media previews check metadata only to recognize directories
  without transferring image or video bytes.
- Validation: contracts, shared, client-runtime, server, web, desktop, and mobile typechecks;
  focused migration, usage, multiwork, project-memory, PR, worktree-cleanup, file-cache,
  keyboard, and composer tests. Targeted lint completed with warnings only.

## Mobile web sidebar continuity and navigation

- `ChatView.tsx` always keeps the mobile composer expanded, including existing threads and after
  focus loss or sending. Its compact expanded layout stays directly editable without an extra tap;
  desktop scroll-to-collapse behavior is unchanged.
- The project scope survives drawer unmounts and reloads through `useSidebarProjectScope.ts`.
  The existing snapshot-readiness guard still prevents clearing an offline project's scope.
- `SidebarThreadHeader.tsx` and `Sidebar.tsx` put a labeled project picker below search, with
  48px mobile targets and 24px project icons (40px/20px on desktop).
- Active-thread dragging now writes server order keys, matching native mobile and other browsers.
  `useSidebarOrderMigration.ts` migrates legacy local arrangements with a persisted retry plan;
  existing server arrangements take precedence. Older servers retain local ordering.
- `AppSidebarLayout.tsx` installs mobile-only edge gestures from `ui/sidebarSwipe.ts`. Vertical
  scrolling, editing, browser-back edges, dialogs, and horizontally scrolling content are excluded.
- Validation: focused project-scope remount, swipe, order migration, and sidebar drag tests;
  web typecheck and targeted formatting/lint. These changes affect mobile web and desktop's shared
  frontend; native mobile already consumes server order keys.

## Upstream sync, September 17

- Merged 35 upstream commits through `6d1d549441`. The previous fork revision is retained as
  `backup/pre-upstream-sync-20260917` at `eaa02c1238`. Upstream added no migrations.
- The composer now uses upstream's Tiptap editor, with rich text on by default and a switch in
  Settings → General. The pen placeholder and one-line minimum height moved into
  `ComposerPromptEditorTiptap.tsx`, whose placeholder accepts an icon again.
- Review diffs use upstream's contract. `files` holds complete numstat counts, untracked files
  included, and a `file` request returns one file's patch with its rename source. The fork keeps
  two optional inputs for its overview request: `sourceKind` returns one source and
  `includePatch: false` skips patch bodies. The fork's `path` input, `patchOmitted` flag, and
  24-file untracked cap are gone. Sources: `packages/contracts/src/review.ts`,
  `apps/server/src/vcs/GitVcsDriverCore.ts`.
- `DiffPanel.tsx` keeps the fork's left file tree, one-file view, and directory picker. With the
  tree hidden, files load progressively through upstream's `useReviewFilePatches` instead of one
  patch capped at 120 KB. The header's file-tree toggle now drives that tree, and the separate
  reopen button is gone. The toggle previously controlled upstream's removed right-side tree.
- Approval prompts take upstream's layout. That restores provider-specific options, labels,
  warnings, and MCP app access details, which an earlier merge had replaced with four fixed
  buttons.
- Upstream's tooltips on the composer environment and workspace controls (#11787) are not
  merged. The fork's compact toolbar, multiwork selector, tasks drawer, and stash menu are unchanged.
- The timeline combines upstream's grouped thought and tool activity and remembered reading
  positions with the fork's work-log folding, first and terminal assistant messages, and inline
  turn plans. Settlement reacts to PR link, sync, and session-end events, still only when the
  fork's opt-in settlement mode is enabled.
- Adopted as upstream: the diff panel opens on the working tree, and diff files start collapsed
  when no preference is saved. Also adopted: checkpoint fsync, sparse-checkout, and placeholder
  fixes, the theme picker shortcuts `mod+alt+a` and `mod+alt+shift+a`, searchable keybindings,
  folder drops as path chips, and OpenCode Go, Cursor, and Grok limits.
- `docs/user/appearance.md` is upstream's page plus the fork's accent color and glass opacity
  sections. The previous merge had mixed Android text into the accent section.
- Validation: typecheck passes for every package. Web (5,288 tests), desktop, contracts,
  client-runtime, shared, and mobile review and thread tests pass. The full server suite has 32
  failures in 12 files, and every one also fails on `backup/pre-upstream-sync-20260917`:
  Antigravity provider timeouts, Codex and npm maintenance detection, Claude home terminal
  defaults, the multiwork bootstrap tests, and the SSH helper test. `vp check` still reports 15
  lint errors that predate this merge, all in fork files: native `title` tooltips and a
  restricted `GitMergeIcon` import.

## Upstream sync and queued follow-ups, September 16

- Merged 99 upstream commits through `052c7ae53e`, including client-side follow-up queues,
  Queue/Steer selection and send-shortcut controls, background worktree setup, project cloning,
  custom snoozes, native provider slash commands, project monograms, PR presentation updates,
  provider thinking traces, worktree checkout performance, and desktop/mobile reliability fixes.
- Preserved the fork's compact desktop and mobile-web composer, multi-directory chips, multiwork,
  project notes and agent workspace tools, multiple-PR overview, collapsible images, file/tree
  caches, stable colored usage accounts, limit-history polling, and macOS shortcut safeguards.
- Existing fork migration numbers remain stable. Upstream's thread-title-state migration is 56;
  tests use the fork's remapped migration boundaries so existing databases are never silently
  reinterpreted. OpenCode keeps fork skill content while applying upstream's bounded CLI output.
- Focused typechecks and regression tests cover queue/steer, keybindings, worktree setup,
  multiwork, project notes, settled-worktree cleanup, multiple PRs, file caches, usage history,
  migrations, and OpenCode inventory. This sync does not push, rebuild, reinstall, or restart.

## Active-provider limit trends, September 14

- Trend charts connect measurements (including quota resets), using dashed bridges across gaps,
  and group account cards under provider headings without merging Personal and Work histories.
- A server-owned scheduler requests fresh provider limits at the first active thread, about every
  30 seconds while busy, and when the last thread finishes. Concurrent threads share the account's
  polling clock and in-flight request; a finish during a probe queues one final check. Startup
  subscriptions are acquired before session seeding to avoid missing short turns.
- Provider snapshot updates are recorded immediately, with 30-second history buckets and a
  30-second 24-hour view. Idle collection and 90-day retention remain. Explicit Claude refreshes
  bypass its capability cache, and cached usage keeps its original measurement timestamp.

## File preview and directory cache, September 14

- Open text-file tabs retain their editor/Markdown surfaces while inactive or while the right
  panel is closed. Files tabs also retain expanded folders and scroll state. Closing a file tab
  releases its query snapshot; media/live pages stop when hidden. Closed panels are inert and
  relinquish native titlebar drag regions.
- Activation, window focus, watcher startup and file changes validate an opaque disk revision
  (device/inode, size, modification and change times). Metadata-only reads do not transfer file
  contents. Unchanged previews stay intact; changed files refresh in the background. Outstanding
  checks cannot discard a newer unsaved edit or refresh a retired tab.
- File trees use cached shallow directory listings with a one-minute idle TTL, refreshed in the
  background. Only the root and visible expanded directories are listed/watched; collapsed
  subtrees are not recursively scanned. Breadcrumb menus load individual directories on demand.
  Explicit file search remains bounded and server-side. Cached descendants cannot recreate a
  deleted parent, and recent-file navigation does not mistake unlisted subtrees for deleted files.

## Upstream sync and thread PR overview, September 14

- Merged 26 upstream commits through `01e05c1526`. The previous fork revision is retained as
  `backup/pre-upstream-sync-20260914` at `db9373c735`.
- Adopted upstream worktree setup progress and cancellation, response streaming settings,
  optional local desktop environment, and release archive runtime management. Upstream removed
  its compact sidebar experiment; the fork's thread ordering, accents, project shortcuts, and
  drag styling remain. Compact composers and the pen placeholder are unchanged.
- Multiwork setup reports clone preparation or reuse through the new progress stream. Cancelling
  setup closes its setup terminal but never sends a multiwork clone to Git worktree removal.
  Sources: `apps/server/src/ws.ts` and the bootstrap tests in `server.test.ts`.
- The existing right-panel Pull requests tab now groups all attached PRs by host and repository,
  preserves stack relationships, shows source and target branches, and summarizes open, merged,
  closed, unknown, and attention-needed PRs. Branch totals count names separately per repository.
  Unknown snapshots are not counted as open; overlapping failure signals count once per PR.
- Clicking a multi-PR badge opens the overview directly. Single PRs still open their detail view.
  Rows wrap in narrow panels and expose their action menu on touch screens. Unlinking uses the
  full repository identity, so identical PR numbers in different repositories remain separate.
  Sources: `components/pullRequest/ThreadPullRequestsPanel.tsx`, `threadPullRequestsOverview.ts`,
  and `components/ThreadStatusIndicators.tsx`. Applies to desktop, web, and mobile web; native
  mobile keeps upstream's existing PR interface and shares the unchanged attachment API.
- Validation covers five attached PRs across repositories, stacks, status aggregation, account
  ordering, project notes, MCP PR/workspace tools, setup progress, and scoped typechecks.
  This update does not reinstall or restart the running app.

## Upstream sync, September 13

- Merged 102 upstream commits through `c07575f573`. The fork checkpoint is `495b2e6c7a`,
  retained as `backup/pre-upstream-sync-20260913`.
- Kept compact desktop and mobile-web composers, the pen placeholder, opaque notices,
  directory chips, collapsible images, account colors and ordering, usage trends, project notes,
  agent workspace and PR tools, Git history, privacy defaults, and opt-in thread settlement.
- Upstream project-scoped settings now include the fork's settlement mode. Browser and device
  overrides use upstream resolution while MCP credentials retain memory and workspace access.
  Project action imports retain their configured working directory.
- Registered upstream message context as migration 55, after fork usage history at 54.
  Upgrade tests cover existing project notes and usage observations as well as an already-present
  context column. Sources: `apps/server/src/persistence/migrations.ts` and migration tests.
- Retained the fork file browser and multiwork roots in `components/files/FileBrowserPanel.tsx`
  and `FilePreviewPanel.tsx`. Integrated upstream attachment, audio, and table previews. File
  watches register before the initial ready event and include nested directories.
- Combined upstream rename and staged-deletion previews with bounded overview patches and lazy
  per-file loading in `apps/server/src/vcs/GitVcsDriverCore.ts`. Upstream context chips and
  streaming rendering coexist with the fork's one-line editor minimum and work-log folding.
- Usage scanning includes upstream account-home discovery and deduplication while retaining
  per-account labels and the fork's separate Claude process-home and config-directory settings.
  Large Codex sub-agent totals still include provider-reported cumulative cached input. This
  upstream revision does not establish a fix for those totals.
- Validation uses focused regression tests and scoped typechecks. No browser checks, live-data
  writes, app reinstall, restart, or push are part of this merge.

## Usage limit trends, September 13

- Usage → Limits → Trends shows separate, consistently ordered account charts with configured
  accents on desktop and mobile web. It supports 24h/7d/30d/90d ranges, measurement tables,
  multi-environment reads, and explicit gaps at resets or missing measurements.
- A server collector samples the existing provider and hub readings at startup and every five
  minutes. It keeps observation timestamps, skips failed probes, and stores bounded five-minute
  buckets in SQLite migration 54 (`usage_limit_history`). Rows expire after 90 days. Read-only
  authenticated RPC queries downsample long ranges and cap responses at 20,000 points.
- Sources: `usage/UsageLimitHistory.ts`, `usage/UsageLimitHistoryCollector.ts`,
  `components/usage/UsageLimitTrends.tsx`, and `packages/contracts/src/usageLimitHistory.ts`.
  Focused tests cover persistence, retention, sampling, identity, chart gaps, and account order.
  Native mobile has the shared RPC available but no trends screen yet.

## Minimal composer placeholder, September 13

- The web/desktop composer and mobile web layouts use a small pen icon instead of normal
  empty-input instructions, including the collapsed mobile row. Approval, project selection,
  connection, and question guidance remain available. The icon does not intercept editor clicks.
- Source: `apps/web/src/components/chat/ChatComposer.tsx`. Validation: web typecheck and focused
  composer editor tests.

## Settled worktree retention, September 13

- The server checks at startup and hourly for T3-managed Git worktrees whose owning threads
  have been settled without newer activity for at least seven days. It checks visible and
  archived threads, configured project directories, provider sessions, and terminal activity.
  Shared active checkouts, dirty or locked worktrees, standalone clones, and external paths
  are retained. Idle sessions and terminal tabs in an eligible checkout are closed.
- Cleanup uses `git worktree remove` without force, retaining branch refs, checkpoints, and
  conversation records. Existing resume behavior recreates the checkout from its saved branch.
  Multiwork clone cleanup is excluded. Sources: `orchestration/SettledWorktreeCleanup.ts` and
  its focused Git integration tests.

## Agent workspace selection, September 13

- Agent guidance names the existing PR link/list/unlink tools, including explicit detachment and
  multiple repositories per thread. Full URLs identify each repository in multi-directory
  projects; stack listings include ordered URLs as well as numbers. Regression coverage
  distinguishes identical PR numbers in different repositories.
- Internal MCP exposes `thread_workspace_inspect`, `thread_workspace_create`, and
  `thread_workspace_select`, scoped to the authenticated thread and its project. Agents can
  create worktrees or multiwork copies, select existing checkouts, or return to the project
  root through normal thread metadata events. No force checkout or removal tools are exposed.
- The first substantive message includes brief workspace guidance when these tools are available.
  It favors task worktrees for implementation while respecting project notes, existing task
  checkouts, and explicit user choices. Agents must use the returned cwd during the current turn;
  the provider restarts in the selected directory on its next turn. Mid-turn selections also
  redirect checkpoint capture and status refresh, with a baseline prepared before editing.
- Sources: `apps/server/src/mcp/toolkits/workspace.ts`, `McpProviderSession.ts`,
  `project/ThreadWorkspaceInstructions.ts`, `project/ProjectMemory.ts`, and the provider/checkpoint
  reactors. Server-side behavior applies across web, desktop, mobile, and remote connections.

## Composer notices, September 12

- The Files tree names its primary root after the project, rather than its generated checkout
  directory. Additional roots use configured labels when present; actual checkout paths remain
  visible beneath the names. Source: `apps/web/src/components/files/FilePreviewPanel.tsx`.

- Composer banners use opaque backgrounds so chat text cannot show through. The resume
  compaction reminder puts its title and token count inline, wrapping on narrow screens while
  keeping actions visible. Applies to web and desktop, including mobile web.
  Sources: `ComposerBannerStack.tsx`, `ChatView.tsx`, and `apps/web/src/index.css`.

## Automatic worktree base and project notes, September 11

- Mobile web uses one continuous composer frame with full-width controls, removing the inset
  lower outline and overlap. Ordinary placeholders are hidden in collapsed and expanded phone
  layouts; the collapsed input retains its tap target. Desktop drawer styling is unchanged.

- New-worktree sends no longer stop with "Select a base branch" when the refs query is still
  loading. The composer keeps an explicit branch choice, otherwise uses the current checkout and
  finally `HEAD`; the agent can start and read project context without an extra blocking prompt.
  Source: `apps/web/src/components/ChatView.tsx` and `BranchToolbar.logic.ts`.
- Project memories are named as project notes in the agent instructions and settings. They remain
  stored by `project_id`, are available to every thread in that project, and retain on-demand MCP
  reads so full note content is not copied into every prompt. Cross-thread persistence has a
  regression test.

## Upstream sync, September 10

- Merged 117 upstream commits through `57aee3e19f`. The pre-merge fork checkpoint is
  `7690b027b3`, also retained as `backup/pre-upstream-20260910`.
- Kept project memory, multiwork provisioning and selectors, compact mobile/composer layouts,
  directory chips, collapsible chat images, account colors and stable account ordering,
  per-account usage, Git history, privacy defaults, and opt-in automatic settlement.
- Integrated upstream device and pull-request MCP tools alongside memory. Memory list parameters
  use an object-only schema compatible with the updated Effect MCP server. Provider credentials
  retain thread/project isolation and explicit capability checks.
- Registered upstream's multi-PR migration as 53, after this fork's memory migration 52.
  Upgrade tests verify memory contents survive and legacy PR links are backfilled.
  Sources: `apps/server/src/persistence/migrations.ts` and migration tests.
- Multi-PR settlement uses upstream link snapshots with the fork's settlement modes. Usage pools
  retain stable account order even when reset times differ; upstream missing-window columns and
  unknown-cost reporting remain available. Sources: `ThreadSettlementReactor.ts`,
  `ThreadSettlementPolicy.ts`, `packages/shared/src/usageLimits.ts`, and `usageMerge.ts`.
- Right-click still closes panel tabs. Shift-right-click opens upstream's extended menu.
  Compact icon tabs and Git history remain available alongside device tabs and PR stacks.
- Validation uses scoped typechecks and focused tests only. No browser verification, live-data
  writes, app reinstall, or restart is part of this merge.

## Multi-directory composer chips, September 9

- Multi-directory projects use one horizontally scrollable row of colored directory chips in
  `apps/web/src/components/BranchToolbar.tsx`, in both expanded and collapsed composer layouts.
  Each chip opens its directory's path, color, workspace mode, branch, and agent guidance controls.
  Directory ordering and primary-directory permissions remain unchanged. Single-directory layout
  is unchanged. This applies to web, desktop, and mobile web, not the native mobile client.
- Validation: 76 toolbar logic tests and the web typecheck pass. Targeted lint reports existing
  toolbar warnings. Browser verification awaits permission. No reinstall performed for this change.

## Project memory and multiwork selectors, September 8

- Restored multiwork first-send provisioning after the upstream merge disconnected the UI mode
  from the clone service. Draft workspace selectors and the Files workspace selector list existing
  copies filtered by repository origin. File browsing does not change the agent's checkout.
- Reusing a multiwork leaves its branch, dirty files, unpushed commits, and local guidance alone.
  New copies preserve remote-tracked guidance and restore only missing context files. These rules
  follow the owner's multiwork skill. Sources: `MultiworkService.ts`, `ws.ts`, `ChatView.tsx`,
  `BranchToolbar.tsx`, `BranchToolbarEnvModeSelector.tsx`, and `files/filePreviewRoots.ts`.
- Project memories live in the T3 database under migration 52, not in checkout files. The first
  non-compaction user message gets a short manual and names/descriptions. Later messages do not
  repeat the index; MCP lists summaries, reads full entries on demand, and saves short entries.
  Tokens grant access only to their thread's project; memory access does not grant browser access.
- Web/desktop and mobile web Project Settings can add, read, edit, and delete memories. Separate
  project records on other environments retain separate memories. Native mobile receives the same
  server-side agent context and MCP tools; its settings UI is unchanged.
  Sources: `project/ProjectMemory.ts`, `mcp/toolkits/memory.ts`, `ProjectMemorySettings.tsx`,
  `packages/contracts/src/projectMemory.ts`, and `ProviderCommandReactor.ts`.
- Validation: memory persistence/isolation, first-message indexing with queued prompts, MCP
  capability separation, safe clone reuse, Files options, editor failure/confirmation behavior,
  and multiwork bootstrap have focused regression tests. No live-data writes or reinstall.

## Upstream sync, September 7

- Mobile web hides the ordinary prompt placeholder, preserving approval and question guidance.
  Multiple workspace roots use the horizontally scrollable compact context strip on mobile,
  retaining directory, branch, mode, and guidance controls without stacked rows.
  Sources: `ChatComposer.tsx` and `BranchToolbar.tsx`.
- Pooled limit bars keep alphabetical account order across all windows, with Personal before
  Work, rather than sorting segments by reset time. The reset schedule stays chronological.
  Shared web/desktop/mobile logic: `packages/shared/src/usageLimits.ts`; regression coverage in
  `usageLimits.test.ts` checks different window reset orders and refreshed balances.
- Merged 169 missing upstream commits through `8588d7f63`, including pooled subscription limits,
  account load balancing, cross-platform window capture, sidebar drag transitions, searchable
  project scopes, provider fixes, and composer scroll/layout fixes.
- Used upstream's Usage page and pooled Limits view as requested. Provider account badges retain
  configured accents; the fork's hourly breakdown still includes all 24 hours in chronological
  order. The old separate account-limit panel no longer replaces the upstream Limits tab.
- Used upstream's scroll-driven resting composer, multiline detection, and control relocation.
  The fork keeps a one-line minimum editor, tighter padding, a 40px expansion reservation, and
  an inline stash chip whose small menu does not expand the prompt. Attached banners use the
  fork's seam-covering glass rules.
- Audited overlapping fork changes after resolving conflicts. Restored file/video attachment
  uploads and retry guards, project-slot menu behavior, device-local inbox order, and section-sign
  shortcut recording around the new upstream paths. Preserved collapsible screenshots, inline
  turn plans, root-aware file panels, branch drift tracking, and default-off privacy/startup gates.
- Preserved all installed fork migration IDs through 49. Incoming branch-PR and active-order
  migrations run as 50 and 51. An upgrade regression test starts at 49 and checks that existing
  thread timestamps and multiple workspace roots survive.
- Kept the fork's Never default and open-PR protection for inactivity settlement. PR-bearing
  threads wait for a successful lookup; threads without a branch or saved PR can still settle
  before network work. Slow post-turn PR refresh runs separately from checkpoint processing.
- Backup: `backup/pre-upstream-sync-20260907` at `9ae821264`.
  No app rebuild, reinstall, restart, live-data writes, or push was performed.
- Validation: 1,307 focused tests across 47 files pass. Web, server, desktop, contracts, shared,
  and client-runtime native TypeScript checks pass; mobile passes `tsc`. Targeted lint has
  warnings but no errors. No browser or computer-use verification was performed.

## Upstream sync and collapsible chat images, September 5

- Merged all 350 missing commits from `upstream/main` through `ab67795dd`. The sync includes
  streaming timeline reuse, deferred attachment URLs and diff workers, hidden-terminal rendering
  fixes, bounded server history, provider updates, prompt history, citations, and usage-limit banners.
- Reconciled those changes around the fork's compact composer and stash chip, inline turn plans,
  multi-directory file navigation, uncached file reads, account-specific usage and limits, branch
  drift handling, and default-off provider checks, updates, keychain access, and automatic settlement.
  Restored missing row-level attachment loading and citation wiring after the fork-first merge.
- Web and desktop chat images have Hide image / Show image controls. Hiding a screenshot removes
  the preview without deleting the message. The choice survives virtualized row remounts and signed
  asset URL renewal during the current client session. Inline badges and icons stay unchanged.
  Sources: `apps/web/src/components/chat/CollapsibleChatImage.tsx`,
  `apps/web/src/components/ChatMarkdown.tsx`, and
  `apps/web/src/components/chat/MessagesTimeline.tsx`.
- Regression tests cover image hide/restore, turn-plan preservation during streaming, file-path
  case sensitivity, manual and signal-triggered uncached reads, and the fork's provider/settlement
  opt-ins. Checkpoint tests now observe the upstream pull-request invalidation service.
- Validation: 1,041 focused tests pass across web, server, desktop, contracts, shared helpers, and
  client runtime. Web, server, desktop, contracts, shared, and client-runtime native TypeScript
  checks pass. Mobile passes `tsc`;
  `tsgo` still reports React Navigation route typing errors. Targeted lint has warnings but no
  errors. No browser verification, app rebuild, reinstall, restart, or push was performed.
- `backup/pre-upstream-sync-20260905` preserves the pre-merge fork, including the composer and Astra
  changes committed before the merge.

## Composer spacing and GPT-6 Astra, September 4

- The web and desktop composer collapses to one row without hidden editor padding. Expanded
  drafts start at one line and grow with their text. Attached banners and the context strip
  overlap their backdrop edges to cover fractional-pixel seams.
- Stashed prompts use an inline chip and a small floating menu. Opening the chip preserves the
  collapsed composer. Sources: `apps/web/src/components/chat/ChatComposer.tsx`,
  `ComposerStashBadge.tsx`, `ComposerStashMenu.tsx`, `apps/web/src/components/ComposerPromptEditor.tsx`,
  and `apps/web/src/index.css`.
- Integrated upstream `bc03c3640` and `bfef973d9`: GPT-6 Astra is a current Codex model, and successful
  catalog refreshes remove retired models. Sources: `apps/server/src/provider/model-manifest.json`
  and `apps/server/src/provider/Layers/ProviderRegistry.ts`, with upstream regression coverage.
- Validation: 14 composer tests, four Codex inventory tests, ten manifest tests, and web/server
  typechecks pass. The broader registry run hits a startup-probe assertion outside these changes.
  Browser layout verification has not been run.

## Upstream merge policy

- Fork behavior wins when an upstream change touches the same feature. Merge upstream fixes and new
  code paths around the fork's defaults instead of restoring upstream behavior.
- Review persisted settings as well as source defaults. A changed schema default does not replace a
  value already written by an older build.
- Trace new alternate paths through the same fork policy. Linked pull requests, branch-discovered
  pull requests, desktop, web, and mobile must all use the same settlement rule.
- Add a regression test for each conflict found during an upstream sync. Do not rely on conflict
  resolution alone when Git can merge both versions cleanly.

## Privacy-Hardened Desktop Startup

- Packaged desktop auto-update checks are disabled by default.
  - Opt in with `T3CODE_ENABLE_AUTO_UPDATE=true`.
  - Source: `apps/desktop/src/app/DesktopConfig.ts`,
    `apps/desktop/src/updates/DesktopUpdates.ts`.
- Provider npm latest-version advisory checks are disabled by default.
  - Opt in with `T3CODE_ENABLE_PROVIDER_VERSION_CHECKS=true`.
  - The hosted model-classification manifest added upstream uses the same gate. Without the opt-in,
    provider checks use the bundled manifest or an existing disk cache and make no manifest request.
  - Source: `apps/server/src/provider/providerMaintenance.ts`,
    `apps/server/src/provider/ModelManifest.ts`.
- Automatic provider background refresh/checks are disabled by default.
  - Opt in with `T3CODE_ENABLE_PROVIDER_AUTO_REFRESH=true`.
  - Explicit/manual provider refresh still works.
  - Source: `apps/server/src/provider/makeManagedServerProvider.ts`.
- OS-keychain ("Safe Storage") secret encryption is disabled by default.
  - The local build is ad-hoc signed (no Apple Developer ID), so macOS re-prompts for the Keychain
    "Safe Storage" key on every launch/reinstall (the app's signature changes each rebuild, so even
    "Always Allow" never sticks). To avoid that prompt, `ElectronSafeStorage.isEncryptionAvailable`
    reports `false` without calling Electron; every consumer already degrades gracefully, so no
    Keychain access happens at all. The October 12 connection-catalog fix adds persistent local
    encryption without Keychain prompts; legacy credential consumers may still keep secrets
    only in memory.
  - Opt back into real Keychain encryption with `T3CODE_ENABLE_SAFE_STORAGE_KEYCHAIN=true`.
  - Source: `apps/desktop/src/electron/ElectronSafeStorage.ts`.
- Validation performed on the installed macOS build showed a clean startup using only loopback
  sockets between Electron and the local backend after these gates were added.

## Multi-directory Projects

- A project can retain several filesystem roots, including a root that is also used by another
  project. The lightweight shell snapshot preserves the complete root list so live chat surfaces do
  not fall back to the primary directory after an update.
- Composer workspace and branch controls render one aligned stacked row per root. Root badges use a
  stable project palette; clicking a badge opens the predefined color picker and persists the
  selection in project metadata.
- Files renders every root across the full available height, titles sections with their directory
  names, and supports collapsing roots and dragging the horizontal dividers to rebalance their
  heights. Each tree toolbar also has a one-click collapse-all-directories control beside Refresh.
  Ignored entries remain visible with muted styling, and open file tabs are keyed by both root and
  relative path.
- Diffs exposes a directory selector for working-tree and branch comparisons and a collapsible
  directory-tree navigator for changed files instead of relying on a flat sequence of file headers.
  The tree/detail divider is draggable and persisted; selecting a tree file renders that file alone
  in the adjacent diff viewer.
- Each directory's branch row has an Agent guidance button. Its note is persisted with that
  directory, appears only in the configuration dialog, and is injected as private context on every
  agent turn. This supports different branch policies across directories (for example, commit
  directly to `main` in a private repo versus creating a task branch for larger work).
- Source: `packages/contracts/src/orchestration.ts`,
  `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`,
  `apps/web/src/components/BranchToolbar.tsx`, `apps/web/src/components/DiffPanel.tsx`,
  `apps/web/src/components/files/FileBrowserPanel.tsx`,
  `apps/web/src/components/files/FilePreviewPanel.tsx`, `apps/web/src/rightPanelStore.ts`.
- Validation: focused projection snapshot, right-panel, diff-file action, and file-preview tests;
  web typecheck.

## Git History Surface

- The thread right panel includes a Git History surface alongside Files, Diff, Terminal, and the
  other workspace tools.
  - Multi-directory projects can switch repositories from the surface header.
  - The current branch's latest 100 commits render as a dense graph-style timeline with merge
    markers, refs/tags, author, relative date, and short SHA.
  - Selecting a commit shows its complete message, author/date/SHA, changed files, per-file line
    statistics, aggregate additions/deletions, and binary-file indicators.
  - Commit-list/details and changed-files/diff columns are independently resizable and persisted.
    Changed files use the same hierarchical navigator and split/unified diff renderer as the Diff
    surface, with one selected file displayed at a time.
  - History and commit details use bounded, read-only Git RPCs and cached client query atoms; Git
    commands never run in the renderer.
- Source: `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`,
  `apps/server/src/git/GitHistory.ts`, `apps/server/src/git/GitWorkflowService.ts`,
  `packages/client-runtime/src/state/git.ts`, `apps/web/src/components/GitHistoryPanel.tsx`,
  `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/rightPanelStore.ts`.

## Focused File Editing

- Undo/redo is routed directly to the editable file surface while its code editor has focus, so
  Cmd/Ctrl+Z cannot mutate the unfocused chat composer. Shift+Cmd/Ctrl+Z routes to editor redo.
- Source: `apps/web/src/components/files/FilePreviewPanel.tsx`,
  `apps/web/src/components/files/fileEditorUndo.ts`.

## Project File Tree Expansion

- The workspace file tree starts fully collapsed and expansion is opt-in, instead of rendering every
  directory open on mount. On a large workspace this is the difference between flattening tens of
  thousands of rows into the virtualizer and flattening the top level.
  - The tree's state is now a set of **expanded** directories rather than collapsed ones, so the
    empty initial state is the closed tree. `allDirectoryPaths` (a full-tree walk run on every
    rebuild purely to feed collapse-all) is gone, replaced by `ancestorDirectories`, which walks one
    path.
  - Opening a file expands exactly its ancestor directories and closes everything else, so the tree
    always shows where the current file lives and nothing more.
  - The collapse-all button now collapses everything **except** the path to the open file, rather
    than shutting the tree completely. Its label reads "Collapse all, keeping the open file".
  - Expansion no longer resets when the entries query refreshes. The reveal effect used to depend on
    the rebuilt directory list, so any refresh re-collapsed the tree under the user.
  - The diff file tree (`DiffFilesTreeNavigator`) deliberately keeps its expanded default: it lists
    only changed files, so a collapsed default would just add clicks.
  - Source: `apps/web/src/components/files/NativeProjectFileTree.tsx`,
    `apps/web/src/components/files/FileBrowserPanel.tsx`.
  - Validated with `nativeProjectFileTree.test.ts` (ancestor derivation, top-level entries, Windows
    separators and empty segments).

## File Preview UX

- Editor surface tabs can be hidden from Settings > General.
  - Hidden-tab mode keeps a compact surface switcher and add-surface control, so files, terminals,
    diffs, and browser previews remain reachable without a persistent tab strip.
  - The setting is persisted with the existing client settings.
  - Source: `packages/contracts/src/settings.ts`,
    `apps/web/src/components/RightPanelTabs.tsx`,
    `apps/web/src/components/settings/SettingsPanels.tsx`.
- The file editor has JetBrains-style workspace navigation.
  - Double Shift opens Search Everywhere with All, Classes, Files, Symbols, Actions, and Text
    scopes. Tab and Shift+Tab cycle scopes.
  - With an empty query, the All and Files scopes list the workspace's files (recent files first,
    then the rest of the project, deduped and capped) so there is always something to select
    immediately — previously a freshly opened workspace with no recent files showed an empty dialog
    and you had to type before any file appeared. Typing still narrows via the server `searchEntries`
    index. Regression-guarded by Chromium tests that select a file with and without typing.
  - File names use the existing fuzzy workspace index. Classes, methods, functions, variables,
    parameters, and text use source-content search through the server workspace index.
  - The Actions scope exposes relevant T3 Code commands, including settings, command palette,
    file explorer, workspace refresh, and tab visibility.
  - Cmd+E opens recent editor files. Recents are persisted per environment and workspace in client
    storage and survive desktop app updates.
  - Cmd-clicking an identifier searches exact workspace definitions/usages. A single target opens
    directly; multiple targets open a searchable chooser and reveal the selected source line.
  - Navigation is source-index based rather than language-server based. It handles common
    declaration forms and exact identifiers across ignored-file-aware workspace content, but does
    not perform full type resolution or overload analysis.
  - Source: `apps/server/src/workspace/WorkspaceSearchIndex.ts`,
    `apps/server/src/workspace/WorkspaceEntries.ts`, `apps/server/src/ws.ts`,
    `apps/web/src/components/files/EditorNavigationDialog.tsx`,
    `apps/web/src/components/files/SymbolNavigationDialog.tsx`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`,
    `apps/web/src/editorNavigationStore.ts`, `packages/contracts/src/project.ts`.

- The editor keeps a back/forward navigation history, like a browser or JetBrains.
  - Back returns to the exact line you jumped from (the clicked identifier's line is captured as the
    origin), not the top of the previous file.
  - Shortcuts: Back is `⌘[` or `Ctrl+←`; Forward is `⌘]` or `Ctrl+→`. The shortcuts only act while the
    editor area owns focus, so chat/composer inputs keep their word navigation. (On macOS, `Ctrl+←/→`
    may be claimed by Mission Control "switch Spaces"; `⌘[`/`⌘]` always work.)
  - The file preview subheader also has Back/Forward arrow buttons, enabled per available history.
  - History is per environment+workspace and lives in the navigation store. The store is the single
    owner of navigation-driven file switches (the preview panel watches `navigationRequest` and opens
    the target file), so symbol jumps, the search dialog, and back/forward all share one code path.
  - Source: `apps/web/src/editorNavigationStore.ts`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`,
    `apps/web/src/components/files/EditorNavigationDialog.tsx`.
- The Cmd-click definition/usage chooser is rendered JetBrains "Find Usages" style.
  - Each row shows the file name, directory, line number, and the source line with every whole-word
    occurrence of the symbol emphasized; a header shows the symbol and the match count.
  - The filter box narrows large result sets, and the keyboard selection scrolls into view.
  - Source: `apps/web/src/components/files/SymbolNavigationDialog.tsx`.
- Cmd-click symbol resolution is more forgiving about tokenization.
  - The clicked token no longer has to be a pristine identifier; a lone identifier is extracted even
    when the grammar attaches adjacent punctuation (`foo(`, `.foo`, `foo,`). Genuinely ambiguous
    multi-identifier tokens are still ignored so navigation never jumps to the wrong symbol. This
    fixes Cmd-click silently doing nothing on many method/class references.
  - Source: `apps/web/src/components/files/FilePreviewPanel.tsx`.
- The Search Everywhere dialog (double Shift) is tightened toward JetBrains density.
  - Narrower popup, faster open animation, and shorter rows/tabs/input. The matched portion of each
    result label is emphasized.
  - Source: `apps/web/src/components/files/EditorNavigationDialog.tsx`,
    `apps/web/src/components/files/SymbolNavigationDialog.tsx`.
- The workspace file tree auto-reveals the file shown in the editor.
  - On open, the tree expands the file's parent directories, scrolls it into view, and highlights
    the row (`data-item-focused`), like JetBrains' "Always Select Opened File". A toolbar toggle
    enables/disables it (persisted, on by default).
  - Source: `apps/web/src/components/files/FileBrowserPanel.tsx`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`.
- Clicking a file in the tree reliably opens it.
  - Opening no longer depends on the tree library's selection callback. File-row clicks and Enter
    resolve the row path explicitly and invoke the current `onOpenFile` callback through a live ref.
    This keeps opening reliable after switching between Files and Structure or after auto-reveal
    scrolls the tree.
  - Auto-reveal expands and scrolls to the active file without stealing tree focus.
  - Source: `apps/web/src/components/files/FileBrowserPanel.tsx`.
- Files and directories can be deleted from the workspace tree.
  - Delete/Backspace removes the focused entry after confirmation, and right-click exposes the same
    action in a context menu. Directory deletion is recursive.
  - A workspace-root-safe `projects.deleteEntry` RPC rejects paths outside the workspace and does not
    follow a symlink target outside the workspace. Successful deletion refreshes file and Git state.
  - Source: `apps/web/src/components/files/FileBrowserPanel.tsx`,
    `apps/server/src/workspace/WorkspaceFileSystem.ts`, `apps/server/src/ws.ts`,
    `packages/client-runtime/src/state/projectCommands.ts`, `packages/contracts/src/project.ts`.
- The file tree marks files with working-tree changes (VCS status), colored by real change kind.
  - Markers come from the granular `git.detailedStatus` RPC. Any file with unstaged changes (or an
    untracked/unversioned file) renders in a pale red so it stands out from fully-staged work, which
    keeps its kind color: staged-added green, staged-modified blue, staged-deleted red, staged-renamed
    amber (copy→added, typechange/unmerged→modified, since the tree's palette has no dedicated colors
    for those). This matches the Commit panel's pale-red unversioned treatment. The
    detailed status is a pull query, so the panel
    refreshes it whenever the live `vcsEnvironment.status` stream reports a working-tree change, keeping
    markers current with edits made outside the Commit panel.
  - Source: `apps/web/src/components/files/FileBrowserPanel.tsx`,
    `apps/web/src/components/files/gitChangesState.ts`.
- The explorer sidebar has a Structure view of the current file, like JetBrains' Structure tool.
  - Lists classes, methods, functions, and top-level declarations with kind badges and nesting,
    derived client-side from the already-loaded file contents (no server round-trip). Clicking a
    symbol scrolls the editor to it. A Files/Structure switch at the top of the sidebar toggles
    between the tree and the outline (persisted). Python and TypeScript/JavaScript have tuned
    extractors; other languages use a generic class/function fallback.
  - Source: `apps/web/src/components/files/fileOutline.ts`,
    `apps/web/src/components/files/FileStructurePanel.tsx`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`.

- Markdown preview mode is global across markdown files instead of being tied to one file path.
  - Switching a markdown file to rendered mode applies to other `.md` and `.mdx` files, including
    newly opened or newly created files.
  - The preference is persisted in browser local storage as `t3code.markdownPreviewMode`.
  - Source: `apps/web/src/components/files/FilePreviewPanel.tsx`,
    `apps/web/src/components/files/filePreviewMode.ts`.
- The workspace file tree has explicit expand-all and collapse-all controls.
  - Source: `apps/web/src/components/files/FileBrowserPanel.tsx`.
- File breadcrumbs are navigable.
  - Clicking a project/directory crumb opens a child picker.
  - Selecting a file opens it.
  - Selecting a directory opens the first file under that directory, or reveals the directory in
    the tree if no file exists below it.
  - Cmd-click on a breadcrumb reveals that parent directory in the file tree.
  - Source: `apps/web/src/components/files/FilePreviewPanel.tsx`,
    `apps/web/src/components/files/filePath.ts`.
- Code rendering has a client-side editor theme selector.
  - Settings now include `Editor theme` with `Follow app` plus several dark syntax themes.
  - A custom `JetBrains Dracula Night` theme is registered for a darker Dracula-like editor
    background.
  - The selected theme applies to file previews, editable file views, diffs, and chat code blocks.
  - Source: `packages/contracts/src/settings.ts`, `apps/web/src/lib/diffRendering.ts`,
    `apps/web/src/components/settings/SettingsPanels.tsx`.

## Surface Keyboard Shortcuts

- Function/`Cmd+1` keys toggle the main workspace surfaces, JetBrains-style.
  - `Cmd+1` opens the file **Structure** view (opens the files surface and switches the explorer to
    the outline), `F1` toggles the code-editor (files) surface, `F2` toggles the browser preview,
    `F3` toggles the terminal.
  - `F2`/`F3` reuse the existing `preview.toggle`/`terminal.toggle` commands; `editor.toggle` and
    `structure.open` are new keybinding commands. All four are user-rebindable in Settings →
    Keybindings.
  - Note: `Cmd+1` previously jumped to thread 1 (`thread.jump.1`); it now opens the structure view
    (the new binding wins as the last default). `Cmd+2`–`Cmd+9` still jump to threads, and the
    model-picker number jumps are preserved (the `Cmd+1` binding is gated `!modelPickerOpen`).
  - The explorer's open/view state was lifted from `FilePreviewPanel` local state into a shared
    `explorerViewStore` so it can be driven from the global keyboard handler as well as the panel UI.
  - Source: `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`,
    `apps/web/src/explorerViewStore.ts`, `apps/web/src/components/ChatView.tsx`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`.

- `editor.navigateBack` / `editor.navigateForward` walk the editor's back/forward history.
  - Defaults are `ctrl+left` / `ctrl+right` plus `mod+[` / `mod+]`, both gated `!terminalFocus`.
    The `ctrl` pair is the requested one; macOS binds `ctrl+left`/`ctrl+right` to Mission Control
    spaces by default, so the `mod` pair ships alongside as the one that always reaches the app.
  - **This re-wires an orphaned feature.** `apps/web/src/editorNavigationStore.ts` and its tests
    survived, but every reference to the store was dropped in `57ce5ccc9` ("fix: reconcile upstream
    merge integration"), leaving back/forward dead since 2026-08-11 while the store still shipped.
  - History is recorded from one place, the active file surface in `ChatView`, so the file tree,
    markdown links, the file picker, and symbol jumps all feed the same history rather than each
    call site maintaining its own. Replaying a step lands on the entry just moved to, which
    `recordActiveLocation` already treats as a no-op, so back/forward never appends to history.
  - Source: `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`,
    `apps/web/src/components/ChatView.tsx`, `apps/web/src/editorNavigationStore.ts`.

- `rightPanel.toggleMaximized` defaults to `mod+alt+m` here, where upstream ships the command with
  no default, and the fork's handler does more than upstream's.
  - Pressing it while the right panel is closed opens **and** maximizes in one go, so the shortcut
    never reads as a dropped key. It is a no-op in the sheet layout, which has no maximized state.
  - The fork originally shipped this as `rightPanel.maximize`; see the 2026-08-15 upstream sync
    below for the rename and the config migration it required.
  - Source: `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`,
    `apps/web/src/components/ChatView.tsx`.

## Git Commit Panel

- The branch selector has explicit Fetch and Pull controls.
  - Fetch contacts the repository's remote and refreshes remote-tracking refs without moving the
    local branch. It is enabled whenever no branch action is in flight. When the current branch has
    an upstream it fetches that upstream's remote; when it has none (e.g. a freshly created local
    branch) the server falls back to fetching the primary remote (`origin`, else the first
    configured remote), returning a null `upstreamRef`. So the control is never permanently greyed
    out for upstream-less branches. A repository with no remote at all surfaces as a failure toast.
    Covered by `GitVcsDriverCore.test.ts` (with-upstream fetch, no-upstream primary-remote fallback,
    and no-remote failure).
  - Pull uses the existing fast-forward-only operation, so it never creates an implicit merge commit.
    It stays disabled until the current branch has an upstream, since fast-forward needs a tracking
    branch.
  - Source: `apps/web/src/components/BranchToolbarBranchSelector.tsx`,
    `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/ws.ts`,
    `packages/client-runtime/src/state/vcs.ts`, `packages/contracts/src/git.ts`.
- The Commit view exposes merge-conflict resolution controls.
  - Unmerged files can use the current side, use the incoming side, or stage the manually edited file
    as resolved. Delete/modify conflicts are handled when one selected side has no file.
  - **Resolve with AI** starts a normal coding-agent turn scoped to the listed unmerged files. The
    model picker is shown whenever conflicts exist, and its selection can optionally be remembered.
    The generated task explicitly stages resolved files but forbids commit, push, reset, merge abort,
    and unrelated-file changes.
  - Source: `apps/web/src/components/files/GitChangesPanel.tsx`,
    `apps/web/src/components/files/gitChangesState.ts`,
    `apps/server/src/vcs/GitVcsDriverCore.ts`, `apps/server/src/git/GitWorkflowService.ts`,
    `apps/server/src/ws.ts`, `packages/client-runtime/src/state/git.ts`,
    `packages/contracts/src/git.ts`.
- The server exposes granular git-index operations, additive and git-only (the shared `VcsDriver`
  contract and the `jj` driver are untouched).
  - New `GitVcsDriver` capabilities: `detailedStatus` (per-file staged/unstaged state + change kind,
    parsed from `git status --porcelain=2 -z`, including untracked and rename/copy origins),
    `stageFiles`, `unstageFiles`, `discardChanges` (reverts tracked paths to HEAD and removes
    untracked ones, with no-HEAD/initial-commit handling), and `commitStaged` (commits the current
    index, splitting the message into subject/body, with optional `--amend`).
  - Exposed through `GitWorkflowService` (gated to git repositories like the other workflow ops) and
    five additive WebSocket RPCs: `git.detailedStatus`, `git.stageFiles`, `git.unstageFiles`,
    `git.discardChanges`, `git.commitStaged`. The stage/unstage/discard RPCs return the refreshed
    detailed status so the client updates in one round trip, and mutations also refresh the VCS
    status stream.
  - Source: `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`,
    `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`,
    `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`.
  - Validated with `GitVcsDriverCore.test.ts` integration tests covering detailed status,
    stage/unstage/commit round-trips, and discard of tracked + untracked files.
- The explorer sidebar has a JetBrains-style **Commit** view alongside Files and Structure.
  - Lists changed files grouped into Changes (tracked) and Unversioned (untracked) with per-file
    change-kind badges (M/A/D/R/C/T), staged-state checkboxes (checked = fully staged, indeterminate
    = partially staged), and a select-all checkbox per group. Clicking a file opens it in the editor.
    The two groups are visually separated by a divider, and unversioned file names render in a pale
    red (matching the file tree's untracked color) to stand out from tracked changes.
  - Each row has a discard control (confirmed, since discarding untracked files deletes them). A
    resizable, multi-line commit message box with an "Amend last commit" toggle commits the staged
    index; the button is enabled only when something is staged (or amending) and a message is present.
  - Backed by the git-index RPCs above via a `useGitDetailedStatus` query plus
    stage/unstage/discard/commit mutation helpers. The commands use upstream's supervised,
    environment-scoped client-runtime atoms so they reconnect and report failures consistently with
    the rest of the current web client.
  - The commit message box has an icon-only **Generate commit message** button (tooltip only) that
    drafts a concise one-line message from the staged diff using the system text-generation model
    (`textGenerationModelSelection`) — it returns the generated subject only (no body) so the result
    is a single, comprehensive line you can edit. It is enabled only when something is staged.
    - Server: a git-only `stagedCommitContext` driver capability reads the current index's
      `git diff --cached` summary + patch without modifying it (extracted from `prepareCommitContext`
      so both share one path), `GitManager.generateStagedCommitMessage` runs it through the existing
      `TextGeneration` service, exposed via `GitWorkflowService.generateCommitMessage` and the
      `git.generateCommitMessage` RPC.
    - Client: a `generateCommitMessage` environment command and a `generateGitCommitMessage` helper
      that fills the message box.
  - Clicking a file in the Commit view opens its **diff** (working-tree changes vs HEAD) over the
    editor area — not the editable file — with the selected row highlighted and a close (✕) control.
    Untracked files render as a full-file addition. Backed by a new git-only `git.fileDiff` RPC
    (`GitVcsDriver.fileDiff` → `git diff HEAD -- <path>`, falling back to `--no-index` for untracked),
    a `fileDiff` query atom, and a `CommitFileDiffView` that reuses the app's `@pierre/diffs` renderer
    (`getRenderablePatch` + `AnnotatableCodeView`).
    - Source: `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`,
      `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`,
      `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`,
      `packages/client-runtime/src/state/git.ts`,
      `apps/web/src/components/files/CommitFileDiffView.tsx`,
      `apps/web/src/components/files/GitChangesPanel.tsx`,
      `apps/web/src/components/files/FilePreviewPanel.tsx`.
  - Source: `apps/web/src/components/files/GitChangesPanel.tsx`,
    `apps/web/src/components/files/gitChangesState.ts`,
    `apps/web/src/components/files/FilePreviewPanel.tsx`,
    `apps/server/src/vcs/GitVcsDriver.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`,
    `apps/server/src/git/GitManager.ts`, `apps/server/src/git/GitWorkflowService.ts`,
    `apps/server/src/ws.ts`, `packages/client-runtime/src/state/git.ts`,
    `packages/contracts/src/git.ts`, `packages/contracts/src/rpc.ts`,
    `packages/contracts/src/ipc.ts`.

## Multiwork as a first-class workspace mode

- **Multiwork is a thread environment mode**, alongside "Current checkout" (local) and "New
  worktree", selectable from the composer's **Workspace** dropdown. Picking "Multiwork copy" and
  sending a first message makes the system provision an isolated full repo copy and run the agent
  inside it — like a git worktree, but a real decoupled copy.
  - `ThreadEnvMode`/`EnvMode`/`DraftThreadEnvMode`/`SidebarNewThreadEnvMode` gained a `"multiwork"`
    value; the env-mode logic treats multiwork like worktree (an isolated workspace that needs a
    base) via a shared `isIsolatedEnvMode` helper.
  - The thread's `worktreePath`/`branch` fields hold the copy and its branch, so the file tree/editor
    and VCS status follow it. New multiwork branches use `spilshchikov-<task>-<unique suffix>`;
    existing copies retain their current branch. Continuing a thread reuses its copy.
  - The turn-start bootstrap's `prepareWorktree` gained a `mode: "worktree" | "multiwork"`; when it
    is `"multiwork"` the server provisions via `MultiworkService.create` (clone + branch) instead of
    `git worktree add`, reading the base directory from the `multiworkBaseDirectory` setting.
  - Source: `packages/contracts/src/settings.ts`, `packages/contracts/src/orchestration.ts`,
    `apps/web/src/composerDraftStore.ts`, `apps/web/src/components/BranchToolbar.logic.ts`,
    `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`,
    `apps/web/src/components/BranchToolbarBranchSelector.tsx`,
    `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/ChatView.tsx`,
    `apps/server/src/ws.ts`.

- The GUI can also create isolated, full repo copies ("multiwork") directly and open them as
  projects, mirroring the `multiwork` shell workflow (the owner's alternative to git worktrees).
  - A persisted `multiworkBaseDirectory` setting (Settings → General) controls where copies live;
    empty resolves to `~/workplace/git/multiwork`.
  - Server `MultiworkService` + `multiwork.create` / `multiwork.list` RPCs perform the procedure:
    resolve the source repo toplevel and origin, object-borrowing clone
    (`git clone --reference … --dissociate`, falling back to a plain clone), fetch, then
    `checkout -B <branch>` — continuing an existing remote branch or branching off the default
    branch — and restore git-ignored project context (`.claude`, `CLAUDE.md`, `AGENTS.md`). It is
    additive and git-only; the shared `VcsDriver` contract and `jj` are untouched.
  - The current UI creates and reuses copies through the thread Workspace selector. The Files
    workspace selector also lists matching copies for browsing. This replaces the older sidebar
    copy dialog after the upstream sync; opening a copy as a separate project remains possible
    through the normal directory picker.
  - Source: `packages/contracts/src/multiwork.ts`, `packages/contracts/src/settings.ts`,
    `packages/contracts/src/rpc.ts`, `packages/contracts/src/ipc.ts`,
    `apps/server/src/multiwork/MultiworkService.ts`, `apps/server/src/server.ts`,
    `apps/server/src/ws.ts`, `packages/client-runtime/src/state/multiwork.ts`,
    `apps/web/src/state/multiwork.ts`, `apps/web/src/components/Sidebar.tsx`,
    `apps/web/src/components/settings/SettingsPanels.tsx`.
  - Validated with `MultiworkService.test.ts` (offline clone against a local bare remote: fresh
    branch + context restore, continuing an existing remote branch, reuse + list, and the
    not-a-repo failure).

## Resumable agent sessions (Claude Code / Codex)

- The server discovers existing CLI coding-agent sessions for a repo so they can be continued in t3,
  round-tripping with the CLIs (continuing writes back to the same on-disk session, so Claude Code →
  t3 → Claude Code stays one conversation).
  - `ResumableSessionDiscovery` (`apps/server/src/sessions/ResumableSessionDiscovery.ts`) scans, for a
    given cwd:
    - **Claude**: every configured Claude instance's config dir (`$CLAUDE_CONFIG_DIR`/`~/.claude`
      plus each `claudeAgent` provider instance's `configDir`, labeled by its display name) at
      `projects/<cwd-with-non-alphanumerics-as-dashes>/<session-id>.jsonl`. The session id is the
      filename; resume cursor is that id (the Claude Agent SDK resumes by session id).
    - **Codex**: `$CODEX_HOME`/`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, newest-first and
      bounded, matched to the repo by the `session_meta` header's `cwd`. Resume cursor is
      `{ threadId: <id> }` (Codex `thread/resume`). Legacy rollouts without a `cwd` are skipped.
    - Each row carries title (first real user prompt, or a Claude `summary` fallback), `updatedAt`,
      message count, and a best-effort `active`/`idle` status from file mtime (the CLIs persist no
      definitive running/awaiting/completed flag, so live "background agent" state is approximated by
      recency rather than true attach).
  - Exposed over `sessions.listResumable` (`packages/contracts/src/resumableSessions.ts`, `rpc.ts`,
    `ipc.ts`, `ws.ts`, read scope), merged across providers and sorted by recency.
  - **V2 resume seam (October 3 repair)**: the scoped project sidebar's collapsible
    `ResumeSessionsSection` calls `threadEnvironment.create` with `importedNativeThread.ref`.
    The orchestrator persists the owning provider instance and native session id; the next message
    resumes through the normal Claude/Codex adapter path. No V1 turn-start seed is required.
  - Rows retain the source account/model, title, relative time, and best-effort recently-active dot.
    Discovery mounts only while expanded. Creation errors do not show a success toast or navigate.
  - Source: `apps/web/src/components/sidebar/ResumeSessionsSection.tsx`,
    `apps/web/src/components/Sidebar.tsx`, `packages/client-runtime/src/operations/commands.ts`,
    `apps/server/src/orchestration-v2/Orchestrator.ts`, provider adapters, and the discovery service.
  - Validation includes discovery tests, remote command tests for both provider identities, and
    the V2 launch/provider-session suites. CLI processes were not launched during this audit.

## Claude Profiles

- Claude provider instances support a dedicated `Claude config directory` setting.
  - The path is passed directly as `CLAUDE_CONFIG_DIR`, allowing named instances such as
    `Claude Personal` (`~/.claude-personal`) and `Claude Work` (`~/.claude-work`) to keep separate
    authentication and configuration.
  - Named Claude instances appear independently in the existing provider/model selector.
  - The older full `HOME` override remains available as an advanced compatibility option.
  - Upstream later reused the old `homePath` field for `CLAUDE_CONFIG_DIR`. This fork keeps the two
    controls separate: `configDir` sets `CLAUDE_CONFIG_DIR`, while `homePath` sets process `HOME`.
    Provider-session, status-probe, and text-generation tests use `configDir` so a future merge
    cannot silently swap those meanings again.
  - Source: `packages/contracts/src/settings.ts`,
    `apps/server/src/provider/Drivers/ClaudeHome.ts`,
    `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`,
    `apps/server/src/provider/Layers/ProviderRegistry.test.ts`,
    `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts`.

## Update-Safe Persistence

- Desktop updates reuse stable, version-independent storage locations.
  - Projects, threads, messages, provider session bindings, settings, and attachments remain under
    `~/.t3/userdata`.
  - Electron UI state, drafts, and browser preferences remain under the stable `t3code` user-data
    directory (on macOS, `~/Library/Application Support/t3code`).
  - Regression tests cover app version, update channel, bundle path, and legacy user-data behavior.
  - Source: `apps/desktop/src/app/DesktopEnvironment.ts`,
    `apps/desktop/src/app/DesktopEnvironment.test.ts`,
    `apps/desktop/src/app/DesktopAppIdentity.test.ts`.

## Upstream Sync 2026-08-13

- Merged `upstream/main` (27 commits, merge base `f0b57ca23`) with `-X ours`, so fork-local code
  wins any conflicting hunk. Backup of the pre-merge tip: branch `backup/pre-upstream-sync-20260813`.
- Only two files conflicted: `apps/web/src/components/BranchToolbar.tsx` and
  `apps/web/src/hooks/useHandleNewThread.ts`. Every upstream-added line was checked against the
  merged tree afterwards; two upstream hunks were deliberately not carried over:
  - `apps/web/src/components/chat/ChatComposer.tsx` — upstream's model-picker alignment tweak
    (`-ms-3.5`/`ps-3.5` on the footer scroller, `triggerClassName="-ms-2.5"`, #6252) has no landing
    site because the fork rewrote that footer for stacked multi-root rows.
  - Nothing else. `BranchToolbar`'s conflict resolved to identical content, so upstream's composer
    resize motion (#6209) is intact.
- Upstream's new right-panel launcher (#6258) reads `action.shortcut` on every surface entry, which
  broke the fork-only Git History entry. It now carries `shortcut: "G"`
  (`apps/web/src/components/RightPanelTabs.tsx`); the letter was free alongside B/T/F/D/P/A.
- One upstream line was grafted back by hand after the conflict resolution dropped it:
  `carryComposerContentTo(draftId)` in `useHandleNewThread`, where the fork's
  `options?.onDraftCreated?.(…)` occupies the same hunk. Without it the upstream "keep the typed
  prompt when a draft changes repo" feature (#6393) was half-landed — `DraftHeroHeadline` passes
  `carryComposerContent: true` and hits exactly that path.

## Upstream Sync 2026-08-15

- Merged `upstream/main` (137 commits, merge base `6bc6cb6be`) with `-X ours`. Backup of the
  pre-merge tip: branch `backup/pre-upstream-sync-20260815`.
- **Right panel maximize converged on upstream's name.** Upstream shipped the same feature two days
  after the fork did (#5091). The fork's `rightPanel.maximize` was renamed to upstream's
  `rightPanel.toggleMaximized` so their tests and docs apply unchanged, while keeping the fork's
  `mod+alt+m` default and its open-and-maximize-in-one-press behavior. Two upstream expectations are
  therefore deliberately not carried:
  - `apps/server/src/keybindings.test.ts`'s `assert.isFalse(defaultsByCommand.has(…))`, since the
    fork does ship a default for it.
  - `docs/user/keybindings.md`'s "It has no default shortcut" sentence, rewritten to document
    `mod+alt+m` and the editor back/forward defaults.
  - Migration: an existing `keybindings.json` naming the old command becomes an invalid entry, and
    one invalid entry makes the server skip the **entire** startup default sync
    (`apps/server/src/keybindings.ts`, `syncDefaultKeybindingsOnStartup`). The live config was
    migrated in place with a `.bak-20260815` copy alongside it.
- Half-landed upstream work that `-X ours` left broken, caught by typecheck and grafted back:
  - `activeRepositoryRoot` in `DiffPanel.tsx` and `useRemoteOpenState` in `FilePreviewPanel.tsx`,
    both used but with their definitions dropped.
  - The `RemoteOpenTargets` mock layer in `apps/server/src/server.test.ts`.
- Upstream fixes the fork's own code had silently missed:
  - `diffFileActions.ts` computed `workspaceFilePath` and then opened the raw `filePath`, so a
    nested project's diff opened the wrong path (#6174). It now opens the resolved path while
    keeping the fork's workspace-root argument. Upstream's new test asserts the unkeyed surface id;
    the fork keys file surfaces by root, so that expectation was adapted rather than the behavior.
  - `markdown-clipboard.ts` gained upstream's copy-verbatim-inside-`<pre>` branch (#5069), placed
    ahead of the fork's Slack table transform.
- `apps/server/src/vcs/GitVcsDriverCore.ts`: upstream turned `runGit`'s fourth parameter from an
  `allowNonZeroExit` boolean into an `ExecuteGitOptions` object. The fork's five git-index call
  sites now pass `{ allowNonZeroExit: true }`.
- `docs/user/providers-claude.md` was restored. It went missing in the 2026-08-13 sync while
  `README.md`, `docs/README.md`, `docs/user/install.md`, and `docs/user/providers-codex.md` all kept
  linking to it. The 08-13 audit only compared files present in the tree, so a wholly absent file
  slipped through; this sync's audit checks for missing files too.

## Provider account limits

- The fork's account-limit service and versioned snapshots remain available for compatibility.
  They key readings by environment and provider instance, preserve Claude account isolation,
  normalize streamed usage windows, and avoid attributing ambiguous Codex transcripts.
- The September 7 sync adopts upstream's pooled Usage → Limits UI and provider probes. It
  deduplicates accounts across environments and hubs and keeps native provider account badges
  and configured accents. Do not restore the old panel over that tab in future merges.
- Sources: `apps/server/src/usage/AccountLimitsService.ts`,
  `apps/server/src/usage/accountLimitsNormalize.ts`,
  `apps/web/src/components/usage/UsageLimits.tsx`,
  `apps/web/src/components/usage/UsageLimitsPooled.tsx`.

## Recent file and panel freshness fixes

- An open text-file preview performs a fresh server read before displaying content and subscribes to
  filesystem invalidations only while that file is visible. Closing the preview stops the watcher;
  external edits then refresh the active file without polling every workspace file.
- Diff previews fetch the selected file on demand and bound the initial untracked-file overview, so
  large worktrees do not spawn one diff process per file before the user selects anything.
- Right-panel tabs are selected with a left click and closed only with a right click; the close icon
  and accidental middle-click closing path were removed. The composer collapse state is a transient
  scroll gesture and resets when changing threads rather than collapsing on thread open.
- Source: `apps/server/src/workspace/WorkspaceFileSystem.ts`,
  `apps/web/src/components/files/projectFilesQueryState.ts`, `apps/web/src/components/DiffPanel.tsx`,
  `apps/web/src/components/RightPanelTabs.tsx`, `apps/web/src/components/ChatView.tsx`.

## Review panel driven by a file list rather than one large patch

- The review diff overview now asks the server for the changed-file list alone (`includePatch:
  false`) and fetches a patch only for the file on screen. `git diff --numstat -z` produces that
  list, so it is complete even when a patch would have hit the 120 KB preview cap. Untracked files
  are listed from `ls-files --others`; their line counts are reported as unknown rather than guessed,
  because counting them means reading every file.
- The changed-files tree renders from that list instead of from the parsed patch, so an empty,
  truncated, or failed patch empties only the code column. Previously a patch the parser could not
  use hid the whole panel, which is what made Working tree and Branch changes look empty.
- Selecting a file and rendering the "all files stacked" view (the tree hidden) each have their own
  query, and the panel's +/- totals come from the file list rather than from whichever patch happens
  to be loaded.
- Source: `packages/contracts/src/review.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`,
  `apps/web/src/components/DiffPanel.tsx`.

## Branch remote state, fetch, and pull

- Every local ref in the branch picker carries its upstream, ahead and behind counts, and whether
  the upstream is gone. They come from `for-each-ref`'s `%(upstream:track)` in the existing snapshot
  command, so listing refs costs no extra process. Rows show a blue down arrow for commits to pull
  and a green up arrow for commits not yet pushed.
- The picker has a fetch button that fetches and prunes the primary remote (`scope: "remote"`), which
  is what refreshes the counts of branches other than the checked-out one. A fetch now invalidates
  the cached ref list.
- A branch that is behind gets a pull button. The checked-out branch pulls with `--ff-only`; any
  other local branch fast-forwards through `git fetch <remote> <branch>:<branch>`, which git itself
  refuses when the update is not a fast-forward.
- A refused fast-forward is reported as `status: "diverged"` instead of as a command failure. The
  toast offers to open a fresh thread whose prompt states the branch, the upstream, the two counts,
  and git's own message, and asks the agent to choose between a rebase and a merge and to walk
  through each conflict.
- Source: `packages/contracts/src/git.ts`, `apps/server/src/vcs/GitVcsDriverCore.ts`,
  `apps/server/src/git/GitWorkflowService.ts`, `apps/server/src/ws.ts`,
  `packages/client-runtime/src/state/vcs.ts`, `apps/web/src/components/BranchToolbar.logic.ts`,
  `apps/web/src/components/BranchToolbarBranchSelector.tsx`.

## Branch drift follows a project checkout too

- A thread working in the project checkout, not a dedicated worktree, now adopts the branch it
  finished a turn on, the same way a worktree thread already did. A dedicated worktree still has to
  belong to exactly one thread before its branch is adopted; a project checkout has no such
  ambiguity. Without this a `git checkout` by the agent left the thread's recorded branch stale, and
  the client only attributes pull-request state to a thread whose recorded branch matches the
  checked-out one, so the thread silently lost its PR.
- Source: `apps/server/src/orchestration/Layers/CheckpointReactor.ts`.

## Sidebar thread arrangement

- Inbox rows can be dragged into any order, reusing the drag machinery the pinned block already had.
  The arrangement is client-local and persisted in `localStorage`; it never reaches the server,
  because it is a view preference rather than thread state.
- Threads the arrangement has never seen keep the slot the ordinary sort gave them, so a new thread
  still arrives at the top instead of sinking below a stale arrangement.
- Source: `apps/web/src/sidebarThreadOrderStore.ts`, `apps/web/src/components/Sidebar.tsx`.

## Composer and right-panel shortcut fixes

- The global shortcut listener registers once and dispatches through a ref. It used to re-register
  on every dependency change, which moved it behind listeners mounted later (the right-panel surface
  launcher, the composer), so a configured shortcut such as `§` reached the panel only sometimes.
- A character bound to a command is never inserted as text, whether or not a thread is open, and the
  `beforeinput` fallback covers any single character rather than only `§` inside the composer. macOS
  delivers the section-sign key to an editable surface as text input without a matching keydown on
  some layouts.
- Toggling a right panel whose tabs were all closed opens it on the Files surface instead of showing
  an empty shell, and reopening restores the surface that was selected before it was hidden. The
  maximize flag is keyed by the same thread as the panel state; keying it by the route desynced the
  two whenever a draft became a thread.
- Source: `apps/web/src/components/ChatView.tsx`, `apps/web/src/rightPanelStore.ts`.

## Composer density and the stash badge

- The editor must apply both `containerClassName` and `placeholderClassName`. The resting
  layout uses them to give the editor available row width and clip the placeholder to one line.
  Dropping these bindings makes an empty editor shrink and its placeholder spill over the toolbar.
- The editor starts at one line and grows with its text. The compact composer uses a single prompt
  row, and the expanded view keeps tighter padding than upstream.
- Losing focus alone does not collapse the prompt, and multiline drafts remain readable. The
  scroll-driven resting layout this section described is now removed, as recorded above.
- Stashes use an inline chip in the footer or relocated controls. The chip anchors a small floating
  menu; opening it does not expand the prompt.
- Sources: `apps/web/src/components/chat/ChatComposer.tsx`,
  `apps/web/src/components/ComposerPromptEditor.tsx`,
  `apps/web/src/components/composerFooterLayout.ts`.

## Resizable columns stretch their panes

- `ResizableColumns` put each pane in a flex item that never grew, so a pane was as wide as its own
  longest line and the rest of the column was clipped. Dragging the divider moved the split without
  the Git history commit description or diff reflowing into the space. Both panes now stretch.
- Source: `apps/web/src/components/ui/resizable-columns.tsx`.

## A finished pull request no longer settles its thread

- Upstream settled a thread the moment its change request closed, and settled a merged one unless
  `sidebarAutoSettleOnMerge` was off. One switch now governs both terminal states and defaults to
  off, so a merged or closed pull request leaves the thread in the inbox until it is settled by
  hand. Turning the switch on restores the upstream behaviour for both states.
- Mobile reads the same preference and defaults it the same way.
- Older upstream builds persisted `true` as their default. Client hydration resets that inherited
  value to `false`; the settings UI records later choices explicitly, so a deliberate opt-in stays
  enabled. This migration also covers pull requests linked directly to a thread.
- Source: `packages/client-runtime/src/state/threadSettled.ts`, `packages/contracts/src/settings.ts`,
  `apps/web/src/hooks/useSettings.ts`, `apps/web/src/components/settings/SettingsPanels.tsx`,
  `apps/mobile/src/features/threads/threadListV2.ts`.

## Claude settings keep account isolation

- Upstream's **Auto-compact after** field appears alongside the fork's `CLAUDE_CONFIG_DIR` field.
  The last merge kept both schema fields but resolved the form order to the fork-only list, which
  left the new control after the ordered fields and produced contradictory tests.
- Source: `packages/contracts/src/settings.ts`,
  `apps/web/src/components/settings/ProviderSettingsForm.test.ts`.

## Manual settlement shortcut remains available

- `mod+shift+s` settles or restores the active thread while the terminal is not focused. The merge
  had the web handler and documentation but dropped the default binding from the shared list because
  it landed beside the fork's numbered project-slot bindings.
- Source: `packages/shared/src/keybindings.ts`, `apps/server/src/keybindings.test.ts`,
  `apps/web/src/components/ChatView.tsx`, `docs/user/keybindings.md`.

## Thread and project accent colours

- Right-clicking a thread offers a Colour submenu: ten muted tones or none, with preview squares.
  Both the main and legacy sidebars offer the same picker and render the saved thread accent.
  The colour enters the
  card from the left as a gradient that gives out by 29% of the width, over a two-pixel rule on the
  leading edge. The tail fades to transparent rather than to a fixed dark, so the same colour reads
  correctly on either theme.
- A project takes a colour in its settings, from the same ten or any custom colour. It marks that
  project's threads from the right, and only while the sidebar is showing every project: scoped to
  one project it would paint every row alike and say nothing. Both gradients combine on one card.
- The project's colour also washes its row in the sidebar's project scope menu and the trigger that
  shows the current scope.
- Colours are stored per device alongside the sidebar thread arrangement. They describe one
  person's view of the work rather than the state of a thread or a project, so nothing crosses the
  wire. Nothing is coloured until you colour it.
- Source: `apps/web/src/lib/accentColors.ts`, `apps/web/src/accentColorStore.ts`,
  `apps/web/src/components/threadActionMenu.logic.ts`, `apps/web/src/components/Sidebar.tsx`,
  `apps/web/src/hooks/useThreadActionMenu.ts`,
  `apps/web/src/components/settings/ProjectSettingsPanel.tsx`.

## Open on the host as its own button

- The pull-request panel puts "Open on GitHub" (or GitLab, Bitbucket, Azure DevOps) beside the merge
  action rather than only inside the overflow menu. It is the action most reached for after the
  merge, and a menu entry made it a two-step.
- Source: `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx`,
  `apps/web/src/components/pullRequest/pullRequestLinkContextMenu.ts`.

## Numbered project slots on mod+1..9

- `mod+1`..`mod+9` scope the sidebar to a project rather than jumping to the Nth thread. Hovering a
  project in the scope menu and pressing `ctrl+1`..`ctrl+9` puts it in that slot; the slot is shown
  on the row afterwards, and a project answers to one slot at a time. The file structure view moved
  from `mod+1` to `mod+shift+1`, since a slot shadowed by another binding is worse than a longer
  chord.
- `thread.jump.*` remains a bindable command, just not a default. A config written against the old
  bindings is migrated on startup: numbered thread jumps become the matching project slots and a
  `mod+1` file-structure rule moves to `mod+shift+1`. Without the migration the backfill would
  refuse to add the new defaults, because the rules being replaced already claim those shortcuts.
- Which project a number recalls is stored per device: it is a habit built at one desk, not a
  property of the project.
- Source: `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`,
  `apps/server/src/keybindings.ts`, `apps/web/src/projectSlotStore.ts`,
  `apps/web/src/components/Sidebar.tsx`.

## Usage account identity and colours

- Usage sources keep the configured provider instance so transcript attribution remains distinct
  for separate accounts. The September 7 sync deliberately adopts upstream's historical chart
  presentation and pooled limits UI instead of the fork's separate account spend cards.
- Native account badges in pooled limits reuse configured provider accents. The fork's
  past-24-hours breakdown keeps every hour in chronological order.
- Each pooled account segment uses its configured accent for the remaining fill, reset hatching,
  and name marker, with the provider color as fallback. A persistent colored edge identifies
  exhausted accounts too. Narrow-screen legend rows use the same colors and keep account names.
- Sources: `packages/contracts/src/usage.ts`, `apps/server/src/usage/UsageService.ts`,
  `packages/shared/src/usageMerge.ts`, `apps/web/src/components/usage/UsageLimitsPooled.tsx`,
  `apps/web/src/components/usage/UsagePage.tsx`.

## Deleting from the file tree

- Right-clicking a file or a folder in the Files tree offers to delete it, which previously needed a
  multi-select and a toolbar button. Folders had no context menu at all before. A folder's menu drops
  the two items that mean nothing for it (copy mention, add to chat), and the confirmation says when
  a folder takes its contents with it.
- Backspace (or Delete) removes the selected entries while the file list has focus, and the delete
  can be taken back with the platform's undo chord or the toast's Undo. Shift-click ranges and
  Cmd-click toggles were already there and now feed both.
- Undo restores from contents read just before the delete. It is offered only when every entry in
  the set is a whole text file under 8 MB in total: a folder, a binary, or a file too large to have
  been read in one piece cannot be reconstructed, and a partial restore reads as a working undo
  while quietly leaving work behind. The confirmation says which of the two it is going to be.
- The undo entry is scoped to the directory it was taken from, and the panel takes focus after a
  delete so the chord still has somewhere to land once the rows unmount.
- Source: `apps/web/src/components/files/FileBrowserPanel.tsx`,
  `apps/web/src/components/files/NativeProjectFileTree.tsx`,
  `packages/client-runtime/src/state/projectCommands.ts`.

## Revealing a file keeps the rest of the tree open

- Opening a file expanded its ancestors by replacing the expanded set, so opening something in one
  directory shut every directory the reader had opened elsewhere. The reveal now adds its ancestors
  to what is already open. Collapsing the tree stays the collapse button's job.
- Source: `apps/web/src/components/files/NativeProjectFileTree.tsx`.

## A configurable app accent

- Appearance takes an accent colour: eight presets or any colour from the platform picker. It drives
  primary buttons, the focus ring, the send action and the update pill, all of which derive from
  `--primary`. Unset by default, which leaves the stock blue exactly where it was.
- A chosen colour keeps its hue and chroma but is pulled into the lightness band the stock accent
  occupies, separately per appearance, since that band is what everything painted on the accent was
  contrast-checked against. The label colour is then picked for readability on the result, so a pale
  yellow and a deep navy both stay legible. A grey, having no hue to preserve, is placed at the
  standard lightness rather than left to dissolve into the surface.
- Stored as hex and parsed again at the point it reaches the document, so neither the settings file
  nor the runtime can put arbitrary CSS into a custom property. It is written as an inline property
  on the root element; theme palettes only ever set `--app-theme-*`, so the two do not fight, and an
  explicit accent wins over the active theme's until it is cleared.
- Source: `packages/contracts/src/settings.ts`, `apps/web/src/themePalette.ts`,
  `apps/web/src/routes/__root.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`.

## Dragging a thread plays once

- Auto-animate sits on the thread list, so the drop's reorder was FLIPped through as a fresh
  animation: the row travelled back to where it started and then replayed, by itself, the move the
  pointer had just made. It is held off for the commit that lands the new order and switched back on
  a frame after that has painted, so a drag now reads as one movement.
- Sortable rows also opted out of dnd-kit's own layout animation. The drop commits the order itself,
  so the row is already where it belongs by the time dnd-kit would animate it there.
- The dragged card lifts instead of fading: a shadow and a faint accent ring on the card rather than
  80% opacity on the row, since the card being moved is the one that most needs to stay readable.
  Its `content-visibility` is pinned while it moves, which stops a long drag blanking the card as it
  crosses out of view.
- Source: `apps/web/src/components/Sidebar.tsx`.

## Markdown links open against the document's own checkout

- A link inside a previewed markdown file opened a file surface with no workspace root, so the panel
  fell back to the thread's checkout. Reading a document from the project while the thread runs in a
  worktree therefore produced dead links: the path was correct, the tree it was looked up in was
  not. The surface now carries the root the link was resolved against, which is the root the
  document itself was read from.
- The basename lookup behind a bare `notes.md` link searched the document's directory rather than
  its workspace root. The entry index is keyed by root, so a document in a subdirectory found
  nothing to disambiguate with.
- Source: `apps/web/src/components/ChatMarkdown.tsx`.

- Chat file links are resolved against the complete multi-directory project, not only the thread's
  primary checkout. Absolute links select the configured root that contains the file. Relative
  links may start with a directory basename or its configured label, which is stripped before the
  file tab opens. Every relative path, including a path such as `yb-cli/internal/file.go` with no
  project-directory prefix, is checked against every root on click. Bare filenames use the same
  lookup, with the active checkout first. This resolution happens while opening the link, so old
  chat messages gain the corrected behavior without being rewritten. External host files remain
  absolute and read-only.
- The selected file tab stores both the relative path and its owning workspace root. This prevents
  the file viewer from asking the primary directory to read a path owned by a secondary directory.
- Source: `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/markdown-links.ts`,
  `apps/web/src/workspaceBasenameLookup.ts`. Regression coverage:
  `apps/web/src/markdown-links.test.ts`, `apps/web/src/workspaceBasenameLookup.test.ts`.

## The right panel's shortcuts answer from anywhere

- They are owned by one listener mounted at the app root, ahead of everything else, instead of by
  whichever chat view happened to be mounted. That is what made a bare printable binding — `§` on a
  Mac ISO layout — work on some routes and type itself into a field on others, and it is why it
  sometimes lost to a listener registered later. Settings is the one exception: it is where the
  binding is read and edited, so a keypress there belongs to the page.
- The key is claimed whether or not there is a thread to act on. A binding that types itself in some
  places and not others is worse than one that occasionally does nothing.
- Maximize moved from chat-view state into the panel store, where the rest of the panel's state
  already lives, so the same listener can own both shortcuts.
- Hiding a panel now gives up its maximized state, in every direction and by every route out
  (toggle, close, closing the last tab). A panel hidden while maximized used to come back filling
  the workspace, which left the chat column at zero width — the chat looked blank until switching
  threads changed the key the stale flag hung on.
- Source: `apps/web/src/components/RightPanelShortcuts.tsx`, `apps/web/src/rightPanelStore.ts`,
  `apps/web/src/components/ChatView.tsx`, `apps/web/src/routes/__root.tsx`.

- The macOS ISO section-sign key is treated as one physical shortcut pair across Electron versions.
  Plain `§` toggles the right panel. Shift on that key, which macOS emits as `±`, toggles the
  panel's maximized state and toggles it back. The matcher accepts `§`, `±`, and Electron's
  `Unidentified` key value with the physical key code. The `beforeinput` fallback reconstructs the
  missing Shift state from `±`, so neither character reaches the chat editor.
- Regression coverage: `apps/web/src/keybindings.test.ts` exercises keydown and modifier-less text
  input for both commands.

## User documentation for the fork's behaviour

- `docs/user/` now covers what this fork changed for a reader: numbered project slots and the
  keybinding migration that lands them, the app-wide right-panel shortcuts, inbox drag ordering and
  thread colours, a finished pull request no longer settling its thread, the per-account usage
  breakdown, branch ahead/behind with fetch and pull, and file-tree selection, deletion and undo.
- Two pages are new, `appearance.md` and `files.md`, both listed in `docs/README.md`.
- Source: `docs/README.md`, `docs/user/keybindings.md`, `docs/user/thread-sidebar.md`,
  `docs/user/project-settings.md`, `docs/user/usage.md`, `docs/user/source-control.md`,
  `docs/user/appearance.md`, `docs/user/files.md`.

## Upstream sync: 2026-08-20

- Rebased the fork's merge base forward from `d484735c6` to upstream `main` at `8824f8f24`.
- Preserved the fork's multi-directory projects, per-account Claude usage limits, file-tree selection and deletion, markdown-link roots, app-wide right-panel shortcuts, prompt collapse, thread colours, and right-click-only tab closing while integrating the upstream web, server, desktop, mobile, contracts, and runtime changes.
- Kept the account-limit implementation from PR #5739 (`54d006d52`); that PR is not an ancestor of current upstream `main`, so its behavior was reconciled explicitly rather than relying on the upstream branch to contain it.
- Added focused merge validation for the composer, thread actions, status indicators, right-panel tabs, usage attribution, and thread-settlement rules. The resolved merge is intentionally left uncommitted so it can be reviewed before it is recorded or pushed.

## Upstream sync audit: 2026-08-26

- Audited merge `7f25b7c35`, whose parents are the fork at `3166b39d55` and upstream at
  `b0a028126`. The audit covered every file changed on both sides, not only Git's conflict list.
- Preserved the fork's pull-request settlement policy across branch-discovered and linked pull
  requests. Old upstream-persisted `true` values now migrate to the fork default until the user
  explicitly enables the setting.
- Kept automatic hosted model-manifest requests behind
  `T3CODE_ENABLE_PROVIDER_VERSION_CHECKS=true`, matching the fork's existing network policy.
- Reconciled Claude settings so `configDir` remains the account-isolation control while `homePath`
  remains the advanced process `HOME` override. Upstream's auto-compaction control appears beside
  both instead of replacing either one.
- Restored upstream's manual settlement shortcut without taking back the fork's `mod+1..9` project
  slots.
- Repaired the migration number collision. Migration 41 runs both additive changes on a fresh
  database, and compatibility migrations 43 and 44 repair databases created from either history.

## Upstream sync: Codex 0.150 compatibility

- Merged upstream `main` through `d3c24a14b` in merge commit `87d9027dc`, while preserving the
  fork's existing behavior and restoring all in-progress local work afterward.
- Included upstream's Codex 0.150 protocol compatibility fix. Generated schemas now accept the new
  multi-agent tools, the `interrupted` tool-call status, and completed subagent activity events.
- Included upstream's static active-list behavior for restored threads: explicitly un-settling a
  thread re-anchors it at the top without allowing ordinary activity to reorder the sidebar.
- Moved upstream's new `ProjectionThreadsUnsettledAt` migration from 43 to 45. IDs 43 and 44 remain
  reserved for this fork's existing migration-collision compatibility repairs.
- Kept finished pull requests from settling threads unless the user explicitly enables
  **Auto-settle finished threads**; the new upstream paths do not bypass that fork policy.
- Imported upstream's release/preview workflow improvements and v0.0.35 package metadata without
  building, installing, restarting, or otherwise touching the currently running app.

## Upstream sync: 2026-08-28

- Merged upstream `main` through `0bbecfabf` in merge commit `a370f51a7`, then restored the
  fork's staged in-progress work. The pre-merge tree remains recoverable from
  `backup/pre-upstream-sync-20260828` and the `pre-upstream-sync-20260828-fork-work` stash.
- Reconciled upstream's exclusive thread-settling policy with the fork rule. Automatic settling is
  now one explicit choice — **Never**, **Pull request merged or closed**, or **Inactivity** — and
  defaults to **Never**. Missing or malformed pull-request timestamps keep a thread active.
- Kept migration IDs 43 and 44 reserved for the fork's compatibility repairs and retained
  `ProjectionThreadsUnsettledAt` as migration 45.
- Preserved multi-directory projects, account-specific Claude usage, account limits, markdown links
  rooted in the document checkout, project scripts/actions, right-panel behavior, typography,
  branch controls, and the fork's provider/network defaults while integrating upstream Codex 0.150
  plans, OpenCode child-session support, provider catalogs, mobile themes, preview fixes, and
  provider/settings improvements.
- Repaired clean-merge semantic collisions found by typechecking: appearance contrast, account-limit
  RPC imports, provider skill menus, mobile settlement state, usage attribution including Grok,
  OpenCode output bounds, analytics test wiring, and provider-refresh compatibility.

## Fork guarantee audit: 2026-09-01

- Added a host filesystem subscription for every visible workspace tree. Directory and file
  changes now arrive through `projects.watchEntries`, are coalesced before crossing RPC, and
  invalidate the Files tree, Git status, Working tree / Branch changes, and the Commit view. This
  does not depend on Claude, Codex, or another provider reporting a `file_change` or
  `command_execution` activity event; those events remain a supplemental refresh path.
- Workspace file contents and full tree listings do not use the client query cache. Their query
  atoms retain no previous value, have a zero idle TTL, and deliberately render an empty loading
  state while each disk request is in flight. Opening a file, reopening the Files surface, toggling
  the right panel, or pressing Refresh therefore completes a new server read before any contents or
  entries are shown. The non-Git tree fallback also refreshes its filesystem index before every
  listing instead of returning an older index snapshot.
- A visible file keeps its narrower per-file watcher, while each visible tree has a root watcher, so
  content rewrites and directory membership changes trigger another uncached read without relying
  on provider activity events. Image URLs and open per-file commit diffs retain their own mutation
  refresh behavior.
- The Files panel now maps the project's primary directory slot to the thread's active checkout or
  worktree. Previously, passing the project's multi-directory configuration replaced that active
  root with the original checkout, so an agent could update a worktree while Files repeatedly read
  an older same-named file from the main checkout. Secondary project directories keep their
  configured roots.
- The file tree has its own worktree dropdown. It reads Git's live worktree list, shows the branch
  and absolute path for each checkout, orders them by latest branch commit, and switches only the
  Files panel root without changing the thread workspace or checking out a branch for the agent.
- Workspace selector synchronization cannot mutate a started thread. Only an explicit pointer or
  keyboard item choice may detach a worktree. An intentional switch to **Current checkout** now
  stores that checkout's real branch together with the null worktree path, preventing a thread from
  advertising its old worktree branch while Files and the next agent use the main checkout.
- Kept editable-file optimistic contents authoritative until their save settles, then applies any
  pending external refresh. Multi-directory pending state is keyed by workspace root as well as
  relative path, so the same file name in two roots cannot suppress the wrong refresh.
- Restored the documented editor surfaces deleted or orphaned by merge reconciliation: Search
  Everywhere, symbol navigation, back/forward history, clickable breadcrumb navigation, Files /
  Structure / Commit explorer switching, and per-file Commit diffs. The restored integration uses
  the current multi-root, resizable explorer and current diff renderer rather than reverting those
  newer fork changes.
- Restored the persisted **Editor tabs** preference and its Settings/Search Everywhere controls.
  Hidden-tab mode retains compact surface icons and the add-surface control.
- Restored the default-off `T3CODE_ENABLE_SAFE_STORAGE_KEYCHAIN` gate so ad-hoc local builds do not
  touch macOS Safe Storage unless explicitly opted in.
- Audited every repository path named in this file; all documented source paths are present.
- Source for the filesystem subscription:
  `apps/server/src/workspace/WorkspaceEntries.ts`, `apps/server/src/ws.ts`,
  `packages/contracts/src/project.ts`, `packages/contracts/src/rpc.ts`,
  `packages/client-runtime/src/state/projectCommands.ts`,
  `packages/client-runtime/src/state/runtime.ts`,
  `apps/web/src/components/files/projectFilesQueryState.ts`,
  `apps/web/src/components/files/filePreviewRoots.ts`,
  `apps/web/src/components/files/FilePreviewPanel.tsx`,
  `apps/web/src/components/BranchToolbar.logic.ts`,
  `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`,
  `apps/web/src/components/DiffPanel.tsx`, and
  `apps/web/src/components/files/GitChangesPanel.tsx`.

## Upstream sync: Claude Fable 5.1 and server-side settlement

- Merged upstream `main` through `163d50846`, including Claude Fable 5.1, manifest-driven Claude
  model discovery, provider and chat performance fixes, Electron 43 preview fixes, and the new
  thread-reference shortcut.
- Claude Fable 5.1 is bundled as `claude-fable-5-1` and requires Claude Code 2.1.257. The installed
  CLI already meets that boundary.
- Kept remote model-manifest requests behind `T3CODE_ENABLE_PROVIDER_VERSION_CHECKS=true`. The
  bundled Claude catalog works without that opt-in; future manifest-only model additions require
  the opt-in or another fork build.
- Adopted upstream's server-side settlement reactor so web, desktop, and mobile use one projected
  state. Preserved the fork's exclusive policies: **Never**, **When PR merges or closes**, and
  **After inactivity**. **Never** remains the default.
- Preserved per-account Claude usage attribution while integrating append-only transcript scans,
  and preserved the fork's project slots, thread colours, composer stack, multi-directory files,
  and app-wide right-panel behavior.
- A recovery branch named `backup/pre-fable-5-1-upstream-sync-20260901` points to the pre-merge tip.

## Upstream sync: 2026-09-02

- Synced `upstream/main` at `0681d8549` (upstream v0.0.38), including the latest pull-request,
  provider-skill, desktop-prerequisite, chat timeline, error-report, and performance fixes.
- Resolved the merge manually with fork behavior taking priority wherever the same code path was
  touched. In particular, multi-directory roots, fresh file reads and listings, worktree-aware
  files and diffs, right-click-only tab closing, the `§` shortcut, prompt/live-follow behavior,
  per-account Claude usage and limits, and default-off automatic settlement remain fork behavior.
- Reconciled upstream's newer timeline presentation and attachment/media paths with the fork's
  work-log grouping and live activity rows. Failed tool activity remains visible and selected file
  diffs remain on-demand so large worktrees do not eagerly load every file.
- Restored the fork's test-only atom reset and made updater tests opt in explicitly to the otherwise
  disabled auto-update path. The product default remains privacy-safe and opt-in.
- Validation for this sync: all package TypeScript checks pass with zero errors; focused web
  timeline, markdown-link, and file-freshness tests pass (160 tests); desktop updater tests pass.

## Upstream sync: 2026-09-03

- Merged `upstream/main` through `617edab65`, covering 169 upstream commits since the prior merge.
  The sync includes Antigravity provider support, browser profiles and cookie import, provider
  limit refreshes, project icons and auto-pull, diff-tree and preview improvements, current Codex
  compatibility, and the latest chat, settings, desktop, and performance fixes.
- Reconciled the merge semantically after the fork-first Git merge. Multi-directory projects,
  worktree-aware fresh file reads, multi-root markdown links, the `§` and `Shift+§` right-panel
  shortcuts, right-click-only tab closing, the compact project/composer strip, and the fork's
  thread-settlement policy remain authoritative.
- Kept per-account Claude and Codex limits while accepting the new provider-neutral limit event
  shape. Canonical 300-minute and 10,080-minute windows map back to the fork's 5h and weekly rows,
  and raw provider payloads remain available for account-specific parsing.
- Reserved migration IDs 43 through 45 for the fork and assigned the incoming upstream migrations
  IDs 46 through 49, avoiding collisions for both existing and newly created databases.
- Repaired timeline integration so completed activity remains present-tense while a turn is still
  active, single completed tool calls render directly, and the fork's activity presentation still
  receives upstream tool identity, browser, and image metadata.
- Validation for this sync: the complete workspace TypeScript check passes. Full web (3,712 tests),
  mobile (1,183 tests), relay (209 tests), and contracts (339 tests) suites pass with bounded
  concurrency. Focused server and fork regression coverage passes for settlement, per-account
  limits, bootstrap cleanup, entrypoint handling, Antigravity discovery, keybindings, multi-root
  links, file freshness, tabs, branches, and timeline behavior.

## Validation Notes

The fork-local changes above were validated with focused server tests, the full web unit suite,
Chromium component tests, formatting/lint checks, TypeScript checks, and earlier full
desktop/provider checks while preparing the macOS build.
