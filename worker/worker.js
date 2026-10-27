// CORS relay for the City of Toronto unofficial results feeds.
// Only the two feed files are served, and only to the results page's origins.
// The City asks consumers not to hammer the feed, so each isolate caches for CACHE_MS
// and serves the last good copy if the City is briefly unreachable.
//
// It also counts viewers: the page sends an anonymous random id (`?v=`) with each poll, each isolate
// batches the ids it sees and hands them to one Durable Object every FLUSH_MS, and /stats?key=<STATS_KEY>
// shows live and 24-hour counts. Counting never delays or fails a feed response.
import { DurableObject } from 'cloudflare:workers';
import STATS_HTML from './stats.html';
import { snapshot, diff, template, checkWriting, signOff } from './feed.js';
import INCUMBENTS from '../incumbents.json';

const UPSTREAM = 'https://mediaresults.toronto.ca/results';
const FILES = new Set(['/unofficialresult.json', '/unofficialresult-wardbyward.json']);
const ORIGINS = ['https://ndroo.github.io', 'https://torontoelections.andrewmcgrath.info', 'https://toronto-election-site.andrewjohnmcgrath.workers.dev', 'http://localhost:8765'];
const CACHE_MS = 15000;
const FLUSH_MS = 10000;
const LIVE_MS = 90000; // the page polls every 30 s, so a viewer missing for 90 s has left
const BUCKET_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_MS = 30000;
const HISTORY_MS = 3 * 60 * 60 * 1000;

const memo = new Map(); // path -> { body, etag, lastModified, fetchedAt }

// Each request does its own upstream fetch when the cached copy is stale. Workers must not await a promise
// started by a different request (it can hang forever if that request is cancelled), so nothing async is shared.
async function load(path) {
  const hit = memo.get(path);
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit;
  try {
    const headers = hit?.etag ? { 'If-None-Match': hit.etag } : {};
    const r = await fetch(UPSTREAM + path, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status === 304 && hit) { hit.fetchedAt = Date.now(); return hit; }
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const body = await r.text();
    JSON.parse(body); // never pass on a truncated file
    const entry = { body, etag: r.headers.get('ETag'), lastModified: r.headers.get('Last-Modified'), fetchedAt: Date.now() };
    memo.set(path, entry);
    return entry;
  } catch (e) {
    if (hit) return { ...hit, stale: String(e.message || e) };
    throw e;
  }
}

// ---------- viewer counting ----------
let pending = new Set();
let lastFlush = 0;

function track(url, env, ctx) {
  const v = url.searchParams.get('v');
  if (!env.VIEWERS || !v || !/^[0-9a-f]{16}$/.test(v)) return;
  if (pending.size < 20000) pending.add(v);
  if (Date.now() - lastFlush < FLUSH_MS) return;
  const ids = [...pending];
  pending = new Set();
  lastFlush = Date.now();
  ctx.waitUntil(env.VIEWERS.get(env.VIEWERS.idFromName('all')).record(ids).catch(() => {}));
}

