#!/bin/sh
# Copies the static site into dist/, which the site Worker serves (site/wrangler.toml).
# Deploy: scripts/build-site.sh && (cd site && npx wrangler@4 deploy)
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/worker
cp index.html app.js election.js wards.json photos.json incumbents.json og.png favicon.svg favicon-48.png apple-touch-icon.png dist/
cp -R photos dist/photos
cp -R og dist/og
# The page imports the feed's race-call rule and templates.
cp worker/feed.js dist/worker/feed.js
# Frozen final results (scripts/freeze.sh), read in archive mode and by ?replay for the night's posts.
[ -d final ] && cp -R final dist/final
# Saved versions of the City's feed for ?replay (scripts/replay-pack.py).
[ -d replay ] && cp -R replay dist/replay
# The version is a hash of the code, so every change gets a new one without bumping anything by hand. Open pages
# reload themselves when version.txt stops matching the app.js?v= they loaded with.
v=$(cat index.html app.js election.js worker/feed.js | shasum | cut -c1-10)
sed -i.bak "s/app\.js?v=[^\"]*\"/app.js?v=$v\"/" dist/index.html && rm dist/index.html.bak
echo "$v" > dist/version.txt
echo "built dist/ ($(du -sh dist | cut -f1)), version $v"
