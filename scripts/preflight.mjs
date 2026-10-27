// Before an election (or after changing election.js): checks the rest of the repo agrees with election.js.
// node scripts/preflight.mjs    ✓ fine · ! worth a look · ✗ will go wrong (exit code 1)
import fs from 'node:fs';
import { ELECTION, FEED_ROOM, STORAGE_PREFIX } from '../election.js';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const exists = (p) => fs.existsSync(new URL(p, root));
let errors = 0;
const ok = (m) => console.log(`✓ ${m}`), warn = (m) => console.log(`! ${m}`), bad = (m) => { errors++; console.log(`✗ ${m}`); };

const close = Date.parse(ELECTION.pollsClose), signOff = Date.parse(ELECTION.signOff);
const pre = ELECTION.preClose.map(Date.parse);
if (!Number.isFinite(close) || !Number.isFinite(signOff) || pre.some((t) => !Number.isFinite(t))) bad('a date in election.js does not parse');
else if (pre.some((t) => t >= close) || signOff <= close) bad('dates out of order: preClose < pollsClose < signOff');
else ok(`polls close ${new Date(close).toLocaleString('en-CA', { timeZone: 'America/Toronto', dateStyle: 'full', timeStyle: 'short' })} Toronto time`);
const now = Date.now();

// Archive mode and the frozen files.
if (ELECTION.archive) (now < signOff ? bad : ok)(`archive mode is on${now < signOff ? ' before the election is over: the page will show final/, not live results' : ''}`);
else {
  ok('archive mode is off: the page reads the results Worker');
  if (exists('final')) warn('final/ is from an earlier election; delete it (the demo reads it, and ?replay takes its feed posts)');
}
if (ELECTION.certified) warn(`certified is set (${ELECTION.certified}): every call shows as "Official winner"`);
if (ELECTION.legacyNames && ELECTION.id !== 'toronto-2026') bad('legacyNames is on for a new election: the feed and browser memory would carry over from 2026');
else ok(`feed store "${FEED_ROOM}", browser memory prefix "${STORAGE_PREFIX}"`);

// Cron schedules are UTC and can't read election.js, so check they cover the night.
const utcDays = [...new Set([pre[0] ?? close, close, signOff].map((t) => new Date(t).toISOString().slice(0, 10)))];
const covers = (cron, day) => {
  const [, , dom, mon] = cron.trim().split(/\s+/);
  const match = (field, v) => field === '*' || field.split(',').some((part) => { const [a, b] = part.split('-').map(Number); return b ? v >= a && v <= b : v === a; });
  const d = new Date(`${day}T12:00:00Z`);
  return match(dom, d.getUTCDate()) && match(mon, d.getUTCMonth() + 1);
};
const crons = [...read('worker/wrangler.toml').matchAll(/^crons\s*=\s*\[(.*)\]/gm)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
if (ELECTION.archive) crons.length ? warn(`the feed writer still runs on a schedule (${crons.join(', ')}) in archive mode`) : ok('feed writer schedule off (archive mode)');
else {
  const missing = utcDays.filter((d) => !crons.some((c) => covers(c, d)));
  missing.length ? bad(`worker/wrangler.toml crons ${JSON.stringify(crons)} miss UTC day(s) ${missing.join(', ')}`) : ok(`feed writer runs on ${utcDays.join(', ')} (UTC)`);
}
const relay = read('.github/workflows/relay.yml');
const relayCrons = [...relay.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
const until = relay.match(/-le (\d{8})/)?.[1];
const lastDay = utcDays[utcDays.length - 1].replace(/-/g, '');
if (!ELECTION.archive) {
  const missing = utcDays.filter((d) => !relayCrons.some((c) => covers(c, d)));
  missing.length ? warn(`relay.yml schedule misses UTC day(s) ${missing.join(', ')} (only the replay archive depends on it)`) : ok('archive relay scheduled for the night');
  if (!until || until < lastDay) warn(`relay.yml restarts itself only until ${until}; set it to ${lastDay} or later`);
}

// Wording and data that still name another election.
const year = new Date(close).getUTCFullYear();
for (const f of ['index.html', 'site/index.js', 'scripts/og_card.py']) {
  const others = [...new Set((read(f).match(/\b20[2-9]\d\b/g) || []).filter((y) => +y !== year))];
  if (others.length) warn(`${f} mentions ${others.join(', ')} (this election is ${year})`);
}
for (const f of ['wards.json', 'incumbents.json', 'photos.json', 'site/cards.json']) exists(f) ? ok(`${f} present`) : bad(`${f} missing`);
const inc = JSON.parse(read('incumbents.json'));
if (!String(inc.asOf || '').includes(String(year))) warn(`incumbents.json is as of ${inc.asOf}; update who holds each seat`);
if (exists('replay/index.json')) {
  const r = JSON.parse(read('replay/index.json'));
  ok(`?replay has ${r.files.length} versions from ${r.archive}`);
}
console.log('\nNot checked from here: Workers Paid plan, STATS_KEY and OPENAI_API_KEY secrets (cd worker && npx wrangler@4 secret list).');
process.exit(errors ? 1 : 0);
