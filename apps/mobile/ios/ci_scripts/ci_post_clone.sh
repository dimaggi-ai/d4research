#!/bin/sh
# Xcode Cloud post-clone step. The native project is committed (Xcode Cloud needs it
# present before this runs); this installs the JavaScript dependencies its build
# phases and Podfile read, then the CocoaPods excluded from source control.
#
# After changing app.config.ts or native dependencies, regenerate the project with
# `expo prebuild --clean --platform ios` and `pod install` on a Mac, keeping this folder.
set -eu

export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
brew install node@24
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
pod install

# Xcode build phases do not inherit this shell; React Native sources .xcode.env.local.
cat > .xcode.env.local <<ENV
export NODE_BINARY="$NODE_BIN/node"
export NODE_OPTIONS="$NODE_OPTIONS"
export APP_VARIANT="$APP_VARIANT"
ENV
