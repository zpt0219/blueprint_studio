#!/usr/bin/env bash
# Build blueprint-studio locally and publish dist/ to gh-pages branch.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="$(git -C "$REPO" remote get-url origin 2>/dev/null || echo "")"

if [ -z "$REMOTE" ]; then
  echo "Error: git remote 'origin' is not configured yet."
  exit 1
fi

echo "==> building blueprint-studio"
( cd "$REPO" && npm ci && npm run build )

echo "==> publishing dist to gh-pages"
TMP="$(mktemp -d)"
cp -r "$REPO/dist/." "$TMP/"
touch "$TMP/.nojekyll"
git -C "$TMP" init -q
git -C "$TMP" checkout -q -b gh-pages
git -C "$TMP" add -A
git -C "$TMP" commit -qm "deploy blueprint-studio dist"
git -C "$TMP" push -fq "$REMOTE" gh-pages
rm -rf "$TMP"
echo "==> done."
