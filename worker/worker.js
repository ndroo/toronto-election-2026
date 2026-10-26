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
import { snapshot, diff, template, checkWriting } from './feed.js';
import INCUMBENTS from '../incumbents.json';

const UPSTREAM = 'https://mediaresults.toronto.ca/results';
const FILES = new Set(['/unofficialresult.json', '/unofficialresult-wardbyward.json']);
const ORIGINS = ['https://ndroo.github.io', 'http://localhost:8765'];
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
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const AI_DAILY_CALLS = 200; // well inside the free daily allowance; templates take over beyond it
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
  type: 'object',
  properties: { posts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, headline: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'headline', 'body'] } } },
  required: ['posts'],
};

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
      const prev = this.get('snap');
      const posted = new Set(this.sql.exec('SELECT key FROM posts').toArray().map((r) => r.key));
      if (prev && prev.seq === String(all.seq || '') && posted.has('polls-closed')) return { unchanged: true };
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
    if (!this.env.AI || budget.calls >= AI_DAILY_CALLS) return out;
    budget.calls++;
    this.put('ai', budget);
    const batch = events.filter((e) => !e.noAI).slice(0, AI_MAX_EVENTS);
    if (!batch.length) return out;
    const recent = this.sql.exec('SELECT headline FROM posts ORDER BY id DESC LIMIT 6').toArray().map((r) => r.headline);
    const names = new Set();
    for (const r of Object.values(cur.races)) for (const c of [r.a, r.b]) if (c?.name) names.add(c.name);
    try {
      const res = await Promise.race([
        this.env.AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: AI_SYSTEM },
            { role: 'user', content: JSON.stringify({ recentHeadlines: recent, events: batch.map((e) => ({ id: e.id, kind: e.kind, facts: e.facts, draft: out.get(e.id) })) }) },
          ],
          max_tokens: 1200, temperature: 0.5,
          response_format: { type: 'json_schema', json_schema: AI_SCHEMA },
        }),
        new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000)),
      ]);
      const body = typeof res?.response === 'string' ? JSON.parse(res.response) : res?.response;
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
  const posts = await env.NEWSROOM.get(env.NEWSROOM.idFromName('feed')).posts();
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
    if (env.NEWSROOM) ctx.waitUntil(env.NEWSROOM.get(env.NEWSROOM.idFromName('feed')).tick().then((r) => console.log('feed tick', JSON.stringify(r))));
  },
};
