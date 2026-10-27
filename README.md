# Toronto 2026 election results

Live at **https://torontoelections.andrewmcgrath.info/** (the old GitHub Pages address redirects there).

A free, ad-free page for following Toronto's municipal election on the night: a ward-by-ward map, race calls for
mayor, council and school trustees, follow links for any candidate, and a live news feed written as the count
came in. Results come straight from the City of Toronto's unofficial results feeds:

- https://mediaresults.toronto.ca/results/unofficialresult.json
- https://mediaresults.toronto.ca/results/unofficialresult-wardbyward.json

**Archive mode since October 27, 2026:** the page shows the final unofficial results from `final/` as static files
and needs no Worker. `?replay` plays election night back from the City's own updates. To run it for another
election, see [docs/REVIVE.md](docs/REVIVE.md).

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| `election.js` | page and Workers | Everything that changes per election: dates, archive switch, URLs, race-call thresholds |
| `index.html`, `app.js` | static site | The page. No framework, no build step beyond copying files |
| `worker/` | Cloudflare Worker `toronto-election-2026` | `/live.json`: both City files and the news feed in one cached, CORS-enabled response. Counts anonymous viewers (`Viewers` Durable Object) and writes the feed (`Newsroom` Durable Object, on a one-minute cron) |
| `worker/feed.js` | Worker and page | Race calls, feed events and their templates, and the check every AI-written post must pass. The page uses the same race-call code, so the two never disagree |
| `site/` | Cloudflare Worker `toronto-election-site` | Serves `dist/` as static assets; gives `?watch=` follow links their own link preview |
| `scripts/relay.py` | GitHub Actions | Saves every version of the City's feed to the `archive` branch on election night |

Each open tab makes one request every 30 seconds while it's visible, and none in the background.

## Running it locally

Node 22 or newer.

```sh
npm install           # puppeteer-core, for the browser tests
npm run serve         # http://localhost:8765/
npm test              # unit tests, then the browser tests (needs Google Chrome)
npm run preflight     # checks the repo agrees with election.js
```

Useful URLs:

- `?demo`: a simulated count on the real candidate lists (red banner). `?demo&preview=thanks` and `?demo&preview=about` open the end-of-night cards
- `?replay`: election night as it happened, from the saved versions in `replay/` (`scripts/replay-pack.py`)
- `?worker=http://localhost:8787`: read a local `wrangler dev` Worker, even in archive mode
- `#w=10&m=council`: pin ward 10, colour the map by council margin (`mayor`, `support`, `council`, `reporting`, `turnout`)
- `?w=10&watch=ian-cunningham`: open ward 10 and follow that candidate (names match loosely)
- `?src=<url>`: read a bundle `{ all, wardbyward }` from another URL

## Deploying

```sh
scripts/build-site.sh && (cd site && npx wrangler@4 deploy)   # the page
(cd worker && npx wrangler@4 deploy)                          # the results Worker
```

The build tags `app.js` with a hash of the code and writes it to `version.txt`; open pages reload themselves within
two minutes of a new version. `scripts/post.sh "Headline" "Body"` adds a hand-written post to the live feed with no
deploy.

Ward boundaries: Toronto Open Data, City Wards (25-ward model), simplified.
