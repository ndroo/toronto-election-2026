# Bringing it back for another election

The site ran live for Toronto's municipal election on October 26, 2026, then was put in archive mode. This is
what it takes to run it again, and what was switched off afterwards.

## What runs where

| Piece | Where | Election night | Archive mode |
|---|---|---|---|
| The page (`index.html`, `app.js`, photos, cards) | Cloudflare Worker `toronto-election-site` with static assets (`site/`), custom domain torontoelections.andrewmcgrath.info | Served as static files; `site/index.js` only rewrites link previews for `?watch=` follow links | Same. Static files are free and unlimited on any Cloudflare plan |
| Results proxy | Cloudflare Worker `toronto-election-2026` (`worker/`) at toronto-election-2026.andrewjohnmcgrath.workers.dev | Passes the City's two JSON files through with CORS, cached 15 s. Every open tab polls it every 30 s | Not used: the page reads `final/` instead |
| Viewer counts | Durable Object `Viewers` in the same Worker; `/stats?key=<STATS_KEY>` | Counts anonymous browser ids seen on results requests | Idle (nothing calls the Worker) |
| Live feed | Durable Object `Newsroom`, run by a cron trigger every minute | Diffs the City feed, writes posts (OpenAI `gpt-5.5`, Workers AI fallback, templates last), serves `/feed.json` | Cron removed; the night's posts are frozen in `final/feed.json` |
| Backup data path + archive | GitHub Actions `relay.yml` / `scripts/relay.py` | Copies the feed to the `data` branch every ~45 s and every change to the `archive` branch | Workflow disabled. The `archive` branch keeps every version of the 2026 feed |

## Accounts and costs

- **Cloudflare** (account andrewjohnmcgrath). Workers **Paid** ($5/month) was turned on for election week. The free
  plan allows 100,000 Worker requests a day, and on election night each open tab made about 300 requests an hour to
  the results Worker, so a few hundred viewers would have run out. Static assets don't count. Upgrade a week or so
  before the next election and cancel after (cancelling takes effect at the end of the billing period).
  Rough Worker cost at ~300 requests per tab-hour: covered by the $5 up to the low thousands of viewers; about
  $1/hour at 10,000 concurrent viewers, $6-10/hour at 100,000.
- **OpenAI**: an API key in the "toronto-election-2026" project, restricted to model requests, stored only as the
  Worker secret `OPENAI_API_KEY`. The feed cost about $3 for the night. `AI_DAILY_CALLS` caps it at 400 calls per UTC day.
- **GitHub Actions**: free for this public repo.

## Checklist for the next election

### 1. Check the City's feed

- Confirm the City still publishes `https://mediaresults.toronto.ca/results/unofficialresult.json` and
  `unofficialresult-wardbyward.json`, in the same format: office id 1 is mayor, 2 is council, everything else is a
  school board. If the URL changes, update `UPSTREAM` in `worker/worker.js`, `scripts/relay.py`, `scripts/freeze.sh`
  and the methodology link in `app.js`.
- Before election day the feed lists every candidate with zero votes, which is enough to build and test everything.

### 2. Dates (all in Toronto time unless noted)

- `POLLS_CLOSE` in `app.js` **and** `worker/feed.js`.
- `PRE_CLOSE` in `worker/feed.js` (the hourly countdown posts on election day).
- `SIGN_OFF` in `worker/worker.js` (one closing post, then the feed stops).
- The cron in `worker/wrangler.toml` (`crons = ["* * 26-29 10 *"]` was election night; day-of-month and month are in
  **UTC**, so include the day after). It is empty in archive mode.
- The schedule in `.github/workflows/relay.yml` (also UTC) and `ELECTION` in `scripts/relay.py` (the archive folder).
- `OFFICIAL.certified` in `app.js` back to `null`.

### 3. Start fresh

- Set `ARCHIVE = false` in `app.js`, delete `final/`.
- Change `FEED_ROOM` in `worker/worker.js` (e.g. `'feed-2030'`). The old Newsroom object still holds 2026's posts;
  a new name starts an empty feed.
- Rename the `feedSeen` storage key in `app.js` (and in the migration `KEYS` list). Returning visitors still have
  2026's last post id saved, so the new feed's first ~75 posts would look already read.
- Empty `NOTICES` and `EXTRA_POSTS` in `worker/worker.js` (2026's hand-written posts).
- The mayor celebration and thank-you card remember the winner's name per browser (`mayorCelebrated`, `thanksShown`,
  `thanksAt`); a different winner shows them again. If the same person wins, rename those keys too.

### 4. Election data

- `wards.json`: ward boundaries (25-ward model, from Toronto Open Data, simplified). Replace if boundaries change.
- `incumbents.json`: who holds each seat, who isn't running again, and councillors running elsewhere.
- `photos.json` + `photos/`: candidate photos, keyed by race and name.
- Link-preview cards: `scripts/og_cards.mjs` builds one card per candidate (`og/*.jpg`) and `site/cards.json` from
  the live candidate list; `scripts/og_card.py` builds the main `og.png`. Re-run both once candidates are final.
- Wording with the year or date: the title, Open Graph tags and heading in `index.html`, the welcome text, the
  thank-you card (and whether it should still pitch Triple C), `README.md`.

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

Bump `app.js?v=` in `index.html` with every page change. The build writes it to `version.txt`, and open pages reload
themselves within two minutes when it changes.

### 6. Test before the night

- `?demo` runs a simulated count on the real candidate list, including race calls, confetti and the feed (templates
  only). `?demo&preview=thanks` and `?demo&preview=about` open the post-result cards straight away.
- `/tick?key=<STATS_KEY>` on the results Worker runs the feed writer once and returns what it did.
- The `archive` branch has every version of the 2026 feed, for replaying a real night.

## Lessons from 2026

- **The City was late.** Some voting places stayed open past 8 p.m. and the first results came after 9. Watch the
  City's announcements (toronto.ca elections pages, @cityoftoronto) and post updates.
- **Hand-written posts go in `EXTRA_POSTS`** in `worker/worker.js`, not in the Newsroom object. The Worker adds them
  as it serves `/feed.json`, so they appear the moment you deploy. The Newsroom object sometimes kept running old code
  for minutes after a deploy.
- **Race calls** use the same rules in `app.js` (`callRace`) and `worker/feed.js`; keep them in step. The mayor was
  called at 88% of polls with a 113,000-vote lead, which held.

## Winding down after an election

What was done on October 27, 2026:

1. `scripts/freeze.sh` saved the City's final files and the feed into `final/`, and `ARCHIVE = true` in `app.js` made
   the page read those instead of the Worker. Re-run the script and redeploy if the City posts corrections.
2. Removed the cron trigger from `worker/wrangler.toml` and redeployed the results Worker.
3. Left the OpenAI key to expire on its own (it was created with a 30-day expiry). With the cron gone nothing calls
   OpenAI; the `OPENAI_API_KEY` secret is still set on the Worker but holds a dead key, so put a new one in next time.
4. Disabled the relay workflow (`gh workflow disable relay.yml`); re-enable it with `gh workflow enable relay.yml`.
5. Cancelled Workers Paid in the Cloudflare dashboard. The free plan covers archive mode.