// One instance holds every count. SQLite keeps which ids were seen in each 10-minute bucket and the
// live-count samples, so both survive a restart; who is live right now is memory only (the object only
// restarts after it has had no requests for a while, i.e. when nobody is watching).
export class Viewers extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS seen (bucket INTEGER, id TEXT, PRIMARY KEY (bucket, id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, n INTEGER, at INTEGER)');
    this.last = new Map(); // id -> last seen (ms)
    this.buckets = new Map(); // bucket -> Set of ids
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (t INTEGER PRIMARY KEY, n INTEGER)');
    const since = Math.floor((Date.now() - DAY_MS) / BUCKET_MS);
    for (const r of this.sql.exec('SELECT bucket, id FROM seen WHERE bucket >= ?', since)) this.bucket(r.bucket).add(r.id);
    this.history = this.sql.exec('SELECT t, n FROM history WHERE t >= ? ORDER BY t', Date.now() - HISTORY_MS).toArray().map((r) => [r.t, r.n]); // [ms, live]
    this.peak = this.sql.exec("SELECT n, at FROM meta WHERE k = 'peak'").toArray()[0] || { n: 0, at: 0 };
  }

  bucket(b) {
    let s = this.buckets.get(b);
    if (!s) this.buckets.set(b, (s = new Set()));
    return s;
  }

  live(now) {
    let n = 0;
    for (const [id, t] of this.last) {
      if (now - t < LIVE_MS) n++;
      else this.last.delete(id);
    }
    return n;
  }

  record(ids) {
    const now = Date.now();
    const b = Math.floor(now / BUCKET_MS);
    const set = this.bucket(b);
    for (const id of ids) {
      this.last.set(id, now);
      if (!set.has(id)) { set.add(id); this.sql.exec('INSERT OR IGNORE INTO seen VALUES (?, ?)', b, id); }
    }
    const live = this.live(now);
    if (live > this.peak.n) {
      this.peak = { n: live, at: now };
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('peak', ?, ?)", live, now);
    }
    const prev = this.history[this.history.length - 1];
    if (!prev || now - prev[0] >= SAMPLE_MS) {
      this.history.push([now, live]);
      this.sql.exec('INSERT OR REPLACE INTO history VALUES (?, ?)', now, live);
      while (this.history.length && now - this.history[0][0] > HISTORY_MS) this.history.shift();
      this.sql.exec('DELETE FROM history WHERE t < ?', now - HISTORY_MS);
    }
    for (const k of this.buckets.keys()) if (k < b - DAY_MS / BUCKET_MS) this.buckets.delete(k);
    // The privacy note promises ids are gone after 24 hours, so stored rows are dropped hourly.
    if (now - (this.pruned || 0) > 60 * 60 * 1000) {
      this.pruned = now;
      this.sql.exec('DELETE FROM seen WHERE bucket < ?', Math.floor((now - DAY_MS) / BUCKET_MS));
    }
  }

  stats() {
    const now = Date.now();
    const b = Math.floor(now / BUCKET_MS);
    const hour = new Set(), day = new Set();
    const series = [];
    for (let k = b - DAY_MS / BUCKET_MS + 1; k <= b; k++) {
      const s = this.buckets.get(k);
      series.push([k * BUCKET_MS, s ? s.size : 0]);
      if (!s) continue;
      for (const id of s) { day.add(id); if (k > b - 6) hour.add(id); }
    }
    return { now, live: this.live(now), peak: this.peak, hour: hour.size, day: day.size, history: this.history, series, bucketMs: BUCKET_MS };
  }
}

// ---------- live feed ----------
// One writer for everyone: a cron trigger runs Newsroom.tick() every minute. It reads the City feed, compares it
// with the last copy, and stores any new posts. Workers AI words the posts; every AI post is checked against the
// facts, and the template text is used whenever the AI is unavailable, over budget, slow or fails the check.
// OpenAI writes the posts (OPENAI_API_KEY secret); Workers AI is the backup if OpenAI can't be reached.
const OPENAI_MODEL = 'gpt-5.5';
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_DAILY_CALLS = 400; // a few dollars at most for the night; templates take over beyond it
const AI_MAX_EVENTS = 8;

