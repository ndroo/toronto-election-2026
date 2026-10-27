// The site is static files; this only runs for the main page (see run_worker_first), so a follow link like
// "/?w=10&watch=ian-cunningham" gets its own link preview: who's being followed, their race, and their card.
import CARDS from './cards.json';
import { ELECTION } from '../election.js';

const SITE = 'https://torontoelections.andrewmcgrath.info';
// Same as the page's slug(): case, accents and punctuation don't matter.
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The ward's council race first, then the mayor's race, then anywhere (the page looks in the same order).
function findCard(w, want) {
  const key = [w && `council|${w}|${want}`, `mayor|${want}`].find((k) => k && CARDS[k]) || Object.keys(CARDS).find((k) => k.endsWith(`|${want}`));
  return key && CARDS[key];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const res = await env.ASSETS.fetch(request);
    const want = slug(url.searchParams.get('watch') || '');
    if (!want || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    const w = url.searchParams.get('w');
    const c = findCard(w && /^\d{1,2}$/.test(w) ? w : null, want);
    if (!c) return res;
    const title = `Follow ${c.name} · ${c.short} · ${ELECTION.title}`;
    const desc = `Live, unofficial results for ${c.name}${c.tag ? ` (${c.tag})` : ''}, ${c.race}: votes, place and the gap to the leader as polls report. Ad-free, from the City of Toronto's results feed.`;
    const link = `${SITE}/?${w ? `w=${w}&` : ''}watch=${want}`;
    const image = `${SITE}/${c.image}`;
    const attr = (name, value) => ({ element(e) { e.setAttribute(name, value); } });
    return new HTMLRewriter()
      .on('title', { element(e) { e.setInnerContent(title); } })
      .on('meta[name="description"]', attr('content', desc))
      .on('meta[property="og:title"]', attr('content', title))
      .on('meta[property="og:description"]', attr('content', desc))
      .on('meta[property="og:url"]', attr('content', link))
      .on('meta[property="og:image"]', attr('content', image))
      .on('meta[property="og:image:alt"]', attr('content', `${c.name}, ${c.race}`))
      .on('meta[name="twitter:image"]', attr('content', image))
      .on('link[rel="canonical"]', attr('href', link))
      .transform(res);
  },
};
