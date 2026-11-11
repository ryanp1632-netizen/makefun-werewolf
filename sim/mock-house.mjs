// A stand-in for the house players: an OpenAI Chat Completions server that reads the env's house prompt
// (system + user message, as program/env/server.mjs writes them) and answers with a heuristic, roughly
// LLM-like player. It is only for local testing: it is not claude-haiku-5-5 and its numbers are not the
// real table's. Usage: node sim/mock-house.mjs <port> [seed]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8790);
let state = Number(process.argv[3] ?? 1) >>> 0 || 1;
const rand = () => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const chance = (p) => rand() < p;

function parse(system, user) {
  const me = Number(/\(seat (\d)\) in game/.exec(system)?.[1]);
  const role = /Your role is (?:a |the )?(werewolf|seer|doctor|villager)/.exec(system)?.[1];
  const players = new Map();
  for (const m of user.matchAll(/\[moderator\] seat (\d) \(([^)]+)\): (alive|dead, was a (\w+))/g)) {
    players.set(Number(m[1]), { seat: Number(m[1]), name: m[2], alive: m[3] === 'alive', role: m[4] ?? null });
  }
  const partner = Number(/Your partner is seat (\d)/.exec(user)?.[1]) || null;
  const wolfVotes = [...user.matchAll(/Night (\d+): seat (\d) \([^)]+\) named seat (\d)/g)].map((m) => ({ night: +m[1], seat: +m[2], target: +m[3] }));
  const inspections = [...user.matchAll(/Night (\d+): you inspected seat (\d) \([^)]+\): (a werewolf|not a werewolf)/g)].map((m) => ({ night: +m[1], seat: +m[2], wolf: m[3] === 'a werewolf' }));
  const lastProtect = Number(/you protected seat (\d)/.exec(user)?.[1]) || null;
  const speeches = [...user.matchAll(/seat (\d) \([^)]+\) said(?: \(cut[^)]*\))?: (".*")$/gm)].map((m) => ({ seat: +m[1], text: JSON.parse(m[2]) }));
  const votes = [...user.matchAll(/seat (\d) \([^)]+\) voted to exile seat (\d)/g)].map((m) => ({ seat: +m[1], target: +m[2] }));
  const day = Number(/Game \d+, (?:night|day) (\d+)/.exec(user)?.[1] ?? 1);
  const options = (() => {
    const d = user.slice(user.indexOf('YOUR DECISION'));
    return [...d.matchAll(/seat (\d) \(/g)].map((m) => +m[1]);
  })();
  const decision = /turn to speak/.test(user) ? 'speak' : /turn to vote/.test(user) ? 'vote' : /tonight's victim/.test(user) ? 'kill' : /Protect one of/.test(user) ? 'protect' : 'inspect';
  // Today's votes: those after the last "voting" line.
  const lastVoting = user.lastIndexOf('voting. Voting order');
  const todayVotes = lastVoting < 0 ? [] : [...user.slice(lastVoting).matchAll(/seat (\d) \([^)]+\) voted to exile seat (\d)/g)].map((m) => ({ seat: +m[1], target: +m[2] }));
  // Claims as the mock reads them.
  const claims = new Map();
  for (const s of speeches) {
    if (/\b(i am|i'm) (the |the real )?seer\b/i.test(s.text) && !/not the seer/i.test(s.text)) {
      if (!claims.has(s.seat)) claims.set(s.seat, []);
    }
    if (claims.has(s.seat)) {
      for (const m of s.text.matchAll(/seat (\d) \([^)]+\)[^.]*?(NOT a werewolf|not a werewolf|a WEREWOLF|a werewolf|is a wolf)/g)) {
        claims.get(s.seat).push({ target: +m[1], wolf: !/not/i.test(m[2]) });
      }
    }
  }
  return { me, role, players, partner, wolfVotes, inspections, lastProtect, speeches, votes, todayVotes, day, options, decision, claims };
}

const nameOf = (g, s) => g.players.get(s)?.name ?? '?';
const ref = (g, s) => pick([`seat ${s} (${nameOf(g, s)})`, `${nameOf(g, s)}`, `Seat ${s}`, `${nameOf(g, s)} (seat ${s})`]);
const alive = (g) => [...g.players.values()].filter((p) => p.alive).map((p) => p.seat);

/** The seer claimant this player believes, with the mock's gullibility. */
function believed(g) {
  const live = [...g.claims.keys()].filter((s) => g.players.get(s)?.alive && s !== g.me);
  if (live.length === 0) return null;
  // A claimant whose wolf result turned out a revealed villager is not believed.
  const ok = live.filter((s) => !g.claims.get(s).some((r) => r.wolf && g.players.get(r.target)?.role && g.players.get(r.target).role !== 'werewolf'));
  if (ok.length === 0) return null;
  // Dead seer revealed: everyone else claiming is a liar.
  if ([...g.players.values()].some((p) => p.role === 'seer')) return null;
  return ok.length === 1 ? (chance(0.85) ? ok[0] : null) : pick(ok);
}