const AI_SYSTEM = `You write the live-updates feed for a nonpartisan, ad-free Toronto municipal election results page on election night, in the voice of a calm, experienced newsroom live blog.

For each event, write:
- headline: a complete newspaper-style headline with a subject and a verb, under 80 characters, sentence case, that names the candidate and the ward (or "mayor"). Good: "Ian Cunningham pulls ahead in Ward 10 Spadina-Fort York". Bad: "ward 10 lead change", "Lead change", "Update".
- body: one or two full sentences (under 240 characters) that say which race it is (the ward number and name, or the school board and ward, or the mayor's race) and give the key numbers.

Each event comes with a draft; keep its facts and meaning but write it fresh, the way a reporter would.

Rules:
- Use ONLY the facts given for that event. Never add numbers, names, places, history, predictions, reasons or context that are not in the facts.
- Write numbers exactly as given (you may add thousands separators, and percentages may be shown with one decimal).
- "projected" calls are this page's own projection from the unofficial count: write "projected to win" (or "projected winner") and never write that a projected candidate won or was elected. Only a "decided" status may be described as a win.
- Never say anyone won or is elected for events that are not calls.
- When the facts name an incumbent, say so: a "decided" incumbent is "re-elected"; a "projected" incumbent is "projected to be re-elected"; a challenger who is ahead of the incumbent in a call "unseats" them (decided) or is "projected to unseat" them (projected). "openSeat" means no incumbent is running; you may call it an open seat. Don't mention incumbency when the facts don't.
- Plain Canadian English, no exclamation marks, no emojis, no hype, no opinions. Vary the wording; don't reuse the phrasing of the recent headlines you're shown.

Reply with JSON only: {"posts":[{"id":"<event id>","headline":"...","body":"..."}]} with one post per event, same ids.`;

const AI_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { posts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'headline', 'body'] } } },
  required: ['posts'],
};

