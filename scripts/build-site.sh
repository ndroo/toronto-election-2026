#!/bin/sh
# Copies the static site into dist/ for Cloudflare Pages (worker/feed.js is included: the demo imports it).
# Deploy: scripts/build-site.sh && npx wrangler@4 pages deploy dist --project-name toronto-election-2026 --branch main
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/worker
cp index.html app.js wards.json photos.json incumbents.json og.png favicon.svg favicon-48.png apple-touch-icon.png dist/
cp -R photos dist/photos
cp -R og dist/og
cp worker/feed.js dist/worker/feed.js
# Frozen final results (scripts/freeze.sh), read by the page when ARCHIVE is on.
[ -d final ] && cp -R final dist/final
# The page reloads itself when this stops matching the app.js?v= it loaded with (bump v= on every change).
sed -n 's/.*app\.js?v=\([^"]*\)".*/\1/p' index.html > dist/version.txt
echo "built dist/ ($(du -sh dist | cut -f1))"
