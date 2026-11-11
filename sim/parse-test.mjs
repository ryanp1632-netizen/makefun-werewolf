// Checks the statement reader on phrasings a language model is likely to use. Usage: node sim/parse-test.mjs
import { analyze } from '../main.ts';

const players = ['Oskar', 'Sena', 'Tariq', 'Jonas', 'Niko', 'Dmitri', 'Uma', 'Wren'].map((name, i) => ({ seat: i + 1, name, alive: true, role: null }));
const cases = [
  ['I am the Seer. Last night I inspected Tariq (seat 3) and he IS a werewolf. Vote him out.', { claim: true, res: [[3, true]] }],
  ["I'm the seer: seat 4 (Jonas) came back clean.", { claim: true, res: [[4, false]] }],
  ['Coming clean: I am the seer. I checked Niko and Niko is not a werewolf.', { claim: true, res: [[5, false]] }],
  ['I need to reveal - I am the seer. Night 1 result: Dmitri is a werewolf!', { claim: true, res: [[6, true]] }],
  ['As the seer, I investigated seat 7 (Uma) last night. She is innocent.', { claim: true, res: [[7, false]] }],
  ['Seer here. Wren = wolf.', { claim: true, res: [[8, true]] }],
  ["The seer should come forward. I'm a villager and I suspect Tariq.", { claim: false, acc: [[3]] }],
  ["I'm not the seer, but Jonas voting for Oskar looks suspicious to me.", { claim: false }],
  ['I trust Sena; she has been consistent. Tariq is deflecting.', { claim: false }],
  ['If I were the seer I would reveal now. I am voting for Niko.', { claim: false, acc: [[5]] }],
];
let bad = 0;
for (const [text, want] of cases) {
  const view = { day: 1, phase: 'debate', you: { seat: 2, name: 'Sena', role: 'villager', alive: true, partner: null }, players, seerResults: null, lastProtect: null, wolfVotes: null, log: [{ seq: 1, day: 1, kind: 'speech', seat: 1, round: 1, text }], outcome: null };
  const an = analyze(view, 1);
  const c = an.claims.get(1);
  const res = (c?.results ?? []).map((r) => [r.target, r.wolf]);
  const ok = !!c === want.claim && (want.res === undefined || JSON.stringify(res) === JSON.stringify(want.res));
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', text, '=>', JSON.stringify({ claim: !!c, res, acc: an.accus.map((a) => a.to), def: an.defs.map((d) => d.to) }));
}
process.exitCode = bad > 0 ? 1 : 0;
