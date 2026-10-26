# Toronto 2026 election results

Live at **https://torontoelections.andrewmcgrath.info/** (the old GitHub Pages address redirects there).

Static page showing live unofficial results for mayor, council and school trustees, from the City of Toronto media feeds:

- https://mediaresults.toronto.ca/results/unofficialresult.json
- https://mediaresults.toronto.ca/results/unofficialresult-wardbyward.json

## How data gets to the browser

The City's feed does not allow cross-origin browser requests, so a GitHub Actions workflow (`.github/workflows/relay.yml`, `scripts/relay.py`) polls it every ~45 seconds and force-pushes the raw feed JSON, unchanged, as `bundle.json` on the `data` branch. The page reads that through the GitHub contents API (falling back to raw.githubusercontent.com, which can lag ~5 min, if the API rate limit is hit). No server to run.

The relay runs on a cron for Oct 26-28. To kick it manually: `gh workflow run relay.yml`.

## Useful URLs

- `?demo` - random numbers on the real candidate lists, to preview the layout (red banner)
- `#w=10&m=council` - pin ward 10, colour map by council margin (`mayor`, `council`, `reporting`, `turnout`)
- `#w=10&watch=ian-cunningham` - open ward 10 and add that candidate to the watch list (names match loosely)
- `?src=<url>` - read a bundle from another URL (local testing)

Ward boundaries: Toronto Open Data, City Wards (25-ward model), simplified.

## Cloudflare Worker (primary data path)

`worker/` is a Cloudflare Worker that passes the two City files through with a CORS header for the GitHub Pages origin (and localhost:8765), caching each for 15 s and serving the last good copy if the City is briefly unreachable. Deploy with `cd worker && npx wrangler@4 deploy` (Node 22+). The page uses it first and falls back to the GitHub Actions copy if it fails. Override with `?worker=<base url>`.

## Hosting the page

The static site is served by a Cloudflare Worker with static assets (`site/`), on the custom domain
torontoelections.andrewmcgrath.info. To publish a change: `scripts/build-site.sh && (cd site && npx wrangler@4 deploy)`
(Node 22+). Bump the `app.js?v=` tag in index.html with each change so browsers don't mix old and new files.
The `gh-pages` branch holds only a redirect page for the old ndroo.github.io address.

## Archive

Every version of the City's feed seen on election night is kept on the `archive` branch
(`archive/<election>/<UTC time>.json.gz`), for replays and future demos.
