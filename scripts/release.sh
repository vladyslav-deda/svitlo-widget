#!/usr/bin/env bash
# Publish a new version to GitHub Releases.
#   1. bump "version" in package.json, commit, push
#   2. npm run release
# Windows clients pick the release up by themselves (electron-updater reads latest.yml from it).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
command -v gh >/dev/null || { echo "Потрібен GitHub CLI: brew install gh && gh auth login"; exit 1; }
export GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"

if [ -n "$(git status --porcelain)" ]; then echo "Є незакомічені зміни — спершу commit + push."; exit 1; fi
if gh release view "$TAG" >/dev/null 2>&1; then echo "Реліз $TAG вже існує — збільште version у package.json."; exit 1; fi
git push -q

echo "▸ тести";            npm test --silent
echo "▸ Windows $TAG";     npx electron-builder --win nsis --x64 --publish always
echo "▸ macOS $TAG";       npx electron-builder --mac dir --arm64 --publish never
codesign --force --deep -s - dist/mac-arm64/Svitlo.app
ZIP="dist/Svitlo-$VERSION-mac-arm64.zip"
rm -f "$ZIP"; ditto -c -k --keepParent dist/mac-arm64/Svitlo.app "$ZIP"
gh release upload "$TAG" "$ZIP" --clobber

echo "✓ $(gh release view "$TAG" --json url -q .url)"
