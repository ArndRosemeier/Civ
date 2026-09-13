# ALPHA AUDIT (O4) — an independent attempt to falsify A1–A7

**Auditor:** O4, an agent that did not write any of the code under test.
**Commit:** `d4e7f721235c0fb3f46d39b9edaab43645a1b91a` ("M9+M10 …"), **plus the uncommitted M11 working tree.**
**Window:** 2026-09-13, 19:04–19:40 UTC. `find … -mmin` confirms **no source file other than this
audit's own new spec was modified between 19:04 and 19:40** — every number below is from one stopped
tree. Box: 8 cores, load average between **1.28 and 10.62** while these runs were taken (other
workspaces were running vitest throughout); each reading names its load.
**Port 3080:** never touched. Its listener was PID `3295461` before, during and after the audit
(`ss -ltnp | grep 3080` → same PID, uptime 2 days 8 h). The app was served on 4174 and 4174 was not
left listening afterwards.

Not in `docs/`: I was forbidden to modify `docs/`, so this report lives at the repo root.

---

## 0. VERDICT FIRST — what fails

| # | Criterion | Verdict |
|---|---|---|
| A1 | human plays from the browser to a victory/defeat screen, **choosing settings**, no CLI | **PARTIAL** — plays to an ending ✅, **chooses settings ✗**, and the opponent is inert |
| A2 | all core systems present **and integrated** | **PASS**, with three named gaps (§A2.4) |
| A3 | AI plays a complete game; a victory condition ends a real game; 20 seeds, 0 violations, in budget | **PASS** — with the honest scope that only `cultural` has ever ended an AI game |
| A4 | UI covers the nine items | **PASS** — 9/9 items have named, passing e2e tests; suite 63/63 green |
| A5 | fast `verify` ≤ 90 s (target ≤ 70 s); `verify:full` ≤ 10 min | **PASS**, with large headroom (§A5) |
| A6 | goldens stable; save/load round-trip; a game **resumes** | **PASS** |
| A7 | five handoff docs, numbers reproducible | **PASS on existence and reproducibility**; **one documented claim is false** and one recorded limit is missing (§A7.4) |

**The single loudest defect in the whole audit is a documentation lie, not a code defect:**

```
README.md:55  "What you can do in the app: start a new game with settings (seed, map size, civ count),"
```

**There is no such control.** A fresh page has 20 buttons and not one of them is game setup; the end
of a game has 22 and not one of them is either. `window.__CIVTS__.seed(seed, options)` is a test
seam, not a player control. The exact input that disproves it is in §A1.

The second loudest: **the browser app runs no AI.** A1's "game" is solitaire. See §A1.4.

---

## A1 — "A human can start a new game from the web UI, choose settings, and play to a victory/defeat screen without touching the CLI"

### The command (anyone can re-run it)

```bash
cd packages/web && pnpm exec playwright test --config playwright.config.ts alpha-audit-a1
```

`packages/web/e2e/alpha-audit-a1.spec.ts` is this audit's own driver, written to play **by clicking**,
not through the test seam. Verdict text is in the test's annotations.

### Raw result — run three times, identical

```
Running 1 test using 1 worker
  ✓  1 [chromium] › e2e/alpha-audit-a1.spec.ts:119:1 › A1 audit: a clean browser session is played
      to an outcome screen by clicking, and the rival seat is measured (12.5s)
  1 passed (14.3s)
```

| annotation | value |
|---|---|
| `A1 seed` | clean load (`localStorage` cleared first) started **seed=1**, turn=1, settings `{"mapSize":"tiny","civCount":2,"seed":1,"difficulty":"regent","fidelity":"tuned","ai":{"aggression":0.5,"expandFast":false},"debug":{"cheats":false,"revealMap":false}}` |
| `A1 result` | **clicks=199 turn=200 headline=Victory** detail=`Player 1 won by the engine's "score" condition, on turn 200.` **hash=7929363e1f5c9055** revision=200 |
| `A1 control surface (fresh page)` | 20 buttons; none is game setup |
| `A1 control surface` (at the end) | 22 buttons; none is game setup |
| `A1 finding — settings / new game` | *"NO control starts a new game and NO control chooses any setting (seed, map size, civ count, difficulty) … A1 says 'start a new game from the web UI, choose settings' — this half is NOT met by the UI."* |

**The victory half is real and reproducible.** 199 clicks on the app's own `End turn` control, no CLI,
no `dispatch`, from a cleared browser state → the `Game over` dialog, headline `Victory`, the engine's
own condition `"score"` and turn 200, at state hash `7929363e1f5c9055`. Two runs produced that hash
byte-identically. The game was played, not simulated: a city was founded through the settler control,
and the treasury went 10 → 1068.

### A1.4 — the falsification that matters: the opponent never plays

