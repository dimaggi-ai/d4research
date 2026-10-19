#!/bin/bash
set -euo pipefail

REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
export HOMEBREW_NO_AUTO_UPDATE=1
brew list node@24 >/dev/null 2>&1 || brew install node@24
brew list cocoapods >/dev/null 2>&1 || brew install cocoapods
brew list watchman >/dev/null 2>&1 || brew install watchman
export PATH="$(brew --prefix node@24)/bin:$PATH"

# Pin the package manager to package.json without depending on the runner image.
TOOLS_DIR="${TMPDIR:-/tmp}/d4-cloud-tools"
npm install --prefix "$TOOLS_DIR" --no-audit --no-fund pnpm@11.10.0
export PATH="$TOOLS_DIR/node_modules/.bin:$PATH"
cd "$REPO_ROOT"
pnpm install --frozen-lockfile

cd apps/mobile/ios
printf 'export NODE_BINARY="%s"\nexport PATH="%s/bin:%s/bin:$PATH"\nexport APP_VARIANT=production\nexport CI=1\n' "$(command -v node)" "$(brew --prefix node@24)" "$(brew --prefix)" > .xcode.env.local
printf 'ulimit -n 65536\n' >> .xcode.env.local
pod install --deployment
# CocoaPods plugins may rewrite project settings; apply release metadata last.
GEM_HOME="$(brew --prefix cocoapods)/libexec" "$(brew --prefix ruby)/bin/ruby" ci_scripts/prepare_signing.rb
