// Local trials against the kit's real env (program/env/server.mjs) with the mock house players.
// Usage: node sim/run.mjs --kit <unpacked kit dir> [--trials 3] [--seed 1] [--practice] [--agent main.ts]
// Each trial draws a fresh 30-game table from the seed (or uses the kit's practice trial-0 table with
// --practice), runs the agent to the end and prints its wolf and village win rates.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const kit = resolve(opt('--kit', ''));
const trials = Number(opt('--trials', 3));
const seed0 = Number(opt('--seed', 1));
const agent = resolve(opt('--agent', 'main.ts'));
const practice = args.includes('--practice');
const verbose = args.includes('--verbose');
const out = resolve('sim/out');
mkdirSync(out, { recursive: true });

const NAMES = 'Oskar Sena Tariq Jonas Niko Dmitri Uma Wren Lior Lena Quinn Yusuf Olu Soren Yara Nadia Rosa Ines Vera Bram Elif Greta Luca Farid Arjun Priya Zoe Mira Hugo Ada'.split(' ');
let rs = 1;
const rnd = () => {
  rs = (rs * 1103515245 + 12345) & 0x7fffffff;
  return rs / 0x80000000;
};
const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

function drawTable(seed) {
  rs = seed * 7919 + 17;
  const sched = shuffle([...Array(15).fill('werewolf'), ...Array(5).fill('seer'), ...Array(5).fill('doctor'), ...Array(5).fill('villager')]);
  let tag = 0;
  const games = sched.map((role, i) => {
    const entry = 1 + Math.floor(rnd() * 8);
    const rest = shuffle(['werewolf', 'werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager', 'villager']);
    rest.splice(rest.indexOf(role), 1);
    const roles = [];
    for (let s = 1; s <= 8; s++) roles.push(s === entry ? role : rest.shift());
    const names = shuffle([...NAMES]).slice(0, 8);
    const personas = roles.map((_, k) => (k + 1 === entry ? null : (++tag).toString(16).padStart(8, '0')));
    return { game: i + 1, entry, roles, names, start: 1 + Math.floor(rnd() * 8), personas };
  });
  return {
    schema: 'werewolf-agent-01/table/v1',
    tables_at_once: 10,
    house: { model: 'claude-haiku-5-5', max_tokens: 1024, reasoning_effort: 'low' },
    games,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function trial(t) {
  const seed = seed0 + t;
  const dir = join(out, `trial-${seed}`);
  const data = join(dir, 'env');
  mkdirSync(data, { recursive: true });
  const table = practice ? JSON.parse(readFileSync(join(kit, 'practice/trial-0/input/env/table.json'), 'utf8')) : drawTable(seed);
  writeFileSync(join(data, 'table.json'), JSON.stringify(table));
  const mockPort = 18000 + (seed % 1000);
  const envPort = 19000 + (seed % 1000);
  const mock = spawn(process.execPath, [resolve('sim/mock-house.mjs'), String(mockPort), String(seed)], { stdio: 'ignore' });
  const state = join(dir, 'state');
  const env = spawn(process.execPath, [join(kit, 'program/env/server.mjs')], {
    env: { ...process.env, MAKEFUN_STATE_DIR: state, MAKEFUN_ENV_DATA_DIR: data, MAKEFUN_ENV_PORT: String(envPort), MAKEFUN_HOUSE_LLM_URL: `http://127.0.0.1:${mockPort}`, MAKEFUN_HOUSE_TOKEN: 'mock' },
    stdio: verbose ? 'inherit' : 'ignore',
  });
  for (let i = 0; i < 100 && !existsSync(join(state, 'ready')); i++) await sleep(100);
  const url = `http://127.0.0.1:${envPort}`;
  const t0 = Date.now();
  const bot = spawn(process.execPath, [agent], { env: { ...process.env, MAKEFUN_ENV_URL: url, MAKEFUN_TRIAL_SEED: `sim-${seed}` }, stdio: verbose ? 'inherit' : ['ignore', 'ignore', 'inherit'] });
  await new Promise((r) => bot.on('exit', r));
  const secs = (Date.now() - t0) / 1000;
  const games = [];
  for (let n = 1; n <= 30; n++) games.push(await post(`${url}/game`, { game: n }));
  writeFileSync(join(dir, 'games.json'), JSON.stringify(games));
  env.kill();
  mock.kill();
  const r = { wolf: 0, village: 0, seer: 0, doctor: 0, villager: 0, unfinished: 0, draws: 0, secs };
  for (const g of games) {
    const v = g.view ?? g;
    const role = v.you.role;
    const team = role === 'werewolf' ? 'werewolves' : 'village';
    if (v.outcome === null) r.unfinished++;
    else if (v.outcome.winner === null) r.draws++;
    else if (v.outcome.winner === team) {
      if (role === 'werewolf') r.wolf++;
      else {
        r.village++;
        r[role]++;
      }
    }
  }
  r.score = Math.round((1000 * (r.wolf / 15 + r.village / 15)) / 2);
  return r;
}

const all = [];
for (let t = 0; t < trials; t++) {
  const r = await trial(t);
  all.push(r);
  console.log(`trial ${t}: score ${r.score} wolf ${r.wolf}/15 village ${r.village}/15 (seer ${r.seer}/5 doctor ${r.doctor}/5 villager ${r.villager}/5) draws ${r.draws} unfinished ${r.unfinished} ${r.secs.toFixed(1)}s`);
}
const mean = (k) => all.reduce((a, r) => a + r[k], 0) / all.length;
console.log(`mean score ${mean('score').toFixed(1)} wolf ${mean('wolf').toFixed(2)}/15 village ${mean('village').toFixed(2)}/15`);