Same test, `A1 rival seat` annotation:

```
rival="Player 2"
  at start  {"cities":0,"units":2,"unitTilesSorted":"2@1973,3@1912","treasury":10,"techs":0}
  at end    {"cities":0,"units":2,"unitTilesSorted":"2@1973,3@1912","treasury":10,"techs":0}
```

**Two hundred turns, and the rival civilization's board is bit-identical.** Same two units, same two
tiles, same treasury, same zero technologies. `grep -rn "policy" packages/web/src` finds no AI in the
web package: the browser imports `@civts/core`, `@civts/rules` and `@civts/testing`, never `@civts/sim`
where the policy lives. `EndTurn` runs the growth/production/economy/barbarian pipeline for every seat
(`core/src/turn.ts`) — the barbarian step is engine behaviour — but a *civilization* only acts when a
policy issues its commands, and nothing in the tab does.

So the "victory" is `city 1 vs city 0` against a statue that never moved. The criterion's sentence
is satisfiable — an outcome screen is reached, by a human, in a browser, with no CLI — and the thing
it describes is not a game. **This is not stated anywhere in `README.md`, `docs/GAME*`, `docs/ENGINE.md`
or `docs/KNOWN-ISSUES.md`.** It is the largest overstatement risk in the alpha claim.

### A1.5 — adversarial probes (dead ends, unreachable controls)

| probe | result |
|---|---|
| Modal trap | **none found.** After the ending, every panel opens and closes (`City 1`, `Technology`, `Debug`), `closeDialogs` reaches zero dialogs, and `Show outcome` re-opens the ending screen after `Close outcome`. |
| A control offering a command the engine accepts over a finished game | **none.** The seam's `dispatch` was instrumented and every enabled control clicked: **0 accepted dispatches**, 0 revisions moved. The three live controls are panel openers/selectors that dispatch nothing. |
| Unreachable control | The engine's finish gates the UI correctly: `End turn`, `Set rates`, `Set government`, every `Move to …`, `Start work: …`, `Fortify` are all disabled at turn 200. |
| **A dead end the UI cannot escape** | **FOUND — a terminal state, not a modal trap.** `A1 adversarial — the terminal state`: *"at turn 200 the page offers 22 buttons and 0 of them can start another game."* When a game ends, the only way to play another is a **page reload**, which restarts the identical seed-1 game, or the test seam. There is no "new game" and no settings screen, so alpha is one game per page load. |

**A1 verdict: PARTIAL.** Play-to-an-ending: **PASS**. Choose settings: **FAIL**. Opponent: **not
stated as absent anywhere, and absent.**

### A1.6 — the ending, seen rather than asserted

Four screenshots land in `packages/web/artifacts/alpha-audit/` (`01-clean-load.png`,
`02-first-city.png`, `03-outcome.png`, `04-all-panels-open-at-the-end.png`). `03-outcome.png` shows
the state the annotations describe, and reviewing it is worth more than the assertions in one respect:
the `EVENTS` log for the last eight turns is a wall of **`Player 2 collected 0 gold, 0 beakers,
0 luxuries` / `Player 2 paid 0 upkeep … for 2 units, 4 free`** — the inert opponent is visible on
screen, in the game's own log, before any instrumentation. The screen itself is correct and readable:
`VICTORY` / *"Player 1 won by the engine's "score" condition, on turn 200."*, `Turn 200`, `Year 20 BC`,
`Treasury 1068 gold`, `Close outcome` live, `End turn` greyed, every unit order greyed.

*Disclosure of an auditor error:* the first version of the spec built its screenshot paths without a
separator and wrote four PNGs as `alpha-audit01-clean-load.png` beside the directory. The files were
removed and the join is now a single named helper (`shot()`); the four screenshots above are from the
corrected run.

---

## A2 — all core systems present **and integrated**

`pnpm verify:full` green is the umbrella evidence (§A5): 2150 passed / 2 skipped of 2152, 64 files.
Integration is evidenced per system below by an **invariant that runs every turn of a real game**
(the strongest available), a **named scenario**, or a **command**.

