#!/usr/bin/env bash
# Publish the current package.json version to GitHub Releases.
#   1. bump "version" in package.json, commit
#   2. npm run release
# Safe to re-run for the same version: the release is reused and its files are replaced.
# Windows clients update themselves from latest.yml attached to the release.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
command -v gh >/dev/null || { echo "Потрібен GitHub CLI: brew install gh && gh auth login"; exit 1; }
if [ -n "$(git status --porcelain)" ]; then echo "Є незакомічені зміни — спершу commit."; exit 1; fi

echo "▸ тести";             npm test --silent
echo "▸ збірка Windows";    npx electron-builder --win nsis --x64 --publish never
echo "▸ збірка macOS";      npx electron-builder --mac dir --arm64 --publish never
codesign --force --deep -s - dist/mac-arm64/Svitlo.app
MACZIP="dist/Svitlo-$VERSION-mac-arm64.zip"
rm -f "$MACZIP"; ditto -c -k --keepParent dist/mac-arm64/Svitlo.app "$MACZIP"

echo "▸ публікація $TAG"
git push -q origin HEAD
NOTES="docs/releases/$VERSION.md"
if ! gh release view "$TAG" >/dev/null 2>&1; then
  if [ -f "$NOTES" ]; then gh release create "$TAG" --title "Svitlo $VERSION" --notes-file "$NOTES" --target "$(git rev-parse HEAD)"
  else gh release create "$TAG" --title "Svitlo $VERSION" --generate-notes --target "$(git rev-parse HEAD)"; fi
elif [ -f "$NOTES" ]; then
  gh release edit "$TAG" --title "Svitlo $VERSION" --notes-file "$NOTES"
fi
gh release upload "$TAG" --clobber \
  "dist/Svitlo-Setup-$VERSION.exe" "dist/Svitlo-Setup-$VERSION.exe.blockmap" dist/latest.yml "$MACZIP"

echo "✓ $(gh release view "$TAG" --json url -q .url)"
