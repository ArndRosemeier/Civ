# BALANCE — what was measured, including what did not move

**Read this first.** Every table below is the output of one command, run in one
session on 2026-09-13 (18:14–18:44 UTC) on an eight-core box that other workspaces
were also using. Raw wall times are given with each command. The engine is
deterministic, so a sweep re-run on a quiet machine prints the same table; the
*timings* will not be the same, and the trees will not be the same either — the
working tree was moving while this was written (M11 was landing), so each section
names the commands rather than promising a revision.

Two rules this report follows, because the alternative is a document that lies:

1. **A flat table is not a finding until the exposure is known.** A knob that never
   entered an odds computation produces the same flat table as a knob that does not
   matter. Every sweep here prints its exposure; where the exposure was nil, this
   document says *measurement limitation* rather than *no effect*.
2. **Every catalog row is `placeholder`** — unsourced, chosen to be playable
   (`docs/GDD.md` §1, `pnpm rules:provenance` prints `0/60 cited (0%)`). Nothing
   below is a claim about Civ 3. It measures *this project's* numbers against *this
   project's* engine.

## The sweeps, at a glance

| # | command | knob | wall | verdict |
|---|---|---|---|---|
| 1 | `npx tsx scripts/balance-sweep.ts` | `units.settler.cost` | 14.0 s | **moves** cities, population, treasury, units |
| 2 | `npx tsx scripts/tech-balance-sweep.ts` | `techs.*.cost` (×1/2/4/8) | 26.6 s | **moves** the tech timeline and count; **does not move** cities or population |
| 3 | `npx tsx scripts/combat-balance-sweep.ts` | `units.warrior.attack` (default) | 15.9 s | **moves** battles, captures, cities; **exits 1** on a real invariant violation |
| 4 | `npx tsx scripts/combat-balance-sweep.ts --knob grassland-defense` | `terrains.grassland.defenseBonusPct` | ≈16 s | flat from 0 to 50, **moves** at 100 — the floor, not the knob |
| 5 | `npx tsx scripts/combat-balance-sweep.ts --knob walls-bonus` | `combat.wallsBonusPct` | ≈16 s | **flat, exposure 0 of 88 battles** — measurement limitation, not a finding |
| 6 | `npx tsx scripts/combat-balance-sweep.ts --knob capture-divisor` | `capture.populationDivisor` | ≈16 s | near-flat: 1 column of 5 differs, by 2 population over 3 games |
| 7 | `npx tsx scripts/combat-balance-sweep.ts --knob damage-per-round` | `combat.damagePerRound` | ≈16 s | **moves** strongly at 2; 3 and 4 identical |
| 8 | `pnpm tournament:evidence` | A3's experiment (no knob) | 149.8 s | 20 games, 0 violations, 0 planner failures, **5 of 20 ended by a condition** |

All seven sweeps are reproducible; none of them reads a clock, `Math.random` or any
ambient input, so the tables are a function of the flags alone.

---

## 1. `units.settler.cost` — the production knob (moves)

```
npx tsx scripts/balance-sweep.ts          # 14.0 s
```

seed set `1,4,5,7,8` (5 runs per value, the same set under every value), tiny 60×60,
2 civs, 25 turns, policy `simple-placeholder`, sample every turn. Baseline (shipped
catalog, no override) state hash `45a70e7671d4b655`; the last sampled turn is turn 26.

| `settler.cost` | cities | Δ | population | Δ | treasury | Δ | units | Δ |
|---|---|---|---|---|---|---|---|---|
| as shipped | 49 | — | 173 | — | 2009 | — | 138 | — |
| 1 | 49 | 0 | 172 | −1 | 1826 | −183 | 148 | +10 |
| 2 | 49 | 0 | 172 | −1 | 1960 | −49 | 145 | +7 |
| 3 (shipped) | 49 | 0 | 173 | 0 | 2009 | 0 | 138 | 0 |
| 5 | 50 | +1 | 162 | −11 | 1906 | −103 | 146 | +8 |
| 9 | 39 | −10 | 124 | −49 | 1472 | −537 | 124 | −14 |

