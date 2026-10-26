// CORS relay for the City of Toronto unofficial results feeds.
// Only the two feed files are served, and only to the results page's origins.
// The City asks consumers not to hammer the feed, so each isolate caches for CACHE_MS
// and serves the last good copy if the City is briefly unreachable.
const UPSTREAM = 'https://mediaresults.toronto.ca/results';
const FILES = new Set(['/unofficialresult.json', '/unofficialresult-wardbyward.json']);
const ORIGINS = ['https://ndroo.github.io', 'http://localhost:8765'];
const CACHE_MS = 15000;

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

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Expose-Headers': 'ETag, Last-Modified, X-Fetched-At, X-Stale',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!FILES.has(url.pathname)) return new Response('Not found', { status: 404, headers: cors });
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
