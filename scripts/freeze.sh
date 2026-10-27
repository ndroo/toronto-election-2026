#!/bin/sh
# After the count: saves the City's final results and the Worker's news feed into final/, which the site
# serves as plain static files once ARCHIVE is on in app.js. Re-run if the City posts corrections.
set -e
cd "$(dirname "$0")/.."
mkdir -p final
CITY=https://mediaresults.toronto.ca/results
WORKER=https://toronto-election-2026.andrewjohnmcgrath.workers.dev
curl -sf "$CITY/unofficialresult.json" -o final/unofficialresult.json
curl -sf "$CITY/unofficialresult-wardbyward.json" -o final/unofficialresult-wardbyward.json
curl -sf -H 'Origin: https://torontoelections.andrewmcgrath.info' "$WORKER/feed.json" -o final/feed.json
python3 -c "
import json
a = json.load(open('final/unofficialresult.json')); f = json.load(open('final/feed.json'))
w = [w for o in a['office'] for w in o['ward']]
print(f\"final/: {sum(int(x['pollsReceived']) for x in w)}/{sum(int(x['polls']) for x in w)} polls, {len(f['posts'])} feed posts\")
"
