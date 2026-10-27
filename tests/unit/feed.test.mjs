// The race-call rule, the feed's events and templates, and the AI writing guard, run against the real 2026 data:
// the frozen final results (final/) and every saved version of the City's feed from election night (replay/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { assessRace, callRace, snapshot, diff, template, checkWriting, signOff, POLLS_CLOSE } from '../../worker/feed.js';
import { ELECTION } from '../../election.js';

const root = new URL('../../', import.meta.url);
const json = (p) => JSON.parse(fs.readFileSync(new URL(p, root)));
const inc = json('incumbents.json');
const race = (votes, { polls = 100, rec = 50, totalVoters = 100000, ...rest } = {}) => {
  const cands = votes.map((v, i) => ({ name: `C${i}`, votes: v })).sort((a, b) => b.votes - a.votes);
  const sum = votes.reduce((a, b) => a + b, 0);
  return { polls, rec, totalVoters, votes: sum, cands, leader: cands[0]?.votes ? cands[0] : null, tied: cands[1]?.votes === cands[0]?.votes && cands[0].votes > 0, complete: rec >= polls, ...rest };
};

test('race calls', () => {
  assert.equal(callRace(race([10])), 'acclaimed');
  assert.equal(callRace(race([0, 0], { rec: 0 })), 'awaiting');
  assert.equal(callRace(race([500, 500])), 'tied');
  assert.equal(callRace(race([9000, 1000], { rec: 10 })), 'early'); // under 25% of polls, however big the lead
  assert.equal(callRace(race([600, 400], { rec: 100 })), 'decided'); // every poll in
  assert.equal(callRace(race([9000, 1000], { rec: 99, totalVoters: 10500 })), 'decided'); // lead bigger than every elector left
  assert.equal(callRace(race([30000, 10000])), 'projected');
  assert.equal(callRace(race([20500, 19500])), 'close');
  const x = assessRace(race([20500, 19500]));
  assert.ok(x.need > 0.5 && x.need < 0.75 && x.hasNow > 0.4, JSON.stringify(x));
});

test('final results: every race finished', () => {
  const s = snapshot(json('final/unofficialresult.json'), json('final/unofficialresult-wardbyward.json'), inc);
  assert.equal(s.rec, s.polls);
  assert.equal(s.races.mayor.status, 'decided');
  for (const [k, r] of Object.entries(s.races)) assert.ok(['decided', 'acclaimed', 'tied'].includes(r.status), `${k} ${r.status}`);
  const t = template(signOff(s));
  assert.match(t.body, /of 25 council races/);
});

test('replaying election night gives a sensible feed', () => {
  const idx = json('replay/index.json');
  let prev = null;
  const posted = new Set(), events = [];
  for (const f of idx.files) {
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`replay/${f.file}`, root))));
    const cur = snapshot(b.all, b.wardbyward, inc);
    if (prev && cur.rec < prev.rec) assert.fail(`polls went backwards at ${f.t}`);
    for (const e of diff(prev, cur, Date.parse(f.t), posted)) events.push(e);
    prev = cur;
  }
  const kinds = events.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] || 0) + 1 }), {});
  assert.equal(kinds['first-results'], 1);
  assert.equal(kinds['polls-closed'], 1);
  assert.equal(events.filter((e) => e.id === 'milestone-1').length, 1);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length, 'an event was repeated');
  const mayorCall = events.find((e) => e.kind === 'call' && e.facts.race === 'Mayor of Toronto');
  assert.equal(mayorCall?.facts.leader.name, 'Olivia Chow');
  for (const e of events) {
    const t = template(e);
    assert.ok(t.headline && t.headline !== 'Update', `no template for ${e.kind}`);
    assert.doesNotMatch(`${t.headline} ${t.body}`, /undefined|NaN|null/, e.id);
  }
});

test('the AI guard rejects invented facts and premature calls', () => {
  const s = snapshot(json('final/unofficialresult.json'), json('final/unofficialresult-wardbyward.json'), inc);
  const r = s.races['council|10'];
  const facts = { race: `City council, Ward 10 (${r.wardName})`, pollsIn: r.rec, polls: r.polls, pctPollsIn: 60, leader: { name: r.a.name, votes: r.a.votes, pct: r.a.pct }, second: { name: r.b.name, votes: r.b.votes, pct: r.b.pct }, gap: r.a.votes - r.b.votes, where: `Ward 10 ${r.wardName}` };
  const names = new Set(Object.values(s.races).flatMap((x) => [x.a?.name, x.b?.name]).filter(Boolean));
  const lead = { kind: 'lead-change', facts: { ...facts, previousLeader: r.b.name } };
  const ok = `${r.a.name} pulls ahead in Ward 10`, body = `${r.a.name} now leads ${r.b.name} with 60% of polls counted.`;
  assert.equal(checkWriting(lead, ok, body, names), null);
  assert.match(checkWriting(lead, ok, `${r.a.name} now leads by 12,345 votes with 60% counted.`, names), /number/);
  assert.match(checkWriting(lead, `${r.a.name} wins Ward 10 race tonight`, body, names), /calls a race/);
  const proj = { kind: 'call', facts: { ...facts, status: 'projected' } };
  assert.match(checkWriting(proj, `${r.a.name} wins in Ward 10 Spadina`, `${r.a.name} has won with 60% of polls in tonight.`, names) || '', /project/);
});

test('election dates are in order', () => {
  const pre = ELECTION.preClose.map(Date.parse);
  assert.ok(pre.every((t, i) => Number.isFinite(t) && t < POLLS_CLOSE && (i === 0 || t > pre[i - 1])));
  assert.ok(Date.parse(ELECTION.signOff) > POLLS_CLOSE);
});
