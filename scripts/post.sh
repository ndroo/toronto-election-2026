#!/bin/sh
# Adds a hand-written post to the live feed, for news the City's numbers can't show (extended voting hours,
# a delay in results). It goes straight into the feed: no deploy, and readers see it within a minute.
#
#   STATS_KEY=... scripts/post.sh "Headline" "One or two sentences."
#   STATS_KEY=... scripts/post.sh --delete <id>        (only hand-written posts can be removed)
#
# Add WORKER=http://localhost:8787 to try it against `wrangler dev` first.
set -e
: "${STATS_KEY:?set STATS_KEY to the results Worker's STATS_KEY secret}"
WORKER=${WORKER:-$(sed -n "s/.*worker: '\([^']*\)'.*/\1/p" "$(dirname "$0")/../election.js")}
if [ "$1" = "--delete" ]; then
  body=$(python3 -c 'import json,sys; print(json.dumps({"delete": int(sys.argv[1])}))' "$2")
else
  [ -n "$1" ] && [ -n "$2" ] || { echo 'usage: scripts/post.sh "Headline" "Body"'; exit 1; }
  body=$(python3 -c 'import json,sys; print(json.dumps({"headline": sys.argv[1], "body": sys.argv[2]}))' "$1" "$2")
fi
curl -sf -X POST "$WORKER/post?key=$STATS_KEY" -H 'Content-Type: application/json' -d "$body"
echo
