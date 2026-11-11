// Print one game of a local trial as readable lines.
// Usage: node sim/show.mjs <games.json> <game number>
import { readFileSync } from 'node:fs';

const games = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const n = Number(process.argv[3] ?? 1);
const v = games[n - 1].view ?? games[n - 1];
const name = (s) => `${s}:${v.players.find((p) => p.seat === s)?.name}`;
console.log(`game ${n}: me ${name(v.you.seat)} ${v.you.role}${v.you.partner ? ` partner ${name(v.you.partner.seat)}` : ''}`);
console.log(v.players.map((p) => `${name(p.seat)}=${p.role ?? '?'}`).join(' '));
for (const e of v.log) {
  const mark = e.seat === v.you.seat ? '>>' : '  ';
  if (e.kind === 'speech') console.log(`${mark} d${e.day}r${e.round} ${name(e.seat)}: ${e.text}`);
  else if (e.kind === 'vote') console.log(`${mark} d${e.day} vote ${name(e.seat)} -> ${e.target === null ? '-' : name(e.target)}`);
  else if (e.kind === 'dawn') console.log(`== day ${e.day} dawn: ${e.died === null ? 'no death' : `${name(e.died)} died (${e.role})`}`);
  else if (e.kind === 'exile') console.log(`== exile: ${e.seat === null ? 'nobody' : `${name(e.seat)} (${e.role})`}`);
  else if (e.kind === 'end') console.log(`== end: ${e.winner} (${e.reason})`);
}
console.log('private:', JSON.stringify({ seer: v.seerResults, protect: v.lastProtect, wolf: v.wolfVotes }));
