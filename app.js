/* Toronto 2026 election results - static client.
 *
 * Data path: City feed -> GitHub Actions relay (scripts/relay.py) -> `data` branch bundle.json
 * -> this page, via the GitHub contents API (CORS-enabled, conditional requests) with
 * raw.githubusercontent.com as a fallback when the API rate limit is hit.
 */
(() => {
  'use strict';

  // ---------- config ----------
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const [OWNER, REPO] = (() => {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    if (m) return [m[1], location.pathname.split('/').filter(Boolean)[0] || `${m[1]}.github.io`];
    return ['ndroo', 'toronto-election-2026'];
  })();
  const POLL_MS = DEMO ? 6000 : 30000;
  const SOURCES = params.get('src')
    ? [{ id: 'custom', url: params.get('src') }]
    : [
        { id: 'worker', base: params.get('worker') || 'https://toronto-election-2026.andrewjohnmcgrath.workers.dev' },
        { id: 'api', url: `https://api.github.com/repos/${OWNER}/${REPO}/contents/bundle.json?ref=data`,
          headers: { Accept: 'application/vnd.github.raw+json' } },
        { id: 'raw', url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/data/bundle.json` },
      ];
  const STALE_MS = 7 * 60 * 1000;
  const TZ = 'America/Toronto';

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const int = (v) => { const n = parseInt(String(v ?? '').replace(/,/g, ''), 10); return Number.isFinite(n) ? n : 0; };
  const fmt = (n) => n.toLocaleString('en-CA');
  const pct = (n, d = 1) => `${n.toFixed(d)}%`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (d) => Date.now() - d > 12 * 3600e3
    ? d.toLocaleString('en-CA', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s >= 86400) return `${Math.floor(s / 86400)} days ago`; return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hexRgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const mix = (a, b, t) => { const A = hexRgb(a), B = hexRgb(b); return `rgb(${A.map((v, i) => Math.round(v * t + B[i] * (1 - t))).join(',')})`; };
  const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

  // ---------- state ----------
  let geo = null;
  let model = null;
  let prevVotes = new Map();
  let lastOk = 0, lastErr = null, apiBlockedUntil = 0, usedSource = null;
  const colorOf = new Map(); // mayoral candidate name -> slot (1..3); sticky so colours follow the person
  const hash = new URLSearchParams(location.hash.slice(1));
  let mode = ['mayor', 'council', 'reporting', 'turnout'].includes(hash.get('m')) ? hash.get('m') : 'mayor';
  let pinned = hash.get('w') || '1';
  let hover = null;
  let sort = { key: 'num', dir: 1 };
  let tab = ['ward', 'wards', 'school', 'about'].includes(hash.get('t')) ? hash.get('t') : 'ward';
  let board = null; // selected school board office id
  let flashNow = false; // only animate vote changes on data updates, not on hover re-renders

  // ---------- model ----------
  // A race: { polls, pollsReceived, totalVoters, votes, cands:[{name, votes, pct, delta}], leader, margin }
  function race(key, w, cands, pctFrom) {
    const list = cands.map((c) => ({ name: c.name.trim(), votes: int(c.votesReceived), feedPct: c.percentage }));
    const sum = list.reduce((a, c) => a + c.votes, 0);
    const total = pctFrom || sum;
    // The feed's `percentage` is used when present; the spec is ambiguous about fraction vs percent,
    // so normalise by checking what the values add up to.
    const feedSum = list.reduce((a, c) => a + (parseFloat(c.feedPct) || 0), 0);
    const feedScale = feedSum > 0.5 && feedSum < 1.5 ? 100 : 1;
    for (const c of list) {
      c.pct = c.feedPct != null && feedSum > 0 ? parseFloat(c.feedPct) * feedScale : total ? (c.votes / total) * 100 : 0;
      const k = `${key}|${c.name}`;
      const before = prevVotes.get(k);
      c.delta = before != null && c.votes > before ? c.votes - before : 0;
      nextVotes.set(k, c.votes);
    }
    list.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const r = {
      polls: int(w.polls), pollsReceived: int(w.pollsReceived), totalVoters: int(w.totalVoters),
      votes: int(w.votesReceived ?? w.votesCounted) || sum, cands: list,
    };
    r.leader = list[0] && list[0].votes > 0 ? list[0] : null;
    r.tied = !!(r.leader && list[1] && list[1].votes === r.leader.votes);
    r.margin = r.leader ? r.leader.pct - (list[1]?.pct || 0) : 0;
    r.complete = r.polls > 0 && r.pollsReceived >= r.polls;
    return r;
  }

  let nextVotes;
  function buildModel(b) {
    nextVotes = new Map();
    const all = b.all, wbw = b.wardbyward;
    const offices = all.office || [];
    const mayorOffice = offices.find((o) => o.id === 1 || /mayor/i.test(o.name));
    const councilOffice = offices.find((o) => o.id === 2 || /council/i.test(o.name));
    const cw = mayorOffice?.ward?.[0] || {};
    const m = {
      seq: all.seq, generatedAt: all.seq ? new Date(Number(all.seq)) : null,
      wbwGeneratedAt: wbw?.seq ? new Date(Number(wbw.seq)) : null,
      relayedAt: b.relayedAt ? new Date(b.relayedAt) : null,
      changedAt: b.changedAt ? new Date(b.changedAt) : null,
      electionDesc: all.electionDesc,
      mayor: race('mayor|city', cw, cw.candidate || []),
      wards: {},
      boards: [],
    };
    for (const w of councilOffice?.ward || []) {
      m.wards[int(w.num)] = { num: int(w.num), name: w.name, council: race(`council|${w.num}`, w, w.candidate || []) };
    }
    // Mayor by ward: the feed is candidate -> wards, pivot to ward -> candidates.
    const byWard = {};
    for (const c of wbw?.office?.candidate || []) {
      for (const w of c.ward || []) {
        const n = int(w.num);
        (byWard[n] ||= { w, cands: [] }).cands.push({ name: c.name, votesReceived: w.votesReceived });
      }
    }
    for (const [n, { w, cands }] of Object.entries(byWard)) {
      const ward = (m.wards[n] ||= { num: int(n), name: w.name });
      ward.name ||= w.name;
      ward.mayor = race(`mayor|${n}`, { ...w, votesReceived: w.votesCounted }, cands, int(w.votesCounted));
    }
    for (const o of offices) {
      if (o === mayorOffice || o === councilOffice) continue;
      m.boards.push({
        id: o.id, name: o.name,
        wards: (o.ward || []).map((w) => ({ num: w.num, name: w.name, race: race(`o${o.id}|${w.num}`, w, w.candidate || []) }))
          .sort((a, b) => int(a.num) - int(b.num)),
      });
    }
    prevVotes = nextVotes;
    return m;
  }

  function assignColours() {
    const top = model.mayor.cands.filter((c) => c.votes > 0).slice(0, 3).map((c) => c.name);
    for (const name of [...colorOf.keys()]) if (!top.includes(name)) colorOf.delete(name);
    const used = new Set(colorOf.values());
    for (const name of top) {
      if (colorOf.has(name)) continue;
      const slot = [1, 2, 3].find((s) => !used.has(s));
      colorOf.set(name, slot); used.add(slot);
    }
  }
  const candColour = (name) => (colorOf.has(name) ? css(`--s${colorOf.get(name)}`) : null);

  // ---------- fetching ----------
  async function fetchBundle() {
    for (const src of SOURCES) {
      if (src.id === 'api' && Date.now() < apiBlockedUntil) continue;
      try {
        if (src.base) {
          // Cloudflare Worker: CORS pass-through of the two City files, fetched in parallel.
          const get = async (f) => {
            const r = await fetch(`${src.base}/${f}`, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`${src.id}: HTTP ${r.status}`);
            return { json: await r.json(), at: r.headers.get('X-Fetched-At') };
          };
          const [a, w] = await Promise.all([get('unofficialresult.json'), get('unofficialresult-wardbyward.json')]);
          usedSource = src.id;
          return { all: a.json, wardbyward: w.json, relayedAt: [a.at, w.at].filter(Boolean).sort()[0] || null };
        }
        const r = await fetch(src.url, { cache: 'no-cache', headers: src.headers || {} });
        if (src.id === 'api' && (r.status === 403 || r.status === 429)) {
          const reset = int(r.headers.get('x-ratelimit-reset')) * 1000;
          apiBlockedUntil = reset > Date.now() ? reset : Date.now() + 5 * 60 * 1000;
          throw new Error(`GitHub API rate limited (${r.status})`);
        }
        if (!r.ok) throw new Error(`${src.id}: HTTP ${r.status}`);
        const b = await r.json();
        if (!b.all) throw new Error(`${src.id}: bundle missing results`);
        usedSource = src.id;
        return b;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No data source available');
  }

  let demoP = 0.08;
  function demoize(b) {
    // Synthetic numbers on the real candidate lists - layout preview only.
    const rnd = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 10000) / 10000; };
    const weight = (name, ward) => Math.pow(rnd(name), 6) * 8 + rnd(name + ward) * 0.6 + 0.02;
    const fill = (w, cands, key, p) => {
      w.pollsReceived = String(Math.min(int(w.polls), Math.round(int(w.polls) * clamp(p + (rnd(key.replace(/^\w+\|/, '')) - 0.5) * 0.3))));
      const cast = Math.round(int(w.totalVoters) * 0.33 * (int(w.pollsReceived) / Math.max(1, int(w.polls))));
      const ws = cands.map((c) => weight(c.name, key)), tot = ws.reduce((a, x) => a + x, 0);
      cands.forEach((c, i) => { c.votesReceived = String(Math.round((cast * ws[i]) / tot)); c.percentage = undefined; });
      w.votesReceived = String(cands.reduce((a, c) => a + int(c.votesReceived), 0));
      cands.sort((a, b) => int(b.votesReceived) - int(a.votesReceived));
    };
    const p = (demoP = Math.min(1, demoP + 0.07));
    const d = structuredClone(b);
    for (const o of d.all.office) for (const w of o.ward) fill(w, w.candidate, `${o.id}|${w.num}`, p);
    // Rebuild the mayor-by-ward file from the per-ward fill so the two agree.
    const mo = d.wardbyward.office;
    for (const w of mo.candidate[0].ward) {
      const cands = mo.candidate.map((c) => ({ name: c.name }));
      const ww = { ...w };
      fill(ww, cands, `m|${w.num}`, p);
      for (const c of mo.candidate) {
        const cw = c.ward.find((x) => x.num === w.num);
        cw.pollsReceived = ww.pollsReceived; cw.votesCounted = ww.votesReceived;
        cw.votesReceived = cands.find((x) => x.name === c.name).votesReceived;
      }
    }
    // City-wide mayor = sum of wards.
    const cityW = d.all.office[0].ward[0];
    for (const c of cityW.candidate) c.votesReceived = String(mo.candidate.find((x) => x.name === c.name).ward.reduce((a, w) => a + int(w.votesReceived), 0));
    cityW.candidate.sort((a, b) => int(b.votesReceived) - int(a.votesReceived));
    cityW.votesReceived = String(cityW.candidate.reduce((a, c) => a + int(c.votesReceived), 0));
    cityW.pollsReceived = String(mo.candidate[0].ward.reduce((a, w) => a + int(w.pollsReceived), 0));
    d.all.seq = d.wardbyward.seq = String(Date.now());
    d.relayedAt = d.changedAt = new Date().toISOString();
    return d;
  }

  let rawBundle = null;
  async function tick() {
    try {
      if (!DEMO || !rawBundle) rawBundle = await fetchBundle();
      model = buildModel(DEMO ? demoize(rawBundle) : rawBundle);
      lastOk = Date.now(); lastErr = null;
      assignColours();
      renderAll();
    } catch (e) {
      lastErr = e;
      console.warn('[results]', e);
      renderStatus();
    }
  }

  // ---------- rendering: map ----------
  const svg = $('#map');
  const NS = 'http://www.w3.org/2000/svg';
  const paths = {};
  let hl, pin;
  function buildMap() {
    svg.setAttribute('viewBox', `0 0 ${geo.w} ${geo.h}`);
    const gW = document.createElementNS(NS, 'g');
    const gL = document.createElementNS(NS, 'g');
    for (const [num, w] of Object.entries(geo.wards)) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', w.d);
      p.setAttribute('class', 'ward');
      p.setAttribute('tabindex', '0');
      p.setAttribute('role', 'button');
      p.setAttribute('aria-label', `Ward ${num} ${w.name}`);
      p.dataset.w = num;
      gW.appendChild(p);
      paths[num] = p;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', w.lx); t.setAttribute('y', w.ly);
      t.setAttribute('class', 'lbl');
      t.textContent = num;
      gL.appendChild(t);
    }
    pin = document.createElementNS(NS, 'path'); pin.setAttribute('class', 'pin');
    hl = document.createElementNS(NS, 'path'); hl.setAttribute('class', 'hl');
    svg.append(gW, pin, hl, gL);

    svg.addEventListener('pointermove', (e) => {
      const n = e.target.dataset?.w;
      if (e.pointerType === 'touch') return;
      if (n) { setHover(n); placeTip(e.clientX, e.clientY); } else setHover(null);
    });
    svg.addEventListener('pointerleave', () => setHover(null));
    svg.addEventListener('click', (e) => { const n = e.target.dataset?.w; if (n) { setPinned(n); setTab('ward'); } });
    svg.addEventListener('focusin', (e) => { const n = e.target.dataset?.w; if (n) { setHover(n); const r = e.target.getBoundingClientRect(); placeTip(r.right, r.top); } });
    svg.addEventListener('focusout', () => setHover(null));
    svg.addEventListener('keydown', (e) => { const n = e.target.dataset?.w; if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPinned(n); setTab('ward'); } });
    $('.modes').addEventListener('click', (e) => { const m = e.target.dataset?.mode; if (m) { mode = m; saveHash(); renderMap(); } });
  }

  const seqRamp = () => css('--seq').split(',').map((s) => s.trim());
  function seqColour(t) { const r = seqRamp(); return r[Math.round(clamp(t) * (r.length - 1))]; }

  function wardFill(w) {
    const nodata = css('--nodata');
    if (!w) return nodata;
    if (mode === 'mayor') {
      const r = w.mayor;
      if (!r?.leader) return nodata;
      if (r.tied) return css('--other');
      const c = candColour(r.leader.name) || css('--other');
      return mix(c, css('--surface'), 0.35 + 0.65 * clamp(r.margin / 30));
    }
    if (mode === 'council') {
      const r = w.council;
      if (!r?.leader) return nodata;
      return seqColour(r.cands.length < 2 ? 1 : r.margin / 40);
    }
    if (mode === 'reporting') {
      const r = w.mayor || w.council;
      return r?.polls ? seqColour(r.pollsReceived / r.polls) : nodata;
    }
    if (mode === 'turnout') {
      const r = w.mayor;
      return r?.totalVoters && r.votes ? seqColour(r.votes / r.totalVoters / 0.6) : nodata;
    }
  }

  function renderMap() {
    for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    for (const [num, p] of Object.entries(paths)) p.style.fill = wardFill(model?.wards[num]);
    const label = css('--ink'), halo = css('--surface');
    for (const t of svg.querySelectorAll('.lbl')) { t.style.fill = label; t.style.stroke = halo; }
    pin.setAttribute('d', geo.wards[pinned]?.d || '');
    renderLegend();
  }

  function renderLegend() {
    const L = $('#legend');
    const ramp = (lo, hi) => `${lo}<span class="ramp">${seqRamp().map((c) => `<span style="background:${c}"></span>`).join('')}</span>${hi}`;
    const nd = `<span><i class="sw" style="background:${css('--nodata')}"></i>No votes yet</span>`;
    if (mode === 'mayor') {
      const items = [...colorOf.entries()].sort((a, b) => a[1] - b[1])
        .map(([n, s]) => `<span><i class="sw" style="background:var(--s${s})"></i>${esc(n)}</span>`);
      L.innerHTML = items.join('') + `<span><i class="sw" style="background:var(--other)"></i>Other / tied</span>${nd}<span>Darker = wider lead</span><span style="color:var(--muted)">Hover to preview · click to pin</span>`;
    } else if (mode === 'council') {
      L.innerHTML = `<span>Lead over 2nd place: ${ramp('0', '40+ pts')}</span>${nd}`;
    } else if (mode === 'reporting') {
      L.innerHTML = `<span>Polls reporting: ${ramp('0%', '100%')}</span>`;
    } else {
      L.innerHTML = `<span>Turnout (mayor ballots / electors): ${ramp('0%', '60%+')}</span>${nd}`;
    }
  }

  // ---------- hover / pin ----------
  function setHover(n) {
    if (n === hover) return;
    hover = n;
    svg.classList.toggle('hovering', !!n);
    for (const [num, p] of Object.entries(paths)) p.classList.toggle('hot', num === n);
    hl.setAttribute('d', n ? geo.wards[n].d : '');
    for (const tr of document.querySelectorAll('#wardTable tbody tr')) tr.classList.toggle('hot', tr.dataset.w === n);
    renderTip();
    renderWard();
  }
  function setPinned(n) {
    pinned = String(n);
    saveHash();
    pin.setAttribute('d', geo.wards[pinned]?.d || '');
    for (const tr of document.querySelectorAll('#wardTable tbody tr')) tr.classList.toggle('pinned', tr.dataset.w === pinned);
    renderWard();
  }
  function saveHash() { history.replaceState(null, '', `#w=${pinned}&m=${mode}&t=${tab}`); }

  const tip = $('#tip');
  function placeTip(x, y) {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + w > innerWidth - 8) left = x - w - 16;
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`;
  }
  function tipRows(r, n, colour) {
    if (!r) return '<div class="empty">No data</div>';
    return r.cands.slice(0, n).map((c) => {
      const col = colour ? candColour(c.name) : null;
      return `<div class="r"><i class="sw" style="width:9px;height:9px;border-radius:2px;background:${col || 'transparent'}"></i><span class="nm">${esc(c.name)}</span><span class="votes">${fmt(c.votes)}</span><span class="pct">${pct(c.pct)}</span></div>`;
    }).join('') + (r.cands.length > n ? `<div style="color:var(--muted);margin-top:2px">+ ${r.cands.length - n} more in side panel</div>` : '');
  }
  function renderTip() {
    if (!hover || !model) { tip.classList.remove('on'); return; }
    const w = model.wards[hover] || { name: geo.wards[hover].name };
    const rep = w.mayor || w.council;
    tip.innerHTML = `<h3>Ward ${hover} - ${esc(w.name)}</h3>
      <div style="color:var(--ink-2)">${rep ? `${fmt(rep.pollsReceived)}/${fmt(rep.polls)} polls reporting${rep.totalVoters ? ` - turnout ${pct((rep.votes / rep.totalVoters) * 100)}` : ''}` : ''}</div>
      <div class="sec"><span>Councillor</span><span>${w.council ? `${w.council.cands.length} candidates` : ''}</span></div>${tipRows(w.council, 4)}
      <div class="sec"><span>Mayor in this ward</span><span>${w.mayor ? `${w.mayor.cands.length} candidates` : ''}</span></div>${tipRows(w.mayor, 4, true)}`;
    tip.classList.add('on');
  }

  // ---------- rendering: lists ----------
  function candList(r, { colour = false, showComplete = true } = {}) {
    if (!r || !r.cands.length) return '<li class="empty">No candidates in feed</li>';
    const max = Math.max(1, ...r.cands.map((c) => c.pct));
    return r.cands.map((c, i) => {
      const lead = r.leader && i === 0 && !r.tied;
      const col = colour ? candColour(c.name) : null;
      const tag = lead && showComplete && r.complete ? '<span class="tag">Unofficial winner</span>' : '';
      return `<li class="cand${lead ? ' lead' : ''}${c.delta && flashNow ? ' flash' : ''}" title="${esc(c.name)}: ${fmt(c.votes)} votes (${pct(c.pct, 2)})${c.delta ? `, +${fmt(c.delta)} since last update` : ''}">
        <span class="sw" style="background:${col || 'transparent'}"></span>
        <span class="nm">${esc(c.name)}${tag}</span>
        <span class="delta">${c.delta ? `+${fmt(c.delta)}` : ''}</span>
        <span class="votes">${fmt(c.votes)}</span>
        <span class="pct">${pct(c.pct)}</span>
        <span class="bar"><i style="width:${(c.pct / max) * 100}%;${col ? `background:${col}` : ''}"></i></span>
      </li>`;
    }).join('');
  }
  // Thin progress bar; `done` turns it green when every poll is in.
  const meter = (frac, done = false) => `<span class="meter${done ? ' done' : ''}"><i style="width:${clamp(frac) * 100}%"></i></span>`;
  const raceMeta = (r) => r ? `${fmt(r.pollsReceived)}/${fmt(r.polls)} polls · ${fmt(r.votes)} votes${r.complete ? ' · all in' : ''}` : '';

  function renderWard() {
    const n = hover || pinned;
    $('#tabWard').textContent = pinned;
    const el = $('#panel-ward');
    if (!model || !n) { el.innerHTML = '<div class="empty">Hover or tap a ward on the map.</div>'; return; }
    const w = model.wards[n] || { name: geo.wards[n]?.name };
    const rep = w.mayor || w.council;
    // Keep each list's scroll position when the panel re-renders for the same ward.
    const keep = el.dataset.w === String(n) ? [...el.querySelectorAll('.scroller')].map((x) => x.scrollTop) : [];
    el.dataset.w = n;
    el.innerHTML = `
      <div class="ward-head">
        <div class="ward-title"><span class="wn">Ward ${n}</span><span class="wname">${esc(w.name || '')}</span>
          <span class="pinned">${hover && hover !== pinned ? 'preview · click to pin' : 'pinned'}</span></div>
        <div class="ward-sub">${rep ? `<span>${fmt(rep.pollsReceived)} of ${fmt(rep.polls)} polls reporting (${pct(rep.polls ? (rep.pollsReceived / rep.polls) * 100 : 0, 0)})${meter(rep.polls ? rep.pollsReceived / rep.polls : 0, rep.complete)}</span>
          <span>Turnout ${pct(rep.totalVoters ? (rep.votes / rep.totalVoters) * 100 : 0)}${meter(rep.totalVoters ? rep.votes / rep.totalVoters : 0)}</span>
          <span>${fmt(rep.totalVoters)} electors</span>` : ''}</div>
      </div>
      <div class="races">
        <div class="race"><div class="race-head"><h3>Council</h3><span class="meta">${raceMeta(w.council)}</span></div>
          <div class="scroller"><ul class="cands">${candList(w.council)}</ul></div></div>
        <div class="race"><div class="race-head"><h3>Mayor</h3><span class="meta">${raceMeta(w.mayor)}</span></div>
          <div class="scroller"><ul class="cands dense">${candList(w.mayor, { colour: true, showComplete: false })}</ul></div></div>
      </div>`;
    el.querySelectorAll('.scroller').forEach((x, i) => { if (keep[i]) x.scrollTop = keep[i]; });
  }

  function renderCity() {
    const r = model.mayor;
    $('#cityMeta').textContent = raceMeta(r);
    const [a, b] = r.cands;
    $('#cityLead').innerHTML = r.leader
      ? (r.tied ? `<b>Tied</b> at ${fmt(a.votes)} votes` : `<b>${esc(a.name)}</b> leads ${esc(b?.name || '')} by <b>${fmt(a.votes - (b?.votes || 0))}</b> votes (${(a.pct - (b?.pct || 0)).toFixed(1)} pts)`)
        + ` - ${r.cands.length} candidates`
      : `${r.cands.length} candidates - no votes reported yet`;
    $('#cityList').innerHTML = candList(r, { colour: true });
  }

  function renderStats() {
    const r = model.mayor;
    const wards = Object.values(model.wards);
    const wardsDone = wards.filter((w) => (w.mayor || w.council)?.complete).length;
    const s = [
      ['Polls reporting', `${fmt(r.pollsReceived)}/${fmt(r.polls)} (${pct(r.polls ? (r.pollsReceived / r.polls) * 100 : 0, 0)})`, meter(r.polls ? r.pollsReceived / r.polls : 0, r.complete)],
      ['Wards complete', `${wardsDone}/${wards.length}`, meter(wards.length ? wardsDone / wards.length : 0, wards.length > 0 && wardsDone === wards.length)],
      ['Mayor ballots', fmt(r.votes), '<span class="meter blank"></span>'],
      ['Turnout', `${pct(r.totalVoters ? (r.votes / r.totalVoters) * 100 : 0)} of ${fmt(r.totalVoters)}`, meter(r.totalVoters ? r.votes / r.totalVoters : 0)],
    ];
    $('#stats').innerHTML = s.map(([k, v, m]) => `<div class="stat"><b>${v}</b>${m}<span>${k}</span></div>`).join('');
  }

  function renderStatus() {
    const st = $('#status'), tx = $('#statusText'), notice = $('#notice');
    st.className = 'status';
    let note = '';
    if (!model) {
      st.classList.add('error');
      tx.textContent = lastErr ? 'Results unavailable - retrying' : 'Loading...';
      if (lastErr) note = `Could not load results: ${esc(lastErr.message)}. Retrying every ${POLL_MS / 1000}s.`;
    } else {
      const r = model.mayor;
      const gen = model.generatedAt ? `${time(model.generatedAt)} (${ago(Date.now() - model.generatedAt)})` : 'unknown';
      const relayAge = model.relayedAt ? Date.now() - model.relayedAt : 0;
      if (lastErr) { st.classList.add('error'); tx.textContent = `Connection problem - showing data from ${gen}`; }
      else if (!DEMO && relayAge > STALE_MS) { st.classList.add('stale'); tx.textContent = `Relay delayed - last checked ${ago(relayAge)}`; }
      else if (r.complete) { st.classList.add('live'); tx.textContent = `All polls reported - feed ${gen}`; }
      else if (r.pollsReceived > 0) { st.classList.add('live'); tx.textContent = `Live - feed ${gen}`; }
      else { tx.textContent = `Waiting for results (polls close 8 p.m.) - feed ${gen}`; }
      if (usedSource === 'raw') note = 'GitHub API limit reached for your network - using a backup copy that can lag up to 5 minutes.';
      $('#srcInfo').textContent = ` Feed seq ${model.seq}${model.relayedAt ? `, relay checked ${time(model.relayedAt)}` : ''}${model.changedAt ? `, last change ${time(model.changedAt)}` : ''}.`;
    }
    notice.hidden = !note; notice.innerHTML = note;
  }

  const COLS = [
    { key: 'num', label: '#', n: true, v: (w) => w.num },
    { key: 'name', label: 'Ward', v: (w) => w.name },
    { key: 'rep', label: 'Reporting', v: (w) => { const r = w.mayor || w.council; return r?.polls ? r.pollsReceived / r.polls : 0; } },
    { key: 'turn', label: 'Turnout', n: true, v: (w) => (w.mayor?.totalVoters ? w.mayor.votes / w.mayor.totalVoters : 0) },
    { key: 'mlead', label: 'Mayor leader', v: (w) => w.mayor?.leader?.name || '' },
    { key: 'mpct', label: '% · lead', n: true, v: (w) => w.mayor?.leader?.pct || 0 },
    { key: 'clead', label: 'Council leader', v: (w) => w.council?.leader?.name || '' },
    { key: 'cpct', label: '% · lead', n: true, v: (w) => w.council?.leader?.pct || 0 },
  ];
  function renderTable() {
    const t = $('#wardTable');
    const col = COLS.find((c) => c.key === sort.key);
    const rows = Object.values(model.wards).sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir || a.num - b.num;
    });
    const who = (r, colour) => {
      if (!r?.leader) return '<span style="color:var(--muted)">-</span>';
      if (r.tied) return 'Tied';
      const c = colour ? candColour(r.leader.name) || css('--other') : null;
      return `<span class="who">${c ? `<i style="background:${c}"></i>` : ''}${esc(r.leader.name)}${r.complete ? ' <span class="done">&#10003;</span>' : ''}</span>`;
    };
    t.innerHTML = `<thead><tr>${COLS.map((c) => `<th data-k="${c.key}"${c.n ? ' class="n"' : ''}${sort.key === c.key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((w) => {
        const r = w.mayor || w.council;
        const rp = r?.polls ? r.pollsReceived / r.polls : 0;
        return `<tr data-w="${w.num}" class="${String(w.num) === pinned ? 'pinned' : ''}${String(w.num) === hover ? ' hot' : ''}">
          <td class="n">${w.num}</td><td>${esc(w.name)}</td>
          <td><span class="num">${r ? `${r.pollsReceived}/${r.polls}` : ''}</span>${r?.complete ? ' <span class="done">&#10003;</span>' : ''}${meter(rp, r?.complete)}</td>
          <td class="n">${pct(COLS[3].v(w) * 100)}${meter(COLS[3].v(w))}</td>
          <td>${who(w.mayor, true)}</td><td class="n">${w.mayor?.leader ? `${pct(w.mayor.leader.pct)}<span class="sub">+${w.mayor.margin.toFixed(1)}</span>` : ''}</td>
          <td>${who(w.council)}<span class="sub">of ${w.council?.cands.length ?? 0}</span></td><td class="n">${w.council?.leader ? `${pct(w.council.leader.pct)}<span class="sub">+${w.council.margin.toFixed(1)}</span>` : ''}</td>
          </tr>`;
      }).join('')}</tbody>`;
  }
  $('#wardTable').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (th) { const k = th.dataset.k; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'num' || k === 'name' || k === 'mlead' || k === 'clead' ? 1 : -1) }; renderTable(); return; }
    const tr = e.target.closest('tbody tr'); if (tr) { setPinned(tr.dataset.w); setTab('ward'); }
  });
  $('#wardTable').addEventListener('mouseover', (e) => { const tr = e.target.closest('tbody tr'); if (tr) { setHover(tr.dataset.w); tip.classList.remove('on'); } });
  $('#wardTable').addEventListener('mouseleave', () => setHover(null));

  const BOARD_SHORT = { 'Toronto District School Board': 'TDSB', 'Toronto Catholic District School Board': 'TCDSB', 'Conseil scolaire Viamonde': 'Viamonde', 'Conseil scolaire catholique MonAvenir': 'MonAvenir' };
  function renderBoards() {
    if (!model.boards.some((b) => b.id === board)) board = model.boards[0]?.id ?? null;
    $('#tabSchool').textContent = model.boards.length || '';
    $('#boardTabs').innerHTML = model.boards.map((b) =>
      `<button data-b="${b.id}" aria-pressed="${b.id === board}" title="${esc(b.name)}">${esc(BOARD_SHORT[b.name] || b.name)} <span style="opacity:.7">· ${b.wards.length}</span></button>`).join('');
    const b = model.boards.find((x) => x.id === board);
    $('#boards').innerHTML = b ? `<div class="board-grid">${b.wards.map((w) => `
      <div class="board-ward"><div class="race-head"><h3>${esc(BOARD_SHORT[b.name] || b.name)} Ward ${esc(w.num)}${w.name ? ` - ${esc(w.name)}` : ''}</h3><span class="meta">${raceMeta(w.race)}</span></div>
      <ul class="cands dense">${candList(w.race)}</ul></div>`).join('')}</div>` : '<div class="empty">No school board races in the feed.</div>';
  }
  $('#boardTabs').addEventListener('click', (e) => { const btn = e.target.closest('button'); if (btn) { board = int(btn.dataset.b); renderBoards(); } });

  // ---------- tabs ----------
  function setTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const p of document.querySelectorAll('#right .panel')) p.hidden = p.id !== `panel-${t}`;
    document.body.classList.toggle('wide-right', t === 'wards' || t === 'school');
    saveHash();
  }
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

  function renderAll() {
    flashNow = true;
    renderStatus(); renderStats(); renderMap(); renderCity(); renderWard(); renderTable(); renderBoards(); renderTip();
    flashNow = false;
  }

  // ---------- boot ----------
  if (DEMO) $('#demoBanner').hidden = false;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => model && renderAll());
  fetch('wards.json').then((r) => r.json()).then((g) => {
    geo = g;
    buildMap();
    if (!geo.wards[pinned]) pinned = '1';
    setTab(tab);
    renderMap(); renderWard();
    tick();
    setInterval(tick, POLL_MS);
    setInterval(renderStatus, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  });
})();
