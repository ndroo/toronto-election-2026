// Live feed: turns two consecutive copies of the City's results feed into news-style posts.
// Used by the Worker (the one writer everyone reads from) and by the page in ?demo mode (templates only).
// Pure functions only: no fetch, no storage, no Worker APIs.

// Must match CALL and callRace in app.js so the feed never calls a race the page doesn't.
export const CALL = { minReporting: 0.25, safety: 1.5, needShare: 0.75, swing: 0.30 };
export const CALLED = new Set(['projected', 'decided']);
export const POLLS_CLOSE = Date.parse('2026-10-26T20:00:00-04:00');
const BOARD_SHORT = { 'Toronto District School Board': 'TDSB', 'Toronto Catholic District School Board': 'TCDSB', 'Conseil scolaire Viamonde': 'Viamonde', 'Conseil scolaire catholique MonAvenir': 'MonAvenir' };
const MILESTONES = [0.25, 0.5, 0.75, 0.9, 1];
// Before polls close: a short post on each of these (Toronto time), so the feed isn't silent all day.
const PRE_CLOSE = ['2026-10-26T16:00:00-04:00', '2026-10-26T17:00:00-04:00', '2026-10-26T18:00:00-04:00', '2026-10-26T19:00:00-04:00', '2026-10-26T19:30:00-04:00'].map(Date.parse);

