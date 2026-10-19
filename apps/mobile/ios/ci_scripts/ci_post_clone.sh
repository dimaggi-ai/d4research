#!/bin/sh
# Xcode Cloud post-clone step. The native project is committed (Xcode Cloud needs it
# present before this runs); this installs the JavaScript dependencies its build
# phases and Podfile read, then the CocoaPods excluded from source control.
#
# After changing app.config.ts or native dependencies, regenerate the project on a Mac with
# `expo prebuild --clean --platform ios`, then `git restore ios/ci_scripts` (--clean deletes
# this folder), then `pod install`, and commit ios/ including Podfile.lock.
#
# Set T3CODE_IOS_BUNDLE_ID in the Xcode Cloud workflow to sign under a team that does not own
# ai.dimaggi.d4research; this script rewrites the committed identifiers before the build.
set -eu

export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
brew list node@24 >/dev/null 2>&1 || brew install node@24
brew list cocoapods >/dev/null 2>&1 || brew install cocoapods
brew list watchman >/dev/null 2>&1 || brew install watchman
NODE_BIN="$(brew --prefix node@24)/bin"
export PATH="$NODE_BIN:$PATH"

export APP_VARIANT="${APP_VARIANT:-production}"
export EXPO_NO_GIT_STATUS=1
# @callstack/liquid-glass imports RCTConversions.h, which the prebuilt React.xcframework omits.
export RCT_USE_PREBUILT_RNCORE=0
export NODE_OPTIONS=--max-old-space-size=8192

REPO="$CI_PRIMARY_REPOSITORY_PATH"
cd "$REPO"
npm install --global "$(node --print "require('./package.json').packageManager")"
pnpm install --frozen-lockfile --filter . --filter "@d4research/mobile..."

cd "$REPO/apps/mobile/ios"
BUNDLE_ID="${T3CODE_IOS_BUNDLE_ID:-}"
if [ -n "$BUNDLE_ID" ]; then
  # Same pattern app.config.ts enforces.
  if ! printf '%s\n' "$BUNDLE_ID" | grep -Eqx '[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'; then
    echo "T3CODE_IOS_BUNDLE_ID must be a reverse-DNS identifier such as com.example.d4." >&2
    exit 1
  fi
  # Covers the app, .widgets and .sharing targets and the group.<id> app group.
  BUNDLE_ID="$BUNDLE_ID" perl -pi -e 's/ai\.dimaggi\.d4research/$ENV{BUNDLE_ID}/g' \
    d4research.xcodeproj/project.pbxproj \
    d4research/Info.plist d4research/d4research.entitlements \
    ExpoWidgetsTarget/Info.plist ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements \
    expo-sharing-extension/Info.plist expo-sharing-extension/expo-sharing-extension.entitlements
fi

# ExpoWidgets embeds the checkout path in its podspec script phases, so its
# checksum changes on Cloud. Keep locked pod versions while refreshing metadata.
pod install

GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" ci_scripts/prepare_signing.rb

# Xcode build phases do not inherit this shell; React Native sources .xcode.env.local.
# The expo-constants phase evaluates app.config.ts, so it needs the same identifier.
cat > .xcode.env.local <<ENV
export NODE_BINARY="$NODE_BIN/node"
export PATH="$NODE_BIN:$(brew --prefix)/bin:\$PATH"
export CI=1
export RCT_USE_PREBUILT_RNCORE=0
export NODE_OPTIONS="$NODE_OPTIONS"
export APP_VARIANT="$APP_VARIANT"
export T3CODE_IOS_BUNDLE_ID="$BUNDLE_ID"
ENV
