// Builds a link-preview card for every candidate (og/<key>.jpg) and site/cards.json, which the site Worker
// uses to give "?w=10&watch=ian-cunningham" links their own title, description and image.
// Run: NODE_PATH=<dir with puppeteer-core> node scripts/og_cards.mjs   (uses the installed Google Chrome)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FEED = 'https://toronto-election-2026.andrewjohnmcgrath.workers.dev/unofficialresult.json';
const BOARD_SHORT = { 'Toronto District School Board': 'TDSB', 'Toronto Catholic District School Board': 'TCDSB', 'Conseil scolaire Viamonde': 'Viamonde', 'Conseil scolaire catholique MonAvenir': 'MonAvenir' };

// Same as the page's slug(): case, accents and punctuation don't matter.
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (n) => n.replace(/\s+/g, ' ').trim();

const all = await fetch(FEED, { headers: { Origin: 'http://localhost:8765' } }).then((r) => r.json());
const geo = JSON.parse(fs.readFileSync(path.join(root, 'wards.json')));
const photos = JSON.parse(fs.readFileSync(path.join(root, 'photos.json')));
const inc = JSON.parse(fs.readFileSync(path.join(root, 'incumbents.json')));
const photoOf = (pkey, name) => Object.entries(photos).find(([k]) => { const [a, b] = k.split('|'); return a === pkey && norm(b) === norm(name); })?.[1]?.f;

// Every candidate: key, race description and the map ward to highlight.
const people = [];
for (const o of all.office) {
  for (const w of o.ward) {
    for (const c of w.candidate) {
      const name = norm(c.name);
      if (o.id === 1) people.push({ key: `mayor|${slug(name)}`, name, race: 'Mayor of Toronto', short: 'mayor', pkey: 'mayor', ward: null, rk: 'mayor|city', n: w.candidate.length });
      else if (o.id === 2) people.push({ key: `council|${w.num}|${slug(name)}`, name, race: `City council · Ward ${w.num} ${w.name}`, short: `Ward ${w.num} council`, pkey: `council-${w.num}`, ward: String(w.num), rk: `council|${w.num}`, n: w.candidate.length });
      else people.push({ key: `o${o.id}|${w.num}|${slug(name)}`, name, race: `${BOARD_SHORT[o.name] || o.name} school trustee · Ward ${w.num}${w.name ? ` ${w.name}` : ''}`, short: `${BOARD_SHORT[o.name] || o.name} Ward ${w.num} trustee`, pkey: `o${o.id}-${w.num}`, ward: null, rk: `o${o.id}|${w.num}`, n: w.candidate.length });
    }
  }
}
for (const p of people) {
  const held = inc.races[p.rk];
  const cl = inc.councillors[p.name];
  p.tag = held?.running === p.name ? 'Incumbent' : cl && cl.runningIn === p.rk ? `Councillor, Ward ${cl.ward}` : '';
  p.image = `og/${p.key.replace(/\|/g, '-')}.jpg`;
}

const mapSvg = (hi) => `<svg viewBox="0 0 ${geo.w} ${geo.h}">${Object.entries(geo.wards).map(([n, w]) => `<path d="${w.d}" fill="${n === hi ? '#2a78d6' : hi ? '#dfe7f1' : '#cde2fb'}" stroke="#f9f9f7" stroke-width="2.2"/>`).join('')}</svg>`;
const card = (p) => {
  const ph = photoOf(p.pkey, p.name);
  const img = ph ? `<img class="ph" src="data:image/jpeg;base64,${fs.readFileSync(path.join(root, 'photos', ph)).toString('base64')}">` : `<div class="ph ini">${esc(p.name.split(' ').filter(Boolean).map((x, i, a) => (i === 0 || i === a.length - 1 ? x[0] : '')).join('').toUpperCase())}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: 1200px; height: 630px; background: #f9f9f7; font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; color: #0b0b0b; position: relative; overflow: hidden; }
    .left { position: absolute; left: 72px; top: 0; bottom: 0; width: 600px; display: flex; flex-direction: column; justify-content: center; }
    .kicker { display: flex; align-items: center; gap: 10px; font-size: 21px; font-weight: 600; color: #2a78d6; letter-spacing: .04em; text-transform: uppercase; }
    .kicker i { width: 12px; height: 12px; border-radius: 50%; background: #d03b3b; }
    .who { display: flex; align-items: center; gap: 26px; margin: 26px 0 22px; }
    .ph { width: 150px; height: 150px; border-radius: 50%; object-fit: cover; flex: none; border: 5px solid #fff; box-shadow: 0 4px 18px rgba(0,0,0,.12); }
    .ini { display: grid; place-items: center; background: #e6e5e0; color: #7a7974; font-size: 52px; font-weight: 700; }
    h1 { font-size: ${p.name.length > 22 ? 50 : 60}px; line-height: 1.02; letter-spacing: -0.025em; font-weight: 750; }
    .tag { display: inline-block; margin-top: 12px; padding: 4px 12px; border-radius: 8px; background: #e9eef5; color: #184f95; font-size: 21px; font-weight: 650; }
    .race { font-size: 27px; line-height: 1.3; color: #52514e; }
    .follow { margin-top: 10px; font-size: 25px; color: #0b0b0b; font-weight: 600; }
    .url { position: absolute; left: 72px; bottom: 40px; font-size: 20px; color: #898781; }
    svg { position: absolute; right: -20px; top: 70px; width: 520px; height: auto; }
  </style></head><body>
    <div class="left">
      <div class="kicker"><i></i>Toronto 2026 election · Oct 26</div>
      <div class="who">${img}<div><h1>${esc(p.name)}</h1>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}</div></div>
      <div class="race">${esc(p.race)}</div>
      <div class="follow">Follow the live results</div>
    </div>
    ${mapSvg(p.ward)}
    <div class="url">torontoelections.andrewmcgrath.info</div>
  </body></html>`;
};

fs.mkdirSync(path.join(root, 'og'), { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630 });
for (const p of people) {
  await page.setContent(card(p), { waitUntil: 'load' });
  await page.screenshot({ path: path.join(root, p.image), type: 'jpeg', quality: 82 });
}
await browser.close();

const cards = Object.fromEntries(people.map((p) => [p.key, { name: p.name, race: p.race, short: p.short, tag: p.tag, image: p.image, n: p.n }]));
fs.writeFileSync(path.join(root, 'site', 'cards.json'), JSON.stringify(cards));
console.log(`${people.length} cards → og/, site/cards.json`);
