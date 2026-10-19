# d4research Apple builds

The production iPhone and iPad app is one universal iOS application. Its native
project is checked in so Xcode Cloud can discover the shared `d4research` scheme.
Open `apps/mobile/ios/d4research.xcworkspace` after installing dependencies.

The application identifier is `ai.dimaggi.d4research`, with `.widgets` and
`.sharing` extension identifiers. All three use Apple Developer team
`CR2PTQ345T` and the App Group `group.ai.dimaggi.d4research`. Register these under
that team and associate the App Group with all three identifiers. Enable push
notifications for the app and widget extension where required by their
entitlements.

## Xcode Cloud workflow

Connect `qvad/d4research` and select branch `master`, workspace
`apps/mobile/ios/d4research.xcworkspace`, and scheme `d4research`. Use Xcode 27
or later. Add an **Archive — iOS — App Store Connect** action and a
**TestFlight Internal Testing** post-action pointing to the intended tester
group. A build-only action does not upload a TestFlight build.

Xcode Cloud discovers `ci_scripts` beside the workspace. `ci_post_clone.sh`
installs Node 24, the repository-pinned pnpm version, CocoaPods, and Watchman,
restores frozen JavaScript and native dependencies, and applies `CI_BUILD_NUMBER` to the app and both extensions.
React Native is compiled from source because the liquid-glass module requires
headers missing from its prebuilt framework. The preparation script enables
the native layout module’s iOS 27.1 hinge APIs only when the selected SDK
provides them; older SDKs retain the existing safe-area metrics.
Signing is automatic. Apple manages the distribution signing credentials.

The Xcode shell environment raises Metro's soft open-file limit to at most
65,536 without changing the build service's hard limit. This avoids `EMFILE`
while scanning the monorepo's icon package during release packaging.
The Expo updates resource phase uses a non-login shell so machine login profiles
cannot replace these build settings or lower its hard file limit.

The App Store Connect app must use the exact registered application identifier,
not an identifier derived from its display name. Select iOS as the platform;
the resulting archive supports both iPhone and iPad.

## Native project maintenance

JavaScript-only changes do not require prebuild. When changing Expo plugins,
native dependencies, or `app.config.ts`, regenerate the committed native files:

```sh
pnpm install --frozen-lockfile
cd apps/mobile
scripts_backup=$(mktemp -d)
cp -R ios/ci_scripts "$scripts_backup/ci_scripts"
APP_VARIANT=production pnpm exec expo prebuild --clean --platform ios --no-install
cp -R "$scripts_backup/ci_scripts" ios/ci_scripts
cd ios
RCT_USE_PREBUILT_RNCORE=0 pod install
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" ci_scripts/prepare_signing.rb
```

The backup preserves `ios/ci_scripts` because Expo recreates the entire native
directory. Review and commit
the project, native sources, workspace, and `Podfile.lock`. Never commit Pods,
build output, signing certificates, or `.xcode.env.local`.

The fork does not receive updates from upstream T3's Expo account. OTA updates
are disabled unless `T3CODE_MOBILE_UPDATES_ENABLED=1` and
`T3CODE_MOBILE_UPDATES_URL` are configured. Optional EAS metadata uses
`T3CODE_MOBILE_EAS_PROJECT_ID` and `T3CODE_MOBILE_EXPO_OWNER`. Supply these
consistently when regenerating the native project and building JavaScript.

## macOS

The existing Electron desktop app remains a separate product and release path
described in [release.md](release.md). This iOS archive is not a macOS Electron
archive. Enabling the iOS app on Apple Silicon Macs provides the mobile remote
client, not the desktop app's local agent host. A native macOS TestFlight release
of Electron requires MAS packaging, sandbox-compatible entitlements, and
validation of local provider subprocess and filesystem behavior before it can
be distributed.
