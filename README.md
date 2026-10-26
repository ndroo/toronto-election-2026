# Toronto 2026 election results

Static page showing live unofficial results for mayor, council and school trustees, from the City of Toronto media feeds:

- https://mediaresults.toronto.ca/results/unofficialresult.json
- https://mediaresults.toronto.ca/results/unofficialresult-wardbyward.json

## How data gets to the browser

The City's feed does not allow cross-origin browser requests, so a GitHub Actions workflow (`.github/workflows/relay.yml`, `scripts/relay.py`) polls it every ~45 seconds and force-pushes the raw feed JSON, unchanged, as `bundle.json` on the `data` branch. The page reads that through the GitHub contents API (falling back to raw.githubusercontent.com, which can lag ~5 min, if the API rate limit is hit). No server to run.

The relay runs on a cron for Oct 26-28. To kick it manually: `gh workflow run relay.yml`.

## Useful URLs

- `?demo` - random numbers on the real candidate lists, to preview the layout (red banner)
- `#w=10&m=council` - pin ward 10, colour map by council margin (`mayor`, `council`, `reporting`, `turnout`)
- `?src=<url>` - read a bundle from another URL (local testing)

Ward boundaries: Toronto Open Data, City Wards (25-ward model), simplified.
