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
installs Node 24, pnpm 11.10.0, CocoaPods, and Watchman, restores frozen JavaScript and
native dependencies, and applies `CI_BUILD_NUMBER` to the app and both extensions.
Signing is automatic. Apple manages the distribution signing credentials.

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
pod install
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" ci_scripts/prepare_signing.rb
```

The backup preserves `ios/ci_scripts` because Expo recreates the entire native
directory. Review and commit
the project, native sources, workspace, and `Podfile.lock`. Never commit Pods,
build output, signing certificates, or `.xcode.env.local`.

The fork does not receive updates from upstream T3's Expo account. OTA updates
are disabled unless `D4_EXPO_UPDATE_URL` is explicitly configured; optional EAS
metadata uses `D4_EAS_PROJECT_ID` and `D4_EXPO_OWNER`. Supply these consistently
when regenerating the native project and building JavaScript.

## macOS

The existing Electron desktop app remains a separate product and release path
described in [release.md](release.md). This iOS archive is not a macOS Electron
archive. Enabling the iOS app on Apple Silicon Macs provides the mobile remote
client, not the desktop app's local agent host. A native macOS TestFlight release
of Electron requires MAS packaging, sandbox-compatible entitlements, and
validation of local provider subprocess and filesystem behavior before it can
be distributed.
