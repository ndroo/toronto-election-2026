# Bringing it back for another election

The site ran live for Toronto's municipal election on October 26, 2026, then was put in archive mode. This is
what it takes to run it again, and what was switched off afterwards.

## What runs where

| Piece | Where | Election night | Archive mode |
|---|---|---|---|
| The page (`index.html`, `app.js`, `election.js`, photos, cards) | Cloudflare Worker `toronto-election-site` with static assets (`site/`), custom domain torontoelections.andrewmcgrath.info | Served as static files; `site/index.js` only rewrites link previews for `?watch=` follow links | Same. Static files are free and unlimited on any Cloudflare plan |
| Results Worker | Cloudflare Worker `toronto-election-2026` (`worker/`) at toronto-election-2026.andrewjohnmcgrath.workers.dev | `/live.json`: the City's two files plus the news feed in one response, cached 15 s. Each visible tab polls it every 30 s | Not used: the page reads `final/` instead |
| Viewer counts | Durable Object `Viewers` in the same Worker; `/stats?key=<STATS_KEY>` | Counts anonymous browser ids seen on results requests | Idle (nothing calls the Worker) |
| Live feed | Durable Object `Newsroom`, run by a cron trigger every minute | Diffs the City feed, writes posts (OpenAI `gpt-5.5`, Workers AI fallback, templates last), served inside `/live.json` | Cron removed; the night's posts are frozen in `final/feed.json` |
| Feed archive | GitHub Actions `relay.yml` / `scripts/relay.py` | Saves every change to the City's feed to the `archive` branch | Workflow disabled. The `archive` branch keeps every version of the 2026 feed; `replay/` has a copy for `?replay` |

## Accounts and costs

- **Cloudflare** (account andrewjohnmcgrath). In 2026 each open tab made about 300 requests an hour, so Workers
  **Paid** ($5/month) was turned on for election week. Since then a tab makes 120 an hour while it's visible and
  none in the background, so the free plan's 100,000 requests a day covers roughly 800 tab-hours (a few hundred
  people watching for a few hours). Expect more than that, or don't want to find out on the night? Upgrade a week
  before and cancel after (cancelling takes effect at the end of the billing period). Static assets don't count.
- **OpenAI**: an API key in the "toronto-election-2026" project, restricted to model requests, stored only as the
  Worker secret `OPENAI_API_KEY`. 2026 cost $0.71 (58 requests). `AI_DAILY_CALLS` caps it at 400 calls per UTC day.
- **GitHub Actions**: free for this public repo.

2026 total: $4.26 ($3.55 prorated Workers Paid, $0.71 OpenAI).

## Checklist for the next election

`npm run preflight` checks most of this: dates, the archive switch, cron schedules, stale wording and data.

### 1. Check the City's feed

- Confirm the City still publishes `unofficialresult.json` and `unofficialresult-wardbyward.json` in the same
  format: office id 1 is mayor, 2 is council, everything else is a school board. If the URL changes, update
  `cityFeed` in `election.js`.
- Before election day the feed lists every candidate with zero votes, which is enough to build and test everything.

### 2. `election.js`

- New `id` (e.g. `'toronto-2030'`), `title`, `pollsClose`, `preClose`, `signOff`.
- `archive: false`, `certified: null`.
- **Delete `legacyNames`.** The Worker's feed and viewer stores and the browser's memory (posts read, winner
  celebrated, thank-you card shown) are then named after `id`, so nothing carries over from 2026.
- Delete `final/` (2026's frozen results).

### 3. Schedules (UTC, can't read `election.js`; preflight checks them)

- `crons` in `worker/wrangler.toml`: 2026 used `["* * 26-29 10 *"]`. Day-of-month and month are UTC, so include the
  day after polls close.
- The schedule and the "start the next run" date in `.github/workflows/relay.yml`, then
  `gh workflow enable relay.yml`.

### 4. Election data

- `wards.json`: ward boundaries (25-ward model, from Toronto Open Data, simplified). Replace if boundaries change.
- `incumbents.json`: who holds each seat, who isn't running again, and councillors running elsewhere.
- `photos.json` + `photos/`: candidate photos, keyed by race and name.
- Link-preview cards: `scripts/og_cards.mjs` builds one card per candidate (`og/*.jpg`) and `site/cards.json` from
  the live candidate list; `scripts/og_card.py` builds the main `og.png`. Re-run both once candidates are final.
- Wording with the year: the title, Open Graph tags and heading in `index.html`, the welcome text, the thank-you
  card (and whether it should still pitch Triple C).

### 5. Cloudflare setup

Node 22 or newer for wrangler (`/opt/homebrew/opt/node@22/bin` on Andrew's Mac).

```sh
# Results Worker: proxy, viewer counts, live feed
cd worker
npx wrangler@4 secret put STATS_KEY        # any random string; the stats page is /stats?key=<it>
npx wrangler@4 secret put OPENAI_API_KEY   # a fresh project key; the 2026 one has expired
npx wrangler@4 deploy

# The page
cd ..
scripts/build-site.sh && (cd site && npx wrangler@4 deploy)
```

Both Workers, the custom domain route and the Durable Object classes already exist on the account, so a deploy is
all it takes. On a fresh Cloudflare account the same commands create them; the domain must be a zone on that account.

The build versions the page automatically; open pages reload themselves within two minutes of a deploy.

### 6. Test before the night

- `npm test`: the race-call rule, feed and AI guard against the real 2026 data, then archive mode, `?replay` and
  the phone layouts in headless Chrome.
- `?replay` plays 2026 back from the City's own updates with the night's posts: the best rehearsal there is. To
  replay another night: `python3 scripts/replay-pack.py <archive folder>`.
- `?demo` runs a simulated count on the real candidate list, including race calls, confetti and the feed
  (templates only). `?demo&preview=thanks` and `?demo&preview=about` open the end-of-night cards.
- `/tick?key=<STATS_KEY>` on the results Worker runs the feed writer once and returns what it did.
- `scripts/post.sh` against `wrangler dev` (`WORKER=http://localhost:8787`) to practise a hand-written post.

## On the night

- **Hand-written posts:** `STATS_KEY=... scripts/post.sh "Headline" "Body"`. It goes straight into the feed with no
  deploy; `--delete <id>` takes one back. In 2026 this needed a code change and a deploy, and the Newsroom object
  sometimes kept running old code for minutes afterwards.
- **The City may be late.** In 2026 some voting places stayed open past 8 p.m. and the first results came after 9.
  Watch the City's announcements (toronto.ca elections pages, @cityoftoronto) and post updates.
- **Race calls** need 25% of polls in, and a lead the runner-up could only overcome with 75% or more of the votes
  left (estimated, times 1.5). The mayor was called at 88% of polls with a 113,000-vote lead, which held.

## Winding down after an election

What was done on October 27, 2026:

1. `scripts/freeze.sh` saved the City's final files and the feed into `final/`, and `archive: true` in
   `election.js` made the page read those instead of the Worker. Re-run the script and redeploy if the City posts
   corrections. `python3 scripts/replay-pack.py 2026` copied the night into `replay/`.
2. Removed the cron trigger from `worker/wrangler.toml` and redeployed the results Worker.
3. Left the OpenAI key to expire on its own (it was created with a 30-day expiry). With the cron gone nothing calls
   OpenAI; the `OPENAI_API_KEY` secret is still set on the Worker but holds a dead key, so put a new one in next time.
4. Disabled the relay workflow (`gh workflow disable relay.yml`).
5. Cancelled Workers Paid in the Cloudflare dashboard (runs to November 17, 2026). The free plan covers archive mode.
