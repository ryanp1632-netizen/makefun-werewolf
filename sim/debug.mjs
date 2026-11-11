// Show what the agent reads from a game at a point in its log: claims, accusations and wolf probabilities.
// Usage: node sim/debug.mjs <games.json> <game> [log seq to cut at]
import { readFileSync } from 'node:fs';
import { analyze, wolfProbs } from '../main.ts';

const games = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const n = Number(process.argv[3]);
const cut = Number(process.argv[4] ?? 1e9);
const v = structuredClone(games[n - 1].view ?? games[n - 1]);
v.log = v.log.filter((e) => e.seq <= cut);
const last = v.log[v.log.length - 1];
v.day = last.day;
// Roles revealed after the cut are hidden again.
const seen = new Set(v.log.flatMap((e) => (e.kind === 'dawn' && e.died != null ? [e.died] : e.kind === 'exile' && e.seat != null ? [e.seat] : [])));
for (const p of v.players) if (!seen.has(p.seat)) {
  p.role = null;
  p.alive = true;
}
const an = analyze(v, n);
console.log('claims', JSON.stringify([...an.claims.values()]));
console.log('accus', an.accus.map((a) => `${a.day}:${a.from}->${a.to}(${a.w})`).join(' '));
console.log('defs', an.defs.map((a) => `${a.day}:${a.from}->${a.to}`).join(' '));
const fmt = (m) => [...m].map(([s, p]) => `${s}:${p.toFixed(2)}`).join(' ');
console.log('self  ', fmt(wolfProbs(an, true)));
console.log('public', fmt(wolfProbs(an, false)));
