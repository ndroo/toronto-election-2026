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
};