| system | present | integrated — the artifact that proves it |
|---|---|---|
| map gen | `core/src/gen.ts` | `pnpm map --seed 42 --map-size tiny --civs 2` → `starts: 0=Player 1@45,15  1=Player 2@49,52`, `state hash: 782fe5306476b5d5`; every game in every tier starts from it; golden `tiny-civs2-seed42` is that same hash |
| units + movement + fog | `core/src/units.ts`, `fog.ts` | scenarios `movement-cost-crossing-terrain`, `blocked-impassable-and-enemy`, `fog-expands-as-a-unit-moves`; invariants `unit-movement-in-range`, `unit-tile-in-bounds`, `unit-not-inside-foreign-city` |
| cities (growth, production, citizens) | `growth.ts`, `production.ts`, `cities.ts` | scenarios `city-growth-timing-and-carry-over`, `city-starvation-takes-a-citizen-and-never-falls-below-one`, `city-production-completes-a-unit-and-promotes-the-queue`; invariants `city-population-at-least-one`, `city-food-box-within-threshold`, `city-works-at-most-its-citizens`, `city-food-conservation`, `city-shield-conservation` |
| economy (sliders, gold, maintenance, workers, improvements, resources) | `economy.ts`, `improvements.ts`, `resources.ts` | scenarios `mine-yield-pays-out-on-the-turn-it-completes`, `work-timing-pays-one-turn-a-turn-and-finishes-on-the-catalog-turn`, `commerce-splits-at-the-players-rates-with-the-remainder-to-gold`, `treasury-conservation-over-120-turns-of-starvation-and-bankruptcy`, `building-maintenance-outruns-income-and-drives-a-shortfall`, `road-connected-resource-allows-the-gated-unit`; invariants `treasury-non-negative`, `gold-conservation`, `pools-non-negative` |
| tech tree | `tech.ts`, `rules` catalog | DAG validated at load; 19 rows over 4 eras (`npx tsx -e '…C.techs…'` → eras `["ancient","medieval","industrial","modern"]`); gates exercised through play in `m6-adversarial` §6; goldens `played-civs2-seed42` research a tech |
| combat + barbarians | `combat.ts`, `barbarians.ts` | invariants `combat-hit-point-conservation`, `captured-city-consistent`; `m6-adversarial` §3–§5: *"runs the barbarian half of the same rule"*, *"lets a barbarian band capture a city"*, *"attacks what stands beside it, before the refill, and takes no dice of its own"*; a barbarian step runs in **all 20 tournament games** |
| culture + borders | `culture.ts`, `borders.ts` | invariants `tile-owner-matches-culture`, `tile-owner-names-a-real-player`, `tile-owned-by-a-city-in-range`, `city-culture-non-negative-and-integral`; `m9-m10-adversarial` §1 compares the stored layer against an **independently re-derived** reading of the contract on every turn of a played game, plus §2's exact thresholds |
| governments | `governments.ts` | invariants `government-is-in-catalog`, `rates-within-government-caps`; `m9-m10-adversarial`: *"every government's rate caps refuse one tenth above and accept the triple at the cap"*; UI test `m9-m10-ui.spec.ts:381` *"M9 government: the menu is the engine's catalog, and the refusal a player reads is the engine's own"* |
| happiness / disorder | `happiness.ts` | invariant `disorder-zeroes-the-yields`; `m9-m10-adversarial` §3 drives zero shields, zero beakers, zero gold and no growth, and the same turn on a content board banks all four |
| victory conditions | `victory.ts`, `victory-rules.ts` | invariant `finished-game-does-not-advance`; `m9-m10-adversarial:1259` *"every one of the four conditions ends a game, each with its own winner"*; golden `played-civs2-seed42-victory`; and **5 of 20 A3 tournament games really ended** (§A3) |
| score | `score.ts` | one function read by engine and UI; UI test `m9-m10-ui.spec.ts:503` compares the Score column **cell by cell** against `scoreTable` and rejects a column of zeros |

### A2.4 — three named gaps (each honest, each real)