**Verdict (the script's own):** the knob moves the measured metrics — cities 39..50
(spread 11), population 124..173 (spread 49), treasury 1472..2009 (spread 537), units
124..148 (spread 24).

What the table is **not**, in the script's words: `units` is the count at the
horizon, not the count ever built (`TurnMetrics` carries no cumulative production),
and `cities` is cities *standing*, which equals cities founded only because nothing in
this engine removes a city. When a milestone adds city loss, that reading has to be
revisited.

Note the shape of the response: cost 1 and 2 do **not** buy more cities than the
shipped 3 — they buy more units and less gold; only at 9 does the board shrink.
A single knob with a non-monotone effect is exactly why this is measured.

---

## 2. `techs.*.cost` — the technology knob (moves the timeline, not the board)

```
npx tsx scripts/tech-balance-sweep.ts     # 26.6 s
```

seed set `1,4,5,7,8`, 40 turns, tiny, 2 civs, policy `simple-placeholder`, sampled
every turn (the beaker trail needs every turn). The multiplier is applied by the
script because **`techs` is the one catalog section `applyOverrides` cannot patch** —
the sweep prints that gap rather than papering over it.

| multiplier | techs known (mean) | cities (mean) | population (mean) | pottery completes (mean turn / runs) | electricity (mean turn / runs) |
|---|---|---|---|---|---|
| ×1 (control) | 37.4 | 9.4 | 44.6 | 12.3 / 10 | 33.8 / 8 |
| ×2 | 33.0 | 9.4 | 44.6 | 15.2 / 10 | 39.7 / 3 |
| ×4 | 24.2 | 9.4 | 44.6 | 18.8 / 10 | never completed |
| ×8 | 15.4 | 9.4 | 44.6 | 23.5 / 10 | never completed |

**What moved:** the whole timeline. Pottery lands 11.2 turns later at ×8; at ×4 and ×8
most of the tree is never reached inside 40 turns, and the cells that never completed
are printed as `-` with the count of runs that did (`n`), not as a mean over the runs
that finished.

**What did not move, and this is a real finding about the horizon rather than a
broken knob:** cities (9.4) and population (44.6) are identical under every
multiplier. At 40 turns on a tiny map the board is decided by settlers and terrain,
not by technology — the technology effect on cities would need a longer horizon to
appear. Do not read this table as "tech does not matter".

---

## 3. `units.warrior.attack` — the combat knob (moves, and the run is not clean)

```
npx tsx scripts/combat-balance-sweep.ts   # 15.9 s, EXIT 1
```

seeds `1,2,3` (duel, 2 civs), 60 turns, policy `simple-placeholder` (attacks when the
engine's per-round odds clear 50%). `eff` is what the knob reads *inside* the patched
ruleset, so a silently refused override would be visible.

| attack | eff | battles | attacker wins | win % | damage | units lost | promotions | captures / population | battles at a city / with walls | units at H | cities at H |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 22 | 11 | 50% | 66 | 22 | 22 | 144 / 144 | 1 / 0 | 104 | 33 |
| 2 | 2 | 41 | 31 | 75% | 119 | 41 | 41 | 201 / 201 | 6 / 1 | 103 | 35 |
| 3 | 3 | 36 | 29 | 80% | 111 | 36 | 36 | 263 / 265 | 5 / 2 | 110 | 38 |
| 4 | 4 | 33 | 28 | 84% | 99 | 33 | 33 | 263 / 265 | 6 / 2 | 114 | 40 |
| 5 | 5 | 36 | 30 | 83% | 109 | 36 | 36 | 262 / 264 | 7 / 2 | 114 | 39 |

Exposure: **168 of 168 battles** fought — the knob was in play.

**The table is not evidence as printed, and the script says so itself.** The run
reports **4 violations** and exits 1:

```
VIOLATIONS (4) — the table above is not evidence
  units.warrior.attack = 3 seed 3: 1 invariant violation(s) at turn 60 (captured-city-consistent)
  units.warrior.attack = 4 seed 3: 1 invariant violation(s) at turn 60 (captured-city-consistent)
  units.warrior.attack = 5 seed 3: 1 invariant violation(s) at turn 60 (captured-city-consistent)
  3 of 15 runs were cut short by the runner itself.
```

Reproduced independently through the shipped CLI, which gives the message the sweep
truncates:

```bash
npx tsx packages/headless/src/cli.ts sim --seeds 3 --map-size duel --civs 2 --turns 60 \
  --policy simple --override units.warrior.attack=3 --json
# exit 1, violations:
#   captured-city-consistent, seed 3, turn 27:
#   city 0 (City 1) holds "pyramids" after a capture, and the city it was taken from did not hold it
```

So the honest reading of this table is: **the higher attack values lead to a board
state the project's own invariant registry refuses.** That is recorded as an open
defect in `docs/KNOWN-ISSUES.md`; it is not this report's to fix, and it is the
reason the three affected rows cover a shorter horizon than 60 turns.

Caveats the report itself prints: the runs are that policy's battles and not a
human's; a per-round odds floor means a value can change *which* attacks happen as
well as how they go; 3 seeds of duel maps is a small sample, reported as a sum.

---

## 4. `terrains.grassland.defenseBonusPct` — flat below 100, because of the floor

```
npx tsx scripts/combat-balance-sweep.ts --knob grassland-defense   # ≈16 s, EXIT 0
```

| defence % | eff | battles | attacker wins | win % | damage | captures / population |
|---|---|---|---|---|---|---|
| 0 | 0 | 22 | 11 | 50% | 66 | 144 / 144 |
| 10 | 10 | 22 | 11 | 50% | 66 | 144 / 144 |
| 25 | 25 | 21 | 9 | 42% | 65 | 144 / 144 |
| 50 | 50 | 21 | 9 | 42% | 63 | 144 / 144 |
| 100 | 100 | 24 | 8 | 33% | 73 | 89 / 89 |

Exposure: **110 of 110 battles.**

This is a *real* zero at the bottom, with a known cause: modifiers are summed as
integers and the result is floored **once**, so a defender on grassland with 2
effective defence has the same strength at +0% and +10% — `floor(2 × 1.0)` and
`floor(2 × 1.1)` are both 2. The M6 commit recorded the same fact ("grassland defence
0 and 10 give IDENTICAL rows"). 25 and 50 happen to land on the same integers as each
other; 100 is far enough to change the board (and to move the attacker's win rate
from 50% to 33%).

**Lesson:** an integer-floored modifier has a dead zone below one unit of effect. A
balance pass must sweep past it rather than concluding the terrain bonus is inert.

---

## 5. `combat.wallsBonusPct` — flat, and the reason is measured, not guessed

```
npx tsx scripts/combat-balance-sweep.ts --knob walls-bonus   # ≈16 s, EXIT 0
```

| walls % | eff | battles | attacker wins | win % | damage | captures / population | battles at a city / with walls |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 22 | 11 | 50% | 66 | 144 / 144 | 1 / 0 |
| 25 | 25 | 22 | 11 | 50% | 66 | 144 / 144 | 1 / 0 |
| 50 (shipped) | 50 | 22 | 11 | 50% | 66 | 144 / 144 | 1 / 0 |
| 100 | 100 | 22 | 11 | 50% | 66 | 144 / 144 | 1 / 0 |

**Exposure: 0 of 88 battles.** The script's own classification is
`NO MEASURABLE EFFECT: MEASUREMENT LIMITATION, not a finding about the knob`, and the
reason is exact:

> the cities these runs take are UNDEFENDED, and an undefended city changes hands on a
> single command that emits `CityCaptured` and no `CombatResolved` at all — so no
> battle, no odds computation and no wall bonus ever happens there. A wall cannot be
> read by an odds calculation that never runs.

`combat.ts` reads the walls bonus only when the defender is standing in **its own**
city **and** that city holds the `walls` row. Neither condition holds in any of these
88 battles, so all four values must produce byte-identical rows — and they do.

**The knob itself is not inert**, and that is measured elsewhere rather than asserted:
`packages/sim/test/ai.test.ts` moves `wallsBonusPct` over this same grid on a fixture
where a defender *is* inside its own walled city and watches the engine's per-round
odds and the AI's decision move with it. The M6b commit recorded the odds moving
42/37/33/30%.

This is the third milestone in which this table has been flat, and each time the
explanation changed (M6: the placeholder policy never fought in a walled city;
M7: the AI built walls and fought, but no battle targeted a city tile; M7b: the
captures are undefended). **A flat table's explanation must be re-measured, not
inherited.**

---

## 6. `capture.populationDivisor` — near-flat, with a measured exposure of 5 in 720

```
npx tsx scripts/combat-balance-sweep.ts --knob capture-divisor   # ≈16 s, EXIT 0
```

| divisor | eff | battles | captures / population |
|---|---|---|---|
| 1 | 1 | 22 | 144 / **146** |
| 2 (shipped) | 2 | 22 | 144 / 144 |
| 3 | 3 | 22 | 144 / 144 |
| 4 | 4 | 22 | 144 / 144 |
| 8 | 8 | 22 | 144 / 144 |

Exposure: **5 of 720** captures involved a city holding more than one citizen — and
the rule is `max(1, floor(population / divisor))`, so a one-citizen city is left with
one citizen under every legal divisor and proves nothing about which divisor is set.
Every column is therefore identical except divisor 1, where two extra population
points survive across three games.

This is the honest shape of a knob whose *rule* is reachable but whose *effect* is
almost always nil on a duel map inside 60 turns. It would need bigger cities (a
longer horizon or a bigger map) before a sweep could rank its values.

---

## 7. `combat.damagePerRound` — the knob with the largest effect size

```
npx tsx scripts/combat-balance-sweep.ts --knob damage-per-round   # ≈16 s, EXIT 0
```

| damage/round | eff | battles | attacker wins | win % | damage | captures / population | battles at a city / with walls |
|---|---|---|---|---|---|---|---|
| 1 (shipped) | 1 | 22 | 11 | 50% | 66 | 144 / 144 | 1 / 0 |
| 2 | 2 | 33 | 16 | 48% | 95 | 395 / 396 | 7 / 1 |
| 3 | 3 | 25 | 10 | 40% | 69 | 3 / 3 | 2 / 0 |
| 4 | 4 | 25 | 10 | 40% | 69 | 3 / 3 | 2 / 0 |

Battles rise 50% and captures nearly triple at 2; at 3 and 4 the same rows appear
twice (the columns are sums over 3 seeds, so equal sums are not proof of equal games,
but the reporter prints what it counted and nothing more). This is the one combat
magnitude measured here whose effect is unambiguous at this sample size — and it also
changes the *number of battles*, because the policy decides to attack on the odds the
applier reports.

---

## 8. A3's tournament — the outcome distribution, not a knob

```
pnpm tournament:evidence      # 149.8 s wall (the script's own bracket: 149,073.7 ms)
```

20 seeds × 100 turns, tiny, 2 civs, the real AI (`smart`) in both seats with the
**seats rotated** so no policy is ever tested from one position only.

| measure | value |
|---|---|
| invariant checks | 66,395 across **35 named predicates** |
| invariant violations | **0** |
| planner failures | **0** (every turn of every game was decided by its policy) |
| games ended by a condition | **5 of 20 (25%)** — the engine's own `game-over` stop reason |
| games that hit the horizon | 15 of 20 (75%) — `max-turns`, no winner |
| wall time | 149,073.7 ms (external bracket) / 149,840 ms for `time pnpm tournament:evidence` |
| per game | 7,453.7 ms |
| budget | 900,000 ms — `DEFAULT_TOURNAMENT_BUDGET_MS`, verdict `within budget` |

The outcome distribution is the part that matters for alpha criterion A3: the
victory conditions are **reachable in real games** (25% of games ended under one,
with no winner declared in the rest because the catalog's own score horizon is turn
200 and the experiment stops at 100). A tournament in which nothing ever ends would
be evidence that the conditions do not work.

**Recorded versus measured, printed by the script itself:**

```
recorded           5621.0ms per game over 20 games of 100 turns — 900000ms budget, 787579ms headroom (87.5%)
this run           7453.7ms per game over 20 games of 100 turns
drift              +32.6% per game
```

The record is stored once, in `@civts/sim`'s `A3_TOURNAMENT_EVIDENCE`, and was taken
at commit `8e9ea21` (M7b) under load average ~2.16–3.4. The +32.6 % drift is a
*speed* reading on a shared box, not a behavioural change — but the record's 20 final
hashes no longer match this run either (seed 1: recorded `49118125b0f5d85e`, measured
`37a049dba29e940f`), because `SCHEMA_VERSION` has moved from 8 to 9 since the record
was taken. **The timing record and the hash record are both stale and both say so in
their own output; nothing in this repository treats either as a live claim.**

---

## 9. What is not measured here

- **No sweep exists for the M9/M10 knobs** (`culture.*`, `victory.*`, `score.*`).
  The evidence for those is the tournament outcome distribution above and the
  per-system scenarios; a cultural-victory-threshold sweep would be the next thing to
  build if someone wants to tune them.
- **`pnpm mutation:check` was not run** in this session: it edits source files on disk
  for about 3 seconds, and other agents were working in the same tree.
- **The `simple-placeholder` policy is not the shipping AI.** Every combat table
  above is that policy's fighting. The M7 AI (`smart`) prices whole battles and
  refuses the ones it loses, so the same knob can look inert under one and live under
  the other; a walls verdict without the policy named beside it is not a verdict.
- **Every number here is a reading from a shared, busy box** (load average 8.2–13.1
  during these runs). Deterministic tables are reproducible; millisecond figures are
  not, and they are labelled as readings rather than budgets.
