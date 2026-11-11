// A scripted Werewolf agent for make.fun's werewolf-agent-01 bounty.
//
// No model calls: every action is a pure function of the view the env served for that game, the game's
// number and MAKEFUN_TRIAL_SEED. Nothing is kept between decisions and nothing depends on the order the
// env lists decisions in, so the replay sends exactly the same requests.
//
// The village side keeps a small Bayesian model over every possible pair of werewolves, scored against
// seer claims and results, votes, accusations, defences and night kills. The werewolf side copies its
// partner's night pick, uses the doctor's "not the same seat twice" rule to land a kill on a protected
// seer, counter-claims seer when the real seer names it, buses a doomed partner and otherwise rides the
// village's own bandwagon onto villagers.

import { createHash } from 'node:crypto';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';

interface PlayerV {
  seat: Seat;
  name: string;
  alive: boolean;
  role: Role | null;
}
interface LogE {
  seq: number;
  day: number;
  kind: string;
  [k: string]: any;
}
export interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: Role; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: PlayerV[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat | null } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogE[];
  outcome: any;
}
export interface Pending {
  game: number;
  decision: string;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

const SEED = process.env.MAKEFUN_TRIAL_SEED ?? '0';
const MAX_CHARS = 500;

/** A number in [0, 1) from the trial seed and the parts given: the only randomness the agent uses. */
export function rnd(...parts: (string | number)[]): number {
  const d = createHash('sha256').update([SEED, ...parts].join('|')).digest();
  return d.readUInt32BE(0) / 4294967296;
}
function pick<T>(xs: readonly T[], ...parts: (string | number)[]): T {
  return xs[Math.floor(rnd(...parts) * xs.length) % xs.length]!;
}

// ------------------------------------------------------------------ reading statements

interface Mention {
  seat: Seat;
  idx: number;
}
interface SeerResult {
  target: Seat;
  wolf: boolean;
  day: number;
}
interface Claim {
  seat: Seat;
  day: number;
  seq: number;
  results: SeerResult[];
}
interface Speech {
  day: number;
  round: number;
  seat: Seat;
  text: string;
  seq: number;
}
interface Vote {
  day: number;
  seat: Seat;
  target: Seat | null;
  seq: number;
}
interface Edge {
  day: number;
  from: Seat;
  to: Seat;
  w: number;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every seat a text refers to, by "seat N", "player N", "#N" or by name, in order, near duplicates merged. */
export function mentionsIn(text: string, players: PlayerV[]): Mention[] {
  const raw: Mention[] = [];
  for (const m of text.matchAll(/\b(?:seat|player|seats)\s*#?\s*([1-8])\b/gi)) raw.push({ seat: Number(m[1]), idx: m.index! });
  for (const m of text.matchAll(/#([1-8])\b/g)) raw.push({ seat: Number(m[1]), idx: m.index! });
  for (const m of text.matchAll(/\(([1-8])\)/g)) raw.push({ seat: Number(m[1]), idx: m.index! });
  for (const p of players) {
    if (p.name.length < 2) continue;
    const re = new RegExp(`(?<![A-Za-z])${esc(p.name)}(?![A-Za-z])`, 'g');
    for (const m of text.matchAll(re)) raw.push({ seat: p.seat, idx: m.index! });
  }
  raw.sort((a, b) => a.idx - b.idx || a.seat - b.seat);
  const out: Mention[] = [];
  for (const m of raw) {
    const prev = out.length > 0 ? out[out.length - 1]! : null;
    if (prev !== null && prev.seat === m.seat && m.idx - prev.idx < 24) continue;
    out.push(m);
  }
  return out;
}

const SEER_CLAIM =
  /\b(?:i am|i'm|im|i’m|i was)\s+(?:actually\s+|really\s+|indeed\s+|in fact\s+)?(?:the\s+)?(?:real\s+|true\s+|actual\s+|genuine\s+)?seer\b|\bas (?:the|your) (?:real |true |actual )?seer\b|\bseer here\b|\bi(?:'m| am)? claim(?:ing)? (?:to be )?(?:the )?seer\b|\bi(?:'m| am) (?:coming out|revealing|outing myself) as (?:the )?seer\b/i;
const NOT_SEER = /\b(?:i am|i'm|im|i’m)\s+not\s+(?:the\s+)?seer\b|\bif i (?:were|was|am) (?:the )?seer\b|\bnot the seer\b/i;
const INSPECT =
  /\b(?:i|we)\s+(?:have\s+|just\s+|also\s+)?(?:inspected|checked|investigated|scanned|examined|peeked at|looked at)\b|\bmy (?:inspection|check|result|reading|vision|investigation)s?\b|\b(?:inspection|check|result)s?\s+(?:on|of)\b|\binspect(?:ed|ion)\b/i;
const DOCTOR_CLAIM = /\b(?:i am|i'm|im|i’m)\s+(?:actually\s+|really\s+)?(?:the\s+)?doctor\b|\bas the doctor\b/i;
const NOT_WOLF = /\b(?:not|isn['’]?t|is not|wasn['’]?t|was not|aren['’]?t|never|no)\s+(?:a\s+|the\s+|one of the\s+)?(?:were)?wol(?:f|ves)\b/i;
const AFFIRM_WOLF =
  /\b(?:is|are|was|=)\s+(?:a\s+|definitely\s+a\s+|confirmed\s+(?:as\s+)?(?:a\s+)?|one of the\s+)?(?:were)?wol(?:f|ves)\b|\bwerewolf\s*[!:]|\bWEREWOLF\b|\bWOLF\b|came back (?:as )?(?:a )?(?:were)?wolf|:\s*(?:a\s+)?(?:were)?wolf\b|[-—]\s*(?:a\s+)?(?:were)?wolf\b|found (?:a |the |our )?(?:were)?wolf/;
const CLEAN = /\b(?:innocent|cleared?|clean|good|safe|trustworthy|village[- ]aligned|on the village(?:'s)? side|town|a villager|not evil)\b|\b(?:is|are|was)\s+(?:on the\s+)?village\b/i;
const WOLFY = /\b(?:were)?wol(?:f|ves)\b|\bwerewolves\b/i;
const ACCUSE =
  /suspicious|suspect|\bsus\b|\bwol(?:f|ves)\b|werewol|\blying\b|\bliar\b|\blies\b|\bfake\b|\bvot(?:e|ing)\s+(?:for|to exile|out|against)?|\bexile\b|eliminate|\bevil\b|deflect|defensive|scum|odd|off about|don['’]?t trust|do not trust|distrust|don['’]?t believe|do not believe/gi;
const DEFEND = /\btrust\b|\binnocent\b|\bclear(?:ed)?\b|\bbelieve\b|not suspicious|\bconfirmed\b|\bprotect\b|\bcredible\b|\bon our side\b/i;
const DISTRUST = /don['’]?t trust|do not trust|distrust|don['’]?t believe|do not believe|not credible|lying|liar|fake/i;

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\s+(?:but|however|whereas|although|though)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resultPolarity(clause: string): boolean | null {
  if (NOT_WOLF.test(clause)) return false;
  if (AFFIRM_WOLF.test(clause)) return true;
  if (CLEAN.test(clause)) return false;
  if (WOLFY.test(clause)) return true;
  return null;
}

// ------------------------------------------------------------------ the game as read from a view

export interface An {
  v: View;
  game: number;
  me: Seat;
  role: Role;
  day: number;
  names: Map<Seat, string>;
  alive: Set<Seat>;
  revealed: Map<Seat, Role>;
  speeches: Speech[];
  votes: Vote[];
  exiles: { day: number; seat: Seat | null; role: Role | null }[];
  deaths: { day: number; seat: Seat; role: Role }[];
  quietDawns: number[];
  claims: Map<Seat, Claim>;
  doctorClaims: Set<Seat>;
  accus: Edge[];
  defs: Edge[];
}

export function analyze(v: View, game: number): An {
  const names = new Map<Seat, string>();
  const alive = new Set<Seat>();
  const revealed = new Map<Seat, Role>();
  for (const p of v.players) {
    names.set(p.seat, p.name);
    if (p.alive) alive.add(p.seat);
    if (p.role !== null) revealed.set(p.seat, p.role);
  }
  const an: An = {
    v,
    game,
    me: v.you.seat,
    role: v.you.role,
    day: v.day,
    names,
    alive,
    revealed,
    speeches: [],
    votes: [],
    exiles: [],
    deaths: [],
    quietDawns: [],
    claims: new Map(),
    doctorClaims: new Set(),
    accus: [],
    defs: [],
  };
  for (const e of v.log) {
    if (e.kind === 'speech') an.speeches.push({ day: e.day, round: e.round, seat: e.seat, text: String(e.text ?? ''), seq: e.seq });
    else if (e.kind === 'vote') an.votes.push({ day: e.day, seat: e.seat, target: e.target ?? null, seq: e.seq });
    else if (e.kind === 'exile') an.exiles.push({ day: e.day, seat: e.seat ?? null, role: e.role ?? null });
    else if (e.kind === 'dawn') {
      if (e.died === null || e.died === undefined) an.quietDawns.push(e.day);
      else an.deaths.push({ day: e.day, seat: e.died, role: e.role });
    }
  }
  for (const s of an.speeches) readSpeech(an, s);
  return an;
}

function readSpeech(an: An, s: Speech): void {
  const players = an.v.players;
  const text = s.text;
  const claimsSeer = SEER_CLAIM.test(text) && !NOT_SEER.test(text);
  const inspects = INSPECT.test(text) && !NOT_SEER.test(text) && !/\bseer\b[^.]{0,30}\b(?:should|could|must|needs?|might|will|can)\b/i.test(text);
  if ((claimsSeer || (inspects && an.claims.has(s.seat))) && !an.claims.has(s.seat)) {
    an.claims.set(s.seat, { seat: s.seat, day: s.day, seq: s.seq, results: [] });
  } else if (inspects && !an.claims.has(s.seat) && /\b(?:i|we)\s+(?:have\s+|just\s+)?(?:inspected|investigated)\b/i.test(text)) {
    an.claims.set(s.seat, { seat: s.seat, day: s.day, seq: s.seq, results: [] });
  }
  if (DOCTOR_CLAIM.test(text) && !/\bnot (?:the )?doctor\b/i.test(text)) an.doctorClaims.add(s.seat);
  const claim = an.claims.get(s.seat);
  let lastInspected: Seat | null = null;
  for (const c of clauses(text)) {
    const ms = mentionsIn(c, players).filter((m) => m.seat !== s.seat);
    if (ms.length === 0) {
      // "I inspected Uma last night. She is innocent.": the verdict follows in a sentence of its own.
      const pol = resultPolarity(c);
      if (claim !== undefined && lastInspected !== null && pol !== null && /\b(?:he|she|they|it|that player|the result)\b/i.test(c)) {
        if (!claim.results.some((r) => r.target === lastInspected)) claim.results.push({ target: lastInspected, wolf: pol, day: s.day });
        if (pol) an.accus.push({ day: s.day, from: s.seat, to: lastInspected, w: 2 });
        else an.defs.push({ day: s.day, from: s.seat, to: lastInspected, w: 1 });
        lastInspected = null;
      }
      continue;
    }
    if (claim !== undefined && INSPECT.test(c) && resultPolarity(c) === null) {
      const verb = c.search(INSPECT);
      lastInspected = (ms.find((m) => m.idx > verb) ?? ms[0]!).seat;
      continue;
    }
    // A seer result: the claimant names a seat with a verdict.
    if (claim !== undefined) {
      const pol = resultPolarity(c);
      const verb = c.search(INSPECT);
      const resulty = verb >= 0 || /\bnight\s*\d|\bresult|\bchecked|\binspected|\bcame back|\bconfirmed\b|[:—]/i.test(c) || claimsSeer;
      if (pol !== null && resulty) {
        const after = verb >= 0 ? ms.find((m) => m.idx > verb) : undefined;
        const target = (after ?? ms[0]!).seat;
        if (!claim.results.some((r) => r.target === target)) claim.results.push({ target, wolf: pol, day: s.day });
        if (pol) an.accus.push({ day: s.day, from: s.seat, to: target, w: 2 });
        else an.defs.push({ day: s.day, from: s.seat, to: target, w: 1 });
        continue;
      }
    }
    // An accusation or a defence: the seat nearest the keyword.
    const distrust = DISTRUST.test(c);
    const notWolf = NOT_WOLF.test(c);
    let kw = -1;
    ACCUSE.lastIndex = 0;
    const am = ACCUSE.exec(c);
    if (am !== null) kw = am.index;
    if (!distrust && (notWolf || (DEFEND.test(c) && kw < 0))) {
      const d = c.search(DEFEND);
      const m = nearest(ms, d >= 0 ? d : 0);
      an.defs.push({ day: s.day, from: s.seat, to: m.seat, w: 1 });
    } else if (kw >= 0 || distrust) {
      const m = nearest(ms, kw >= 0 ? kw : 0);
      const strong = /\bvot(?:e|ing)\b|\bexile\b|\bwerewolf\b|\bwolf\b/i.test(c);
      an.accus.push({ day: s.day, from: s.seat, to: m.seat, w: strong ? 1.5 : 1 });
    }
  }
}

function nearest(ms: Mention[], at: number): Mention {
  let best = ms[0]!;
  for (const m of ms) if (Math.abs(m.idx - at) < Math.abs(best.idx - at)) best = m;
  return best;
}

// ------------------------------------------------------------------ the wolf-pair model

/**
 * P(seat is a werewolf) for every seat, by enumerating every pair (or single) of living werewolves the hard
 * facts allow and weighing each against the public record. `self` true reads it as the agent's own seat
 * would (its role and, for the seer, its results); false reads it as an outsider with only public facts.
 */
export function wolfProbs(an: An, self: boolean): Map<Seat, number> {
  const known = new Map<Seat, boolean>();
  for (const [s, r] of an.revealed) known.set(s, r === 'werewolf');
  if (self && an.role !== 'werewolf') {
    known.set(an.me, false);
    for (const r of an.v.seerResults ?? []) known.set(r.seat, r.werewolf);
  }
  if (self && an.role === 'werewolf') {
    for (const s of an.names.keys()) known.set(s, s === an.me || s === an.v.you.partner?.seat);
  }
  const knownWolves = [...known].filter(([, w]) => w).map(([s]) => s);
  const left = 2 - knownWolves.length;
  const unknown = [...an.alive].filter((s) => !known.has(s)).sort((a, b) => a - b);
  const hyps: Seat[][] = [];
  if (left <= 0) hyps.push([]);
  else if (left === 1) for (const a of unknown) hyps.push([a]);
  else for (let i = 0; i < unknown.length; i++) for (let j = i + 1; j < unknown.length; j++) hyps.push([unknown[i]!, unknown[j]!]);
  const p = new Map<Seat, number>();
  for (const s of an.names.keys()) p.set(s, known.has(s) ? (known.get(s) ? 1 : 0) : 0);
  if (hyps.length === 0) {
    for (const s of unknown) p.set(s, Math.max(0, left) / Math.max(1, unknown.length));
    return p;
  }
  let total = 0;
  const mass = new Map<Seat, number>();
  for (const h of hyps) {
    const W = new Set<Seat>([...knownWolves, ...h]);
    const l = likelihood(an, W, self);
    total += l;
    for (const s of h) mass.set(s, (mass.get(s) ?? 0) + l);
  }
  for (const s of unknown) p.set(s, total > 0 ? (mass.get(s) ?? 0) / total : left / unknown.length);
  return p;
}

function likelihood(an: An, W: Set<Seat>, self: boolean): number {
  let l = 1;
  const deadSeer = [...an.revealed].some(([, r]) => r === 'seer');
  let liveVillageClaimants = 0;
  for (const c of an.claims.values()) {
    if (self && c.seat === an.me) continue;
    const r = an.revealed.get(c.seat);
    if (r === 'seer') {
      for (const x of c.results) l *= W.has(x.target) === x.wolf ? 1 : 0.02;
      continue;
    }
    if (r === 'werewolf') {
      for (const x of c.results) if (x.wolf && W.has(x.target)) l *= 0.3;
      continue;
    }
    if (r !== undefined) continue; // a dead villager or doctor who bluffed
    if (W.has(c.seat)) {
      for (const x of c.results) {
        if (x.wolf && W.has(x.target)) l *= 0.2;
        if (!x.wolf && W.has(x.target)) l *= 1.3;
      }
    } else {
      liveVillageClaimants += 1;
      for (const x of c.results) if (W.has(x.target) !== x.wolf) l *= 0.05;
      if (deadSeer) l *= 0.15;
      if (self && an.role === 'seer') l *= 0.01;
    }
  }
  if (liveVillageClaimants >= 2) l *= Math.pow(0.15, liveVillageClaimants - 1);
  // A lone, uncontested seer claim is more often the real seer than a wolf's bluff.
  const live = [...an.claims.keys()].filter((s) => !an.revealed.has(s) && !(self && s === an.me));
  if (live.length === 1 && !deadSeer && W.has(live[0]!)) l *= 0.5;
  for (const v of an.votes) {
    if (v.target === null) continue;
    if (W.has(v.seat) && W.has(v.target)) l *= 0.3;
    else if (W.has(v.seat) && an.revealed.has(v.target) && an.revealed.get(v.target) !== 'werewolf') l *= 1.25;
  }
  for (const a of an.accus) {
    if (W.has(a.from) && W.has(a.to)) l *= Math.pow(0.75, a.w);
  }
  for (const d of an.defs) {
    if (W.has(d.from) && W.has(d.to)) l *= 1.35;
  }
  for (const d of an.deaths) {
    let n = 0;
    for (const a of an.accus) if (a.from === d.seat && W.has(a.to) && n < 2) {
      l *= 1.25;
      n += 1;
    }
  }
  return l;
}

// ------------------------------------------------------------------ shared helpers

const who = (an: An, s: Seat): string => `seat ${s} (${an.names.get(s) ?? '?'})`;

function tallyToday(an: An): Map<Seat, number> {
  const t = new Map<Seat, number>();
  for (const v of an.votes) if (v.day === an.day && v.target !== null) t.set(v.target, (t.get(v.target) ?? 0) + 1);
  return t;
}

/** The seats still to vote after the agent today, in order. */
function votersAfterMe(an: An): Seat[] {
  let order: Seat[] = [];
  for (const e of an.v.log) if (e.kind === 'voting' && e.day === an.day) order = (e.order as Seat[]) ?? [];
  const voted = new Set(an.votes.filter((v) => v.day === an.day).map((v) => v.seat));
  const i = order.indexOf(an.me);
  return order.slice(i + 1).filter((s) => an.alive.has(s) && !voted.has(s));
}

function argmax(xs: Seat[], score: (s: Seat) => number, an: An, tag: string): Seat | null {
  let best: Seat | null = null;
  let bs = -Infinity;
  for (const s of xs) {
    const sc = score(s) + rnd(an.game, an.day, tag, s) * 1e-6;
    if (sc > bs) {
      bs = sc;
      best = s;
    }
  }
  return best;
}

function fit(text: string, max: number): string {
  const folded = text.replace(/[\t\n\v\f\r]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...folded];
  if (chars.length <= max) return folded;
  const head = chars.slice(0, max).join('');
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '));
  return (cut > max / 3 ? head.slice(0, cut + 1) : head.slice(0, head.lastIndexOf(' '))).trim();
}

/** Reasons the public record gives to suspect a seat, most telling first. */
function reasonsAgainst(an: An, t: Seat): string[] {
  const out: string[] = [];
  for (const c of an.claims.values()) {
    if (c.seat === t) continue;
    for (const r of c.results) if (r.target === t && r.wolf) out.push(`${who(an, c.seat)}'s seer check named them a werewolf`);
  }
  const deadWolves = [...an.revealed].filter(([, r]) => r === 'werewolf').map(([s]) => s);
  for (const w of deadWolves) {
    if (an.defs.some((d) => d.from === t && d.to === w)) out.push(`they defended ${who(an, w)}, who turned out to be a werewolf`);
    const ex = an.exiles.find((e) => e.seat === w);
    if (ex !== undefined && an.votes.some((v) => v.day === ex.day && v.seat === t && v.target !== w)) out.push(`they voted to save ${who(an, w)}, a werewolf`);
  }
  for (const e of an.exiles) {
    if (e.seat === null || e.role === 'werewolf') continue;
    if (an.votes.some((v) => v.day === e.day && v.seat === t && v.target === e.seat)) out.push(`they pushed the exile of ${who(an, e.seat)}, who was an innocent ${e.role}`);
  }
  for (const d of an.deaths) {
    if (an.accus.some((a) => a.from === d.seat && a.to === t)) out.push(`${who(an, d.seat)} suspected them and was killed that night`);
  }
  if (an.claims.has(t) && [...an.claims.keys()].filter((s) => s !== t && !an.revealed.has(s)).length > 0) out.push('their seer claim is contested, and only one seer exists');
  return out;
}

// ------------------------------------------------------------------ the village side

function believedClaimant(an: An, p: Map<Seat, number>): Seat | null {
  let best: Seat | null = null;
  let bp = 0.35;
  for (const c of an.claims.values()) {
    if (c.seat === an.me || !an.alive.has(c.seat)) continue;
    const q = p.get(c.seat) ?? 1;
    if (q < bp) {
      bp = q;
      best = c.seat;
    }
  }
  return best;
}

function villageVote(an: An, options: Seat[]): Seat | null {
  const p = wolfProbs(an, true);
  const opts = options.filter((s) => s !== an.me);
  if (opts.length === 0) return null;
  const best = argmax(opts, (s) => p.get(s) ?? 0, an, 'vv')!;
  const pb = p.get(best) ?? 0;
  if (pb >= 0.55) return best;
  const t = tallyToday(an);
  const leader = argmax(
    opts.filter((s) => (t.get(s) ?? 0) > 0),
    (s) => (t.get(s) ?? 0) * 10 + (p.get(s) ?? 0),
    an,
    'vl',
  );
  if (leader !== null && leader !== best) {
    const pl = p.get(leader) ?? 0;
    if (pl >= 0.6 * pb && pl >= 0.18) return leader;
  }
  return best;
}

function seerShouldReveal(an: An): boolean {
  const res = an.v.seerResults ?? [];
  if (an.claims.has(an.me)) return true;
  if (res.some((r) => r.werewolf && an.alive.has(r.seat))) return true;
  if ([...an.claims.keys()].some((s) => s !== an.me && an.alive.has(s))) return true;
  if (an.day >= 2 && res.length > 0) return true;
  const pressure = an.accus.filter((a) => a.to === an.me && a.day === an.day).reduce((x, a) => x + a.w, 0);
  if (pressure >= 2 && res.length > 0) return true;
  return false;
}

function seerSpeech(an: An, round: number): string {
  const res = an.v.seerResults ?? [];
  const p = wolfProbs(an, true);
  const parts: string[] = [];
  const liveWolves = res.filter((r) => r.werewolf && an.alive.has(r.seat)).map((r) => r.seat);
  const fakes = [...an.claims.keys()].filter((s) => s !== an.me && an.alive.has(s));
  parts.push(round === 1 || !an.claims.has(an.me) ? 'I am the seer.' : 'Again: I am the real seer.');
  if (res.length > 0) {
    parts.push(
      res
        .map((r) => `Night ${r.night}: ${who(an, r.seat)} is ${r.werewolf ? 'a WEREWOLF' : 'NOT a werewolf'}${an.alive.has(r.seat) ? '' : ' (now dead)'}.`)
        .join(' '),
    );
  }
  for (const f of fakes) {
    if (!liveWolves.includes(f)) parts.push(`${who(an, f)} is falsely claiming seer, so ${who(an, f)} is a werewolf.`);
  }
  const targets = [...new Set([...liveWolves, ...fakes])];
  if (targets.length > 0) {
    const t = argmax(targets, (s) => (liveWolves.includes(s) ? 2 : 1) + (p.get(s) ?? 0), an, 'st')!;
    parts.push(`Vote out ${who(an, t)} today, everyone, together.`);
    if (round === 1) parts.push('Doctor, please protect me tonight.');
  } else {
    const t = argmax([...an.alive].filter((s) => s !== an.me && !res.some((r) => r.seat === s)), (s) => p.get(s) ?? 0, an, 'st2');
    if (t !== null) parts.push(`My strongest suspicion among the rest is ${who(an, t)}. Trust the seats I cleared.`);
  }
  return parts.join(' ');
}

function villageSpeech(an: An, round: number): string {
  if (an.role === 'seer' && seerShouldReveal(an)) return seerSpeech(an, round);
  const p = wolfProbs(an, true);
  const others = [...an.alive].filter((s) => s !== an.me);
  const t = argmax(others, (s) => p.get(s) ?? 0, an, 'vs');
  const pt = t === null ? 0 : p.get(t) ?? 0;
  const bc = believedClaimant(an, p);
  const liveClaims = [...an.claims.keys()].filter((s) => s !== an.me && an.alive.has(s));
  const parts: string[] = [];
  if (an.day === 1 && round === 1 && an.speeches.filter((s) => s.day === 1).length < 2 && liveClaims.length === 0) {
    parts.push(
      pick(
        [
          'Good morning. I have no night information, so I will judge by claims and votes.',
          'No information from the night on my side. Words are cheap; votes are what I will hold people to.',
          'I am a plain villager with nothing from the night.',
        ],
        an.game,
        'open',
      ),
    );
    parts.push('Seer, if you found a werewolf, say it now with your exact result so we can act on it today.');
    if (t !== null && pt > 0.3) parts.push(`So far ${who(an, t)} worries me most.`);
    return parts.join(' ');
  }
  if (liveClaims.length >= 2) {
    const fake = argmax(liveClaims, (s) => p.get(s) ?? 0, an, 'fk')!;
    const real = liveClaims.find((s) => s !== fake);
    parts.push(`There are ${liveClaims.length} seer claims and only one seer, so a werewolf is lying.`);
    if (real !== undefined && (p.get(fake) ?? 0) > (p.get(real) ?? 0) + 0.1) parts.push(`I believe ${who(an, real)}; ${who(an, fake)} is the liar.`);
  } else if (bc !== null) {
    parts.push(`I believe ${who(an, bc)}'s seer claim and I will follow their results.`);
  }
  if (t !== null && pt >= 0.2) {
    const why = reasonsAgainst(an, t);
    parts.push(`My vote is on ${who(an, t)}${why.length > 0 ? `: ${why.slice(0, 2).join(', and ')}` : ''}.`);
    if (round === 2) parts.push(`Let us not split the vote; split votes only help the wolves.`);
  } else {
    parts.push('Nobody stands out clearly yet. I will vote where the evidence is strongest and not split the village.');
  }
  return parts.join(' ');
}

function protect(an: An, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const p = wolfProbs(an, true);
  const bc = believedClaimant(an, p);
  if (bc !== null && options.includes(bc)) return bc;
  // Otherwise guess the wolves' victim: a trusted seat that has been naming likely wolves.
  return argmax(
    options,
    (s) => {
      const q = p.get(s) ?? 0.3;
      let threat = 0;
      for (const a of an.accus) if (a.from === s) threat += a.w * (p.get(a.to) ?? 0);
      if (an.doctorClaims.has(s)) threat += 0.5;
      return (1 - q) * (1 + threat);
    },
    an,
    'pr',
  );
}

function inspect(an: An, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const p = wolfProbs(an, true);
  const done = new Set((an.v.seerResults ?? []).map((r) => r.seat));
  const fresh = options.filter((s) => !done.has(s) && (p.get(s) ?? 0) < 0.95);
  const pool = fresh.length > 0 ? fresh : options;
  return argmax(pool, (s) => (p.get(s) ?? 0) + 0.15 * rnd(an.game, an.day, 'ins', s), an, 'in');
}

// ------------------------------------------------------------------ the werewolf side

interface WolfCtx {
  partner: Seat | null;
  wolves: Set<Seat>;
  ps: Map<Seat, number>;
  /** Living seer claimants that are not wolves: the real seer, or a bluffer. */
  realClaims: Seat[];
  /** Real claimants who named a wolf as a werewolf. */
  hunters: Seat[];
  myClaim: Claim | undefined;
}

function wolfCtx(an: An): WolfCtx {
  const partner = an.v.you.partner?.seat ?? null;
  const wolves = new Set<Seat>([an.me, ...(partner === null ? [] : [partner])]);
  const ps = wolfProbs(an, false);
  const realClaims = [...an.claims.keys()].filter((s) => !wolves.has(s) && an.alive.has(s));
  const hunters = realClaims.filter((s) => an.claims.get(s)!.results.some((r) => r.wolf && wolves.has(r.target)));
  return { partner, wolves, ps, realClaims, hunters, myClaim: an.claims.get(an.me) };
}

/**
 * Bus mode: one uncontested seer claim has named the partner (not the agent), and neither wolf has
 * claimed seer. Defending the partner would only tie the agent to them, so the agent sides with the seer.
 */
function busPartner(an: An, w: WolfCtx): boolean {
  const p = w.partner;
  if (p === null || !an.alive.has(p) || w.myClaim !== undefined || an.claims.has(p)) return false;
  if (w.realClaims.length !== 1) return false;
  const c = an.claims.get(w.realClaims[0]!)!;
  return c.results.some((r) => r.wolf && r.target === p) && !c.results.some((r) => r.wolf && r.target === an.me);
}

function kill(an: An, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const w = wolfCtx(an);
  const votes = an.v.wolfVotes ?? [];
  const pv = votes.find((x) => x.night === an.day && x.seat === w.partner);
  if (pv !== undefined && pv.target !== null && options.includes(pv.target)) return pv.target;
  const lastNight = votes.filter((x) => x.night === an.day - 1 && x.target !== null);
  const lastTarget = lastNight.length > 0 && lastNight.every((x) => x.target === lastNight[0]!.target) ? lastNight[0]!.target : null;
  const quietLast = an.quietDawns.includes(an.day);
  const doctorDead = [...an.revealed.values()].includes('doctor');
  const villagers = options.filter((s) => !w.wolves.has(s));
  const pool = villagers.length > 0 ? villagers : options;
  const topSuspect = argmax(pool, (s) => w.ps.get(s) ?? 0, an, 'ts');
  const framed = new Set((w.myClaim?.results ?? []).filter((r) => r.wolf).map((r) => r.target));
  return argmax(
    pool,
    (s) => {
      let sc = 1 + rnd(an.game, an.day, 'kill', s);
      const claim = an.claims.get(s);
      if (claim !== undefined && w.realClaims.includes(s)) {
        const fresh = claim.day === an.day - 1 && !doctorDead && lastTarget !== s;
        sc += fresh && !w.hunters.includes(s) ? 4 : 10;
      }
      if (lastTarget === s && quietLast) sc += 12;
      if (an.doctorClaims.has(s)) sc += 6;
      for (const a of an.accus) if (a.from === s && w.wolves.has(a.to)) sc += a.w * (a.day === an.day - 1 ? 1.5 : 1);
      sc += 1.5 * (1 - (w.ps.get(s) ?? 0.3));
      if (s === topSuspect && (w.ps.get(s) ?? 0) > 0.35) sc -= 4;
      if (framed.has(s)) sc -= 20;
      return sc;
    },
    an,
    'k',
  );
}

/** The villager the wolves should push today: the village's own top suspect, or the seer who named a wolf. */
function wolfTarget(an: An, w: WolfCtx): Seat | null {
  const villagers = [...an.alive].filter((s) => !w.wolves.has(s));
  if (villagers.length === 0) return null;
  const myTargets = (w.myClaim?.results ?? []).filter((r) => r.wolf && an.alive.has(r.target)).map((r) => r.target);
  if (myTargets.length > 0) return myTargets[myTargets.length - 1]!;
  return argmax(villagers, (s) => (w.ps.get(s) ?? 0) + (w.hunters.includes(s) ? 0.35 : 0) + (an.claims.has(s) ? -0.15 : 0), an, 'wt');
}

function wolfVote(an: An, options: Seat[]): Seat | null {
  const w = wolfCtx(an);
  const opts = options.filter((s) => s !== an.me);
  if (opts.length === 0) return null;
  const t = tallyToday(an);
  const after = votersAfterMe(an).length;
  const villagers = opts.filter((s) => !w.wolves.has(s));
  const maxOf = (pred: (s: Seat) => boolean): number => Math.max(0, ...[...t].filter(([s]) => pred(s)).map(([, n]) => n));
  const partner = w.partner !== null && an.alive.has(w.partner) && opts.includes(w.partner) ? w.partner : null;
  if (partner !== null && busPartner(an, w)) return partner;
  if (partner !== null) {
    const pv = t.get(partner) ?? 0;
    const other = maxOf((s) => s !== partner);
    if (pv - other > after + 1) return partner; // doomed: bus them and look clean
    if (pv > 0 && pv >= other) {
      const save = argmax(villagers, (s) => (t.get(s) ?? 0) * 10 + (w.ps.get(s) ?? 0), an, 'save');
      if (save !== null) return save;
    }
  }
  const mine = t.get(an.me) ?? 0;
  if (mine > 0 && mine >= maxOf((s) => s !== an.me)) {
    const save = argmax(villagers, (s) => (t.get(s) ?? 0) * 10 + (w.ps.get(s) ?? 0), an, 'save2');
    if (save !== null) return save;
  }
  if (villagers.length === 0) return null;
  const hunter = w.hunters.find((s) => villagers.includes(s));
  if (hunter !== undefined) return hunter;
  const target = wolfTarget(an, w);
  const leader = argmax(
    villagers.filter((s) => (t.get(s) ?? 0) > 0),
    (s) => (t.get(s) ?? 0) * 10 + (w.ps.get(s) ?? 0),
    an,
    'wl',
  );
  if (leader !== null && (target === null || (t.get(leader) ?? 0) >= (t.get(target) ?? 0))) return leader;
  return target ?? villagers[0]!;
}

/** The fake seer results the agent has announced, plus a fresh one for each night since. */
function fakeResults(an: An, w: WolfCtx, accuse: Seat | null): { night: number; seat: Seat; wolf: boolean }[] {
  const out: { night: number; seat: Seat; wolf: boolean }[] = [];
  const said = w.myClaim?.results ?? [];
  let night = 1;
  for (const r of said) out.push({ night: night++, seat: r.target, wolf: r.wolf });
  const used = new Set(out.map((r) => r.seat));
  while (night <= an.day) {
    let seat: Seat | null = null;
    let wolf = false;
    if (accuse !== null && !used.has(accuse) && night === an.day) {
      seat = accuse;
      wolf = true;
    } else {
      const pool = [...an.names.keys()].filter((s) => !w.wolves.has(s) && !used.has(s) && !w.realClaims.includes(s) && s !== accuse);
      // Clear a villager the village already trusts: a clear is never disproved by a villager's death.
      seat = argmax(pool, (s) => (an.alive.has(s) ? 1 : 0) - (w.ps.get(s) ?? 0), an, `fr${night}`);
    }
    if (seat === null) break;
    used.add(seat);
    out.push({ night: night++, seat, wolf });
  }
  return out;
}

function wolfSpeech(an: An, round: number): string {
  const w = wolfCtx(an);
  const partnerClaimed = w.partner !== null && an.claims.has(w.partner);
  const huntsMe = w.hunters.filter((s) => an.claims.get(s)!.results.some((r) => r.wolf && r.target === an.me));
  const parts: string[] = [];
  if (w.myClaim !== undefined || (huntsMe.length > 0 && !partnerClaimed)) {
    // The counter-claim: I am the seer and my accuser is the werewolf.
    const accuser = huntsMe[0] ?? w.realClaims.find((s) => an.alive.has(s)) ?? null;
    const res = fakeResults(an, w, w.myClaim === undefined ? accuser : null);
    parts.push(w.myClaim === undefined ? 'I am the real seer, and I have to come out now.' : 'I repeat: I am the real seer.');
    parts.push(res.map((r) => `Night ${r.night}: ${who(an, r.seat)} is ${r.wolf ? 'a WEREWOLF' : 'NOT a werewolf'}.`).join(' '));
    const target = res.filter((r) => r.wolf && an.alive.has(r.seat)).map((r) => r.seat)[0] ?? accuser;
    if (target !== null && an.alive.has(target)) {
      parts.push(`${who(an, target)} is a werewolf faking the seer role to get the real seer exiled. Vote out ${who(an, target)} today.`);
    }
    return parts.join(' ');
  }
  if (busPartner(an, w)) {
    const c = w.realClaims[0]!;
    parts.push(`I believe ${who(an, c)}'s seer claim: nobody has contested it.`);
    parts.push(`That makes ${who(an, w.partner!)} our werewolf today. I am voting ${who(an, w.partner!)}, and I ask everyone to do the same so we do not split.`);
    return parts.join(' ');
  }
  const target = wolfTarget(an, w);
  if (an.day === 1 && round === 1 && w.realClaims.length === 0) {
    parts.push(
      pick(
        [
          'Morning. I am a villager with nothing from the night, so I will go by claims and votes.',
          'Nothing from the night on my side; I am just a villager.',
          'I have no night information. I want to hear every seat explain itself before the vote.',
        ],
        an.game,
        'wopen',
      ),
    );
    parts.push('Seer, if you have a result, share it.');
    if (target !== null && (w.ps.get(target) ?? 0) > 0.3) parts.push(`So far ${who(an, target)} is the one I am watching.`);
    return parts.join(' ');
  }
  const bc = w.realClaims.length === 1 ? w.realClaims[0]! : null;
  if (bc !== null && !w.hunters.includes(bc)) parts.push(`${who(an, bc)}'s claim fits what I see so far.`);
  if (w.hunters.length > 0 && target !== null && w.hunters.includes(target)) {
    parts.push(`I do not buy ${who(an, target)}'s seer claim. A wolf can claim seer and name anyone, and nobody has confirmed it.`);
  }
  if (target !== null) {
    const why = reasonsAgainst(an, target);
    parts.push(`My vote is on ${who(an, target)}${why.length > 0 ? `: ${why.slice(0, 2).join(', and ')}` : ''}.`);
  }
  if (round === 2) parts.push('Let us not split the vote; that only helps the wolves.');
  return parts.join(' ');
}

// ------------------------------------------------------------------ deciding

export function decide(p: Pending): Record<string, unknown> {
  const an = analyze(p.view, p.game);
  const options = p.options ?? [];
  const wolf = an.role === 'werewolf';
  switch (p.decision) {
    case 'speak': {
      const round = 1 + an.speeches.filter((s) => s.day === an.day && s.seat === an.me).length;
      const text = fit(wolf ? wolfSpeech(an, round) : villageSpeech(an, round), Math.min(MAX_CHARS, p.max_chars ?? MAX_CHARS));
      return text.length > 0 ? { game: p.game, decision: 'speak', text } : { game: p.game, decision: 'speak', pass: true };
    }
    case 'vote':
      return { game: p.game, decision: 'vote', target: safe(wolf ? wolfVote(an, options) : villageVote(an, options), options) };
    case 'kill':
      return { game: p.game, decision: 'kill', target: safe(kill(an, options), options) };
    case 'protect':
      return { game: p.game, decision: 'protect', target: safe(protect(an, options), options) };
    case 'inspect':
      return { game: p.game, decision: 'inspect', target: safe(inspect(an, options), options) };
    default:
      return fallbackFor(p);
  }
}

function safe(s: Seat | null, options: Seat[]): Seat | null {
  return s !== null && options.includes(s) ? s : null;
}

function fallbackFor(p: Pending): Record<string, unknown> {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

// ------------------------------------------------------------------ the env loop

const ENV = (process.env.MAKEFUN_ENV_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${ENV}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (err) {
      if (attempt >= 60) throw err;
      await sleep(500);
    }
  }
}

async function handle(p: Pending): Promise<void> {
  let act: Record<string, unknown>;
  try {
    act = decide(p);
  } catch {
    act = fallbackFor(p);
  }
  const r = await post('/act', act);
  if (r.status === 400) await post('/act', fallbackFor(p));
}

async function main(): Promise<void> {
  let failures = 0;
  for (;;) {
    let r: { status: number; json: any };
    try {
      r = await post('/observe', {});
    } catch {
      return;
    }
    if (r.status !== 200 || r.json === null || typeof r.json !== 'object') {
      failures += 1;
      if (failures > 200) return;
      await sleep(250);
      continue;
    }
    failures = 0;
    const pending: Pending[] = Array.isArray(r.json.pending) ? r.json.pending : [];
    for (const p of pending) await handle(p);
    if (r.json.done === true) return;
  }
}

if (process.argv[1] !== undefined && /main\.ts$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
