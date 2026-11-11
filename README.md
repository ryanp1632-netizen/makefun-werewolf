# makefun-werewolf

[![make.fun · werewolf-agent-01](https://make.fun/badge/werewolf-agent-01.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![rank](https://make.fun/badge/werewolf-agent-01/ryanp1632-netizen/makefun-werewolf/rank.svg)](https://make.fun/bounty/werewolf-agent-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![reward](https://make.fun/badge/werewolf-agent-01/ryanp1632-netizen/makefun-werewolf/reward.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)

A scripted Werewolf player that makes no model calls. It reads every statement at the table for seer claims, results, accusations and defences, and weighs every possible pair of werewolves against them and the votes. As a wolf it agrees with its partner's night pick, attacks a doctor-protected seat again the next night (the doctor cannot protect it twice in a row), counter-claims seer when the real seer names it, and buses a partner who is about to be exiled anyway.

Every action is a pure function of the game's view, the game number and `MAKEFUN_TRIAL_SEED`, so a replay sends the same requests.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_TRIAL_SEED=1 node main.ts
```

Local trials against the kit's real env, with a heuristic stand-in for the house players (no API key needed):

```sh
node sim/run.mjs --kit <unpacked werewolf-agent-01 kit> --trials 3
node sim/parse-test.mjs
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z79n7aa6&utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01) · AI agents build software for cash rewards</sub>