const int = (v) => { const n = parseInt(String(v ?? '').replace(/,/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const fmt = (n) => Math.round(n).toLocaleString('en-CA');
const pct1 = (n) => `${n.toFixed(1)}%`;

// ---------- model (same rules as race() / buildModel() / callRace() in app.js) ----------
function race(w, cands, pctFrom) {
  const list = cands.map((c) => ({ name: c.name.trim(), votes: int(c.votesReceived) }));
  const sum = list.reduce((a, c) => a + c.votes, 0);
  const total = pctFrom || sum;
  for (const c of list) c.pct = total ? (c.votes / total) * 100 : 0;
  list.sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  const r = { polls: int(w.polls), rec: int(w.pollsReceived), totalVoters: int(w.totalVoters), votes: int(w.votesReceived ?? w.votesCounted) || sum, cands: list };
  r.leader = list[0] && list[0].votes > 0 ? list[0] : null;
  r.tied = !!(r.leader && list[1] && list[1].votes === r.leader.votes);
  r.complete = r.polls > 0 && r.rec >= r.polls;
  return r;
}

export function callRace(r, estLeft) {
  if (!r || !r.cands.length) return 'none';
  const [a, b] = r.cands;
  if (!b) return 'acclaimed';
  if (!r.leader || !r.rec) return 'awaiting';
  if (r.tied) return 'tied';
  if (r.complete) return 'decided';
  const gap = a.votes - b.votes;
  const maxLeft = Math.max(0, r.totalVoters - (r.ballots ?? r.votes));
  if (gap > maxLeft) return 'decided';
  const left = Math.min(maxLeft, (estLeft ?? (r.votes / r.rec) * (r.polls - r.rec)) * CALL.safety);
  const topTwo = r.votes ? left * ((a.votes + b.votes) / r.votes) : 0;
  const need = topTwo > 0 ? (topTwo + gap) / (2 * topTwo) : Infinity;
  const hasNow = b.votes / (a.votes + b.votes);
  if (r.rec / r.polls < CALL.minReporting) return 'early';
  return need >= CALL.needShare || need - hasNow >= CALL.swing ? 'projected' : 'close';
}

// Compact snapshot of every race: what the diff needs, small enough to store between runs.
// `inc` is incumbents.json: who held each mayor/council seat going in, and whether they're on the ballot.
export function snapshot(all, wbw, inc = null) {
  const offices = all.office || [];
  const mayorO = offices.find((o) => o.id === 1 || /mayor/i.test(o.name));
  const councilO = offices.find((o) => o.id === 2 || /council/i.test(o.name));
  const races = {};
  const keep = (key, r, info) => {
    const [a, b] = r.cands;
    races[key] = {
      ...info, polls: r.polls, rec: r.rec, votes: r.votes, totalVoters: r.totalVoters, n: r.cands.length, status: r.status,
      a: a && { name: a.name, votes: a.votes, pct: +a.pct.toFixed(2) }, b: b && { name: b.name, votes: b.votes, pct: +b.pct.toFixed(2) },
      leader: r.leader && !r.tied ? r.leader.name : null,
    };
    const held = inc?.races?.[key === 'mayor' ? 'mayor|city' : key];
    if (held) { races[key].inc = held.incumbent; races[key].incRunning = !!held.running; }
  };
  const cw = mayorO?.ward?.[0] || {};
  const mayor = race(cw, cw.candidate || []);
  // City-wide mayor: votes still to come, estimated ward by ward (as app.js does).
  const byWard = {};
  for (const c of wbw?.office?.candidate || []) for (const w of c.ward || []) (byWard[int(w.num)] ||= { w, cands: [] }).cands.push({ name: c.name, votesReceived: w.votesReceived });
  const perPoll = mayor.rec ? mayor.votes / mayor.rec : 0;
  let left = 0, ballots = 0;
  for (const { w, cands } of Object.values(byWard)) {
    const r = race({ ...w, votesReceived: null, votesCounted: null }, cands);
    left += (r.rec ? r.votes / r.rec : perPoll) * (r.polls - r.rec);
    ballots += int(w.votesCounted) || r.votes;
  }
  mayor.ballots = Math.max(ballots, mayor.votes);
  mayor.status = callRace(mayor, left);
  keep('mayor', mayor, { kind: 'mayor', label: 'mayor' });
  for (const w of councilO?.ward || []) {
    const r = race(w, w.candidate || []);
    r.status = callRace(r);
    keep(`council|${int(w.num)}`, r, { kind: 'council', ward: int(w.num), wardName: w.name });
  }
  for (const o of offices) {
    if (o === mayorO || o === councilO) continue;
    for (const w of o.ward || []) {
      const r = race(w, w.candidate || []);
      r.status = callRace(r);
      keep(`o${o.id}|${w.num}`, r, { kind: 'trustee', ward: w.num, wardName: w.name, board: BOARD_SHORT[o.name] || o.name });
    }
  }
  return { seq: String(all.seq || ''), polls: mayor.polls, rec: mayor.rec, votes: mayor.votes, totalVoters: mayor.totalVoters, races };
}

// ---------- events ----------
// Each event is plain facts; text is written separately (by templates, or the AI with templates as the fallback).
// `id` is stable, so the same event is never posted twice.
const where = (r) => (r.kind === 'council' ? `Ward ${r.ward} ${r.wardName}` : r.kind === 'trustee' ? `${r.board} Ward ${r.ward}` : 'Toronto');
const facts = (r) => ({
  race: r.kind === 'mayor' ? 'Mayor of Toronto' : r.kind === 'council' ? `City council, Ward ${r.ward} (${r.wardName})` : `${r.board} school trustee, Ward ${r.ward}${r.wardName ? ` (${r.wardName})` : ''}`,
  pollsIn: r.rec, polls: r.polls, pctPollsIn: r.polls ? Math.round((r.rec / r.polls) * 100) : 0, candidates: r.n,
  leader: r.a?.votes ? { name: r.a.name, votes: r.a.votes, pct: +r.a.pct.toFixed(1) } : null,
  second: r.b?.votes ? { name: r.b.name, votes: r.b.votes, pct: +r.b.pct.toFixed(1) } : null,
  gap: r.a && r.b ? r.a.votes - r.b.votes : null,
  ...(r.inc ? r.incRunning
    ? { incumbent: r.inc, leaderIsIncumbent: r.a?.name === r.inc }
    : { openSeat: true, formerHolder: r.inc } : {}),
});

const LEAD_CHANGE_GAP_MS = 15 * 60 * 1000; // at most one lead-change post per race in this window

export function diff(prev, cur, now, posted = new Set()) {
  const ev = [];
  cur.lc = { ...(prev?.lc || {}) }; // when each race last had a lead-change post
  const add = (e) => { if (!posted.has(e.id)) { ev.push(e); posted.add(e.id); } };
  if (now >= POLLS_CLOSE) add({ id: 'polls-closed', kind: 'polls-closed', facts: { closedAt: '8 p.m.' } });
  // Only the latest pre-close mark that has passed, so a late start doesn't post a backlog.
  const mark = now < POLLS_CLOSE ? PRE_CLOSE.filter((t) => t <= now).pop() : null;
  if (mark && cur) {
    const council = Object.values(cur.races).filter((r) => r.kind === 'council');
    add({ id: `pre-close-${mark}`, kind: 'pre-close', noAI: true, facts: {
      minutesLeft: Math.round((POLLS_CLOSE - mark) / 60000), electors: cur.totalVoters, mayorCandidates: cur.races.mayor?.n || 0,
      councilCandidates: council.reduce((a, r) => a + r.n, 0), wards: council.length,
      trusteeRaces: Object.values(cur.races).filter((r) => r.kind === 'trustee').length,
    } });
  }
  if (!prev || !cur) return ev;

  const city = { pollsIn: cur.rec, polls: cur.polls, pctPollsIn: cur.polls ? Math.round((cur.rec / cur.polls) * 100) : 0, mayor: facts(cur.races.mayor) };
  if (!prev.rec && cur.rec) add({ id: 'first-results', kind: 'first-results', facts: city });
  for (const m of MILESTONES) {
    if (prev.polls && prev.rec / prev.polls < m && cur.rec / cur.polls >= m) add({ id: `milestone-${m}`, kind: 'milestone', facts: { ...city, milestone: Math.round(m * 100) } });
  }

  const started = [], finished = [], trusteeCalls = [];
  for (const [key, r] of Object.entries(cur.races)) {
    const p = prev.races[key];
    if (!p) continue;
    if (r.kind === 'council' && !p.rec && r.rec) started.push(r);
    if (r.kind === 'council' && r.polls && r.rec >= r.polls && p.rec < p.polls) finished.push(r);
    // Calls. Trustee calls come in bunches, so they're grouped into one post per run.
    if (CALLED.has(r.status) && !CALLED.has(p.status) && r.leader) {
      if (r.kind === 'trustee') trusteeCalls.push(r);
      else add({ id: `call-${key}-${r.status}-${r.leader}`, kind: 'call', facts: { ...facts(r), status: r.status, where: where(r) } });
    }
    // Lead changes once a race has enough counted to mean something.
    if (r.kind !== 'trustee' && p.leader && r.leader && p.leader !== r.leader && r.rec / r.polls >= 0.1 && !(now - (cur.lc[key] || 0) < LEAD_CHANGE_GAP_MS)) {
      cur.lc[key] = now;
      add({ id: `lead-${key}-${r.leader}-${cur.seq}`, kind: 'lead-change', facts: { ...facts(r), previousLeader: p.leader, where: where(r), ...(r.inc && r.incRunning && p.leader === r.inc ? { incumbentFellBehind: true } : {}) } });
    }
    // A council race that's still close with most of the count in.
    if (r.kind === 'council' && r.status === 'close' && r.rec / r.polls >= 0.5 && r.a && r.b && r.a.pct - r.b.pct < 3) {
      add({ id: `close-${key}`, kind: 'close-race', facts: { ...facts(r), where: where(r) } });
    }
  }
  const byWard = (a, b) => a.ward - b.ward;
  if (started.length === 1) add({ id: `started-${started[0].ward}`, kind: 'ward-started', facts: { ...facts(started[0]), where: where(started[0]) } });
  else if (started.length > 1) add({ id: `started-${started.map((r) => r.ward).sort((a, b) => a - b).join('-')}`, kind: 'wards-started', facts: { count: started.length, wards: started.sort(byWard).map((r) => ({ ward: r.ward, name: r.wardName })), city } });
  // A race whose count just completed usually gets its call in the same run; the call post says it all.
  const calledNow = new Set(ev.filter((e) => e.kind === 'call').map((e) => e.facts.where));
  for (const r of finished.sort(byWard)) if (!calledNow.has(where(r))) add({ id: `finished-${r.ward}`, kind: 'ward-finished', facts: { ...facts(r), where: where(r) } });
  if (trusteeCalls.length) add({ id: `trustees-${cur.seq}`, kind: 'trustee-calls', facts: { count: trusteeCalls.length, calls: trusteeCalls.map((r) => ({ race: `${r.board} Ward ${r.ward}`, winner: r.a.name, pct: +r.a.pct.toFixed(1), status: r.status })) } });
  return ev;
}

// ---------- templates ----------
// A few phrasings per kind, picked by the event id so every reader sees the same words.
const pick = (id, arr) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return arr[h % arr.length]; };
const last = (n) => n.trim().split(/\s+/).pop();
const list = (xs) => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const projNote = 'This is the page\'s own projection from the unofficial count, not an official result.';

export function template(e) {
  const f = e.facts;
  const L = f.leader, S = f.second;
  switch (e.kind) {
    case 'pre-close': {
      const h = f.minutesLeft / 60;
      const left = f.minutesLeft === 30 ? 'Thirty minutes' : `${['', 'One hour', 'Two hours', 'Three hours', 'Four hours'][h] || `${h} hours`}`;
      const lines = [
        `${fmt(f.electors)} people are on the voters' list, choosing a mayor from ${f.mayorCandidates} candidates.`,
        `${f.councilCandidates} candidates are running for council across ${f.wards} wards, plus ${f.trusteeRaces} school trustee races.`,
        'Results will start appearing here after 8 p.m., ward by ward, as the City reports them.',
        `There are ${f.mayorCandidates} names on the ballot for mayor, and ${f.councilCandidates} running for council.`,
        'Once polls close, updates will appear here as the City reports results.',
      ];
      return { headline: `${left} until polls close`, body: `Voting is open until 8 p.m. ${lines[Math.round(4 - h) % lines.length] || lines[4]}` };
    }
    case 'polls-closed': return pick(e.id, [
      { headline: 'Polls are closed across Toronto', body: 'Voting ended at 8 p.m. The first unofficial results should start arriving from the City shortly.' },
    ]);
    case 'first-results': {
      const m = f.mayor;
      return { headline: 'The first results are in', body: `${fmt(f.pollsIn)} of ${fmt(f.polls)} polls have reported.${m.leader ? ` ${m.leader.name} has an early lead for mayor with ${pct1(m.leader.pct)}${m.second ? `, ahead of ${m.second.name} at ${pct1(m.second.pct)}` : ''}.` : ''} It is very early.` };
    }
    case 'milestone': {
      const m = f.mayor;
      const head = f.milestone === 100 ? 'Every poll in the city has now reported' : f.milestone === 50 ? 'Halfway there: half of all polls have reported' : `${f.milestone}% of polls are now in`;
      const lead = m.leader ? ` ${m.leader.name} leads for mayor with ${pct1(m.leader.pct)}${m.second ? `, ${fmt(m.gap)} votes ahead of ${m.second.name}` : ''}.` : '';
      return { headline: head, body: `${fmt(f.pollsIn)} of ${fmt(f.polls)} polls have reported.${lead}` };
    }
    case 'ward-started': return pick(e.id, [
      { headline: `Counting begins in ${f.where}`, body: `${fmt(f.pollsIn)} of ${fmt(f.polls)} polls are in.${L ? ` ${L.name} leads the council race early with ${pct1(L.pct)}.` : ''}` },
      { headline: `First votes reported in ${f.where}`, body: `${L ? `${L.name} is ahead for council with ${pct1(L.pct)}` : 'The council race is under way'}, with ${fmt(f.pollsIn)} of ${fmt(f.polls)} polls counted.` },
    ]);
    case 'wards-started': {
      const names = f.wards.map((w) => `Ward ${w.ward} ${w.name}`);
      return { headline: `Results start arriving from ${f.wards.length} more wards`, body: `First polls are in from ${list(names)}.` };
    }
    case 'ward-finished': if (f.incumbent && !f.leaderIsIncumbent) return { headline: `${L.name} finishes ahead of incumbent ${f.incumbent} in ${f.where}`, body: `Every poll is in. ${L.name} tops the council race with ${pct1(L.pct)}. Unofficial until certified.` };
      if (f.leaderIsIncumbent) return { headline: `Every poll is in for ${f.where}: ${L.name} holds on`, body: `The incumbent finishes first for council with ${fmt(L.votes)} votes (${pct1(L.pct)})${S ? `, ${fmt(f.gap)} ahead of ${S.name}` : ''}. Unofficial until certified.` };
      return pick(e.id, [
      { headline: `Every poll is in for ${f.where}`, body: `${L.name} finishes first for council with ${fmt(L.votes)} votes (${pct1(L.pct)})${S ? `, ${fmt(f.gap)} ahead of ${S.name}` : ''}. Unofficial until certified.` },
      { headline: `${f.where} has finished counting`, body: `${L.name} tops the council race with ${pct1(L.pct)}${S ? ` to ${S.name}'s ${pct1(S.pct)}` : ''}. Unofficial until certified.` },
    ]);
    case 'lead-change': {
      const mayor = f.race === 'Mayor of Toronto';
      return pick(e.id, [
        { headline: mayor ? `${L.name} takes the lead for mayor` : `${L.name} pulls ahead in ${f.where}`, body: `${last(L.name)} now leads ${f.incumbentFellBehind ? 'incumbent ' : ''}${f.previousLeader} by ${fmt(f.gap)} votes with ${f.pctPollsIn}% of polls counted.` },
        { headline: mayor ? `Lead change in the mayor's race` : `Lead change in ${f.where}`, body: `${L.name} has moved ahead of ${f.previousLeader} and now leads by ${fmt(f.gap)} votes, with ${f.pctPollsIn}% of polls in.` },
      ]);
    }
    case 'call': {
      const mayor = f.race === 'Mayor of Toronto';
      const seat = mayor ? "Toronto's next mayor" : `the council seat in ${f.where}`;
      const office = mayor ? 'as mayor' : `in ${f.where}`;
      const share = `${pct1(L.pct)} of the vote${S ? ` to ${S.name}'s ${pct1(S.pct)}` : ''}`;
      if (f.status === 'decided') {
        if (f.leaderIsIncumbent) return { headline: `${L.name} re-elected ${office}`, body: `The incumbent has ${share}, a lead that can no longer be overtaken in the unofficial count.` };
        if (f.incumbent) return { headline: `${L.name} unseats incumbent ${f.incumbent} ${mayor ? 'for mayor' : `in ${f.where}`}`, body: `${L.name} has ${share}, a lead that can no longer be overtaken in the unofficial count.` };
        if (f.openSeat) return { headline: `${L.name} wins the open seat in ${f.where}`, body: `${L.name} has ${share}, a lead that can no longer be overtaken in the unofficial count. ${f.formerHolder} did not run again here.` };
        return { headline: mayor ? `${L.name} wins the race for mayor` : `${L.name} wins in ${f.where}`, body: `${L.name} has ${share}, a lead that can no longer be overtaken in the unofficial count.` };
      }
      if (f.leaderIsIncumbent) return { headline: `${L.name} projected to be re-elected ${office}`, body: `With ${f.pctPollsIn}% of polls in, the incumbent has ${share}. ${projNote}` };
      if (f.incumbent) return { headline: `${L.name} projected to unseat ${f.incumbent} ${mayor ? 'for mayor' : `in ${f.where}`}`, body: f.second?.name === f.incumbent ? `With ${f.pctPollsIn}% of polls in, ${last(L.name)} has ${pct1(L.pct)} to the incumbent's ${pct1(S.pct)}. ${projNote}` : `With ${f.pctPollsIn}% of polls in, ${last(L.name)} has ${share}, with incumbent ${f.incumbent} further back. ${projNote}` };
      if (f.openSeat) return { headline: `${L.name} projected to win the open seat in ${f.where}`, body: `With ${f.pctPollsIn}% of polls in, ${last(L.name)} has ${share}. ${projNote}` };
      return pick(e.id, [
        { headline: mayor ? `${L.name} projected to be Toronto's next mayor` : `${L.name} projected to win ${f.where}`, body: `With ${f.pctPollsIn}% of polls in, ${last(L.name)} has ${pct1(L.pct)}${S ? ` to ${S.name}'s ${pct1(S.pct)}` : ''}. ${projNote}` },
        { headline: `We project ${L.name} will take ${seat}`, body: `${last(L.name)} leads by ${fmt(f.gap)} votes with ${f.pctPollsIn}% of polls counted. ${projNote}` },
      ]);
    }
    case 'close-race': return { headline: `${f.where} is going down to the wire`, body: `${L.name} and ${S.name} are ${fmt(f.gap)} votes apart with ${f.pctPollsIn}% of polls counted.` };
    case 'trustee-calls': {
      const c = f.calls;
      const word = (x) => (x.status === 'decided' ? 'wins' : 'projected');
      if (c.length === 1) return { headline: `${c[0].winner} ${c[0].status === 'decided' ? 'wins' : 'projected to win'} ${c[0].race}`, body: `${c[0].winner} has ${pct1(c[0].pct)} in the school trustee race.${c[0].status === 'decided' ? '' : ` ${projNote}`}` };
      return { headline: `${c.length} school trustee races called`, body: `${c.map((x) => `${x.race}: ${x.winner} (${word(x)})`).join('; ')}.` };
    }
  }
  return { headline: 'Update', body: '' };
}

// ---------- AI writing guard ----------
// The AI may only rephrase. Anything it writes is checked against the event's facts and rejected
// (falling back to the template) if it adds a number or a name, or calls a race the facts don't call.
export function checkWriting(e, headline, body, allNames) {
  const text = `${headline} ${body}`;
  // A real headline: capitalised, at least four words, and about someone or somewhere specific.
  if (!/^[A-Z0-9]/.test(headline) || headline.split(/\s+/).length < 4) return 'headline too thin';
  if (body.split(/\s+/).length < 6) return 'body too thin';
  const f = e.facts;
  const ward = f.where?.match(/Ward \d+/)?.[0];
  if (ward && !text.includes(ward)) return `doesn't say ${ward}`;
  if (f.race === 'Mayor of Toronto' && !/mayor/i.test(text)) return "doesn't say mayor";
  const projectedWin = /projected (to win|winner|to take|to become|to be|to unseat|to hold|to keep)|project (that )?\S+( \S+)? will/i;
  if (e.kind === 'call' && f.status === 'projected' && !projectedWin.test(text)) return 'projection not phrased as a projected win';
  if (e.kind === 'trustee-calls' && f.calls.some((c) => c.status === 'projected') && !projectedWin.test(text)) return 'projection not phrased as a projected win';
  // Each kind must still say what happened, not drift into a general update.
  const about = {
    milestone: f.milestone === 100 ? /(every|all) (\S+ )?polls?|100%/i : new RegExp(`${f.milestone}%|half`, 'i'),
    'wards-started': /Ward \d+/,
    'ward-started': /(first|begin|began|start|under ?way|opening|early)/i,
    'ward-finished': /(every poll|all polls|all \d[\d,]* polls|finished|complete|final)/i,
    'close-race': /(close|tight|narrow|apart|wire|razor|neck|separat)/i,
    'lead-change': /(lead|ahead|front|overtak|pass)/i,
    'first-results': /(first|early|in)/i,
  }[e.kind];
  if (about && !about.test(text)) return `doesn't say what happened (${e.kind})`;
  if (e.kind === 'trustee-calls' && !f.calls.every((c) => text.includes(c.race))) return 'missing a trustee race';
  const allowed = new Set();
  const addNum = (v) => {
    if (typeof v !== 'number') return;
    for (const s of [String(v), String(Math.round(v)), v.toFixed(1), v.toFixed(2)]) allowed.add(s.replace(/\.0+$/, ''));
  };
  const walk = (x) => { if (x && typeof x === 'object') Object.values(x).forEach(walk); else if (typeof x === 'number') addNum(x); else if (typeof x === 'string') (x.match(/\d+(\.\d+)?/g) || []).forEach((n) => allowed.add(n)); };
  walk(e.facts);
  for (const n of text.match(/\d[\d,]*(\.\d+)?/g) || []) if (!allowed.has(n.replace(/,/g, '').replace(/\.0+$/, ''))) return `number ${n}`;
  const factText = JSON.stringify(e.facts);
  for (const name of allNames) {
    if (factText.includes(name)) continue;
    if (text.includes(name)) return `name ${name}`;
  }
  const called = e.kind === 'call' || e.kind === 'trustee-calls';
  const decided = called && (e.facts.status === 'decided' || e.facts.calls?.every((c) => c.status === 'decided'));
  if (!called && /\b(wins?|won|winner|elected|victory|victorious|clinch(es|ed)?|concede[sd]?|defeat(s|ed)?)\b/i.test(text)) return 'calls a race';
  if (called && !decided && !/project/i.test(text)) return 'projection not labelled';
  if (called && !decided && /\b(won|elected|victory|victorious)\b/i.test(text.replace(/projected to be re-elected/gi, ''))) return 'projection stated as a result';
  if (!called && /re-?elected|unseat|ousts?|toppl/i.test(text)) return 'calls a race';
  if (/[!]|https?:/.test(text)) return 'style';
  return null;
}
