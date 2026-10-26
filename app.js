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
  let tab = ['ward', 'wards', 'school', 'method'].includes(hash.get('t')) ? hash.get('t') : 'ward';
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
  const CALL_LABEL = { acclaimed: '&#10003; Acclaimed', official: '&#10003; Official winner', decided: '&#10003; Winner &middot; unofficial', projected: '&#9670; Projected winner', close: 'Too close to call', early: 'Too early to call', tied: 'Tied', awaiting: 'No results yet' };
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
  function callRow(r) {
    if (!r) return '';
    const [a, b] = r.cands;
    let txt;
    if (r.cands.length === 1) txt = `<b>${esc(a.name)}</b> is the only candidate`;
    else if (!r.leader) txt = `${r.cands.length} candidate${r.cands.length === 1 ? '' : 's'} · no votes counted yet`;
    else if (r.tied) txt = `<b>${esc(a.name)}</b> and <b>${esc(b.name)}</b> are tied at ${fmt(a.votes)}`;
    else if (!b) txt = `<b>${esc(a.name)}</b> is the only candidate`;
    else txt = `<b>${esc(a.name)}</b> leads ${esc(b.name)} by <b>${fmt(a.votes - b.votes)}</b> votes (${(a.pct - b.pct).toFixed(1)} pts)`;
    return `<div class="callrow">${badge(r.call)}<span class="lead-txt">${txt}</span></div>${why(r.call)}`;
  }
  const why = (call) => call && call.status !== 'awaiting' ? `<div class="call-why">${esc(call.reason)}</div>` : '';

  function renderMethod() {
    const ex = (st) => `<span class="call call-${st}">${CALL_LABEL[st]}</span>`;
    const sections = [
      ['m-disclaimer', 'Disclaimer'], ['m-calls', 'Race calls'], ['m-data', 'Where the numbers come from'], ['m-calc', 'How each number is worked out'],
      ['m-map', 'Map colours'], ['m-photos', 'Candidate photos'], ['m-limits', 'Limits'],
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
      <p><b>Mayor leader:</b> the top three mayoral candidates city-wide each get a colour, and keep it even if their ranks change. A ward led by anyone else, or tied, is grey. Darker means a wider lead in that ward (full strength at 30 points or more).</p>
      <p><b>Council margin:</b> darker blue means a wider lead for the council leader (full strength at 40 points). <b>Reporting</b> and <b>Turnout:</b> darker means higher (turnout full strength at 60%).</p>
      <p>Ward boundaries: <a href="https://open.toronto.ca/dataset/city-wards/">Toronto Open Data</a>, 25-ward model, simplified for the web.</p>
      </section>

      <section id="m-photos"><h3>Candidate photos</h3>
      <p>Photos were taken from each candidate's own campaign website or social page, as listed on the <a href="https://www.toronto.ca/city-government/elections/candidate-list/">City's candidate list</a>, and cropped automatically around the face. Each crop was then checked by hand, and images that weren't clearly a headshot of the candidate were dropped. Candidates without a usable photo are shown with their initials. If a photo is wrong, contact <a href="https://andrewmcgrath.info">Andrew McGrath</a>.</p>
      <p>On the map, the Mayor and Council views show the leading candidate's photo at each ward's centre. Where we have no photo of the leader, their initials are shown instead. Use the Faces switch under the map to turn photos off.</p>
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
      maybeWelcome();
      renderWelcome();
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
  let faceLayer;
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
    svg.append(gW, pin, hl, faceLayer, gL);
    // Face size scales with the ward's footprint so small downtown wards don't overflow.
    for (const [num, p] of Object.entries(paths)) { const b = p.getBBox(); wardSize[num] = Math.sqrt(b.width * b.height); }

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
      for (const f of faces) {
        const ring = mode === 'mayor' ? (candColour(f.c.name) || css('--other')) : css(f.lead ? '--ink' : '--surface');
        const id = `fc${clipId++}`;
        parts.push(`<g class="face"><title>${esc(f.c.name)} ${pct(f.c.pct)}</title>
          <circle cx="${f.x}" cy="${f.y}" r="${f.rad + 2.5}" fill="${ring}"/>
          ${f.ph ? `<clipPath id="${id}"><circle cx="${f.x}" cy="${f.y}" r="${f.rad}"/></clipPath>
          <image href="photos/${f.ph.f}" x="${f.x - f.rad}" y="${f.y - f.rad}" width="${f.rad * 2}" height="${f.rad * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
          : `<circle cx="${f.x}" cy="${f.y}" r="${f.rad}" class="face-i"/><text x="${f.x}" y="${f.y}" class="face-t" style="font-size:${f.rad * 0.62}px">${esc(initials(f.c.name))}</text>`}</g>`);
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
      note = 'Darker = wider lead';
    } else if (mode === 'council') {
      key = ramp('0', '40+ pts', "Council leader's lead over 2nd place");
      note = 'Darker = safer seat';
    } else if (mode === 'reporting') {
      key = ramp('0%', '100%', 'Polls reporting');
      note = 'Darker = more counted';
    } else {
      key = ramp('0%', '60%+', 'Turnout (mayor ballots ÷ electors)');
      note = 'Darker = higher turnout';
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
  const normName = (n) => n.replace(/\s+/g, ' ').trim();
  const photoOf = (pkey, name) => photos[`${pkey}|${normName(name)}`];
  const initials = (name) => { const p = normName(name).split(' '); return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };
  function avatar(pkey, name, ring) {
    const ph = photoOf(pkey, name);
    const st = ring ? ` style="box-shadow:0 0 0 2px ${ring}"` : '';
    return ph ? `<span class="av"${st}><img src="photos/${ph.f}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="av av-i"${st}>${esc(initials(name))}</span>`;
  }

  // ---------- rendering: lists ----------
  function candList(r, { colour = false, showCall = true } = {}) {
    if (!r || !r.cands.length) return '<li class="empty">No candidates in feed</li>';
    const max = Math.max(1, ...r.cands.map((c) => c.pct));
    return r.cands.map((c, i) => {
      const lead = r.leader && i === 0 && !r.tied;
      const col = colour ? candColour(c.name) : null;
      const st = r.call?.status;
      const tag = lead && showCall && CALLED.has(st) ? `<span class="tag tag-${st}">${{ projected: 'Projected', decided: 'Winner', official: 'Official', acclaimed: 'Acclaimed' }[st]}</span>` : '';
      return `<li class="cand${lead ? ' lead' : ''}${c.delta && flashNow ? ' flash' : ''}" title="${esc(c.name)}: ${fmt(c.votes)} votes (${pct(c.pct, 2)})${c.delta ? `, +${fmt(c.delta)} since last update` : ''}">
        ${avatar(r.pkey, c.name, col)}
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
        <div class="ward-sub">${rep ? `<span class="ws"><span class="wt wt-polls">${fmt(rep.pollsReceived)}/${fmt(rep.polls)} polls · ${pct(rep.polls ? (rep.pollsReceived / rep.polls) * 100 : 0, 0)}</span>${meter(rep.polls ? rep.pollsReceived / rep.polls : 0, rep.complete)}</span>
          <span class="ws"><span class="wt wt-turn">Turnout ${pct(rep.totalVoters ? (rep.votes / rep.totalVoters) * 100 : 0)}</span>${meter(rep.totalVoters ? rep.votes / rep.totalVoters : 0)}</span>
          <span>${fmt(rep.totalVoters)} electors</span>` : ''}</div>
      </div>
      <div class="races">
        <div class="race"><div class="race-head"><h3>Council</h3><span class="meta">${raceMeta(w.council)}</span></div>${callRow(w.council)}
          <div class="scroller"><ul class="cands">${candList(w.council)}</ul></div></div>
        <div class="race"><div class="race-head"><h3>Mayor</h3><span class="meta">${raceMeta(w.mayor)}</span></div><div class="call-why">Votes cast in this ward. The mayor's race is called city-wide.</div>
          <div class="scroller"><ul class="cands dense">${candList(w.mayor, { colour: true, showCall: false })}</ul></div></div>
      </div>`;
    el.querySelectorAll('.scroller').forEach((x, i) => { if (keep[i]) x.scrollTop = keep[i]; });
  }

  function renderCity() {
    const r = model.mayor;
    $('#cityMeta').textContent = raceMeta(r);
    $('#cityCall').innerHTML = callRow(r);
    $('#cityList').innerHTML = candList(r, { colour: true });
  }

  // Header mayor stat: the leader's name, with what kind of lead it is spelled out underneath.
  function mayorStat(r) {
    const st = r.call?.status;
    const name = r.leader && !r.tied ? esc(r.leader.name) : '';
    const blank = '<span class="meter blank"></span>';
    if (!name) return ['Mayor', st === 'tied' ? 'Tied' : 'Results after 8 p.m.', blank];
    const v = { projected: `&#9670; ${name}`, decided: `&#10003; ${name}`, official: `&#10003; ${name}` }[st] || name;
    const l = { projected: 'projected winner', decided: 'winner (unofficial)', official: 'official winner' }[st] || 'ahead, not called yet';
    return [`Mayor · <span class="st st-${st}">${l}</span>`, v, blank];
  }

  function renderStats() {
    const r = model.mayor;
    const wards = Object.values(model.wards);
    const wardsDone = wards.filter((w) => (w.mayor || w.council)?.complete).length;
    const council = wards.map((w) => w.council?.call?.status);
    const called = council.filter((x) => CALLED.has(x)).length;
    const s = [
      mayorStat(r),
      ['Council called', `${called}/${wards.length}`, meter(wards.length ? called / wards.length : 0, called === wards.length)],
      [`Polls reporting · ${pct(r.polls ? (r.pollsReceived / r.polls) * 100 : 0, 0)}`, `${fmt(r.pollsReceived)}/${fmt(r.polls)}`, meter(r.polls ? r.pollsReceived / r.polls : 0, r.complete)],
      ['Wards complete', `${wardsDone}/${wards.length}`, meter(wards.length ? wardsDone / wards.length : 0, wards.length > 0 && wardsDone === wards.length)],
      [`Turnout · ${fmt(r.votes)} of ${fmt(r.totalVoters)}`, pct(r.totalVoters ? (r.votes / r.totalVoters) * 100 : 0), meter(r.totalVoters ? r.votes / r.totalVoters : 0)],
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
      else if (r.complete) { st.classList.add('live'); tx.textContent = `All polls in · ${gen}`; }
      else if (r.pollsReceived > 0) { st.classList.add('live'); tx.textContent = `Live · ${gen}`; }
      else { tx.textContent = 'Waiting for results · polls close 8 p.m.'; }
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
    const who = (r, colour) => {
      if (!r?.leader) return '<span style="color:var(--muted)">-</span>';
      if (r.tied) return 'Tied';
      const c = colour ? candColour(r.leader.name) || css('--other') : null;
      const st = r.call?.status;
      const ico = CALLED.has(st) ? `<span class="ico ico-${st}" aria-label="${st}">${st === 'projected' ? '&#9670;' : '&#10003;'}</span>` : '';
      return `<span class="who">${c ? `<i style="background:${c}"></i>` : ''}${ico}${esc(r.leader.name)}</span>`;
    };
    t.innerHTML = `<thead><tr>${COLS.map((c) => `<th data-k="${c.key}"${c.n ? ' class="n"' : ''}${sort.key === c.key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((w) => {
        const r = w.mayor || w.council;
        const rp = r?.polls ? r.pollsReceived / r.polls : 0;
        return `<tr data-w="${w.num}" class="${String(w.num) === pinned ? 'pinned' : ''}${String(w.num) === hover ? ' hot' : ''}">
          <td><b class="num">${w.num}</b> ${esc(w.name)}</td>
          <td><span class="num">${r ? `${r.pollsReceived}/${r.polls}` : ''}</span>${meter(rp, r?.complete)}</td>
          <td><span class="num">${pct(COLS[2].v(w) * 100)}</span>${meter(COLS[2].v(w))}</td>
          <td>${who(w.mayor, true)}${w.mayor?.leader ? `<div class="sub2">${pct(w.mayor.leader.pct)} · lead ${w.mayor.margin.toFixed(1)} pts</div>` : ''}</td>
          <td>${who(w.council)}${w.council?.leader ? `<div class="sub2">${pct(w.council.leader.pct)} · lead ${w.council.margin.toFixed(1)} pts · ${w.council.cands.length} running</div>` : ''}</td>
          </tr>`;
      }).join('')}</tbody>`;
  }
  $('#wardTable').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (th) { const k = th.dataset.k; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'num' ? 1 : -1) }; renderTable(); return; }
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
      <div class="board-ward"><div class="race-head"><h3>${esc(BOARD_SHORT[b.name] || b.name)} Ward ${esc(w.num)}${w.name ? ` - ${esc(w.name)}` : ''}</h3>${badge(w.race.call)}<span class="meta">${raceMeta(w.race)}</span></div>
      <ul class="cands dense">${candList(w.race)}</ul></div>`).join('')}</div>` : '<div class="empty">No school board races in the feed.</div>';
  }
  $('#boardTabs').addEventListener('click', (e) => { const btn = e.target.closest('button'); if (btn) { board = int(btn.dataset.b); renderBoards(); } });

  // ---------- tabs ----------
  function setTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const p of document.querySelectorAll('#right .panel')) p.hidden = p.id !== `panel-${t}`;
    saveHash();
  }
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

  function renderAll() {
    flashNow = true;
    renderStatus(); renderStats(); renderMap(); renderCity(); renderWard(); renderTable(); renderBoards(); renderTip();
    flashNow = false;
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
      box.innerHTML = `<div class="cd-label">Polls close at 8 p.m. in</div>
        <div class="cd">${hh}<small>h</small> ${mm}<small>m</small> ${ss}<small>s</small></div>
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
    const dlg = $('#welcome');
    if (!dlg?.showModal) return;
    dlg.addEventListener('close', () => clearInterval(welcomeTimer), { once: true });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside closes
    dlg.showModal();
    renderWelcome();
    welcomeTimer = setInterval(renderWelcome, 1000);
    $('#welcomeGo').focus();
  }

  // ---------- boot ----------
  if (DEMO) $('#demoBanner').hidden = false;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => model && renderAll());
  Promise.all([
    fetch('wards.json').then((r) => r.json()),
    fetch('photos.json').then((r) => r.json()).catch(() => ({})),
  ]).then(([g, ph]) => {
    geo = g;
    photos = Object.fromEntries(Object.entries(ph).map(([k, v]) => { const [a, b] = k.split('|'); return [`${a}|${normName(b)}`, v]; }));
    buildMap();
    if (!geo.wards[pinned]) pinned = '1';
    setTab(tab);
    renderMethod();
    renderMap(); renderWard();
    tick();
    setInterval(tick, POLL_MS);
    setInterval(renderStatus, 1000);
    setTimeout(maybeWelcome, 4000); // still greet people if the first load is slow or fails
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  });
})();
