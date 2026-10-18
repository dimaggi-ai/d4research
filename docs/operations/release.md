# Release Checklist

> For maintainers. Using d4research? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## Publication is opt-in for this fork

The d4research release line stays isolated from upstream's distribution channels and publishes
under the `d4research` CLI package name. Every outward-facing job (npm publish, GitHub Release
publication, the version-alignment commit to `main`, and the Discord announcement) is gated behind
the repository variable `RELEASE_PUBLISH_ENABLED`.

While that variable is unset, pushing a `v*.*.*` tag still runs the quality gates and builds every
desktop artifact, then stops: nothing is published anywhere. Set `RELEASE_PUBLISH_ENABLED=true` on
the repository to enable publication, and review the CLI package name first.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - manual `workflow_dispatch` with `channel=stable`, the normal way to ship stable. Stable
    and nightly dispatches must select `main`; preview may select any branch. The channel defaults
    to preview so an omitted selection cannot publish a stable release.
  - push tag matching `v*.*.*` for a stable release of an explicit commit
  - scheduled nightly check every 30 minutes
  - manual `workflow_dispatch` with `channel=nightly`
  - manual `workflow_dispatch` with `channel=preview`, the maintainers' test train. It exercises the whole release flow (build, sign, notarize, smoke, publish) for a commit that end users must never receive, which is how an unmerged branch or a risky change gets a real release run before it lands. It builds the triggering commit with nightly's versioning under the `preview` prerelease identifier (`0.0.41-preview.<date>.<run>`) and publishes a GitHub prerelease plus the npm packages under the `preview` dist-tag. Preview is not on the schedule, no default npm dist-tag points at it, its desktop builds carry no update feed, and no updater manifest (`latest*.yml`, `nightly*.yml`, blockmaps) is attached, so a stable or nightly install cannot be offered one. The only ways onto it are downloading the release by hand, `npx d4research@preview`, `T3CODE_CHANNEL=preview` for the install scripts, or `d4research update --channel preview` from a terminal; each prints a warning, and the CLI asks for confirmation when the running build is not itself a preview. The release itself is named as a maintainer test build and its body is a warning rather than generated notes: a changelog of unmerged branch history is not a changelog, and nightly and stable notes are unaffected because each series resolves its previous tag within its own channel. Discord announcements are skipped. Keep it; it costs nothing when idle.
- A manual stable release builds the commit of the latest published nightly, not `main` HEAD.
  Nightly is the release candidate: verify the nightly, then promote it. Merges to `main` keep
  landing while you verify and never leak into the stable build.
  - The version defaults to the one the nightly previewed (`0.0.39-nightly.*` ships as `0.0.39`).
    Pass the `version` input to override it, for example for a minor bump.
  - The stable tag is created on the nightly's commit when the GitHub Release is published.
  - Pushing a `vX.Y.Z` tag by hand still works and builds exactly the tagged commit. Use it when
    the commit to ship is not the latest nightly, such as a cherry-picked fix on a release branch.
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Builds the platform-independent JS (server bundle, web client, Electron main) once in the `build_bundle` job and hands it to every platform job as the `js-bundle` artifact; the platform jobs only package it, so no runner rebuilds it.
- Builds six desktop artifacts in parallel for both channels, each as its own job (`desktop_<platform>_<arch>`, one call of `release-desktop.yml`) on hardware of its own architecture, gated only on the bundle. The Windows jobs embed the same-arch Linux CLI archive as the WSL runtime and wait for that artifact partway through, not for the whole Linux job:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` and `arm64` AppImages
  - Windows `x64` and `arm64` NSIS installers
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Builds a self-contained CLI archive per platform (`d4research-<version>-<platform>-<arch>.tar.gz`, `.zip` on Windows) in the same job as that target's desktop artifact and attaches them to the GitHub Release with a `SHA256SUMS` file, on every channel, for five targets: macOS arm64, Linux x64 and arm64, Windows x64 and arm64. Every archive is built, signed, and smoke-tested on hardware of its own architecture. The CLI launcher supports those five targets. The macOS x64 desktop app uses Electron.
  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so unpacking it needs neither Node, npm, nor a compiler. It is the only form in which d4research manages a runtime: the desktop's SSH environments, the boot service, `d4research update`, and the install scripts all download and verify this archive against `SHA256SUMS`. The `d4research` npm package exists for people who run `npx d4research` or `npm install -g d4research` themselves, and it downloads this same archive too; nothing in the product installs from npm. The source installers are `scripts/install.sh` and `scripts/install.ps1`.
  - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`, kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on `engines.node`.
  - macOS archives are signed with the Developer ID certificate and notarized when the Apple secrets are present (ad hoc otherwise, which still runs from `curl`/`tar` installs). Windows executables use the same Azure Trusted Signing setup as the installer. Every native addon in the macOS archive is signed too, since the hardened runtime refuses unsigned libraries.
  - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`) before it is uploaded.
- After the GitHub Release is published, publishes the `d4research` npm package with OIDC trusted publishing from the same workflow file. It is only a launcher (`scripts/npm-launcher/d4research.mjs`): on first run it downloads its exact version's CLI archive from the GitHub Release, verifies it against `SHA256SUMS`, and unpacks it into `<T3 home>/runtime/versions/<version>`, the layout the install scripts and `d4research update` share. The npm package contains the launcher; executable archives are release assets. Because the launcher reads from the release, `publish_cli` runs after `release`, never before.
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
  - preview releases publish npm dist-tag `preview`, which nothing resolves unless asked for by name
  - one-time setup: package `d4research` needs a trusted publisher registered for this workflow file (see below).
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

Stable releases require these GitHub Actions secrets in addition to the platform
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The finalize job uses them to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the `d4research` npm launcher to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Servers that update
themselves download that version's CLI archive from the GitHub Release; servers run through npm are
handed a `d4research@<version>` command to run. Every released client version must therefore have its
release archives, and then its npm launcher, available before users can receive that client.

The workflow enforces this ordering:

1. `release` publishes the GitHub Release with the CLI archives and `SHA256SUMS`.
2. `publish_cli` publishes the `d4research@<version>` launcher, which downloads from that release, on every
   channel.

Desktop auto-update reads the GitHub Release directly, so a desktop client can see the new version
a few minutes before `d4research@<version>` is on npm. Only the copied manual command for npm-run servers
depends on npm, and it works once `publish_cli` finishes.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view d4research@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx d4research@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - if unset, no update feed is configured. The fork does not fall back to the
    ambient `GITHUB_REPOSITORY`, so a build never inherits an upstream channel.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship a
Linux-only `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar. WSL verifies
and extracts that archive into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside
the selected distro, then reuses it for later launches of the same update. The
Windows-side `wsl-server-tree/<version>` extraction remains a fallback and is
removed after the distro-local runtime passes preflight.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build with a WSL node-pty prebuild omits the WSL archive or SHA-256
  sidecar, the sidecar digest does not match the emitted archive, or required
  Linux runtime members are absent.
