// Browser checks in headless Chrome: archive mode, ?replay, and the phone layouts (on ?demo).
// node tests/browser.mjs   (CHROME=<path> if Chrome isn't in the usual macOS place; screenshots go to tests/shots/)
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const PORT = 8766;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const DEVICES = [
  ['fold-280', 280, 653, 3], ['se1-320', 320, 568, 2], ['se-375', 375, 667, 2], ['iphone15-393', 393, 852, 3],
  ['pixel7-412', 412, 915, 2.625], ['promax-430', 430, 932, 3], ['landscape-852', 852, 393, 3], ['ipadmini-768', 768, 1024, 2],
];
const WATCH = ['mayor|city|Olivia Chow', 'council|10|Ausma Malik', 'o3|10|Karen Emerson'];

const server = await serve(PORT);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

async function open(path, { device, theme = 'light', seed = {} } = {}) {
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:')) external.push(r.url()); });
  if (device) {
    const [, w, h, dpr] = device;
    await page.emulate({ viewport: { width: w, height: h, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, isLandscape: w > h },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.evaluateOnNewDocument((seed) => {
    sessionStorage.setItem('welcomed', '1');
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); }
  }, seed);
  await page.goto(BASE + path, { waitUntil: 'networkidle2' });
  return { page, errors, external };
}

// Anything sticking out past the screen edge that isn't inside something meant to scroll sideways.
const overflow = () => {
  const W = document.documentElement.clientWidth;
  const scrollsX = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(p).overflowX)) return true; return false; };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).position === 'fixed' || el.closest('dialog:not([open])')) continue;
    if ((r.right > W + 1 || r.left < -1) && !scrollsX(el)) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`);
  }
  return document.documentElement.scrollWidth > W + 1 ? ['page scrolls sideways', ...bad.slice(0, 5)] : bad.slice(0, 5);
};

// ---------- archive mode: the final results, no outside requests ----------
{
  const { page, errors, external } = await open('/');
  await wait(1500);
  const r = await page.evaluate(() => ({ status: document.querySelector('#statusText').textContent, posts: document.querySelectorAll('#posts .post').length, ticker: document.querySelector('.tk-live')?.textContent, dialogs: document.querySelectorAll('dialog[open]').length }));
  check(r.status === 'Final unofficial results · all polls in', `archive: status "${r.status}"`);
  check(r.posts > 50 && r.ticker === 'Recap', `archive: ${r.posts} feed posts, ticker "${r.ticker}"`);
  check(!external.length, `archive: no outside requests ${external.slice(0, 3).join(' ')}`);
  check(!errors.length, `archive: no errors ${errors.join(' | ')}`);
  await page.close();
}

// ---------- replay: steps through election night with the night's own posts ----------
{
  const { page, errors } = await open('/?replay');
  await wait(1500);
  const a = await page.evaluate(() => ({ prog: document.querySelector('#demoProg').textContent, posts: document.querySelectorAll('#posts .post').length }));
  await wait(9000);
  const b = await page.evaluate(() => ({ prog: document.querySelector('#demoProg').textContent, posts: document.querySelectorAll('#posts .post').length, status: document.querySelector('#statusText').textContent }));
  check(a.prog !== b.prog && /of \d+$/.test(b.prog), `replay: advances (${a.prog} -> ${b.prog})`);
  check(b.posts >= a.posts && b.posts > 0 && /^Replay/.test(b.status), `replay: ${b.posts} posts, status "${b.status}"`);
  check(!errors.length, `replay: no errors ${errors.join(' | ')}`);
  await page.close();
}

// ---------- phones and tablets (demo data) ----------
for (const device of DEVICES) {
  for (const theme of ['light', 'dark']) {
    const tag = `${device[0]}-${theme}`;
    const { page, errors } = await open('/?demo#w=10', { device, theme, seed: { watch: JSON.stringify(WATCH), myWard: '10' } });
    await page.waitForFunction(() => document.querySelectorAll('#watchList .wc').length > 0, { timeout: 20000 }).catch(() => {});
    await wait(1000);
    await page.screenshot({ path: `${OUT}${tag}.png` });
    const bad = await page.evaluate(overflow);
    check(!bad.length, `${tag}: fits the screen ${bad.join(' | ')}`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)); await wait(300);
    const w = await page.evaluate(() => { const el = document.querySelector('#watch'), b = el.getBoundingClientRect(); return { cards: document.querySelectorAll('#watchList .wc').length, bottom: Math.round(innerHeight - b.bottom), share: b.height / innerHeight }; });
    check(w.cards > 0 && Math.abs(w.bottom) <= 1 && w.share < 0.35, `${tag}: watch strip pinned (${w.cards} cards, ${Math.round(w.share * 100)}% of screen)`);
    if (theme === 'light') {
      for (const t of ['feed', 'wards', 'method']) {
        await page.evaluate((t) => document.querySelector(`.tabs [data-tab="${t}"]`).click(), t); await wait(300);
        const b = await page.evaluate(overflow);
        check(!b.length, `${tag}: ${t} tab fits ${b.join(' | ')}`);
      }
      await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('aboutBtn').click(); }); await wait(500);
      const ab = await page.evaluate(() => { const d = document.getElementById('welcome'), b = d.getBoundingClientRect(); return d.open && b.left >= 0 && b.right <= innerWidth && b.height <= innerHeight; });
      check(ab, `${tag}: About box fits`);
    }
    check(!errors.length, `${tag}: no errors ${errors.join(' | ')}`);
    await page.close();
  }
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