function suspicion(g) {
  const sc = new Map();
  for (const s of alive(g)) sc.set(s, rand() * 0.8);
  for (const sp of g.speeches) {
    for (const m of sp.text.matchAll(/seat (\d)/gi)) {
      if (/suspicious|wolf|vote|lying|liar/i.test(sp.text)) sc.set(+m[1], (sc.get(+m[1]) ?? 0) + 0.3);
    }
  }
  for (const v of g.todayVotes) sc.set(v.target, (sc.get(v.target) ?? 0) + 0.7);
  const b = believed(g);
  if (b !== null) for (const r of g.claims.get(b)) if (g.players.get(r.target)?.alive) sc.set(r.target, (sc.get(r.target) ?? 0) + (r.wolf ? 5 : -2));
  return sc;
}

function decideMock(g) {
  const opts = g.options;
  const wolves = new Set(g.role === 'werewolf' ? [g.me, g.partner].filter(Boolean) : [g.me].filter(() => false));
  if (g.decision === 'kill') {
    const pv = g.wolfVotes.find((v) => v.night === g.day && v.seat === g.partner);
    if (pv && chance(0.92)) return { target: pv.target };
    const seers = opts.filter((s) => g.claims.has(s));
    if (seers.length && chance(0.75)) return { target: pick(seers) };
    return { target: pick(opts) };
  }
  if (g.decision === 'protect') {
    const b = believed(g);
    if (b !== null && opts.includes(b) && chance(0.8)) return { target: b };
    return { target: pick(opts) };
  }
  if (g.decision === 'inspect') {
    const done = new Set(g.inspections.map((i) => i.seat));
    const fresh = opts.filter((s) => !done.has(s));
    return { target: pick(fresh.length ? fresh : opts) };
  }
  if (g.decision === 'vote') {
    if (g.role === 'seer') {
      const w = g.inspections.find((i) => i.wolf && opts.includes(i.seat));
      if (w) return { target: w.seat };
      const fake = [...g.claims.keys()].find((s) => s !== g.me && opts.includes(s));
      if (fake) return { target: fake };
    }
    const sc = suspicion(g);
    let cands = opts.filter((s) => !wolves.has(s));
    if (g.role === 'werewolf') {
      // Bus a doomed partner sometimes; otherwise ride the strongest villager wagon.
      const pv = g.todayVotes.filter((v) => v.target === g.partner).length;
      if (pv >= 3 && chance(0.4) && opts.includes(g.partner)) return { target: g.partner };
    }
    if (g.role === 'seer') cands = cands.filter((s) => !g.inspections.some((i) => i.seat === s && !i.wolf));
    if (!cands.length) cands = opts;
    cands.sort((a, b) => (sc.get(b) ?? 0) - (sc.get(a) ?? 0));
    return { target: chance(0.85) ? cands[0] : pick(cands) };
  }
  // speak
  const live = alive(g).filter((s) => s !== g.me);
  if (g.role === 'seer') {
    const found = g.inspections.find((i) => i.wolf && g.players.get(i.seat)?.alive);
    const counter = [...g.claims.keys()].some((s) => s !== g.me);
    const claimed = g.claims.has(g.me);
    if (claimed || found || counter || (g.day >= 2 && chance(0.5))) {
      const res = g.inspections.map((i) => `Night ${i.night}: seat ${i.seat} (${nameOf(g, i.seat)}) is ${i.wolf ? 'a werewolf' : 'not a werewolf'}.`).join(' ');
      return { say: `I am the seer. ${res} ${found ? `Vote ${nameOf(g, found.seat)} out.` : ''}`.trim() };
    }
  }
  if (g.role === 'werewolf' && g.day === 1 && !g.claims.size && chance(0.15)) {
    const v = pick(live.filter((s) => s !== g.partner));
    return { say: `I am the seer. Last night I checked seat ${v} (${nameOf(g, v)}) and they are a werewolf.` };
  }
  if (chance(0.15)) return { say: null };
  const sc = suspicion(g);
  const cands = live.filter((s) => !wolves.has(s) || g.role !== 'werewolf');
  cands.sort((a, b) => (sc.get(b) ?? 0) - (sc.get(a) ?? 0));
  const t = cands[0];
  if (t === undefined) return { say: 'No strong read.' };
  return {
    say: pick([
      `I find ${ref(g, t)} suspicious; their answers feel evasive.`,
      `My vote is leaning toward ${ref(g, t)}.`,
      `I think ${ref(g, t)} could be a wolf. I don't trust them.`,
      `We have little to go on, but ${ref(g, t)} has been pushing votes without reasons.`,
    ]),
  };
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let out;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages.filter((m) => m.role === 'user')[0]?.content ?? '';
      const g = parse(system, user);
      const ans = decideMock(g);
      out = JSON.stringify({ ...ans, thought: 'mock' });
    } catch (err) {
      out = JSON.stringify({ say: null, target: null, thought: `mock error ${err.message}` });
    }
    const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content: out }, finish_reason: 'stop' }] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply);
  });
}).listen(port, '127.0.0.1');