1. **PLAN §7's invariant list names "no fog leaks into AI decisions". No such invariant exists.**
   The registry is 35 predicates (`npx tsx -e 'import {CORE_INVARIANTS} from "@civts/sim"; console.log(CORE_INVARIANTS.length)'` → `35`) and none is about fog. The AI *deliberately* reads every unit
   present in the state, and says so at the rule site (`packages/sim/src/ai/smart.ts:83-88`:
   *"This AI's threat and hunting reads use the units present in the state, not the player's fog layer
   … That makes this AI a slightly better-informed opponent than fog would imply, and it is recorded
   here"*). The rule-site discipline is honoured; **the docs are not** — `grep -rn "fog" docs/`
   returns exactly one hit and it is about something else (ENGINE.md:311). A limit the project recorded
   is missing from `docs/KNOWN-ISSUES.md`.
2. **The border tie-break ("ties go to the LOWER city id") has no test that a tie ever occurred.**
   It is implemented in the independent re-derivation that `m9-m10-adversarial` §1 compares against the
   engine every turn, so a wrong tie rule would be caught *if a tie arose*; `grep -rn "tie"` across the
   suites finds no test constructing two equal-culture cities. INTERFACES M9 asked for "a tie broken by
   the lower city id" as its own scenario. The rule is stated once and cross-read; its boundary is not
   *demonstrated*.
3. **Barbarians have no invariant of their own.** They are covered indirectly
   (`unit-owner-exists`, `tile-owner-names-a-real-player`) plus `m6-adversarial` §5's determinism
   tests and `m9-m10-adversarial` §5's *"barbarians never win, never score"*. Integration is real;
   there is simply no registry entry that fails if a barbarian breaks a rule.

---

## A3 — "AI opponents play a complete game unaided; at least one victory condition ending a real game; 20-seed tournament, 0 invariant violations, budget met"

### The command

```bash
cd /home/box/Harness/CivGlm && time pnpm tournament:evidence
```

### Raw result (load average 4.88 at start, 5.25 at end)

```
civts tournament — 20 games, 2 seats, smart #0 vs smart #1
settings    tiny 60x60, 2 civs, 100 turns max
totals      1897 turns played, 3784 metric rows, 66395 invariant checks
budget      900000ms stated, 144776.9ms elapsed — within budget
invariants  35 named predicates, 66395 checks, 0 violations
planners    0 planner failures in 0 of 20 games
verdict     every invariant held in all 20 games; no planner failures …; within budget
  exit code          0
OUTCOME DISTRIBUTION
  game-over         5 of 20 games (25.0%)
  max-turns         15 of 20 games (75.0%)
EVIDENCE
  wall               144802.9ms  (external bracket: process.hrtime.bigint)
  reported elapsed   144776.9ms  (the harness clock the budget is judged with)
  agreement          0.02% between the two clocks
  per game           7240.1ms over 20 games

real	2m25.515s
```

- **Zero-invariant-violation status: PASS.** 66,395 checks over **35 named predicates, 0 violations, 0
  planner failures**, exit 0.
- **Budget: PASS.** 144,776.9 ms against the stated 900,000 ms — **83.9 % headroom (755.2 s)**.
- **Outcome distribution:** 5 of 20 games (25 %) ended by an engine condition; 15 of 20 hit the
  100-turn horizon with no winner (the catalog's own score horizon is turn 200 and the experiment
  stops at 100).
- **Every per-game hash reproduces the ones `docs/BALANCE.md` prints** (seed 1 `37a049dba29e940f`, …).

### Which victory condition actually ended a game — and which never has

The tournament report prints the *stop reason*, not the condition. I re-ran the five ending seeds
through the shipped CLI:

```bash
npx tsx packages/headless/src/cli.ts sim --seeds 8,16,18,19,20 --turns 100 \
  --map-size tiny --civs 2 --policy smart --json
```

```json
"wins": [ { "count": 5, "outcome": "cultural", "winner": 1 } ]
```

All five final hashes match the tournament exactly (`a64f10af08558dd6`, `0ebe69c727447062`,
`67ad3bb7b3abe1af`, `55d0cc5198539b0d`, `b8acee17caa073cf`), so these are the same five games.

**A3 is met literally: `cultural` is a victory condition and it ended five real games played by the AI,
and `score` ended the browser game in §A1.** But two of the four shipped conditions — **conquest and
domination — have never ended a game the AI played.** They are demonstrated only in
`packages/testing/test/m9-m10-adversarial.test.ts` (`:1163` conquest, `:590` domination, `:1259` all
four), which are scenario-constructed boards, not AI play. INTERFACES M9+M10 asked for "every victory
condition demonstrated ENDING A REAL GAME … a condition that has never fired is a condition that does
not work". For conquest and domination, that acceptance line is **not** satisfied by the A3 evidence.

### An unreported observation: the winner was always seat 1

In all five endings the winner is **player 1**, i.e. the second seat — and with seats rotated, four of
those games were won by `smart #0` sitting in seat 1 and one by `smart #1` sitting in seat 1. So the
outcome tracks the **seat**, not the policy instance. 5/5 is p ≈ 3.1 % under a fair-seat null: suggestive,
not proof, and I have not diagnosed it. No document mentions a seating asymmetry, and the seat
rotation exists precisely to expose one.

---

## A4 — the nine UI items, each with a named test

```bash
cd packages/web && time pnpm test:e2e      # 63 passed (3.9m)
real	3m53.582s
```

**63 passed, 0 failed, 0 flaky, 0 retries** (Playwright config sets `retries: 0`, `workers: 1`), load
average 3.52 at start and **2.26 at the end**. Every item below is a test that **passed in this run**:

| # | item | named e2e test(s) |
|---|---|---|
| 1 | map render + pan/zoom | `map.spec.ts:59` *A4 map render: the first frame draws tiles…*; `:98` *A4 map pan…*; `:147` *A4 map zoom…*; `:475` *A4 map render: the camera and the drawn tiles agree with the projection at every zoom level* |
| 2 | unit orders | `orders.spec.ts:81` *move*; `:130` *found city*; `:153` *work*; `:195` *fortify*; `:406` *attack* |
| 3 | city screen | `city.spec.ts:94` *the City `<name>` dialog opens…*; `:107` *worked tiles*; `:197` *production*; `:238` *queue* |
| 4 | tech tree | `tech.spec.ts:48` *research selection*; `:147` *known / available / locked* |
| 5 | turn/year indicator | `panels.spec.ts:46` *A4 turn indicator…*; `:64` *A4 year indicator…* |
| 6 | event log | `panels.spec.ts:110` *A4 event log: the log is the engine's own story of the game* |
| 7 | scoreboard | `panels.spec.ts:153` *A4 scoreboard: one row per player…*; `m9-m10-ui.spec.ts:503` *M10 scoreboard: the Score column is the engine's own scoreTable, player for player* |
| 8 | save/load | `save.spec.ts:28` *a save round-trips stateHash() unchanged, across a page reload*; `:78`; `:102` *the payload is the engine's own format…*; `:138` *a corrupt, foreign or absent save is refused…* |
| 9 | debug panel | `debug.spec.ts:32` *opens from its own control and shows the engine's own state hash*; `:45` *follows the state as the game is played*; `:76` *two different games have two different hashes* |

**A4 verdict: PASS.** No item is PARTIAL — all nine have at least one named test, and the keystone
tests (`keystone.spec.ts` ×5, `m8-adversarial.spec.ts` ×8) prove the offered/reachable property in both
directions on the live page.

`docs/KNOWN-ISSUES.md` §3.4 records this suite as **load-sensitive** (57 passed / 4 failed at load 9.4,
all four "the app never reported `ready === true`"). **I did not reproduce it** — my run was green at
load 2.26–3.52 — so I can neither confirm nor deny that hazard. It is a real risk for anyone using this
suite as a gate on a busy box, and the doc says so.

---

## A5 — the two tiers, measured

### Commands and raw output

```bash
time pnpm verify          # ×3
time pnpm verify:full
time pnpm check:static:full   # the UNcached static step, to remove the cache-warmth caveat
```

| run | command | load avg (start → end) | raw | verdict |
|---|---|---|---|---|
| 1 | `pnpm verify` | 4.60 → 8.87 | **`real 0m33.182s`** | green, 64 files, 2096 passed / 56 skipped of 2152 |
| 2 | `pnpm verify` | 8.36 → 10.62 | **`real 0m32.034s`** | green, same counts |
| 3 | `pnpm verify` | 1.28 → 3.64 | **`real 0m29.310s`** | green, same counts |
| 4 | `pnpm verify:full` | 10.01 → 4.42 | **`real 7m20.491s`** | green, 64 files, **2150 passed / 2 skipped of 2152** |
| 5 | `pnpm check:static:full` | 1.66 | **`real 0m25.783s`** | green (uncached eslint + prettier + typecheck, in parallel) |

### Headroom

| tier | bound | measured | headroom |
|---|---|---|---|
| fast `pnpm verify` | A5: **≤ 90 s**; M11 internal target **≤ 70 s** | **29.3 – 33.2 s** | **56.8 – 60.7 s** vs 90 s (63–67 %); **36.8 – 40.7 s** vs 70 s (53–58 %) |
| fast, worst case with a **cold lint/format cache** | ≤ 70 s | ≈ **25.8 s + 24.0 s ≈ 50 s** (steps 4/5 added) | ≈ 20 s |
| `verify:full` | **≤ 10 min (600 s)** | **440.5 s** | **159.5 s (26.6 %)** |

The full tier's 2 skipped are the `CIVTS_MUTATION_CHECK` battery, which mutates source files on disk
and is correctly excluded from a shared tree (KNOWN-ISSUES §3.6).

**A5 verdict: PASS.** The M11 target of ≤ 70 s is met with more than half the budget spare, and the
uncached static step shows the result is not an artefact of the warm cache. Note that `README.md`
(64.0 s) and `docs/ENGINE.md` (§5) still print the **previous serial script's** figure and explicitly
say the re-drawn gate "was not measured" — those figures are **stale in the pessimistic direction**,
and now measurably so. They do not overstate; they under-claim, and they say they might.

---

## A6 — goldens, round-trip, and a game that RESUMES

### Round trip preserves the state hash — CLI, end to end

```bash
npx tsx packages/headless/src/cli.ts save /tmp/o4-save-42.json --seed 42 --map-size tiny --civs 2
npx tsx packages/headless/src/cli.ts load /tmp/o4-save-42.json
```

```
saved: /tmp/o4-save-42.json (109980 bytes, state hash 782fe5306476b5d5)
{"version":1,"engine":{"schemaVersion":9,"nodeMajor":24},"hash":"782fe5306476b5d5","state":{…}}
loaded: /tmp/o4-save-42.json
  turn 1, revision 0, seed 42, schema 9
  state hash 782fe5306476b5d5
```

That hash is the same digest three independent paths produce: `pnpm map --seed 42 --map-size tiny
--civs 2` → `782fe5306476b5d5`, the golden entry `tiny-civs2-seed42` → `782fe5306476b5d5`, and the save
payload. The 109,980-byte figure is README's own.

### A game RESUMES — not merely loads

A session started at a **different seed (7)** loads the seed-42 save, then plays two turns:

```bash
npx tsx packages/headless/src/cli.ts play --seed 7 --map-size tiny --civs 2 --script <load,state,end,state,end,state>
```

```
loaded: /tmp/o4-save-42.json (turn 1, seed 42, state hash 782fe5306476b5d5)
state: seed=42 turn=1 revision=0 …   hash: 782fe5306476b5d5
state: seed=42 turn=2 revision=1 …   hash: fedf905a745eece9
state: seed=42 turn=3 revision=2 …   hash: dddaa974829bff21
```

and the **control**, the same seed 42 played straight through with two `end`s:

```
state: seed=42 turn=3 revision=2 …   hash: dddaa974829bff21
```

**Identical.** The resumed game is the same game, not merely a playable one. It is also the exact
hash README quotes for "seed 42 / turn 3 / revision 2".

### Golden replays are stable, including in a fresh process

```bash
npx tsx packages/headless/src/cli.ts play --seed 42 … --record /tmp/o4-log.json --script <8 commands>
npx tsx packages/headless/src/cli.ts replay /tmp/o4-log.json    # process A
npx tsx packages/headless/src/cli.ts replay /tmp/o4-log.json    # process B
```

```
replayed: /tmp/o4-log.json
  6 turn boundaries reproduced, 8 commands applied
  final hash c4552be54e685157 (seed 42)
```

`diff` of A and B: **IDENTICAL**, both exit 0. The same script played *directly* also ends at
`c4552be54e685157` — so `replay` is not a private path. **Negative control**: one recorded boundary
hash corrupted by hand →

```
error: /tmp/o4-log.json did not replay - turn 3 diverged: the log recorded deadbeefdeadbeef,
       this run produced 06a8c04f50326f42
CORRUPT_EXIT=1
```

It names the exact turn and exits non-zero, so the boundary check is not a rubber stamp.

### The suites that own this

```bash
npx vitest run packages/core/test/serialize.test.ts packages/core/test/replay.test.ts   # 49 passed
npx vitest run packages/testing/test/golden.test.ts                                      # 17 passed
CIVTS_TEST_TIER=full npx vitest run packages/headless/test/repl.test.ts \
  packages/headless/test/sim-cli.test.ts -t "fresh process"                              # 2 passed
```

Named proofs: *"round-trips fresh seed 1 / seed 42 / seed 1337 / standard map / played / disordered /
finished exactly, to the same engine hash"*, *"is exact over every state at once, not one at a time"*,
*"round-trips the golden states themselves, to the hashes the golden file records"*, *"keeps optional
fields ABSENT rather than writing undefined"*, *"REJECTS a payload whose hash disagrees with the state
it carries"*, *"DIVERGES at the turn it diverges on, even when the end still matches"*, *"founds a city,
works it, builds in it and ends turns — byte-identically in two fresh processes"*.

`packages/testing/goldens/state.json`: **6 entries, `nodeMajor: 24`**, including
`played-civs2-seed42-victory` — the played victory golden INTERFACES M9+M10 asked for.

### Independent checks I ran rather than trusting the suites

- Determinism bans: `grep -rnE "Math\.(random|pow|sin|cos|tan|log|exp|atan|sqrt)|Date\.now|new Date\(|performance\.now|process\.hrtime" packages/core/src packages/sim/src` → **no matches**.
- `: any` / `as any` / non-null assertions / `eslint-disable` in any `packages/*/src` → **none** (all
  `any` hits are the English word in comments).
- Absent-never-undefined: the token `undefined` appears **0 times** in the save, the replay log and the
  golden file; a recursive walk of a real `GameState` finds **no key whose value is `undefined`**, and
  a JSON round trip is lossless.

**A6 verdict: PASS.**

---

## A7 — the handoff documents, and whether their numbers are real

### Existence

| document | size | what it carries |
|---|---|---|
| `README.md` | 12,135 B | install, how to run/play, where the tests are, provenance, determinism |
| `docs/GDD.md` | 20,100 B | the game as built + the provenance table + §7 "how to reproduce every number" |
| `docs/ENGINE.md` | 30,709 B | architecture, determinism, the pipeline, the 35 invariants, gate tiers, lesson ledger |
| `docs/BALANCE.md` | 16,903 B | 8 measured sweeps, including the flat ones and why |
| `docs/KNOWN-ISSUES.md` | 15,984 B | the §16.3 deferred list + every recorded limit |

### Figures I re-ran, chosen at random, and their raw results

| source | claim | my command | result |
|---|---|---|---|
| README:178 | `0/60 cited (0%), 60 placeholder` | `pnpm rules:provenance` | **`ruleset provenance — 0/60 cited (0%), 60 placeholder`** ✅ exact |
| README:104 | map hash `782fe5306476b5d5`, `0=Player 1@45,15  1=Player 2@49,52` | `pnpm map --seed 42 --map-size tiny --civs 2` | **both exact** ✅ |
| README:198 | goldens: 6 entries, `nodeMajor: 24` | read `packages/testing/goldens/state.json` | **6 entries, nodeMajor 24** ✅ |
| README:86 | save is 109,980 B, `{version,engine:{schemaVersion,nodeMajor},hash,state}` | `civts save` | **109,980 B**, shape exact ✅ |
| README:89 | hash `dddaa974829bff21` at seed 42 / turn 3 / revision 2 | `civts play` ×2 | **exact** ✅ |
| GDD:72-76 | players/treasury/rates/government; 28 huts, 30 resources, 0 improvements | GDD §7's own `tsx -e` | **every value exact** ✅ |
| GDD:185,244,256 | pyramids 30/2/wonder/2/1/growth-food 1; education industrial 28 lit+math; despotism 8/8/2, 2, 1, 0 | GDD §7's catalog dump | **all exact** ✅ |
| BALANCE:287-294 | 66,395 checks, 35 predicates, 0 violations, 0 planner failures, 5 of 20 ended | `pnpm tournament:evidence` | **66,395 / 35 / 0 / 0 / 5-of-20** ✅ exact |
| BALANCE:52-57 | the whole `settler.cost` table, baseline hash `45a70e7671d4b655` | `npx tsx scripts/balance-sweep.ts` | **every cell exact**, `real 13.352s` vs claimed 14.0 s ✅ |
| BALANCE:196-201 | walls bonus flat, **exposure 0 of 88** | `combat-balance-sweep.ts --knob walls-bonus` | **`battles fought by a defender inside its own walled city: 0 of 88`** ✅ |
| KNOWN-ISSUES:69-75 | `captured-city-consistent`, seed 3, turn 27, exit 1 | the doc's own `sim … --override units.warrior.attack=3` | **exit 1; identical message verbatim** ✅ |
| ENGINE:191 | 35 invariants | `tsx -e 'CORE_INVARIANTS.length'` | **35** ✅ |
| README:130 / ENGINE:221 | `pnpm verify` = 64.0 s "pre-M11 script, not measured composed" | `time pnpm verify` ×3 | **29.3 / 32.0 / 33.2 s** — stale, in the safe direction, and the docs flag it ✅ |
| README:131 / ENGINE:222 | `verify:full` = 491.6 s | `time pnpm verify:full` | **440.5 s** — same order, labelled a reading ✅ |
| README:133 / ENGINE:224 | tournament = 149.8 s | `time pnpm tournament:evidence` | **145.5 s** (`real 2m25.515s`) ✅ |
| README:162 | tests 24.5 s, 2095 passed / 56 skipped of 2151 | `pnpm test` inside verify | **24.03 s, 2096 passed / 56 skipped of 2152** ✅ (one test added since) |

**Everything I sampled reproduced.** Not one figure overstated. Two figures are stale and both are
labelled as readings with the revision they were taken at.

### A7.4 — the two documentation defects

1. **`README.md:55` is false** — see §0. There is no settings surface and no new-game control.
2. **A recorded limit is missing from the docs.** `docs/KNOWN-ISSUES.md` claims to carry "every honest
   limit this project recorded". The AI's deliberate non-use of the fog layer is recorded in
   `packages/sim/src/ai/smart.ts:83-88` and appears **nowhere** in `docs/` (§A2.4.1).

Minor, disclosed divergences I checked and did **not** count as findings, because the docs say so
themselves: the tech tree is **19 rows over 4 eras** against PLAN §12 M5's "~40 techs / 4 ages"
(`docs/GDD.md:249` states the 19 and the Civ 3 comparison); `difficulty: "regent"` changes nothing
(KNOWN-ISSUES §1); space race, culture flips, corruption, diplomacy and espionage are absent
(KNOWN-ISSUES §1–2).

---

## What alpha IS, plainly

**Alpha is: a single-player, single-game, browser-hosted, deterministic 4X with a genuinely complete
and well-instrumented simulation core, and one serious hole at the player's end of the pipe — there is
nobody to play against in the browser and nothing to configure.**

What is genuinely there and proven: a deterministic engine (identical hashes in two fresh processes,
in the browser and headless), 35 invariants checked on every turn of every game, a real AI that plays a
complete game unaided and beats the do-nothing baseline, four victory conditions that each end an
engine game and one that ends a browser game, save/load/replay that round-trips a state hash and
resumes a game exactly, a UI whose every control is proven to dispatch a command the engine accepts and
whose every engine-accepted action is proven reachable from it, a 33 s gate with 55 % headroom and a
7 m 20 s full gate with 27 % headroom, and documentation whose sampled numbers all reproduce.

### How to run it

```bash
# the game (the browser is the engine host; the port is 4174, never 3080)
pnpm --filter @civts/web dev        # then open http://127.0.0.1:4174/
# the gates
pnpm verify                          # ~30 s, green
pnpm verify:full                     # ~7 m 20 s, green
# the agent's channel
pnpm play --seed 42 --map-size tiny --civs 2
# the evidence
pnpm tournament:evidence             # 20 seeds × 100 turns, ~2 m 25 s
npx tsx scripts/balance-sweep.ts
```

### Knowingly incomplete

Deferred by `PLAN.md` §16.3 and stated in KNOWN-ISSUES: balance tuning, corruption, culture flips, full
diplomacy, espionage, isometric renderer/sprites, audio, animation, mod packs, difficulty handicaps,
auto-explore/auto-improve, multiplayer. `difficulty` is inert. Space race has no catalog row and is
named as deferred. Plus the three gaps in §A2.4, the terminal-state dead end in §A1.5, and the open
defect in §"weakest three" #3.

### Every place the alpha claim would be overstated if stated plainly

1. **"Play a game in your browser" → you will play solitaire.** No AI policy runs in the tab; the rival
   civilization is frozen for all 200 turns (measured, §A1.4). No document says this.
2. **"Start a new game with settings" → there is no such control** (`README.md:55`). The page always
   starts seed 1 / tiny / 2 civs / regent, and a page reload is the only way to start over.
3. **"Zero invariant violations" → true for the shipped AI at alpha settings, false in general.** A
   reachable shipped-content board violates `captured-city-consistent`; the exact command is in
   KNOWN-ISSUES §3.1 and I reproduced it.
4. **"Civ 3 clone" → 0 of 60 rules rows are cited.** Every number is a self-declared placeholder;
   `fidelity: "cited-only"` is expected to refuse to start. KNOWN-ISSUES and GDD say so loudly, but
   the phrase in the README's first line ("a Civilization III–shaped 4X") is the strongest true claim
   available and should not be shortened to "Civ 3 clone".
5. **"All four victory conditions work" → two have never ended an AI game.** Conquest and domination
   end scenario-constructed games only.
6. **"Integrated systems" → the fog→AI boundary is not enforced** and not in the invariant registry,
   and the one limit recorded about it lives in a source comment rather than the docs.
7. **"This is alpha" → alpha exists only in an uncommitted working tree.** HEAD `d4e7f72` has no
   `core/src/serialize.ts`, no `replay.ts`, no `load`/`replay` REPL verbs and no BALANCE/KNOWN-ISSUES
   documents. Anyone who clones at HEAD gets pre-alpha and cannot save-and-load. README lines 6–10 and
   KNOWN-ISSUES §3.3 say this, but a hand-off that ships the commit instead of the working tree hands
   over something materially smaller.
8. **The e2e suite is load-sensitive** (57/4 at load 9.4, per KNOWN-ISSUES §3.4). My run was 63/63 at
   load 2.3–3.5. Do not promise a green UI suite on a busy box.

---

## The weakest three things in the project

1. **There is no opponent in the browser.** The engine contains a good AI (`packages/sim/src/ai/`) that
   plays 1897 turns of self-play without a violation — and the web app does not import it. A1's "play a
   game" is a human moving against a board that never answers, so the victory screen is not evidence
   about play, balance, or difficulty. This is the cheapest large fix (wire `SmartPolicy` into the seat
   loop in the tab) and the one that changes what alpha *is*.
2. **Alpha is not committed.** Every proof in this report was taken on an uncommitted working tree at
   HEAD `d4e7f72`. Save/load/replay, the M11 gate re-draw, `docs/BALANCE.md` and `docs/KNOWN-ISSUES.md`
   are all untracked or modified. Until that lands, the reproducible artefact does not contain alpha.
3. **Nothing is Civ 3-accurate, and one shipped-content board is refused by the project's own
   invariant registry.** 0/60 rows cited is honest and disclosed; the `captured-city-consistent`
   violation at seed 3 / turn 27 is undiagnosed and reproducible from shipped content with one flag.
   Together they mean the game's numbers are placeholders and at least one of its rules can produce a
   state the project itself calls illegal.
