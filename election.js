// Everything that changes from one election to the next, in one place. Read by the page (app.js), the Worker
// (worker/worker.js, worker/feed.js) and the scripts. `node scripts/preflight.mjs` checks the rest of the repo
// agrees with it (cron schedules, data files). See docs/REVIVE.md.
export const ELECTION = {
  // Names the archive folder, the live-feed store and this election's browser memory.
  id: 'toronto-2026',
  title: 'Toronto 2026 election results',
  // Toronto time, with the UTC offset in force on the day.
  pollsClose: '2026-10-26T20:00:00-04:00',
  // Short countdown posts in the feed on election day.
  preClose: ['2026-10-26T16:00:00-04:00', '2026-10-26T17:00:00-04:00', '2026-10-26T18:00:00-04:00', '2026-10-26T19:00:00-04:00', '2026-10-26T19:30:00-04:00'],
  // Live coverage ends: one closing post, then the feed stops writing. Results keep updating.
  signOff: '2026-10-27T01:00:00-04:00',
  // After the count: the page reads the frozen results in final/ (scripts/freeze.sh) and needs no Worker.
  archive: true,
  // When the City Clerk certifies the results, set the date (e.g. 'October 28, 2026') and every call
  // becomes "Official winner".
  certified: null,
  certifiedUrl: 'https://www.toronto.ca/city-government/elections/election-results-reports/election-results/',
  cityFeed: 'https://mediaresults.toronto.ca/results',
  worker: 'https://toronto-election-2026.andrewjohnmcgrath.workers.dev',
  // 2026 ran before the Worker's stores and the browser's memory were named after `id`. Leave this out next
  // time: everything is then named after `id`, so no posts, viewer counts or "already seen" flags carry over.
  legacyNames: true,
};

// Race-call thresholds, used by the page and the feed alike. The About tab explains them with these values.
export const CALL = { minReporting: 0.25, safety: 1.5, needShare: 0.75, swing: 0.30 };

const legacy = ELECTION.legacyNames;
export const FEED_ROOM = legacy ? 'feed' : `feed-${ELECTION.id}`; // the Newsroom object holding the posts
export const VIEWERS_ROOM = legacy ? 'all' : `viewers-${ELECTION.id}`; // the Viewers object holding the counts
export const STORAGE_PREFIX = legacy ? '' : `${ELECTION.id}:`; // for this election's localStorage keys
