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
  const POLL_MS = DEMO ? 9000 : 30000;
  const SOURCES = params.get('src')
    ? [{ id: 'custom', url: params.get('src') }]
    : [
        { id: 'worker', base: params.get('worker') || 'https://toronto-election-2026.andrewjohnmcgrath.workers.dev' },
        { id: 'api', url: `https://api.github.com/repos/${OWNER}/${REPO}/contents/bundle.json?ref=data`,
          headers: { Accept: 'application/vnd.github.raw+json' } },
        { id: 'raw', url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/data/bundle.json` },
      ];
  const STALE_MS = 7 * 60 * 1000;
  // Anonymous random id per browser, sent to the Worker so it can count live and daily viewers.
  const VIEWER = (() => {
    const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      let v = localStorage.getItem('viewer');
      if (!/^[0-9a-f]{16}$/.test(v || '')) localStorage.setItem('viewer', (v = fresh()));
      return v;
    } catch { return fresh(); }
  })();
  // Race-call thresholds. The About tab explains them using these same values.
  const CALL = { minReporting: 0.25, safety: 1.5, needShare: 0.75, swing: 0.30 };
  // The City's feed never marks results official. When the City Clerk certifies the election,
  // set `certified` to the date (e.g. 'October 28, 2026') and every call becomes "Official winner".
  const OFFICIAL = { certified: null, url: 'https://www.toronto.ca/city-government/elections/election-results-reports/election-results/' };
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
  const hm = (d) => d ? d.toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '';
  const compact = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : fmt(n);
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
  // Device-only memory: the ward found from location, and the last ward viewed. No coordinates are kept.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  let myWard = store.get('myWard');
  let pinned = hash.get('w') || store.get('lastWard') || myWard || '1';
  let userPinned = false; // set once the person picks a ward themselves this visit
  let hover = null;
  let sort = { key: 'num', dir: 1 };
  let tab = { school: 'wards' }[hash.get('t')] || (['ward', 'wards', 'method', 'feed'].includes(hash.get('t')) ? hash.get('t') : 'ward');
  let racesView = hash.get('t') === 'school' ? 3 : 'council'; // 'council' or a school board office id
  // Ward tabs the person has opened (up to 5), remembered on this device.
  const MAX_WARD_TABS = 5;
  let openWards = (hash.get('o') || store.get('openWards') || '').split(',').filter(Boolean);
  let board = null; // selected school board office id
  let flashNow = false; // only animate vote changes on data updates, not on hover re-renders
  // Watched candidates, as `<race key>|<name>` (mayor is always the city-wide race); this device only.
  const MAX_WATCH = 8;
  let watch = (() => { try { const v = JSON.parse(store.get('watch') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_WATCH) : []; } catch { return []; } })();

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
      key,
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
    // Photo lookup keys match photos.json: mayor | council-N | o<board>-N
    m.mayor.pkey = 'mayor';
    for (const w of Object.values(m.wards)) { if (w.mayor) w.mayor.pkey = 'mayor'; if (w.council) w.council.pkey = `council-${w.num}`; }
    for (const b of m.boards) for (const w of b.wards) w.race.pkey = `o${b.id}-${w.num}`;
    prevVotes = nextVotes;
    // Calls. City-wide mayor estimates the votes still to come ward by ward.
    const perPoll = m.mayor.pollsReceived ? m.mayor.votes / m.mayor.pollsReceived : 0;
    const mayorLeft = Object.values(m.wards).reduce((sum, w) => {
      const r = w.mayor; if (!r) return sum;
      return sum + (r.pollsReceived ? r.votes / r.pollsReceived : perPoll) * (r.polls - r.pollsReceived);
    }, 0);
    m.mayor.call = callRace(m.mayor, mayorLeft);
    for (const w of Object.values(m.wards)) if (w.council) w.council.call = callRace(w.council);
    for (const b of m.boards) for (const w of b.wards) w.race.call = callRace(w.race);
    return m;
  }

  // ---------- race calls ----------
  // status: awaiting | early | close | tied | projected | decided | official, with a plain-English reason.
  function callRace(r, estLeft) {
    if (!r || !r.cands.length) return null;
    const [a, b] = r.cands;
    if (OFFICIAL.certified && r.leader && !r.tied) return { status: 'official', reason: `Certified by the City Clerk on ${OFFICIAL.certified}` };
    if (!b) return { status: 'acclaimed', reason: 'Only candidate in this race, so elected by acclamation when nominations closed' };
    if (!r.leader || !r.pollsReceived) return { status: 'awaiting', reason: 'No polls reported yet' };
    if (r.tied) return { status: 'tied', reason: `Tied at ${fmt(a.votes)} votes each` };
    if (r.complete) return { status: 'decided', reason: `All ${fmt(r.polls)} polls reported - unofficial until certified` };
    const gap = a.votes - b.votes;
    const maxLeft = Math.max(0, r.totalVoters - r.votes);
    if (gap > maxLeft) return { status: 'decided', reason: `Lead of ${fmt(gap)} is bigger than all ${fmt(maxLeft)} electors not yet counted` };
    const left = Math.min(maxLeft, (estLeft ?? (r.votes / r.pollsReceived) * (r.polls - r.pollsReceived)) * CALL.safety);
    const topTwo = r.votes ? left * ((a.votes + b.votes) / r.votes) : 0;
    const need = topTwo > 0 ? (topTwo + gap) / (2 * topTwo) : Infinity;
    const hasNow = b.votes / (a.votes + b.votes); // runner-up's share of the top-two vote so far
    const why = `${b.name} would need ${need > 1 ? 'more than all' : `${Math.round(need * 100)}%`} of an estimated ${fmt(Math.round(topTwo))} votes still to come between the top two, and has ${Math.round(hasNow * 100)}% so far`;
    const rep = r.pollsReceived / r.polls;
    if (rep < CALL.minReporting) return { status: 'early', need, reason: `Only ${pct(rep * 100, 0)} of polls are in. Calls start at ${CALL.minReporting * 100}%.` };
    return { status: need >= CALL.needShare || need - hasNow >= CALL.swing ? 'projected' : 'close', need, reason: why };
  }
  const CALL_LABEL = { acclaimed: '&#10003; Acclaimed', official: '&#10003; Official winner', decided: '&#10003; Winner &middot; unofficial', projected: '&#10003; Projected winner', close: 'Too close to call', early: 'Too early to call', tied: 'Tied', awaiting: 'No results yet' };
  const CALLED = new Set(['projected', 'decided', 'official', 'acclaimed']);
  // One definition per label, shared by the hover card and the Methodology tab.
  const CALL_DEF = {
    awaiting: 'No polls in this race have reported yet.',
    early: `Fewer than ${CALL.minReporting * 100}% of this race's polls have reported, so no call is made yet, however big the lead. The candidate listed first is ahead for now.`,
    close: `Enough polls are in to consider a call, but the runner-up could still realistically catch up. The candidate listed first is ahead for now.`,
    tied: 'The top two candidates have exactly the same number of votes.',
    projected: `This page's estimate, not an official result: at least ${CALL.minReporting * 100}% of polls are in, and to catch up the runner-up would need ${CALL.needShare * 100}% or more of the remaining votes between the top two, or a share ${CALL.swing * 100} or more points higher than they have managed so far.`,
    acclaimed: 'Only one candidate was nominated, so the City Clerk declared them elected by acclamation before election day. No votes are cast in this race.',
    decided: 'The result can no longer change: all polls are in, the lead is bigger than every elector not yet counted, or only one candidate is running. Still unofficial until the City Clerk certifies.',
    official: 'The City Clerk has certified the results. This is set by hand once certified results are posted; the feed never says it.',
  };
  const badge = (call) => call ? `<button class="call call-${call.status}" data-status="${call.status}" data-reason="${esc(call.reason)}" aria-label="${CALL_LABEL[call.status].replace(/&[^;]+;\s*/g, '')}: ${esc(call.reason)}. Show explanation.">${CALL_LABEL[call.status]}<span class="i" aria-hidden="true">i</span></button>` : '';
  // Status pill + plain sentence about the lead, then the reason underneath.
  function callRow(r, { reason = true } = {}) {
    if (!r) return '';
    const [a, b] = r.cands;
    let txt;
    if (r.cands.length > 1 && !r.leader && r === model?.mayor) txt = `${r.cands.length} candidates, listed A–Z until votes are counted`;
    else if (r.cands.length === 1) txt = `<b>${esc(a.name)}</b> is the only candidate`;
    else if (!r.leader) txt = `${r.cands.length} candidate${r.cands.length === 1 ? '' : 's'} · no votes counted yet`;
    else if (r.tied) txt = `<b>${esc(a.name)}</b> and <b>${esc(b.name)}</b> are tied at ${fmt(a.votes)}`;
    else if (!b) txt = `<b>${esc(a.name)}</b> is the only candidate`;
    else txt = `<b>${esc(a.name)}</b> leads ${esc(b.name)} by <b>${fmt(a.votes - b.votes)}</b> votes (${(a.pct - b.pct).toFixed(1)} pts)`;
    return `<div class="callrow">${badge(r.call)}<span class="lead-txt">${txt}</span></div>${reason ? why(r.call) : ''}`;
  }
  const why = (call) => call && call.status !== 'awaiting' ? `<div class="call-why">${esc(call.reason)}</div>` : '';

  function renderMethod() {
    const ex = (st) => `<span class="call call-${st}">${CALL_LABEL[st]}</span>`;
    const sections = [
      ['m-disclaimer', 'Disclaimer'], ['m-calls', 'Race calls'], ['m-data', 'Where the numbers come from'], ['m-calc', 'How each number is worked out'],
      ['m-map', 'Map colours'], ['m-photos', 'Candidate photos'], ['m-location', 'Your location'], ['m-incumbents', 'Incumbents'], ['m-privacy', 'Privacy'], ['m-limits', 'Limits'],
    ];
    $('#method').innerHTML = `
      <h2>Methodology</h2>
      <p>How this page gets its data and turns it into what you see. All of it runs in your browser from the City's published feed.</p>
      <nav class="toc">${sections.map(([id, t]) => `<a href="#" data-jump="${id}">${t}</a>`).join('')}</nav>

      <section id="m-disclaimer"><h3>Disclaimer</h3>
      <div class="disclaimer-box">
        <p>This page was made by <a href="https://andrewmcgrath.info">Andrew McGrath</a> and is offered as an ad-free alternative to mainstream media platforms. It is not affiliated with the City of Toronto.</p>
        <p>All results come from the City of Toronto's unofficial results feed and are unofficial until certified by the City Clerk. Race calls ("Projected winner", "Winner · unofficial") are this page's own estimates using the method below, not official results or City announcements.</p>
        <p>This page is provided as is, without representations or warranties of any kind. We take no responsibility for the accuracy, completeness or timeliness of the data or projections. For official results, see the <a href="https://www.toronto.ca/city-government/elections/">City of Toronto elections website</a>.</p>
      </div>
      </section>

      <section id="m-calls"><h3>Race calls</h3>
      <p><b>The City's feed only reports unofficial vote counts. It never says a race is decided.</b> Every label below is this page's own estimate, recalculated each time the feed updates. News outlets may call races sooner or later using other information.</p>
      <dl class="calls">${['awaiting', 'early', 'close', 'tied', 'projected', 'decided', 'official', 'acclaimed'].map((st) => `<dt>${ex(st)}</dt><dd>${CALL_DEF[st]}</dd>`).join('')}</dl>
      <p><b>The projection, step by step</b></p>
      <ol>
        <li>Wait until at least <b>${CALL.minReporting * 100}%</b> of the race's polls have reported.</li>
        <li>Estimate the votes still to come: average votes per poll so far × polls not yet reported. For mayor this is done ward by ward and added up, so a big ward reporting late is not underestimated.</li>
        <li>Multiply that estimate by <b>${CALL.safety}</b> as a safety margin, and cap it at the number of electors not yet counted.</li>
        <li>Assume the top two keep the same combined share of those votes they have so far, and work out what share of them the runner-up needs to draw level.</li>
        <li>If the runner-up would need <b>${CALL.needShare * 100}% or more</b> of those votes, or a share at least <b>${CALL.swing * 100} points higher</b> than their share of the top-two vote so far (for example 40% when they have had 8%), the leader is shown as <span class="call call-projected">${CALL_LABEL.projected}</span>. Otherwise it stays <span class="call call-close">${CALL_LABEL.close}</span>. Every badge shows the actual figure for that race when you hover it.</li>
      </ol>
      <p>Only the city-wide mayor's race is called. The mayor results shown for each ward are the votes cast there, not a separate race. Council and school trustee races are each called on their own numbers.</p>
      <p><b>Official results:</b> ${OFFICIAL.certified ? `certified by the City Clerk on ${esc(OFFICIAL.certified)}.` : 'not certified yet.'} Certification happens after election night and is posted on the <a href="${OFFICIAL.url}">City's election results page</a>. The page is switched to "Official winner" by hand at that point.</p>
      </section>

      <section id="m-data"><h3>Where the numbers come from</h3>
      <p>The City of Toronto's unofficial results feeds: <a href="https://mediaresults.toronto.ca/results/unofficialresult.json">all offices</a> (mayor, council, four school boards) and <a href="https://mediaresults.toronto.ca/results/unofficialresult-wardbyward.json">mayor by ward</a>. The City updates them about every 60 seconds from 8 p.m. on election night until all results are in. This page checks every 30 seconds.</p>
      <p>The feed blocks cross-origin requests from browsers, so it is passed through unchanged by a small Cloudflare Worker (each file cached up to 15 seconds). If that fails, the page uses a copy kept by a GitHub Actions job, which can be 1-2 minutes behind; a notice appears when that happens.</p>
      <p>Advance-vote results are added into ward totals on election night. Results by voting place are published on Toronto Open Data only after certification.</p>
      </section>

      <section id="m-calc"><h3>How each number is worked out</h3>
      <dl class="calls defs">
        <dt>Votes</dt><dd>As reported by the feed, unchanged.</dd>
        <dt>Percent</dt><dd>The feed's own percentage for city-wide and ward races. For mayor results within a ward (which the feed gives without percentages), votes ÷ total mayor votes counted in that ward.</dd>
        <dt>Polls reporting</dt><dd>Voting subdivisions received ÷ total subdivisions, from the feed. Advance-vote subdivisions are included.</dd>
        <dt>Turnout</dt><dd>Ballots counted for the office ÷ eligible electors on the list, both from the feed. It rises as polls report and is only final when all polls are in.</dd>
        <dt>Lead</dt><dd>Leader's percent minus second place's percent, in percentage points.</dd>
        <dt>+ green numbers</dt><dd>Votes added since the previous update you saw.</dd>
      </dl>
      </section>

      <section id="m-map"><h3>Map colours</h3>
      <p><b>Mayor leader:</b> the top three mayoral candidates city-wide each get a colour, and keep it even if their ranks change. A ward led by anyone else, or tied, is grey. A stronger colour means a wider lead in that ward (full strength at 30 points or more).</p>
      <p><b>Council margin:</b> a stronger blue means a wider lead for the council leader (full strength at 40 points). <b>Reporting</b> and <b>Turnout:</b> a stronger blue means higher (turnout full strength at 60%).</p>
      <p>Ward boundaries: <a href="https://open.toronto.ca/dataset/city-wards/">Toronto Open Data</a>, 25-ward model, simplified for the web.</p>
      </section>

      <section id="m-photos"><h3>Candidate photos</h3>
      <p>Photos were taken from each candidate's own campaign website or social page, as listed on the <a href="https://www.toronto.ca/city-government/elections/candidate-list/">City's candidate list</a>, and cropped automatically around the face. Each crop was then checked by hand, and images that weren't clearly a headshot of the candidate were dropped. Candidates without a usable photo are shown with their initials. If a photo is wrong, contact <a href="https://andrewmcgrath.info">Andrew McGrath</a>.</p>
      <p>On the map, the Mayor and Council views show the leading candidate's photo at each ward's centre. Where we have no photo of the leader, their initials are shown instead. Use the Faces switch under the map to turn photos off.</p>
      </section>

      <section id="m-location"><h3>Your location</h3>
      <p>"Find my ward" asks your browser for your location once, and matches it against the ward map on your own device. Your location is never sent to us or anyone else, and it isn't stored. Only your ward number is saved in your browser, so the page can open on your ward next time. Clear your browser's site data to forget it. Ward edges on the map are simplified, so if you're right on a boundary, double-check your ward with the <a href="https://www.toronto.ca/city-government/elections/">City</a>.</p>
      </section>

      <section id="m-incumbents"><h3>Incumbents</h3>
      <p>The City's results feed doesn't say who already holds each seat, so "Incumbent" labels come from a list made for this page from the City's <a href="https://www.toronto.ca/city-government/council/members-of-council/">Members of Council</a> page and news coverage, including by-elections since 2022. They cover the mayor and council only. "Open seat" means the sitting councillor isn't running again in that ward; "Councillor" marks a sitting councillor running for a different seat (for example, a councillor running for mayor). "Re-elected" and "unseats" in the live updates follow the same race calls as the rest of the page.</p>
      </section>

      <section id="m-privacy"><h3>Privacy</h3>
      <p><b>No ads, no cookies, no accounts and no tracking or advertising scripts.</b> Nothing on this page follows you around the web or builds a profile of you, and nothing is sold or shared.</p>
      <p><b>Counting viewers.</b> To see how many people are using the page, your browser makes up a random code (like <code>3f9a0c71b2e48d65</code>) and sends it along when it checks for new results. It isn't linked to your name, account, location or anything else about you; it only lets us count how many browsers have the page open right now and over the last day. The codes are deleted after 24 hours. Only the totals are kept.</p>
      <p><b>Saved in your browser only.</b> Your watched candidates, theme, ticker setting, ward (if you used "Find my ward"), last ward viewed, open ward tabs, view choices and the random code are kept in your browser's local storage, on your device. They're never sent anywhere except the random code above. Clear this site's data in your browser to remove them all.</p>
      <p><b>Your location</b> never leaves your device. See <a href="#" data-jump="m-location">Your location</a>.</p>
      <p><b>Hosting.</b> The page is served by GitHub Pages, and results pass through a small Cloudflare Worker (or GitHub if that fails). Like any website host, they receive your IP address and browser details to deliver the page, under their own policies (<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub</a>, <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a>). We don't collect or keep those request logs. Candidate photos are served from this site, and there are no outside fonts or scripts.</p>
      </section>

      <section id="m-limits"><h3>Limits</h3>
      <p>Polls do not report in random order. Advance-vote polls (subdivisions 98 and 99 in each ward) and whole neighbourhoods can arrive in batches, so early numbers can lean one way. The minimum share of polls and the safety margin are there to absorb that, but a projection can still be wrong.</p>
      <p>The feed has no historical results, demographics or poll-by-poll counts, so the projection cannot model how particular areas usually vote.</p>
      </section>`;
  }
  $('#method').addEventListener('click', (e) => {
    const a = e.target.closest('[data-jump]');
    if (a) { e.preventDefault(); document.getElementById(a.dataset.jump).scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) { setTab('method'); document.getElementById(b.dataset.goto).scrollIntoView({ block: 'start' }); }
  });

  // Explanation card for call badges: definition + this race's own numbers.
  // Hover shows it; click/tap keeps it open; the link inside goes to the methodology.
  const callTip = $('#callTip');
  let tipHide = null, tipPinned = false;
  function showCallTip(el) {
    const st = el.dataset.status;
    if (!st) return;
    clearTimeout(tipHide);
    callTip.innerHTML = `<span class="call call-${st}">${CALL_LABEL[st]}</span><p class="def">${CALL_DEF[st]}</p>
      ${el.dataset.reason ? `<div class="this"><b>This race</b>${el.dataset.reason}</div>` : ''}
      <button class="linkish more" data-goto="m-calls">How races are called &rarr;</button>`;
    const r = el.getBoundingClientRect();
    callTip.classList.add('on');
    const w = callTip.offsetWidth, h = callTip.offsetHeight;
    const left = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = r.top - h - 6;
    callTip.style.left = `${left}px`; callTip.style.top = `${top}px`;
  }
  function hideCallTip() { clearTimeout(tipHide); tipPinned = false; callTip.classList.remove('on'); }
  const hideSoon = () => { if (!tipPinned) { clearTimeout(tipHide); tipHide = setTimeout(hideCallTip, 180); } };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('.call[data-status]'); if (el && e.pointerType !== 'touch' && !tipPinned) showCallTip(el); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('.call[data-status]')) hideSoon(); });
  callTip.addEventListener('pointerenter', () => clearTimeout(tipHide));
  callTip.addEventListener('pointerleave', hideSoon);
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.call[data-status]');
    if (el) { showCallTip(el); tipPinned = true; return; }
    if (!e.target.closest('#callTip') || e.target.closest('[data-goto]')) hideCallTip();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCallTip(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('.call[data-status]'); if (el) showCallTip(el); });

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
            const q = f === 'unofficialresult.json' ? `?v=${VIEWER}` : '';
            const r = await fetch(`${src.base}/${f}${q}`, { cache: 'no-cache', signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`${src.id}: HTTP ${r.status}`);
            return { json: await r.json(), at: r.headers.get('X-Fetched-At') };
          };
          const [a, w] = await Promise.all([get('unofficialresult.json'), get('unofficialresult-wardbyward.json')]);
          usedSource = src.id;
          return { all: a.json, wardbyward: w.json, relayedAt: [a.at, w.at].filter(Boolean).sort()[0] || null };
        }
        const r = await fetch(src.url, { cache: 'no-cache', headers: src.headers || {}, signal: AbortSignal.timeout(10000) });
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

  // Simulated election night: counting starts at zero, arrives in uneven batches, holds on the final
  // result for a few updates, then quietly starts over.
  let demoP = 0, demoTick = 0, demoHold = 0, demoPaused = false, demoQuiet = false;
  let demoLast = null; // the simulated feed for this tick, which the demo live feed reads
  const demoPrev = new Map();
  function demoize(b) {
    // Synthetic numbers on the real candidate lists - layout preview only.
    const rnd = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 10000) / 10000; };
    // Candidates with a campaign photo tend to be the established campaigns, so the demo favours them.
    const hasPhoto = (name) => Object.keys(photos).some((k) => k.endsWith(`|${normName(name)}`));
    // Each candidate gets a random home base on the map; support falls off with distance, so leaders vary by area.
    const near = (name, key) => {
      const g = geo?.wards[key.split('|')[1]];
      if (!g) return 1;
      const d = Math.hypot(g.lx - rnd(name + 'x') * geo.w, g.ly - rnd(name + 'y') * geo.h);
      return 0.35 + 3 * Math.exp(-d / 260);
    };
    const weight = (name, ward) => (Math.pow(rnd(name), 6) * 8 + rnd(name + ward) * 0.6 + 0.02) * (hasPhoto(name) ? 3 + rnd(name + 'p') * 6 : 1) * near(name, ward);
    const fill = (w, cands, key, p) => {
      w.pollsReceived = String(Math.min(int(w.polls), Math.round(int(w.polls) * clamp(p + (rnd(key.replace(/^\w+\|/, '')) - 0.5) * 0.3))));
      const cast = Math.round(int(w.totalVoters) * 0.33 * (int(w.pollsReceived) / Math.max(1, int(w.polls))));
      // Swings that fade as counting finishes, so close candidates trade places now and then.
      const ws = cands.map((c) => weight(c.name, key) * (1 + (hasPhoto(c.name) ? 0.12 : 0) * (1 - p) * Math.sin(demoTick * 1.1 + rnd(c.name + key) * 6.28))), tot = ws.reduce((a, x) => a + x, 0);
      cands.forEach((c, i) => {
        const k = `${key}|${c.name}`;
        const v = Math.max(demoPrev.get(k) || 0, Math.round((cast * ws[i]) / tot));
        demoPrev.set(k, v);
        c.votesReceived = String(v); c.percentage = undefined;
      });
      w.votesReceived = String(cands.reduce((a, c) => a + int(c.votesReceived), 0));
      cands.sort((a, b) => int(b.votesReceived) - int(a.votesReceived));
    };
    demoTick++;
    if (demoP >= 1 && ++demoHold > 2) { demoP = 0; demoHold = 0; demoPrev.clear(); odoPrev.clear(); deltaPrev.clear(); demoQuiet = true; }
    else if (demoTick > 1 && demoP < 1) demoP = Math.min(1, demoP + 0.015 + Math.random() * 0.055);
    const p = demoP;
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
      if (DEMO && demoPaused && model) return;
      if (!DEMO || !rawBundle) rawBundle = await fetchBundle();
      if (DEMO) demoLast = demoize(rawBundle);
      model = buildModel(DEMO ? demoLast : rawBundle);
      lastOk = Date.now(); lastErr = null;
      assignColours();
      renderAll(demoQuiet);
      demoQuiet = false;
      if (DEMO) $('#demoProg').textContent = `Simulated count: ${Math.round((model.mayor.pollsReceived / model.mayor.polls) * 100)}% of polls in`;
      maybeWelcome();
      renderWelcome();
      loadFeed().catch((e) => console.warn('[feed]', e));
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
  const wardSize = {};
  let faceLayer, meLayer;
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
      t.dataset.n = num;
      t.textContent = num;
      gL.appendChild(t);
    }
    pin = document.createElementNS(NS, 'path'); pin.setAttribute('class', 'pin');
    hl = document.createElementNS(NS, 'path'); hl.setAttribute('class', 'hl');
    faceLayer = document.createElementNS(NS, 'g'); faceLayer.setAttribute('class', 'faces');
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = '<filter id="desat"><feColorMatrix type="saturate" values="0.1"/></filter>';
    svg.append(defs);
    meLayer = document.createElementNS(NS, 'g'); meLayer.setAttribute('class', 'me');
    svg.append(gW, pin, hl, faceLayer, gL, meLayer);
    // Face size scales with the ward's footprint so small downtown wards don't overflow.
    for (const [num, p] of Object.entries(paths)) { const b = p.getBBox(); wardSize[num] = Math.sqrt(b.width * b.height); }

    svg.addEventListener('pointermove', (e) => {
      const n = e.target.dataset?.w;
      if (e.pointerType === 'touch') return;
      if (n) { setHover(n); placeTip(e.clientX, e.clientY); } else setHover(null);
    });
    svg.addEventListener('pointerleave', () => setHover(null));
    svg.addEventListener('click', (e) => { const n = e.target.dataset?.w; if (n) { setPinned(n, true); setTab('ward'); } });
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
    renderFaces();
    renderLegend();
  }

  // Leader's photo at each ward's centre (mayor and council views), or their initials if we have no photo.
  let showFaces = true;
  try { showFaces = localStorage.getItem('faces') !== 'off'; } catch {}
  function renderFaces() {
    const parts = [];
    let clipId = 0;
    const on = showFaces && (mode === 'mayor' || mode === 'council') && model;
    for (const [num, g] of Object.entries(geo.wards)) {
      const lbl = svg.querySelector(`.lbl[data-n="${num}"]`);
      const r = on ? (mode === 'mayor' ? model.wards[num]?.mayor : model.wards[num]?.council) : null;
      const a = r?.leader && !r.tied ? r.cands[0] : null;
      const pa = a && photoOf(r.pkey, a.name);
      if (!a) { lbl.setAttribute('y', g.ly); lbl.classList.remove('small'); continue; }
      const r1 = clamp(wardSize[num] * 0.15, 16, 28);
      const faces = [{ c: a, ph: pa, rad: r1, x: g.lx, y: g.ly, lead: true }];
      // Council view: the face also shows the state of the race. Faded = not called, blue + ✓ = projected,
      // green + ✓ = settled. (The mayor's race is only called city-wide, so mayor faces stay plain.)
      const st = mode === 'council' ? r.call?.status : null;
      const settled = st === 'decided' || st === 'official' || st === 'acclaimed';
      const pending = mode === 'council' && !settled && st !== 'projected';
      for (const f of faces) {
        const ring = mode === 'mayor' ? (candColour(f.c.name) || css('--other'))
          : settled ? css('--good-fill') : st === 'projected' ? css('--proj') : css('--axis');
        const id = `fc${clipId++}`;
        const badge = settled || st === 'projected'
          ? `<circle cx="${f.x + f.rad * 0.74}" cy="${f.y + f.rad * 0.74}" r="${f.rad * 0.42}" fill="${ring}" stroke="${css('--surface')}" stroke-width="1.5"/>
             <text x="${f.x + f.rad * 0.74}" y="${f.y + f.rad * 0.76}" class="face-badge" style="font-size:${f.rad * 0.5}px">&#10003;</text>` : '';
        parts.push(`<g class="face${pending ? ' pending' : ''}"><title>${esc(f.c.name)} ${pct(f.c.pct)}${st ? ` - ${CALL_LABEL[st].replace(/&[^;]+;\s*/g, '')}` : ''}</title>
          <circle cx="${f.x}" cy="${f.y}" r="${f.rad + 2.5}" fill="${pending ? css('--surface') : ring}"${pending ? ` stroke="${ring}" stroke-width="1.5" stroke-dasharray="3 2.5"` : ''}/>
          ${f.ph ? `<clipPath id="${id}"><circle cx="${f.x}" cy="${f.y}" r="${f.rad}"/></clipPath>
          <image href="photos/${f.ph.f}" x="${f.x - f.rad}" y="${f.y - f.rad}" width="${f.rad * 2}" height="${f.rad * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"${pending ? ' filter="url(#desat)" opacity=".7"' : ''}/>`
          : `<circle cx="${f.x}" cy="${f.y}" r="${f.rad}" class="face-i"/><text x="${f.x}" y="${f.y}" class="face-t" style="font-size:${f.rad * 0.62}px">${esc(initials(f.c.name))}</text>`}
          ${badge}</g>`);
      }
      lbl.setAttribute('y', g.ly + r1 + 11); lbl.classList.add('small');
    }
    faceLayer.innerHTML = parts.join('');
  }

  // Always two rows (key, then notes) so switching modes never changes the card's height.
  function renderLegend() {
    // Ramp first at a fixed position, label after, so the bar never moves between modes.
    const ramp = (lo, hi, label) => `<span class="rk"><span class="lo">${lo}</span><span class="ramp">${seqRamp().map((c) => `<span style="background:${c}"></span>`).join('')}</span><span class="hi">${hi}</span></span><span>${label}</span>`;
    const sw = (bg, label) => `<span><i class="sw" style="background:${bg}"></i>${label}</span>`;
    let key, note;
    if (mode === 'mayor') {
      key = [...colorOf.entries()].sort((a, b) => a[1] - b[1]).map(([n, s]) => sw(`var(--s${s})`, esc(n))).join('') + sw('var(--other)', 'Other / tied');
      note = 'Stronger colour = wider lead';
    } else if (mode === 'council') {
      key = ramp('0', '40+ pts', "Council leader's lead over 2nd place");
      note = '<span class="lg-faces"><i class="lf pend"></i>Not called <i class="lf proj">&#10003;</i>Projected <i class="lf won">&#10003;</i>Winner</span>';
    } else if (mode === 'reporting') {
      key = ramp('0%', '100%', 'Polls reporting');
      note = 'Stronger colour = more counted';
    } else {
      key = ramp('0%', '60%+', 'Turnout (mayor ballots ÷ electors)');
      note = 'Stronger colour = higher turnout';
    }
    $('#legend').innerHTML = `<div class="lg-row">${key}</div>
      <div class="lg-row lg-note">${sw(css('--nodata'), 'No votes yet')}<span>${note}</span>
        <label class="lg-toggle"${mode === 'mayor' || mode === 'council' ? '' : ' hidden'}><input type="checkbox" id="facesToggle"${showFaces ? ' checked' : ''}> Faces</label>
        <span>Hover to preview · click to pin</span></div>`;
  }

  $('#legend').addEventListener('change', (e) => {
    if (e.target.id !== 'facesToggle') return;
    showFaces = e.target.checked;
    try { localStorage.setItem('faces', showFaces ? 'on' : 'off'); } catch {}
    renderFaces();
  });

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
  function setPinned(n, byUser = false) {
    pinned = String(n);
    openWardTab(pinned);
    store.set('lastWard', pinned);
    if (byUser) userPinned = true;
    saveHash();
    pin.setAttribute('d', geo.wards[pinned]?.d || '');
    for (const tr of document.querySelectorAll('#wardTable tbody tr')) tr.classList.toggle('pinned', tr.dataset.w === pinned);
    renderWard();
  }
  function saveHash() { history.replaceState(null, '', `#w=${pinned}&o=${openWards.join(',')}&m=${mode}&t=${tab}`); }

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
      return `<div class="r">${avatar(r.pkey, c.name, col)}<span class="nm">${esc(c.name)}</span><span class="votes">${fmt(c.votes)}</span><span class="pct">${pct(c.pct)}</span></div>`;
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

  // ---------- photos ----------
  // photos.json maps "<race key>|<name>" to a face crop from the candidate's own site.
  let photos = {};
  // Incumbents (incumbents.json): who held each mayor/council seat going in. Not in the City's feed.
  let incumbents = null;
  const raceKeyOf = (r) => (r.key.startsWith('mayor|') ? 'mayor|city' : r.key);
  function incTag(r, name, { short = false } = {}) {
    const held = incumbents?.races?.[raceKeyOf(r)];
    if (held?.running && held.running === name) return `<span class="inc" title="Holds this seat going into the election">Incumbent</span>`;
    const c = incumbents?.councillors?.[name];
    if (c && c.runningIn === raceKeyOf(r)) return `<span class="inc cllr" title="Sitting councillor for Ward ${c.ward}, running for this seat">Councillor${short ? '' : `, Ward ${c.ward}`}</span>`;
    return '';
  }
  const openSeat = (r) => { const held = r && incumbents?.races?.[raceKeyOf(r)]; return held && !held.running ? held.incumbent : null; };
  const normName = (n) => n.replace(/\s+/g, ' ').trim();
  const photoOf = (pkey, name) => photos[`${pkey}|${normName(name)}`];
  const initials = (name) => { const p = normName(name).split(' '); return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };
  function avatar(pkey, name, ring) {
    const ph = photoOf(pkey, name);
    const st = ring ? ` style="box-shadow:0 0 0 2px ${ring}"` : '';
    return ph ? `<span class="av"${st}><img src="photos/${ph.f}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="av av-i"${st}>${esc(initials(name))}</span>`;
  }

  // ---------- watch list ----------
  const watchKey = (r, name) => `${r.key.startsWith('mayor|') ? 'mayor|city' : r.key}|${name}`;
  const star = (wk) => {
    const on = watch.includes(wk);
    return `<button type="button" class="star" data-watch="${esc(wk)}" aria-pressed="${on}" aria-label="${on ? 'Stop watching' : 'Watch'} ${esc(wk.split('|').slice(2).join('|'))}" title="${on ? 'Stop watching' : 'Watch this candidate'}">${on ? '&#9733;' : '&#9734;'}</button>`;
  };

  // ---------- rendering: lists ----------
  function candList(r, { colour = false, showCall = true } = {}) {
    if (!r || !r.cands.length) return '<li class="empty">No candidates in feed</li>';
    const max = Math.max(1, ...r.cands.map((c) => c.pct));
    return r.cands.map((c, i) => {
      const lead = r.leader && i === 0 && !r.tied;
      const col = colour ? candColour(c.name) : null;
      const st = r.call?.status;
      const tag = lead && showCall && CALLED.has(st) ? `<span class="tick tick-${st}" title="${CALL_LABEL[st].replace(/&[^;]+;\s*/g, '')}">&#10003;</span>` : '';
      const k = esc(`${r.key}|${c.name}`);
      return `<li class="cand${lead ? ' lead' : ''}" data-fk="${k}" title=""${esc(c.name)}: ${fmt(c.votes)} votes (${pct(c.pct, 2)})${c.delta ? `, +${fmt(c.delta)} since last update` : ''}">
        ${avatar(r.pkey, c.name, col)}
        <span class="nm"><span class="nm-t">${esc(c.name)}</span>${incTag(r, c.name)}${tag}</span>
        <span class="delta">${c.delta ? `+${fmt(c.delta)}` : ''}</span>
        <span class="votes" data-ok="v|${k}">${fmt(c.votes)}</span>
        <span class="pct" data-ok="p|${k}">${pct(c.pct)}</span>
        ${star(watchKey(r, c.name))}
        <span class="bar"><i data-bk="${k}" style="width:${(c.pct / max) * 100}%;${col ? `background:${col}` : ''}"></i></span>
      </li>`;
    }).join('');
  }
  // Thin progress bar; `done` turns it green when every poll is in.
  const meter = (frac, done = false) => `<span class="meter${done ? ' done' : ''}"><i style="width:${clamp(frac) * 100}%"></i></span>`;
  const raceMeta = (r) => r ? `${fmt(r.pollsReceived)}/${fmt(r.polls)} polls · ${fmt(r.votes)} votes${r.complete ? ' · all in' : ''}` : '';

  function renderWard() {
    const n = hover || pinned;
    const el = $('#panel-ward');
    if (!model || !n) { el.innerHTML = `<div class="skeleton">${'<i></i>'.repeat(8)}</div>`; return; }
    const w = model.wards[n] || { name: geo.wards[n]?.name };
    const rep = w.mayor || w.council;
    // Keep each list's scroll position when the panel re-renders for the same ward.
    const keep = el.dataset.w === String(n) ? [...el.querySelectorAll('.scroller')].map((x) => x.scrollTop) : [];
    el.dataset.w = n;
    el.innerHTML = `
      <div class="ward-head">
        <div class="ward-title"><span class="wn">Ward ${n}</span><span class="wname">${esc(w.name || '')}</span>
          ${String(n) === myWard ? '<span class="you-tag">Your ward</span>' : ''}
          ${hover && hover !== pinned ? '<span class="pinned">Previewing · click to pin</span>' : ''}</div>
        <div class="ward-sub">${rep ? `<span class="ws"><span class="wt wt-polls">${fmt(rep.pollsReceived)}/${fmt(rep.polls)} polls · ${pct(rep.polls ? (rep.pollsReceived / rep.polls) * 100 : 0, 0)}</span>${meter(rep.polls ? rep.pollsReceived / rep.polls : 0, rep.complete)}</span>
          <span class="ws"><span class="wt wt-turn">Turnout ${pct(rep.totalVoters ? (rep.votes / rep.totalVoters) * 100 : 0)}</span>${meter(rep.totalVoters ? rep.votes / rep.totalVoters : 0)}</span>
          <span>${fmt(rep.totalVoters)} electors</span>` : ''}</div>
      </div>
      <div class="races">
        <div class="race"><div class="race-head"><h3>Council · Ward ${n}${openSeat(w.council) ? ` <span class="open-seat" title="${esc(openSeat(w.council))} is not running again here">Open seat</span>` : ''}</h3><span class="meta">${raceMeta(w.council)}</span></div>
          <div class="race-sum">${callRow(w.council)}</div>
          <div class="scroller"><ul class="cands">${candList(w.council)}</ul></div></div>
        <div class="race"><div class="race-head"><h3>Mayor · votes in Ward ${n}</h3><span class="meta">${raceMeta(w.mayor)}</span></div>
          <div class="race-sum">${wardMayorSummary(w.mayor)}</div>
          <div class="scroller"><ul class="cands">${candList(w.mayor, { colour: true, showCall: false })}</ul></div></div>
      </div>`;
    el.querySelectorAll('.scroller').forEach((x, i) => { if (keep[i]) x.scrollTop = keep[i]; });
    // Both summaries take the taller one's height so the two candidate lists start on the same line.
    const sums = [...el.querySelectorAll('.race-sum')];
    const h = Math.max(...sums.map((x) => x.scrollHeight));
    sums.forEach((x) => { x.style.height = `${h}px`; });
  }

  // Same shape as the council summary, so both columns line up, but scoped to this ward and never a call.
  function wardMayorSummary(r) {
    const [a, b] = r?.cands || [];
    const txt = !r?.leader ? 'No votes counted in this ward yet'
      : r.tied ? `<b>${esc(a.name)}</b> and <b>${esc(b.name)}</b> are tied in this ward`
      : `<b>${esc(a.name)}</b> leads ${esc(b?.name || '')} in this ward by <b>${fmt(a.votes - (b?.votes || 0))}</b> votes`;
    return `<div class="callrow"><span class="scope-pill">This ward only</span><span class="lead-txt">${txt}</span></div>
      <div class="call-why">The mayor's race is called on the city-wide count (left), not ward by ward.</div>`;
  }

  // City-wide mayor: every candidate as a card, in rank order; the top five are what's in view.
  function renderCity() {
    const r = model.mayor;
    $('#cityMeta').textContent = raceMeta(r);
    $('#cityCall').innerHTML = callRow(r, { reason: false }); // the reason is in the badge's hover card; space is tight here
    const st = r.call?.status;
    const max = Math.max(1, ...r.cands.map((c) => c.pct));
    const counting = r.votes > 0; // before the first results the order is just A-Z, so no ranks or zeros
    $('#cityTop').innerHTML = r.cands.map((c, i) => {
      const k = esc(`city|${c.name}`), col = candColour(c.name);
      const lead = i === 0 && r.leader && !r.tied;
      const tag = lead && CALLED.has(st) ? `<span class="tick tick-${st}" title="${CALL_LABEL[st].replace(/&[^;]+;\s*/g, '')}">&#10003;</span>` : '';
      return `<div class="pc${lead ? ' first' : ''}" data-fk="${k}" title="${esc(c.name)}: ${fmt(c.votes)} votes (${pct(c.pct, 2)})">
        <span class="pc-rank">${counting ? i + 1 : ''}</span>${star(watchKey(r, c.name))}
        <span class="pc-av">${avatar('mayor', c.name, col)}${incTag(r, c.name, { short: true })}</span>
        <div class="pc-name">${esc(c.name)}</div>${tag}
        ${counting ? `<div class="pc-nums"><b data-ok="pp|${k}">${pct(c.pct)}</b><span data-ok="pv|${k}">${fmt(c.votes)}</span></div>
        <div class="pc-delta"><span class="delta">${c.delta ? `+${fmt(c.delta)}` : ''}</span></div>
        <div class="pc-bar"><i data-bk="${k}" style="width:${(c.pct / max) * 100}%;${col ? `background:${col}` : ''}"></i></div>` : '<div class="pc-wait">No votes yet</div>'}
      </div>`;
    }).join('');
    const list = cityView === 'list';
    $('#cityList').innerHTML = list ? candList(r, { colour: true }) : '';
    $('#cityCard').classList.toggle('all', list);
    for (const b of document.querySelectorAll('#cityViewSw button')) b.setAttribute('aria-pressed', String(b.dataset.v === cityView));
    updateCityArrows();
  }
  // Cards (default) or the full ranked list; remembered on this device.
  let cityView = store.get('cityView') === 'list' ? 'list' : 'cards';
  $('#cityViewSw').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    cityView = b.dataset.v; store.set('cityView', cityView);
    if (model) renderCity();
  });
  // Five cards fit at once; the rest are a sideways scroll (trackpad, swipe or the arrows).
  function updateCityArrows() {
    const el = $('#cityTop');
    $('#cityPrev').disabled = el.scrollLeft < 4;
    $('#cityNext').disabled = el.scrollLeft + el.clientWidth > el.scrollWidth - 4;
    $('#cityCard').classList.toggle('more-right', !$('#cityNext').disabled);
  }
  const pageCity = (dir) => { const el = $('#cityTop'); el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' }); };
  $('#cityPrev').addEventListener('click', () => pageCity(-1));
  $('#cityNext').addEventListener('click', () => pageCity(1));
  $('#cityTop').addEventListener('scroll', updateCityArrows, { passive: true });

  function renderStats() {
    const r = model.mayor;
    const wards = Object.values(model.wards);
    const wardsDone = wards.filter((w) => (w.mayor || w.council)?.complete).length;
    const council = wards.map((w) => w.council?.call?.status);
    const called = council.filter((x) => CALLED.has(x)).length;
    const s = [
      ['Council called', `${called}/${wards.length}`, meter(wards.length ? called / wards.length : 0, called === wards.length)],
      [`Polls reporting · ${pct(r.polls ? (r.pollsReceived / r.polls) * 100 : 0, 0)}`, `${fmt(r.pollsReceived)}/${fmt(r.polls)}`, meter(r.polls ? r.pollsReceived / r.polls : 0, r.complete)],
      ['Wards complete', `${wardsDone}/${wards.length}`, meter(wards.length ? wardsDone / wards.length : 0, wards.length > 0 && wardsDone === wards.length)],
      [`Turnout · ${compact(r.votes)} of ${compact(r.totalVoters)}`, pct(r.totalVoters ? (r.votes / r.totalVoters) * 100 : 0), meter(r.totalVoters ? r.votes / r.totalVoters : 0)],
    ];
    $('#stats').innerHTML = s.map(([k, v, m], i) => `<div class="stat"><b data-ok="s|${i}">${v}</b>${m}<span>${k}</span></div>`).join('');
  }

  function renderStatus() {
    const st = $('#status'), tx = $('#statusText'), notice = $('#notice');
    st.className = 'status';
    let note = '';
    if (!model) {
      st.classList.add(lastErr ? 'error' : 'loading');
      tx.textContent = lastErr ? 'Results unavailable - retrying' : 'Connecting to results…';
      if (lastErr) note = `Could not load results: ${esc(lastErr.message)}. Retrying every ${POLL_MS / 1000}s.`;
    } else {
      const r = model.mayor;
      const gen = model.generatedAt ? `${time(model.generatedAt)} (${ago(Date.now() - model.generatedAt)})` : 'unknown';
      const relayAge = model.relayedAt ? Date.now() - model.relayedAt : 0;
      if (lastErr) { st.classList.add('error'); tx.textContent = `Connection problem - showing data from ${gen}`; }
      else if (!DEMO && relayAge > STALE_MS) { st.classList.add('stale'); tx.textContent = `Relay delayed - last checked ${ago(relayAge)}`; }
      else if (r.complete) { st.classList.add('live'); tx.textContent = `All polls in · ${hm(model.generatedAt)}`; }
      else if (r.pollsReceived > 0) { st.classList.add('live'); tx.textContent = `Live · updated ${hm(model.generatedAt)}`; }
      else {
        const ms = POLLS_CLOSE - Date.now();
        st.classList.add('waiting');
        const p2 = (n) => String(n).padStart(2, '0');
        tx.textContent = ms > 0 ? `Polls close in ${Math.floor(ms / 3600e3)}h ${p2(Math.floor((ms % 3600e3) / 60e3))}m ${p2(Math.floor((ms % 60e3) / 1000))}s` : 'Polls closed · waiting for first results';
      }
      st.title = `Feed generated ${gen}`;
      if (usedSource === 'raw') note = 'GitHub API limit reached for your network - using a backup copy that can lag up to 5 minutes.';
      $('#srcInfo').textContent = ` Feed seq ${model.seq}${model.relayedAt ? `, relay checked ${time(model.relayedAt)}` : ''}${model.changedAt ? `, last change ${time(model.changedAt)}` : ''}.`;
    }
    notice.hidden = !note; notice.innerHTML = note;
  }

  const COLS = [
    { key: 'num', label: 'Ward', v: (w) => w.num },
    { key: 'rep', label: 'Reporting', v: (w) => { const r = w.mayor || w.council; return r?.polls ? r.pollsReceived / r.polls : 0; } },
    { key: 'turn', label: 'Turnout', v: (w) => (w.mayor?.totalVoters ? w.mayor.votes / w.mayor.totalVoters : 0) },
    { key: 'mmar', label: 'Mayor leader here', v: (w) => w.mayor?.margin || 0 },
    { key: 'cmar', label: 'Council leader', v: (w) => w.council?.margin || 0 },
  ];
  function renderTable() {
    const t = $('#wardTable');
    const col = COLS.find((c) => c.key === sort.key);
    const rows = Object.values(model.wards).sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir || a.num - b.num;
    });
    // Every row gets the leader's photo (initials if none). Mayor: ring in their map colour.
    // Council: a status badge like the map's (blue ✓ projected, green ✓ winner, dashed grey not called).
    const who = (r, colour) => {
      if (!r?.leader) return `<span class="who"><span class="avw"><span class="av av-i av-none"></span></span><span class="who-n muted">No votes yet</span></span>`;
      const c = r.cands[0], st = r.call?.status;
      const ring = colour ? (r.tied ? css('--other') : candColour(c.name) || css('--other')) : null;
      const badge = colour ? '' : `<span class="sb sb-${CALLED.has(st) ? st : 'pending'}">${st === 'projected' ? '&#10003;' : CALLED.has(st) ? '&#10003;' : ''}</span>`;
      const name = r.tied ? `Tied: ${esc(c.name)} &amp; ${esc(r.cands[1].name)}` : esc(c.name);
      return `<span class="who"><span class="avw">${avatar(r.pkey, c.name, ring)}${badge}</span><span class="who-n">${name}${r.tied ? '' : incTag(r, c.name, { short: true })}</span></span>`;
    };
    t.innerHTML = `<thead><tr>${COLS.map((c) => `<th data-k="${c.key}"${c.n ? ' class="n"' : ''}${sort.key === c.key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((w) => {
        const r = w.mayor || w.council;
        const rp = r?.polls ? r.pollsReceived / r.polls : 0;
        return `<tr data-w="${w.num}" data-fk="t|${w.num}" class=""${String(w.num) === pinned ? 'pinned' : ''}${String(w.num) === hover ? ' hot' : ''}">
          <td><b class="num">${w.num}</b> ${esc(w.name)}</td>
          <td><span class="num" data-ok="tr|${w.num}">${r ? `${r.pollsReceived}/${r.polls}` : ''}</span>${meter(rp, r?.complete)}</td>
          <td><span class="num" data-ok="tt|${w.num}">${pct(COLS[2].v(w) * 100)}</span>${meter(COLS[2].v(w))}</td>
          <td>${who(w.mayor, true)}${w.mayor?.leader ? `<div class="sub2">${pct(w.mayor.leader.pct)} · lead ${w.mayor.margin.toFixed(1)} pts</div>` : ''}</td>
          <td>${who(w.council)}${w.council?.leader ? `<div class="sub2">${pct(w.council.leader.pct)} · lead ${w.council.margin.toFixed(1)} pts · ${w.council.cands.length} running</div>` : ''}</td>
          </tr>`;
      }).join('')}</tbody>`;
  }
  $('#wardTable').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (th) { const k = th.dataset.k; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'num' ? 1 : -1) }; renderTable(); return; }
    const tr = e.target.closest('tbody tr'); if (tr) { setPinned(tr.dataset.w, true); setTab('ward'); }
  });
  $('#wardTable').addEventListener('mouseover', (e) => { const tr = e.target.closest('tbody tr'); if (tr) { setHover(tr.dataset.w); tip.classList.remove('on'); } });
  $('#wardTable').addEventListener('mouseleave', () => setHover(null));

  const BOARD_SHORT = { 'Toronto District School Board': 'TDSB', 'Toronto Catholic District School Board': 'TCDSB', 'Conseil scolaire Viamonde': 'Viamonde', 'Conseil scolaire catholique MonAvenir': 'MonAvenir' };
  // "All races": one switch between the 25-ward council table and each school board's trustee races.
  function renderBoards() {
    if (racesView !== 'council' && !model.boards.some((b) => b.id === racesView)) racesView = 'council';
    $('#raceSwitch').innerHTML = `<button data-v="council" aria-pressed="${racesView === 'council'}">City council <span style="opacity:.7">· 25</span></button>`
      + model.boards.map((b) => `<button data-v="${b.id}" aria-pressed="${b.id === racesView}" title="${esc(b.name)}">${esc(BOARD_SHORT[b.name] || b.name)} <span style="opacity:.7">· ${b.wards.length}</span></button>`).join('');
    $('#councilView').hidden = racesView !== 'council';
    $('#boardView').hidden = racesView === 'council';
    const b = model.boards.find((x) => x.id === racesView);
    $('#boards').innerHTML = b ? `<div class="board-grid">${b.wards.map((w) => `
      <div class="board-ward"><div class="race-head"><h3>${esc(BOARD_SHORT[b.name] || b.name)} Ward ${esc(w.num)}${w.name ? ` - ${esc(w.name)}` : ''}</h3><span class="meta">${raceMeta(w.race)}</span></div>
      <div class="bw-call">${badge(w.race.call)}</div>
      <ul class="cands dense">${candList(w.race)}</ul></div>`).join('')}</div>` : '';
  }

  // ---------- watch strip ----------
  // Where a watched race lives in the model, what to call it, and how to get to it.
  function watchedRace(rk) {
    const [kind, num] = rk.split('|');
    if (kind === 'mayor') return { r: model.mayor, label: 'Mayor · city-wide', go: () => $('#cityCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' }) };
    if (kind === 'council') {
      const r = model.wards[num]?.council;
      return r && { r, label: `Council · Ward ${num}`, go: () => { setPinned(num, true); setTab('ward'); $('#right').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } };
    }
    const b = model.boards.find((x) => `o${x.id}` === kind);
    const r = b?.wards.find((w) => String(w.num) === num)?.race;
    return r && { r, label: `${BOARD_SHORT[b.name] || b.name} trustee · Ward ${num}`, go: () => { racesView = b.id; setTab('wards'); renderBoards(); $('#right').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } };
  }
  const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;
  const lastName = (n) => normName(n).split(' ').pop();

  function renderWatch() {
    const dock = $('#watch');
    dock.hidden = !watch.length;
    document.body.classList.toggle('watching', !!watch.length);
    if (!watch.length || !model) return;
    $('#watchList').innerHTML = watch.map((wk) => {
      const rk = wk.split('|').slice(0, 2).join('|'), name = wk.split('|').slice(2).join('|');
      const w = watchedRace(rk);
      const i = w ? w.r.cands.findIndex((c) => c.name === name) : -1;
      if (i < 0) return `<div class="wc gone">${star(wk)}${avatar('', name)}<div class="wc-name">${esc(name)}</div><div class="wc-race">Not in the current results</div></div>`;
      const r = w.r, c = r.cands[i], lead = r.cands[0], next = r.cands[1];
      const counting = r.votes > 0;
      const rank = 1 + r.cands.filter((x) => x.votes > c.votes).length; // ties share a place
      const tied = counting && r.cands.some((x) => x !== c && x.votes === c.votes);
      const st = r.call?.status;
      const won = rank === 1 && !tied && CALLED.has(st);
      let gap, cls = '';
      if (!counting) gap = 'No votes yet';
      else if (rank === 1 && !tied) { gap = `Leads ${esc(lastName(next?.name || ''))} by ${fmt(c.votes - (next?.votes || 0))}`; cls = ' up'; }
      else if (rank === 1) gap = 'Tied for the lead';
      else gap = `${fmt(lead.votes - c.votes)} behind ${esc(lastName(lead.name))}`;
      return `<div class="wc${rank === 1 && counting && !tied ? ' first' : ''}" data-go="${esc(rk)}" role="button" tabindex="0" title="${esc(c.name)} · ${esc(w.label)} · go to race">
        ${star(wk)}${avatar(r.pkey, c.name, rk === 'mayor|city' ? candColour(c.name) : null)}
        <div class="wc-name">${esc(c.name)}${won ? `<span class="tick tick-${st}" title="${CALL_LABEL[st].replace(/&[^;]+;\s*/g, '')}">&#10003;</span>` : ''}</div>
        <div class="wc-pos">${counting ? `${tied ? 'T-' : ''}${ordinal(rank)} <span>of ${r.cands.length}</span>` : `<span>${r.cands.length} running</span>`}</div>
        <div class="wc-race"><span class="nm-t">${esc(w.label)}</span>${incTag(r, c.name, { short: true })}</div>
        <div class="wc-votes">${counting ? `${fmt(c.votes)} · <b>${pct(c.pct)}</b>` : ''}</div>
        <div class="wc-gap${cls}">${gap}</div>
      </div>`;
    }).join('');
  }
  function toggleWatch(wk) {
    watch = watch.includes(wk) ? watch.filter((x) => x !== wk) : [...watch, wk].slice(-MAX_WATCH);
    store.set('watch', JSON.stringify(watch));
    const on = watch.includes(wk);
    for (const b of document.querySelectorAll(`.star[data-watch="${CSS.escape(wk)}"]`)) {
      b.setAttribute('aria-pressed', String(on)); b.innerHTML = on ? '&#9733;' : '&#9734;';
      b.title = on ? 'Stop watching' : 'Watch this candidate';
    }
    renderWatch();
  }
  // Stars live inside rows and cards that have their own hover and click behaviour, so they stop the event here.
  document.addEventListener('click', (e) => {
    const s = e.target.closest('.star');
    if (s) { e.preventDefault(); e.stopPropagation(); toggleWatch(s.dataset.watch); return; }
    const g = e.target.closest('#watch [data-go]');
    if (g && model) watchedRace(g.dataset.go)?.go();
  }, true);
  $('#watch').addEventListener('keydown', (e) => {
    const g = e.target.closest('[data-go]');
    if (g && (e.key === 'Enter' || e.key === ' ') && e.target === g) { e.preventDefault(); watchedRace(g.dataset.go)?.go(); }
  });

  // ---------- live feed ----------
  // Posts come from the Worker, which writes one feed for everyone. In ?demo they're made here from the
  // simulated count, with the same rules and wording (worker/feed.js), so the layout can be previewed.
  let posts = [];
  let tickerOn = store.get('ticker') !== 'off'; // the Live tab is opt-in already; the ticker can be hidden
  let feedSeen = int(store.get('feedSeen'));
  let feedAt = 0, feedLib = null, demoSnap = null, demoPosted = new Set(), demoId = 0;
  const feedTime = (t) => new Date(t).toLocaleTimeString('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const KIND = {
    'polls-closed': ['Polls closed', ''], 'first-results': ['First results', ''], milestone: ['Count', ''],
    'ward-started': ['Counting begins', ''], 'wards-started': ['Counting begins', ''], 'ward-finished': ['Count complete', ''],
    'lead-change': ['Lead change', 'k-lead'], 'close-race': ['Close race', 'k-close'], call: ['Race call', 'k-call'], 'trustee-calls': ['Trustee calls', 'k-call'],
  };
  async function loadFeed() {
    if (params.get('src')) return;
    if (DEMO) {
      if (!rawBundle || !demoLast) return;
      feedLib ||= await import('./worker/feed.js');
      const cur = feedLib.snapshot(demoLast.all, demoLast.wardbyward, incumbents);
      if (demoSnap && cur.rec < demoSnap.rec) { posts = []; demoSnap = null; demoPosted = new Set(); } // the simulation started over
      for (const e of feedLib.diff(demoSnap, cur, 0, demoPosted)) posts.unshift({ id: ++demoId, t: Date.now(), kind: e.kind, ...feedLib.template(e) });
      demoSnap = cur;
    } else {
      if (Date.now() - feedAt < 55000) return;
      feedAt = Date.now();
      const base = SOURCES.find((s) => s.id === 'worker')?.base;
      const r = await fetch(`${base}/feed.json`, { cache: 'no-cache', signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      posts = (await r.json()).posts || [];
    }
    renderFeed();
  }
  function renderFeed() {
    const latest = posts[0];
    $('#ticker').hidden = !latest || !tickerOn;
    $('#tickerToggle').checked = tickerOn;
    if (latest) {
      const tx = $('#tkText');
      if (tx.dataset.id !== String(latest.id)) {
        tx.dataset.id = latest.id; tx.textContent = latest.headline;
        tx.classList.remove('in'); void tx.offsetWidth; tx.classList.add('in');
        $('#tkTime').textContent = feedTime(latest.t);
      }
    }
    if (tab === 'feed' && latest) { feedSeen = Math.max(feedSeen, latest.id); store.set('feedSeen', String(feedSeen)); }
    const unread = posts.filter((p) => p.id > feedSeen).length;
    $('#feedCount').hidden = !unread; $('#feedCount').textContent = unread > 99 ? '99+' : unread;
    const list = $('#posts');
    const shown = new Set([...list.querySelectorAll('.post')].map((x) => x.dataset.id));
    list.innerHTML = posts.length ? posts.map((p) => {
      const [label, cls] = KIND[p.kind] || ['Update', ''];
      const won = (p.kind === 'call' || p.kind === 'trustee-calls') && !/projected/i.test(p.headline + p.body) ? ' k-won' : '';
      return `<li class="post${shown.size && !shown.has(String(p.id)) ? ' fresh' : ''}" data-id="${p.id}">
        <time>${feedTime(p.t)}</time><span class="kind ${cls}${won}">${label}</span><h4>${esc(p.headline)}</h4><p>${esc(p.body)}</p></li>`;
    }).join('') : `<li class="empty">${Date.now() < POLLS_CLOSE ? 'Updates start when polls close at 8 p.m. They\'ll appear here as results come in.' : 'Waiting for the first results…'}</li>`;
    renderToWatch();
  }
  // Races to watch: the tightest races still being counted, from the page's own numbers.
  function renderToWatch() {
    const el = $('#toWatch');
    if (!model) { el.innerHTML = ''; return; }
    const open = [model.mayor, ...Object.values(model.wards).map((w) => w.council)].filter((r) => r?.leader && r.cands[1] && !CALLED.has(r.call?.status) && r.pollsReceived / r.polls >= 0.1);
    const close = open.sort((a, b) => a.margin - b.margin).slice(0, 4);
    el.innerHTML = close.length ? `<div class="towatch"><h3>Races to watch</h3><div class="tw-list">${close.map((r) => {
      const [a, b] = r.cands, n = r.key.split('|')[1];
      return `<button type="button" class="tw" data-go="${r.key === 'mayor|city' ? 'mayor|city' : `council|${n}`}">
        <div class="tw-where">${r.key === 'mayor|city' ? 'Mayor' : `Ward ${n} ${esc(model.wards[n]?.name || '')}`} · ${pct((r.pollsReceived / r.polls) * 100, 0)} in</div>
        <div class="tw-who">${esc(lastName(a.name))} vs ${esc(lastName(b.name))}</div>
        <div class="tw-gap">${fmt(a.votes - b.votes)} votes apart · ${(a.pct - b.pct).toFixed(1)} pts</div></button>`;
    }).join('')}</div></div>` : '';
  }
  $('#toWatch').addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g && model) watchedRace(g.dataset.go)?.go(); });
  const setTicker = (on) => { tickerOn = on; store.set('ticker', on ? 'on' : 'off'); renderFeed(); };
  $('#tickerOff').addEventListener('click', () => setTicker(false));
  $('#tickerToggle').addEventListener('change', (e) => setTicker(e.target.checked));
  $('#tickerBtn').addEventListener('click', () => { setTab('feed'); renderFeed(); $('#right').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  $('#raceSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    racesView = btn.dataset.v === 'council' ? 'council' : int(btn.dataset.v);
    renderBoards();
  });

  // ---------- ward tabs ----------
  function openWardTab(n) {
    n = String(n);
    if (!openWards.includes(n)) {
      openWards.push(n);
      // Over the limit: drop the oldest tab that isn't the person's own ward or the one being opened.
      while (openWards.length > MAX_WARD_TABS) {
        const drop = openWards.findIndex((w) => w !== myWard && w !== n);
        openWards.splice(drop < 0 ? 0 : drop, 1);
      }
      store.set('openWards', openWards.join(','));
    }
    renderTabs();
  }
  function closeWardTab(n) {
    if (openWards.length <= 1) return;
    openWards = openWards.filter((w) => w !== n);
    store.set('openWards', openWards.join(','));
    if (pinned === n) { setPinned(openWards[openWards.length - 1]); }
    renderTabs(); saveHash();
  }
  function renderTabs() {
    $('#wardTabs').innerHTML = openWards.map((n) => {
      const sel = tab === 'ward' && n === pinned;
      return `<button role="tab" class="wt" data-tab="ward" data-w="${n}" aria-selected="${sel}" title="Ward ${n} - ${esc(geo?.wards[n]?.name || '')}. Click other wards on the map to open more tabs.">${n === myWard ? PIN_SVG : ''}Ward ${n}${openWards.length > 1 ? `<span class="wt-x" data-close="${n}" role="button" aria-label="Close Ward ${n}">&times;</span>` : ''}</button>`;
    }).join('');
  }
  const PIN_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.3 4.5 8.5 4.5 8.5s4.5-5.2 4.5-8.5A4.5 4.5 0 0 0 8 1.5Zm0 6.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z" fill="currentColor"/></svg>';

  // ---------- tabs ----------
  function setTab(t) {
    tab = t;
    if (t === 'feed') renderFeed();
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t && (t !== 'ward' || b.dataset.w === pinned)));
    for (const p of document.querySelectorAll('#right .panel')) p.hidden = p.id !== `panel-${t}`;
    saveHash();
  }
  $('.tabs').addEventListener('click', (e) => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); closeWardTab(x.dataset.close); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.w) { setPinned(b.dataset.w); setTab('ward'); } else setTab(b.dataset.tab);
  });

  // ---------- motion ----------
  // Only on data updates: changed digits roll like an odometer, rows slide to their new places,
  // and bars grow from their previous length. Hover re-renders never animate.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const odoPrev = new Map();
  const deltaPrev = new Map(); // row key -> last "+N" shown
  const EASE = 'cubic-bezier(.45,0,.25,1.04)'; // slow start, gentle settle: easy to follow by eye
  const MOVE_MS = 1600;
  function snapshot() {
    const pos = new Map(), bars = new Map();
    for (const el of document.querySelectorAll('[data-fk]')) {
      if (el.offsetParent) { const b = el.getBoundingClientRect(); pos.set(el.dataset.fk, { top: b.top, left: b.left, idx: [...el.parentNode.children].indexOf(el) }); }
    }
    for (const el of document.querySelectorAll('[data-bk]')) bars.set(el.dataset.bk, el.style.width);
    return { pos, bars };
  }
  function rollHTML(a, b, base = 0) {
    const n = Math.max(a.length, b.length);
    a = a.padStart(n, '\u2007'); b = b.padStart(n, '\u2007');
    const up = parseFloat(b.replace(/[^\d.-]/g, '')) >= parseFloat(a.replace(/[^\d.-]/g, ''));
    let out = '';
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) { out += esc(b[i]); continue; }
      const d = base + (n - 1 - i) * 120; // right-most digit turns first, like a counter
      out += up ? `<span class="roll" style="--d:${d}ms"><span>${esc(a[i])}</span><span>${esc(b[i])}</span></span>`
        : `<span class="roll down" style="--d:${d}ms"><span>${esc(b[i])}</span><span>${esc(a[i])}</span></span>`;
    }
    return out;
  }
  // A stream rather than a rush: changes flow through the page in reading order. Each row's digits roll
  // in turn (bars grow with them), and a row that changed place slides only after its own numbers settle.
  const ROLL_PHASE_MS = 1300; // time for a row's digits to finish turning
  const STREAM_STEP_MS = 70, STREAM_MAX_MS = 3000;
  function animateChanges(snap, quiet = false) {
    const motion = !reduceMotion.matches && !quiet;
    const rowStart = new Map(); // row key -> when its numbers start rolling
    let step = 0;
    const startFor = (el) => {
      const row = el.closest('[data-fk]')?.dataset.fk;
      if (row && rowStart.has(row)) return rowStart.get(row);
      const t = Math.min(step++ * STREAM_STEP_MS, STREAM_MAX_MS);
      if (row) rowStart.set(row, t);
      return t;
    };
    for (const el of document.querySelectorAll('[data-ok]')) {
      const k = el.dataset.ok, now = el.textContent, before = odoPrev.get(k);
      odoPrev.set(k, now);
      if (motion && before != null && before !== now && el.offsetParent) {
        const t = startFor(el);
        el.innerHTML = rollHTML(before, now, t);
        // Once every digit has turned, put the plain number back so nothing can stay misaligned.
        setTimeout(() => { if (el.querySelector('.roll')) el.textContent = now; }, t + now.length * 120 + 1300);
      }
    }
    if (!motion) {
      for (const el of document.querySelectorAll('[data-fk] .delta')) { const row = el.closest('[data-fk]')?.dataset.fk; if (row) deltaPrev.set(row, el.textContent); }
      return;
    }
    // New-vote deltas ("+123"): the previous figure stays until the row's turn in the stream, then
    // crossfades to the new one (or fades away if the row got no new votes).
    for (const el of document.querySelectorAll('[data-fk] .delta')) {
      const row = el.closest('[data-fk]')?.dataset.fk;
      if (!row) continue;
      const now = el.textContent, before = deltaPrev.get(row) || '';
      deltaPrev.set(row, now);
      if (!el.offsetParent || before === now) continue;
      el.innerHTML = `<span class="dl">${esc(before)}</span><span class="dl">${esc(now)}</span>`;
      const [oldEl, newEl] = el.children;
      const t = Math.max(0, startFor(el) - 150);
      oldEl.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-8px)' }],
        { duration: 450, delay: t, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'both' });
      if (now) newEl.animate([
        { opacity: 0, transform: 'translateX(10px)', filter: 'blur(3px)' },
        { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' },
      ], { duration: 650, delay: t + 200, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    }
    for (const el of document.querySelectorAll('[data-bk]')) {
      const before = snap.bars.get(el.dataset.bk);
      if (before && before !== el.style.width) {
        el.animate([{ width: before }, { width: el.style.width }], { duration: 1100, delay: startFor(el), easing: EASE, fill: 'backwards' });
      }
    }
    for (const el of document.querySelectorAll('[data-fk]')) {
      const before = snap.pos.get(el.dataset.fk);
      if (before == null || !el.offsetParent) continue;
      // Only rows that changed rank move; rows nudged by a neighbour's layout stay put.
      if ([...el.parentNode.children].indexOf(el) === before.idx) continue;
      const now = el.getBoundingClientRect(), newIdx = [...el.parentNode.children].indexOf(el);
      const dy = before.top - now.top, dx = before.left - now.left;
      if (Math.abs(dy) < 2 && Math.abs(dx) < 2) continue;
      const climbing = newIdx < before.idx;
      // Rows climbing the list pass over the ones they overtake; each waits in its old spot until its turn.
      el.style.position = 'relative'; el.style.zIndex = climbing ? '2' : '1'; el.style.background = 'var(--surface)';
      // Tinted by direction (green climbing, red dropping). The tint fades in while the row's numbers roll,
      // holds while it slides to its new place, then fades out after it lands.
      const surface = css('--surface');
      const tint = mix(climbing ? '#0ca30c' : '#d03b3b', surface, 0.2);
      const shadow = '0 6px 18px rgba(0,0,0,.14)', none = '0 0 0 rgba(0,0,0,0)';
      const FADE_MS = 1100, total = ROLL_PHASE_MS + MOVE_MS + FADE_MS;
      el.animate([
        { transform: `translate(${dx}px, ${dy}px)`, background: surface, boxShadow: none },
        { offset: ROLL_PHASE_MS / total, transform: `translate(${dx}px, ${dy}px)`, background: tint, boxShadow: shadow, easing: EASE },
        { offset: (ROLL_PHASE_MS + MOVE_MS) / total, transform: 'translate(0, 0)', background: tint, boxShadow: none },
        { transform: 'translate(0, 0)', background: surface, boxShadow: none },
      ], { duration: total, delay: rowStart.get(el.dataset.fk) ?? startFor(el), fill: 'backwards' })
        .onfinish = () => { el.style.zIndex = ''; el.style.background = ''; };
    }
  }

  function renderAll(quiet = false) {
    const snap = snapshot();
    flashNow = true;
    renderStatus(); renderStats(); renderMap(); renderCity(); renderWard(); renderTable(); renderBoards(); renderWatch(); renderTip();
    flashNow = false;
    animateChanges(snap, quiet);
  }

  // ---------- welcome dialog ----------
  // Shown once per tab. Before results it is a live countdown to polls closing, then a "waiting for the
  // first results" screen, and it closes itself as soon as the first results arrive.
  const POLLS_CLOSE = Date.parse('2026-10-26T20:00:00-04:00');
  let welcomed = false, welcomeTimer = null;
  const hasResults = () => !!model && model.mayor.pollsReceived > 0;
  function welcomePhase() {
    if (hasResults()) return 'results';
    return Date.now() < POLLS_CLOSE ? 'countdown' : 'waiting';
  }
  function renderWelcome() {
    const dlg = $('#welcome');
    if (!dlg.open) return;
    const phase = welcomePhase();
    if (phase === 'results' && dlg.dataset.phase && dlg.dataset.phase !== 'results') { dlg.close(); return; } // first results just arrived
    dlg.dataset.phase = phase;
    const box = $('#welcomeWait');
    box.hidden = phase === 'results';
    $('#welcomeDemo').hidden = phase === 'results';
    $('#welcomeGo').textContent = phase === 'results' ? 'View results' : 'Look around now';
    if (phase === 'countdown') {
      const sec = Math.max(0, Math.floor((POLLS_CLOSE - Date.now()) / 1000));
      const hh = Math.floor(sec / 3600), mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0'), ss = String(sec % 60).padStart(2, '0');
      const tile = (v, l) => `<div class="cd-tile"><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`;
      box.innerHTML = `<div class="cd-label">Polls close at 8 p.m.</div>
        <div class="cd">${tile(hh, hh === 1 ? 'hour' : 'hours')}${tile(mm, 'minutes')}${tile(ss, 'seconds')}</div>
        <p>Keep this open and it will switch to live results by itself once counting starts.</p>`;
    } else if (phase === 'waiting') {
      box.innerHTML = `<div class="cd-label">Polls are closed</div>
        <div class="cd-wait"><span class="spinner" aria-hidden="true"></span>Waiting for the first results to come in&hellip;</div>
        <p>The City usually starts reporting shortly after 8 p.m. This will close by itself when they arrive.</p>`;
    }
  }
  function maybeWelcome() {
    if (welcomed || DEMO) return;
    welcomed = true;
    try { if (sessionStorage.getItem('welcomed')) return; sessionStorage.setItem('welcomed', '1'); } catch {}
    openWelcome();
  }
  // Also opened from the header's About button and the status pill.
  function openWelcome() {
    const dlg = $('#welcome');
    if (!dlg?.showModal || dlg.open) return;
    delete dlg.dataset.phase;
    clearInterval(welcomeTimer);
    dlg.showModal();
    renderWelcome();
    welcomeTimer = setInterval(renderWelcome, 1000);
    $('#welcomeGo').focus();
  }

  $('#welcome').addEventListener('close', () => clearInterval(welcomeTimer));
  $('#welcome').addEventListener('click', (e) => { if (e.target === $('#welcome')) $('#welcome').close(); }); // click outside closes
  $('#aboutBtn').addEventListener('click', openWelcome);
  $('#status').addEventListener('click', () => { if (!hasResults()) openWelcome(); });

  // ---------- find my ward ----------
  // The browser's location is matched against the ward shapes right here on the device; it is never sent
  // anywhere. Only the ward number is remembered (localStorage), so returning visitors land on it.
  let myPoint = null; // map position for the "you are here" dot, this visit only
  function wardAt(lat, lon) {
    const { minx, maxy, s } = geo.proj;
    const my = (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
    const pt = { x: (lon - minx) * s, y: (maxy - my) * s };
    for (const [num, p] of Object.entries(paths)) if (p.isPointInFill(new DOMPoint(pt.x, pt.y))) return { num, pt };
    return { num: null, pt };
  }
  function renderMe() {
    meLayer.innerHTML = myPoint ? `<circle class="me-halo" cx="${myPoint.x}" cy="${myPoint.y}" r="14"/><circle class="me-dot" cx="${myPoint.x}" cy="${myPoint.y}" r="6"/>` : '';
    renderTabs();
    $('#findWardBtn').innerHTML = myWard ? `${PIN_ICON} Your ward: ${myWard}` : `${PIN_ICON} Find my ward`;
  }
  function useWard(num, pt, { jump = true } = {}) {
    myWard = String(num); store.set('myWard', myWard);
    if (pt) myPoint = pt;
    if (jump) { setPinned(myWard); setTab('ward'); }
    renderMe(); renderWard();
  }
  function wardMsg(text) { const m = $('#wardMsg'); m.hidden = !text; m.textContent = text || ''; }
  function locate({ quiet = false } = {}) {
    if (!navigator.geolocation) { if (!quiet) wardMsg("This browser can't share its location. Pick your ward from the list instead."); return; }
    const btn = $('#wardLocate');
    const label = btn.querySelector('span');
    if (!quiet) { btn.disabled = true; label.textContent = 'Finding your ward…'; wardMsg(''); }
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false; label.textContent = 'Use my current location';
      const { num, pt } = wardAt(pos.coords.latitude, pos.coords.longitude);
      if (num) {
        useWard(num, pt, { jump: !quiet || !userPinned });
        if ($('#wardDlg').open) $('#wardDlg').close();
      } else if (!quiet) {
        wardMsg("You don't seem to be in the City of Toronto right now. Pick a ward from the list instead.");
      }
    }, (err) => {
      btn.disabled = false; label.textContent = 'Use my current location';
      if (quiet) return;
      wardMsg(err.code === err.PERMISSION_DENIED ? 'Location access is turned off for this site. You can pick your ward from the list instead.'
        : "Couldn't get your location just now. Try again, or pick your ward from the list.");
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 });
  }
  function openWardDlg() {
    const dlg = $('#wardDlg');
    if (!dlg?.showModal || dlg.open || $('#welcome').open) return;
    wardMsg('');
    $('#wardGo').hidden = !myWard;
    if (myWard) $('#wardGo').textContent = `Go to Ward ${myWard}`;
    const hero = $('#wardHeroMap');
    hero.setAttribute('viewBox', `0 0 ${geo.w} ${geo.h}`);
    hero.innerHTML = Object.entries(geo.wards).map(([n, w]) => `<path d="${w.d}"${n === myWard ? ' class="mine"' : ''}/>`).join('');
    $('#wardPick').innerHTML = '<option value="">Select a ward…</option>' + Object.entries(geo.wards)
      .sort((a, b) => a[0] - b[0]).map(([n, w]) => `<option value="${n}"${n === myWard ? ' selected' : ''}>Ward ${n} - ${esc(w.name)}</option>`).join('');
    dlg.showModal();
    $('#wardLocate').focus({ focusVisible: false });
  }
  // 30 seconds in: if location is already allowed, quietly use it; if we've never asked, offer it once per visit.
  async function maybeAskWard() {
    let state = 'prompt';
    try { state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch {}
    if (state === 'denied') return;
    if (state === 'granted') { locate({ quiet: true }); return; }
    if (myWard) return; // they've told us before; we already opened on their last ward
    try { if (sessionStorage.getItem('askedWard')) return; sessionStorage.setItem('askedWard', '1'); } catch {}
    if ($('#welcome').open) { $('#welcome').addEventListener('close', () => setTimeout(openWardDlg, 1200), { once: true }); return; }
    openWardDlg();
  }
  const PIN_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.3 4.5 8.5 4.5 8.5s4.5-5.2 4.5-8.5A4.5 4.5 0 0 0 8 1.5Zm0 6.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z" fill="currentColor"/></svg>';
  $('#findWardBtn').addEventListener('click', openWardDlg);
  $('#wardLocate').addEventListener('click', () => locate());
  $('#wardGo').addEventListener('click', () => { setPinned(myWard, true); setTab('ward'); $('#wardDlg').close(); });
  $('#wardPick').addEventListener('change', (e) => { if (e.target.value) { useWard(e.target.value); $('#wardDlg').close(); } });
  $('#wardDlg').addEventListener('click', (e) => { if (e.target === $('#wardDlg')) $('#wardDlg').close(); });

  // ---------- boot ----------
  if (DEMO) {
    $('#demoBanner').hidden = false;
    $('#demoPause').addEventListener('click', (e) => { demoPaused = !demoPaused; e.target.textContent = demoPaused ? 'Resume' : 'Pause'; });
    $('#demoRestart').addEventListener('click', () => { demoP = 0; demoHold = 0; demoTick = 0; demoPrev.clear(); odoPrev.clear(); deltaPrev.clear(); demoQuiet = true; demoPaused = false; $('#demoPause').textContent = 'Pause'; tick(); });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => model && renderAll());
  // Theme: follow the device (auto), or force light or dark; remembered on this device.
  const THEMES = {
    auto: ['Auto', '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>'],
    light: ['Light', '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'],
    dark: ['Dark', '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg>'],
  };
  const themeOrder = ['auto', 'light', 'dark'];
  let theme = THEMES[store.get('theme')] ? store.get('theme') : 'auto';
  function applyTheme() {
    if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const [label, icon] = THEMES[theme];
    const next = themeOrder[(themeOrder.indexOf(theme) + 1) % 3];
    $('#themeBtn').innerHTML = `${icon}<span>${label}</span>`;
    $('#themeBtn').setAttribute('aria-label', `Theme: ${label}. Switch to ${THEMES[next][0]}`);
    $('#themeBtn').title = `Theme: ${label}${theme === 'auto' ? ' (follows your device)' : ''} · click for ${THEMES[next][0]}`;
  }
  applyTheme();
  $('#themeBtn').addEventListener('click', () => {
    theme = themeOrder[(themeOrder.indexOf(theme) + 1) % 3];
    store.set('theme', theme);
    applyTheme();
    if (model) renderAll(true); else if (geo) renderMap(); // map and chart colours are read from the theme
  });
  Promise.all([
    fetch('wards.json').then((r) => r.json()),
    fetch('photos.json').then((r) => r.json()).catch(() => ({})),
    fetch('incumbents.json').then((r) => r.json()).catch(() => null),
  ]).then(([g, ph, inc]) => {
    geo = g;
    incumbents = inc;
    photos = Object.fromEntries(Object.entries(ph).map(([k, v]) => { const [a, b] = k.split('|'); return [`${a}|${normName(b)}`, v]; }));
    buildMap();
    if (!geo.wards[pinned]) pinned = '1';
    openWards = openWards.filter((w) => geo.wards[w]);
    openWardTab(pinned);
    setTab(tab);
    renderMethod();
    renderMap(); renderWard(); renderMe(); renderFeed();
    tick();
    setTimeout(maybeAskWard, 30000);
    setInterval(tick, POLL_MS);
    setInterval(renderStatus, 1000);
    setTimeout(maybeWelcome, 4000); // still greet people if the first load is slow or fails
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  });
})();