// One structured-output call: OpenAI if there's a key, otherwise (or if it fails) Workers AI.
async function aiWrite(env, messages) {
  if (env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_MODEL, reasoning_effort: 'low', messages, response_format: { type: 'json_schema', json_schema: { name: 'feed_posts', strict: true, schema: AI_SCHEMA } } }),
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status} ${(await r.text()).slice(0, 200)}`);
      return JSON.parse((await r.json()).choices[0].message.content);
    } catch (err) {
      console.log('feed: OpenAI failed, trying Workers AI', String(err.message || err));
    }
  }
  if (!env.AI) throw new Error('no AI available');
  const res = await Promise.race([
    env.AI.run(AI_MODEL, { messages, max_tokens: 1200, temperature: 0.5, response_format: { type: 'json_schema', json_schema: AI_SCHEMA } }),
    new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000)),
  ]);
  return typeof res?.response === 'string' ? JSON.parse(res.response) : res?.response;
}

// The Newsroom object holding this election's posts. A new name starts an empty feed (see docs/REVIVE.md).
const FEED_ROOM = 'feed';

// Live coverage ends here (Toronto time): one sign-off post, then no more posts. The results proxy keeps running.
const SIGN_OFF = Date.parse('2026-10-27T01:00:00-04:00');

// One-off posts written by hand, added once on the next tick (key keeps them from repeating).
const NOTICES = [
  { key: 'notice-extended-voting', kind: 'notice', headline: 'Voting extended at 11 locations, so results may take a little longer',
    body: 'After earlier disruptions, the City kept 11 voting places open past 8 p.m., the last until 8:20 p.m., in Wards 2, 5, 7, 8, 11, 13 and 16. Results may start arriving later than usual. Details at toronto.ca/elections.' },
];

// Hand-written posts added by the Worker as it serves /feed.json, so they show up the moment this is deployed
// (the Newsroom object can take minutes to pick up new code). t is when the post goes up; each slots in after
// the newest Newsroom post at or before t. beforeResults posts are dropped once results have arrived.
const EXTRA_POSTS = [
  { t: Date.parse('2026-10-26T21:01:00-04:00'), kind: 'notice', headline: 'Still waiting on the first results from the City',
    body: 'The last extended voting place closed at 8:20 p.m., and the City hasn\'t posted any results yet. This page checks for new numbers every 30 seconds, so results will appear here on their own as soon as the City publishes them. No need to refresh.' },
  { t: Date.parse('2026-10-26T21:12:00-04:00'), kind: 'notice', headline: 'City expected results around 9 p.m.; none posted yet',
    body: 'In a post at 8:53 p.m., the City of Toronto said some voting places still had voters in line, and that unofficial results would begin to be available at approximately 9 p.m. As of 9:12 p.m. none have been posted. They\'ll appear here as soon as the City publishes them.' },
];
function withExtras(posts, now) {
  const hasResults = posts.some((p) => p.kind !== 'notice' && !['pre-close', 'polls-closed'].includes(p.kind));
  const heads = new Set(posts.map((p) => p.headline));
  const picked = EXTRA_POSTS.filter((x) => x.t <= now && !heads.has(x.headline) && !(x.beforeResults && hasResults))
    .sort((a, b) => a.t - b.t);
  const after = new Map(); // several extras after the same post get 0.5, 0.51, 0.52... so each id is unique and in order
  const extra = picked.map((x) => {
    const base = Math.max(0, ...posts.filter((p) => p.t <= x.t).map((p) => p.id));
    const k = after.get(base) || 0; after.set(base, k + 1);
    return { id: base + 0.5 + k / 100, t: x.t, kind: x.kind, headline: x.headline, body: x.body };
  });
  return [...posts, ...extra].sort((a, b) => b.id - a.id);
}

export class Newsroom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, t INTEGER, kind TEXT, headline TEXT, body TEXT, ai INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)');
    this.busy = false;
  }

  get(k) { const r = this.sql.exec('SELECT v FROM state WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : null; }
  put(k, v) { this.sql.exec('INSERT OR REPLACE INTO state VALUES (?, ?)', k, JSON.stringify(v)); }

  async tick() {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try {
      const base = this.env.UPSTREAM || UPSTREAM;
      const get = async (f) => { const r = await fetch(`${base}/${f}`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`upstream ${r.status}`); return r.json(); };
      const [all, wbw] = await Promise.all([get('unofficialresult.json'), get('unofficialresult-wardbyward.json')]);
      const now = Date.now();
      for (const n of NOTICES) if (!(n.beforeResults && (+all.office?.[0]?.ward?.[0]?.pollsReceived || this.get('snap')?.rec))) this.sql.exec('INSERT OR IGNORE INTO posts (key, t, kind, headline, body, ai) VALUES (?, ?, ?, ?, ?, 0)', n.key, now, n.kind, n.headline, n.body);
      const prev = this.get('snap');
      const posted = new Set(this.sql.exec('SELECT key FROM posts').toArray().map((r) => r.key));
      if (posted.has('sign-off')) return { signedOff: true };
      if (now >= SIGN_OFF) {
        const e = signOff(snapshot(all, wbw, INCUMBENTS)), x = template(e);
        this.sql.exec('INSERT OR IGNORE INTO posts (key, t, kind, headline, body, ai) VALUES (?, ?, ?, ?, ?, 0)', e.id, now, e.kind, x.headline, x.body);
        return { signedOff: true };
      }
      if (prev && prev.seq === String(all.seq || '') && posted.has('polls-closed')) return { unchanged: true, code: 'n2' };
      const cur = snapshot(all, wbw, INCUMBENTS);
      const events = diff(prev, cur, now, posted);
      if (events.length) {
        const texts = await this.write(events, cur);
        for (const e of events) {
          const x = texts.get(e.id);
          this.sql.exec('INSERT OR IGNORE INTO posts (key, t, kind, headline, body, ai) VALUES (?, ?, ?, ?, ?, ?)', e.id, now, e.kind, x.headline, x.body, x.ai ? 1 : 0);
        }
      }
      this.put('snap', cur);
      return { events: events.length };
    } finally {
      this.busy = false;
    }
  }

  // Template text for every event, replaced by the AI's wording where it passes the check.
  async write(events, cur) {
    const out = new Map(events.map((e) => [e.id, { ...template(e), ai: false }]));
    const day = new Date().toISOString().slice(0, 10);
    const budget = this.get('ai') || { day, calls: 0 };
    if (budget.day !== day) { budget.day = day; budget.calls = 0; }
    if ((!this.env.OPENAI_API_KEY && !this.env.AI) || budget.calls >= AI_DAILY_CALLS) return out;
    const batch = events.filter((e) => !e.noAI).slice(0, AI_MAX_EVENTS);
    if (!batch.length) return out;
    budget.calls++;
    this.put('ai', budget);
    const recent = this.sql.exec('SELECT headline FROM posts ORDER BY id DESC LIMIT 6').toArray().map((r) => r.headline);
    const names = new Set();
    for (const r of Object.values(cur.races)) for (const c of [r.a, r.b]) if (c?.name) names.add(c.name);
    try {
      const body = await aiWrite(this.env, [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: JSON.stringify({ recentHeadlines: recent, events: batch.map((e) => ({ id: e.id, kind: e.kind, facts: e.facts, draft: out.get(e.id) })) }) },
      ]);
      for (const p of body?.posts || []) {
        const e = batch.find((x) => x.id === p.id);
        if (!e || typeof p.headline !== 'string' || typeof p.body !== 'string') continue;
        const headline = p.headline.trim().slice(0, 120), text = p.body.trim().slice(0, 400);
        const bad = checkWriting(e, headline, text, names);
        if (bad) { console.log('feed: AI text rejected', e.id, bad); continue; }
        out.set(e.id, { headline, body: text, ai: true });
      }
    } catch (err) {
      console.log('feed: AI unavailable', String(err.message || err));
    }
    return out;
  }

  posts() {
    return this.sql.exec('SELECT id, t, kind, headline, body FROM posts ORDER BY id DESC LIMIT 80').toArray();
  }
}

// Readers poll this; each isolate keeps the answer for FEED_CACHE_MS so the Durable Object isn't asked per viewer.
const FEED_CACHE_MS = 15000;
let feedMemo = null;
async function feed(env) {
  if (feedMemo && Date.now() - feedMemo.at < FEED_CACHE_MS) return feedMemo.body;
  const posts = withExtras(await env.NEWSROOM.get(env.NEWSROOM.idFromName(FEED_ROOM)).posts(), Date.now());
  feedMemo = { at: Date.now(), body: JSON.stringify({ at: Date.now(), posts }) };
  return feedMemo.body;
}

async function stats(url, env) {
  if (!env.STATS_KEY || !env.VIEWERS || url.searchParams.get('key') !== env.STATS_KEY) return new Response('Not found', { status: 404 });
  if (url.pathname === '/stats') return new Response(STATS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  const body = await env.VIEWERS.get(env.VIEWERS.idFromName('all')).stats();
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/tick' && env.STATS_KEY && url.searchParams.get('key') === env.STATS_KEY) {
      try { return Response.json(await env.NEWSROOM.get(env.NEWSROOM.idFromName(FEED_ROOM)).tick()); } catch (err) { return Response.json({ error: String(err.message || err) }, { status: 502 }); }
    }
    if (url.pathname === '/stats' || url.pathname === '/stats.json') {
      try { return await stats(url, env); } catch (err) { return Response.json({ error: String(err.message || err) }, { status: 502 }); }
    }
    const origin = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Expose-Headers': 'ETag, Last-Modified, X-Fetched-At, X-Stale',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });
    if (url.pathname === '/feed.json' && env.NEWSROOM) {
      try { return new Response(await feed(env), { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } }); }
      catch (err) { return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }); }
    }
    if (!FILES.has(url.pathname)) return new Response('Not found', { status: 404, headers: cors });
    track(url, env, ctx);
    try {
      const e = await load(url.pathname);
      const headers = {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Fetched-At': new Date(e.fetchedAt).toISOString(),
      };
      if (e.etag) headers.ETag = e.etag;
      if (e.lastModified) headers['Last-Modified'] = e.lastModified;
      if (e.stale) headers['X-Stale'] = e.stale;
      const weak = (t) => (t || '').replace(/^W\//, '');
      if (e.etag && weak(req.headers.get('If-None-Match')) === weak(e.etag)) return new Response(null, { status: 304, headers });
      return new Response(e.body, { headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.NEWSROOM) ctx.waitUntil(env.NEWSROOM.get(env.NEWSROOM.idFromName(FEED_ROOM)).tick().then((r) => console.log('feed tick', JSON.stringify(r))));
  },
};