- The emitted WSL archive contains Windows/Darwin node-pty payloads, ConPTY,
  pnpm install metadata, or Windows-only FFF, ffi-rs, or msgpackr bindings.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

After the GitHub Release is published, the workflow runs `node scripts/build-npm-launcher.ts`, then
`node apps/server/scripts/cli.ts publish --packages-dir npm-packages`, which runs `npm publish` on
`d4research.tgz`. That is the only package published per release.

Checklist:

1. Confirm the npm org owns package `d4research`.
2. For `d4research`, configure a Trusted Publisher in the npm package settings:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; the workflow publishes the GitHub Release and then the
   launcher with npm dist-tag `latest`.
5. Nightly runs publish with npm dist-tag `nightly`; preview runs with `preview`.

## 1) Release validation and unsigned builds

With `RELEASE_PUBLISH_ENABLED=true`, there is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `d4research` with npm dist-tag
`latest`, creates a real GitHub Release, and can commit a version bump to `main` in the finalize
job. Do not push a test tag
to validate the workflow.

Publication is disabled while `RELEASE_PUBLISH_ENABLED` is unset. Once it is enabled, the workflow
has no per-run non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, and desktop updater release, but it does not update the stable channel or commit a
version bump to `main`. Only run it when a real nightly release is acceptable.

With publication enabled, manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `ai.dimaggi.d4research` and enable Associated Domains.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Re-run a tag release and confirm macOS artifacts are signed and notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.
- In-app browser passkeys depend on the same profile. The packager adds each entitlement only when
  the profile grants it, because macOS will not launch an app that claims more than its profile
  allows. The build log reports which ones it enabled.
  - `keychain-access-groups` (`<TEAM_ID>.ai.dimaggi.d4research.webauthn`) enables Touch ID passkeys.
    Profiles that grant the team's keychain groups (`<TEAM_ID>.*`) cover it.
  - `com.apple.developer.web-browser.public-key-credential` lets the system passkey sheet (iCloud
    Keychain, password managers, phones, security keys) serve any site. Apple grants it as a
    managed capability: the Account Holder requests it through the
    [macOS Browsers Passkeys form](https://developer.apple.com/contact/request/macos-browsers-passkeys/).
    After approval, regenerate the profile and update `MACOS_PROVISIONING_PROFILE`.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure the repository default branch is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
6. Smoke test downloaded artifacts.

For every release candidate, attach an applicability record instead of assuming upstream parity:

| Area        | Required decision and evidence                                                             |
| ----------- | ------------------------------------------------------------------------------------------ |
| Web         | Local and remote first-run journey, affected browser tests, supported browsers             |
| Desktop     | Each published OS/architecture, clean install, first launch, update, uninstall             |
| Mobile      | iOS/Android behavior for affected states, or an explicit unsupported note                  |
| Providers   | Supported adapter list, opt-in live-probe result, requested/resolved target evidence       |
| Connections | Local, Tailscale/SSH, reconnect, and version-skew behavior                                 |
| Memo        | Built-in vs external backend, oversized attachment, handoff, reload, missing-data recovery |
| Workflows   | Research and Dev target policy, actual delegate provenance, budget termination             |

Do not publish an artifact or product claim without a link to its matching test, smoke log, or
manual verification record. A source-only dogfood deployment is not evidence for signed desktop or
mobile distribution.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.ai.dimaggi.d4research` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
