# Q3 — INDEPENDENT VERIFICATION of the final findings

**Verifier:** Q3, an agent that wrote none of the code under test. Everything below is a
measurement made with a command this report names, re-runnable by hand.
**Tree:** `bb85931` ("M11 + A7 …") **plus the uncommitted working tree** (`git status`:
`README.md`, `docs/{BALANCE,GDD,INTERFACES,KNOWN-ISSUES}.md`, `packages/{core/src/victory.ts,
headless/src/sim-cli.ts, headless/test/sim-cli.test.ts, rules/src/index.ts, sim/src/*,
sim/test/*}`, `scripts/tournament-evidence.ts` modified; `P2-VERIFICATION.md`, `scripts/probes/`
untracked; this report and `scripts/probes/q3-check-count-probe.ts` added by this pass).
**Window:** 2026-09-13, 22:08–22:50 UTC. Box: 8 cores, **shared** — every wall figure below
carries the raw load average it was taken under.
**Port 3080 / the DSH GUI:** never touched; no server was started or bound by this pass.
**Mutation discipline:** every source a mutation touched was restored from a byte-copy and
re-hashed; §B7 records the hashes.

The assignment: verify that the three repairs (the deciding turn is checked; the check count is
counted rather than derived; the draw arm is covered) are real, that the domination documentation
now matches the engine, that the outcome evidence still holds, and that A5 still fits — then try
to falsify each of those.

---

## 0. VERDICT FIRST

| # | Question | Verdict |
|---|---|---|
| A | integration: `pnpm verify` and `pnpm verify:full` green, six goldens unmoved | **PASS** — both EXIT 0, `reproduce every stored state hash` green (§A) |
| B1 | the deciding turn is checked, once, and the pre-fix order is gone | **PASS** — from a recording registry, and the mutation back to the old order is RED (§B1) |
| B2 | `invariants.checks` EQUALS what a registry really saw | **PASS** — 3 registry sizes × 6 horizons, plus two report levels (§B2) |
| B3 | the draw arm covers a real draw, and its mutation is RED | **PASS** — the arm's engine state is `{score, winner: null}`, and P2's vacuous mutation now fails a test (§B3) |
| B4 | docs match the engine's domination rule; ≥ 4 figures re-run | **ONE FINDING (F3 residue)** — two sites in the engine package still state the overruled wording, and one dead helper's doc calls itself the rule's denominator (§B4) |
| B5 | outcome evidence still good: census + 0 violations + 0 planner failures + budget | **PASS** — three configurations re-run, every recorded figure reproduced (§B5) |
| B6 | A5: fast ≤ 70 s, full ≤ 10 min, with headroom and named skips | **PASS** — 52.4 s cold / 32.0 s warm, 424.2 s full, 56 + 2 skips named (§B6) |
| B7 | mutation-check every fix; hashes identical after revert | **PASS with one pinning gap** — 6 mutations run; 4 RED, 2 GREEN and reported as gaps (§B7) |

**Findings, in severity order** — the report is otherwise "no finding":

- **F3-residue (documentation, open).** `packages/core/src/victory-rules.ts:84` and `:90` still
  call the domination land share "the share of the land **any city claims**" — the exact wording
  the AMENDMENT at `docs/INTERFACES.md:2100–2125` rules wrong. `packages/core/src/borders.ts:394`
  describes `claimedLandCount` as "the denominator of the domination victory's land share"; it is
  not (the rule divides by `landTileCount`), and the function now has **zero readers**.
- **F5 (documentation/engine divergence, corrected: this report's own "not observed in AI play"
  clause was FALSE).** The domination numerator was `ownedLandCount` — every tile the player's
  cities claim, **land or water** — while every doc site stated the rule as a share "of the **map's
  land**". Measured: a radius-3 coastal claim is 20 land + 25 water tiles. This report called the
  divergence unobservable in play; **R1 measured the opposite on this tree** — 8 of 8 AI-played tiny
  games, 16 of 16 borders, **713 of 1,793** owned tiles water (**39.8 %**) — so it was a live
  divergence in every AI-played game, not a nuance. The sentence is corrected in place at §B4, with
  the measurement and the corrected reading of why R1's land-only numerator was justified.
- **F6 (test pinning, minor).** `buildTournamentReport`'s `invariants.checks` sum is not
  falsifiable: replacing it with the derived product leaves the whole suite **green** (§B7).
  The batch report's equivalent IS caught.

---

## A. INTEGRATION (Phase A)

`pnpm verify` — the command a person runs, with `time` and the load average it ran under:

```
$ rm -rf .cache && uptime && time pnpm verify
 22:29:43 up 6 days,  1:38,  0 users,  load average: 5.24, 3.58, 3.04
real    0m52.368s          EXIT 0
 Test Files  64 passed (64)
      Tests  2113 passed | 56 skipped (2169)
 22:30:35 ... load average: 9.62, 4.90, 3.51     # the box was BUSY, and it still fit
```

```
$ time pnpm verify            # warm caches, immediately afterwards
real    0m32.043s          EXIT 0
 Test Files  64 passed (64)
      Tests  2113 passed | 56 skipped (2169)
 22:31:07 ... load average: 10.22, 5.46, 3.74
```

```
$ time pnpm verify:full
real    7m4.233s           EXIT 0
 Test Files  64 passed (64)
      Tests  2167 passed | 2 skipped (2169)
 22:38:12 ... load average: 3.13, 5.38, 4.67
```

**And once more on the frozen tree** — after this report and the new probe were added, nothing else
changed:

```
$ rm -rf .cache && time pnpm verify
 22:54:43 ... load average: 1.17, 2.03, 3.04
real    0m50.873s          EXIT 0    Tests 2113 passed | 56 skipped (2169)
$ time pnpm verify:full
real    6m59.131s          EXIT 0    Tests 2167 passed | 2 skipped (2169)
 23:02:33 ... load average: 3.17, 4.48, 4.20
```

Both are the *final* state of the tree this report describes.

**The six golden hashes are unmoved.** `packages/testing/goldens/state.json` is **not** in
`git status` (untouched, byte for byte), and the run's own gate reproduces every entry:

```
m4b/m4c/m3/m4a adversarial: 781d15e49cf79357 782fe5306476b5d5 717543ac9b22ed91
golden.test.ts > golden file > reproduces every stored state hash   ✓
```

`played-civs2-seed42`, `played-civs2-seed42-combat` and `played-civs2-seed42-victory` are covered
by that last line; the file's authority is `{781d15e49cf79357, 782fe5306476b5d5, 717543ac9b22ed91,
ba1c98cb81d62c08, cfb35436b3d9bfcd, 2294bc55f0ef3f3e}` and none moved.

---

## B1. THE DECIDING TURN IS CHECKED — measured from a recording registry

**Instrument.** `scripts/probes/q3-check-count-probe.ts` (new, this pass). It installs a registry
whose every `check` appends the `InvariantContext` it was handed, so "every turn is checked" stops
being a reading of a loop's source and becomes a list of contexts a test can compare. It asserts,
and exits non-zero if any assertion fails:

1. `SimulationResult.invariantChecks === the number of contexts really recorded`;
2. the recorded contexts group into **exactly `turnsPlayed` distinct `state` object identities**,
   each group holding the whole registry — so no loop iteration is checked twice and none is
   skipped (a played turn is one iteration, and one iteration hands over one state object);
3. on a decided run, **`gameOutcomeOf(lastStateChecked)` is non-null** — the deciding state itself
   reached the predicates.

**Readings** (decided games; the pre-fix count is `(turnsPlayed − 1) × size`):

```
1. DECIDED games
  conquest, smart vs do-nothing, duel, 80 turns, registry 1
    stopped game-over, turnsPlayed 35, outcome conquest on turn 35
    contexts recorded 35, turnsPlayed × size 35, invariantChecks 35
    loop iterations seen 35 (distinct state identities), turns 2..35,
    final state turn 35, pre-fix count would have been 34, last state decided true
  conquest, ..., registry 7
    turnsPlayed 34, contexts recorded 238, iterations 34, last state decided true
  score at the catalog horizon, do-nothing, duel, 200 turns, registry 3
    turnsPlayed 199, contexts recorded 597, iterations 199, last state decided true
```

**The converse: no turn is checked twice, and the pre-fix behaviour is gone.** Mutation **M1**
puts the game-over break back **before** the registry call (`const decided = …; if (decided)
{ stopped = 'game-over'; break; }`) — the F2 defect exactly:

```
$ npx vitest run packages/sim/test/runner.test.ts packages/headless/test/sim-cli.test.ts
 FAIL  runner.test.ts > hand the registry the turn that decides the game, and counts what it ran (F2)
   expected [ 2, 3, …, ] to have a length of 199 but got 198
 FAIL  sim-cli.test.ts > names the condition and the winners when a run in the batch really ends
   expected [ 6930, 6930 ] to strictly equal [ 6965, 6965 ]
 Test Files  2 failed (2)     Tests  2 failed | 98 passed | 6 skipped
```

`6930 = 198 × 35` is the pre-fix arithmetic reappearing, which is what makes the mutation
non-vacuous. Two independent suites notice it, at two levels.

**A note the readings force, and it is not a defect.** For a game decided by a **command** (an
`AttackUnit` capture) the last two loop iterations carry the *same turn number* — `advanceTurn`
refuses to advance a finished state (`turn.ts:335`) — while being different states
(`turns 2..35`, 35 contexts from 35 iterations). So "checked twice" must be counted in **loop
iterations**, not in turn numbers; the probe's identity check is the version that is true, and the
probe prints the turn range so the coincidence is visible rather than hidden.

---

## B2. THE COUNT IS TRUE

**At the runner level** (same probe): `invariantChecks` equals the recorded contexts for **three
registry sizes (1, 3, 7)** and **six horizons (5, 12, 40, 80, 200)**, decided and turn-limited:

```
2. TURN-LIMITED games
  no-commands, duel, 5 turns,  registry 1 → recorded 5,   checks 5,   iterations 5
  no-commands, duel, 5 turns,  registry 3 → recorded 15,  checks 15,  iterations 5
  no-commands, duel, 5 turns,  registry 7 → recorded 35,  checks 35,  iterations 5
  no-commands, duel, 12 turns, registry 1/3/7 → 12 / 36 / 84, iterations 12
  no-commands, duel, 40 turns, registry 1/3/7 → 40 / 120 / 280, iterations 40
```

**At the report level** — `civts sim --seeds 1..2 --turns 200 --policy none --map-size duel`,
whose report is compared against an instrumented batch of the same games:

```
3. THE REPORT
  registry size 35, games 2, turnsPlayed 398
  report.invariants.checks 13930 · Σ runs[].invariantChecks 13930 · turnsPlayed × count 13930
  per run: seed 1 199 turns → 6965, seed 2 199 turns → 6965

4. A DIFFERENT registry size (6 instead of 35)
  registry of 6: checks 2388, Σ runs 2388, product 2388
```

A derived product that happened to agree at 35 would not survive the 6-predicate run; both move
together because both are the count.

**At the tournament level, from the re-run evidence itself** (§B5):

| turns | Σ `games[].turnsPlayed` | × 35 | report `invariants.checks` | decided games |
|---|---|---|---|---|
| 100 | 1,897 | **66,395** | 66,395 | 5 |
| 150 | 2,485 | **86,975** | 86,975 | 13 |
| 200 | 2,678 | **93,730** | 93,730 | 20 |

Each equals P2's F2 figure for the *real* count (`86,975 − 35 × 13 = 86,520` was the pre-fix
truth), and B1's instrument is what establishes that the equality is now a fact rather than a
coincidence: every played turn, the deciding one included, is handed to the registry.

---

## B3. THE DRAW ARM

**Is the fixture a draw, or just a game that failed to end?** Measured against the engine, not
read off the test:

```
$ npx tsx -e '… gameOutcomeOf on a civ-less world at the catalog horizon …'
scoreHorizon 200
outcome of civless:            {"condition":"score","winner":null}     ← the engine's own DRAW
outcome with civs (tie at 0):  {"condition":"score","winner":0}        ← a tie is NOT a draw
```

So the arm is reached by a state whose **engine-read outcome is a draw**, and the test builds it
by copying a real `SimulationResult.finalState` at `scoreHorizon(RULESET)` with every player's
`kind` set to `'barbarian'`. The tie-break (lowest player id) is confirmed separately: two
do-nothing civilizations tied at zero are credited to **player 0**, not drawn.

**Mutation M3 — P2's exact vacuous mutation B′**, applied to the draw arm of
`gameOutcomeReport` (`condition: outcome.condition` → `condition: 'conquest'`):

```
$ npx vitest run packages/headless/test/sim-cli.test.ts
 FAIL  > reports a drawn ending, and the counted checks rather than a product
   AssertionError: expected 'conquest' to be 'score'
 Test Files  1 failed (1)     Tests  1 failed | 64 passed | 6 skipped
```

The mutation that proved nothing before now fails a test. **The vacuity P2 caught is closed.**

---

## B4. DO THE DOCS MATCH THE ENGINE?

**The engine's rule, read from the implementation.** `dominationWinner`
(`packages/core/src/victory.ts:244–263`): `land = landTileCount(state.map, ruleset)`; the land half
returns early when `ownedLandCount(player) * 100 < dominationLandPct * land`; the population half
is then tested over `world` citizens with barbarian cities counted. **Both shares, AND; the land
denominator is the map's land.** That matches the AMENDMENT at `docs/INTERFACES.md:2100–2125`
exactly.

**Every site, checked.** Correct now: `docs/GDD.md` §1 (`:51–55`) and §5 (`:356–372`);
`packages/rules/src/index.ts` `:872–900`, `:938–950`, `:2281–2320`; `packages/core/src/victory.ts`
`:32–52` and `:192–263`. The frozen `docs/INTERFACES.md:2050` still carries the original wording,
which the AMENDMENT at the end of that same file (`:2100–2125`) overrules — that file is out of
bounds for this pass and is correct as an amended contract.

**Still stale — F3-residue:**

```
packages/core/src/victory-rules.ts:84
 * - `dominationLandPct` — the share of the land *any city claims* that wins;
packages/core/src/victory-rules.ts:90
  /** Percent (`0..100`) of the land any city claims. */
packages/core/src/borders.ts:394
 * Every tile any city claims in this state, as a **count** — the denominator of the
 * domination victory's land share.
```

The first two are the overruled sentence, verbatim, in the file that declares the engine's own
`VictoryRules` view — the likeliest place for a reader to look. The third is worse than stale: it
names a function the rule does not call. `claimedLandCount` now has **no reader anywhere in the
repository** (`grep -rn "claimedLandCount" --include=*.ts .` matches only its own declaration), so
it is dead code whose doc comment states a false rule.

**F5, the numerator, measured.** `ownedLandCount` counts entries of `state.tileOwner`, and
`computeTileOwner` (`borders.ts:236–256`) has **no terrain filter** — a claim is a geometric disc.
A radius-3 claim on a real generated map:

```
$ npx tsx -e '… computeTileOwner with one city on a coastal land tile …'
a coastal land centre: 451 [31,7] water neighbours 4
that city claims 20 land and 25 WATER tiles => ownedLandCount = 45
```

Every doc site describes the rule as a share "of the **map's land**"; the numerator is
land-and-water. **CORRECTED IN PLACE (S2): the sentence that stood here — "It is not observable in
AI play — 16 games (duel and tiny, seeds 1–8, the real AI in one seat), 97 cities in the final
states, 0 water tiles inside any border — so this is reported as a nuance, not as a live
misstatement of outcomes" — is FALSE, and its own numbers are the tell.** The claim counted water
tiles "inside any border" and reported zero; on this tree the opposite is measured, reproducibly,
with the repository's own instrument:

```
$ npx tsx scripts/probes/land-numerator-probe.ts        # 2m32.5s, load 1.16 → 1.02, EXIT 0
2. WATER INSIDE BORDERS AT THE END OF 8 AI-PLAYED GAMES
   (tiny, seeds 1..8, smart vs smart, 200 turns)
  seed 1: 151 turns, cultural (player 0), borders 48+56w / 62+30w
  seed 2: 164 turns, cultural (player 0), borders 37+52w / 30+59w
  seed 3: 199 turns, score (player 1), borders 65+35w / 38+41w
  seed 4: 120 turns, cultural (player 0), borders 78+53w / 63+34w
  seed 5: 182 turns, cultural (player 0), borders 57+39w / 18+49w
  seed 6: 123 turns, cultural (player 0), borders 94+65w / 61+31w
  seed 7: 199 turns, score (player 0), borders 52+31w / 69+38w
  seed 8: 66 turns, cultural (player 1), borders 43+20w / 265+80w
  totals: 8 of 8 games and 16 borders hold at least one water tile;
          713 water tiles across 1793 owned tiles (1080 land). 8 of 8 games ended.
```

**8 of 8 games and 16 of 16 borders hold water; 713 of 1,793 owned tiles — 39.8 % — are water.**
Not one game in the sample, and not one border, is water-free. (R2 reproduces the same figures,
`R2-VERIFICATION.md` §B2(4): "713 water tiles across 1793 owned tiles (1080 land)".) The zero this
report recorded cannot have been measured the way it is spelled: the probe's own section 1 shows a
single radius-3 coastal claim at **20 land + 25 water**, so a border is more likely to contain water
than not on a map that is 38 % land, and 16 borders all clean is the reading a wrong predicate
produces — the reading `ownedLandCount` itself gives, which is precisely the predicate the sentence
was written to exonerate.

**What this changes about the ruling that followed.** The land-only numerator in the domination
rule (`borders.ts`' `ownedLandTiles`, wired at `victory.ts:268`) was **justified on the measured
basis, not on the false one.** R1's reasoning never rested on water being rare in play: it rested
on (a) the AMENDMENT at `docs/INTERFACES.md:2103–2128` ruling the map's land the correct
denominator, so numerator and denominator must be the same *kind* of quantity, and (b) the target
comparison being a moving denominator a player can lower by claiming less. The measurement makes
the case *stronger*, not weaker: with ~40 % of every border water, an all-tiles numerator counts a
player's bays toward a share of the world's **land**, which is a materially different number on
every board in play — the 8-game sample's land halves happen to agree at the shipped 60 % threshold
(probe section 3: `0` disagreements), but the divergence is live in the quantity, in every game,
which is what the fix was for. Nothing that follows from F5 in this report is withdrawn; the
"nuance, not a live misstatement" framing is, and the ruling it carried stands on measurement.

**Four figures re-run** (all reproduced; commands are the docs' own):

| figure | source | measured now |
|---|---|---|
| `pnpm map --seed 42 --map-size tiny --civs 2` → `state hash: 782fe5306476b5d5`, `starts: 0=Player 1@45,15 1=Player 2@49,52` | GDD §2, README | **identical** |
| `pnpm rules:provenance` → `0/60 cited (0%), 60 placeholder` | GDD §1 | **identical** |
| GDD's `npx tsx -e` seed-42 block → treasury 10, rates `{6,4,0}`, despotism, `settler,worker,settler,worker`, `huts 28 resources 30 improvements 0`, `schemaVersion 9` | GDD §2 | **identical** |
| `npx tsx scripts/probes/starting-position-probe.ts` → seat 0 grassland ×20; seat 1 plains ×5 | GDD §5.1, P2 | **identical** (plains on seeds 3, 8, 12, 16, 20) |
| `npx tsx packages/headless/src/cli.ts sim --seeds 1..2 --turns 200 --policy none --map-size duel` → `wins: score 2 (player 0 2)`, `35 named predicates, 13930 checks, 0 violations` | BALANCE §8 | **identical** |
| `npx tsx scripts/probes/outcome-aggregate-probe.ts` → conquest 6/6, turns 35–42, winner 0/1 alternating | GDD §5.1 | **identical** |
| `docs/BALANCE.md` / `docs/KNOWN-ISSUES.md` cite `m9-m10-adversarial.test.ts:590–681` for the domination boundary tests | both | **correct range** (the test opens at `:590`, closes at `:681`) |
| `npx vitest list --filesOnly \| wc -l` → 64 collected, 0 e2e | P2 §B6 | **identical** |

---

## B5. OUTCOME EVIDENCE STILL GOOD

Three configurations re-run through the shipped evidence script, one after another (nothing else
running), each with the raw `time` and the load average:

```
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 100 --json
real    2m17.075s   EXIT 0    load 2.08 → 3.15
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json
real    2m55.000s   EXIT 0    load 1.98 → 2.85
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 200 --json
real    3m15.309s   EXIT 0    load (start ~2.9) → 3.01
```

| turns | ended | no outcome | conquest | domination | cultural | score | wins seat 0 | wins seat 1 | script `wallMs` | per game | checks | violations | planner failures | budget |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 5 of 20 | 15 | 0 | 0 | **5** | 0 | 0 | **5** | 136,593.2 ms | 6,829.7 | 66,395 | **0** | **0** | within (900,000 ms budget; `overByMs` 0) |
| 150 | 13 of 20 | 7 | 0 | 0 | **13** | 0 | 3 | **10** | 174,480.3 ms | 8,724.0 | 86,975 | **0** | **0** | within (elapsed 174,450.0 ms) |
| 200 | **20 of 20** | **0** | 0 | 0 | **18** | 2 | 8 | 12 | 194,813.9 ms | 9,740.7 | 93,730 | **0** | **0** | within (elapsed 194,783.3 ms) |

Every number in `docs/BALANCE.md` §8 reproduces: the condition census, the no-outcome bucket, the
per-seat wins (0/5, 3/10, 8/12 — **the auditor's "seat 1 won 5 of 5" is reproduced at 100 turns**),
the invariants checks, and zero violations and zero planner failures in all three. The
`stopReasons` census agrees with the outcome column game for game: `game-over` exactly
5/13/20 times, `max-turns` exactly 15/7/0. Clock agreement (`clockAgreementPct`) is 0.02 % in all
three, so the budget verdict is computed from a clock measuring the run.

**Budget verdict:** `"within budget"`, `withinBudget: true`, `overByMs: 0`, `exitCode: 0`,
`status: ok` — in all three. Compared with the recorded external walls (142,078 / 177,166 /
186,513 ms) the re-runs are −3.5 % / −1.2 % / **+4.7 %**; the 200-turn row is the slowest reading
recorded so far and is a shared-box reading, not a behavioural change (every game hash and every
census entry matches).

---

## B6. A5 RE-CHECK, WITH RAW `time`

| command | raw wall | load average | bound | headroom | verdict |
|---|---|---|---|---|---|
| `pnpm verify` (cold, `.cache` deleted) | **52.368 s** | 5.24 → 9.62 | ≤ 70 s | **17.6 s (25 %)** | PASS, EXIT 0 |
| `pnpm verify` (warm) | **32.043 s** | 9.62 → 10.22 | ≤ 70 s | **38.0 s (54 %)** | PASS, EXIT 0 |
| `pnpm verify:full` | **424.233 s** (7 m 4.2 s) | ~10.2 → 3.13 | ≤ 600 s | **175.8 s (29 %)** | PASS, EXIT 0 |
| `pnpm verify` (cold, final tree) | **50.873 s** | 1.17 → 5.45 | ≤ 70 s | **19.1 s (27 %)** | PASS, EXIT 0 |
| `pnpm verify:full` (final tree) | **419.131 s** (6 m 59.1 s) | ~1.2 → 3.17 | ≤ 600 s | **180.9 s (30 %)** | PASS, EXIT 0 |

The cold figure is the honest one for a fresh checkout and it is the tighter of the two; it is
also **4 s better** than the 56.153 s the docs record, taken at a lower load. Both bounds hold
with the box busy (load 9.6–10.2 during the fast tiers).

**Skips are still reported BY NAME in the fast tier** — 56 of them, grouped by file, with the
reason:

```
Skipped in this tier — 56 tests, reported by name so the split is readable from this output.
They RUN under `pnpm verify:full` (CIVTS_TEST_TIER=full); nothing is deleted:
  packages/headless/test/repl.test.ts (1)
    · the play command > founds a city, works it, builds in it and ends turns — byte-identically…
  packages/headless/test/sim-cli.test.ts (6)
  packages/sim/test/ai.test.ts (8)
  … (13 files in all)
```

The full tier's own 2 skips are named too (`m9-m10-adversarial.test.ts` §9, the two mutation-check
tests, which are gated by `CIVTS_MUTATION_CHECK=1` rather than by the tier — `KNOWN-ISSUES.md` §3.6
says so). `npx vitest list --filesOnly | wc -l` collects **64 files, 0 of them e2e**.

---

## B7. MUTATION CHECK — each fix, and the file hashes

Every mutation was applied to a copy-on-disk baseline, run, then reverted from that byte-copy and
re-hashed. **No repository file was mutated in place without a byte-copy baseline.**

| # | mutation | target | result | tests that noticed |
|---|---|---|---|---|
| M1 | game-over break moved back **before** the registry call | `packages/sim/src/runner.ts` | **RED** | `runner.test.ts` (registry saw 198 turns), `sim-cli.test.ts` (6930 ≠ 6965) |
| M2a | batch report's `checks` derived as `turnsPlayed × count` | `packages/headless/src/sim-cli.ts` | **RED** | `sim-cli.test.ts > reports a drawn ending, and the counted checks rather than a product` (280 ≠ 147) |
| M2b | tournament report's `checks` derived as `turnsPlayed × count` | `packages/headless/src/sim-cli.ts` | **GREEN** | none — **F6, reported** |
| M2c | runner's `invariantChecks` derived as `turnsPlayed × invariants.length` | `packages/sim/src/runner.ts` | **GREEN** | none — see the note below |
| M1+M2c | the whole F2 defect restored (break first **and** product count) | both files | **RED** | `runner.test.ts > hand the registry the turn that decides the game` |
| M3 | draw arm names `'conquest'` instead of the engine's condition | `packages/headless/src/sim-cli.ts` | **RED** | `sim-cli.test.ts > reports a drawn ending, …` |

**Hashes identical after revert:**

```
before  packages/sim/src/runner.ts            3b283e1084a2e1a9e287bd1b4f3fb66d335c34b49ecdb74f9ec79c5913b124e8
after   packages/sim/src/runner.ts            3b283e1084a2e1a9e287bd1b4f3fb66d335c34b49ecdb74f9ec79c5913b124e8
before  packages/headless/src/sim-cli.ts      95e7cd03fd907fe04f8ef2300e03f1b9ac4cf81958f6569c7c800b29e0297370
after   packages/headless/src/sim-cli.ts      95e7cd03fd907fe04f8ef2300e03f1b9ac4cf81958f6569c7c800b29e0297370
```

(tournament.ts `3d0c3071…` and batch.ts `e0e8098e…` also match P2's own baseline hashes, so nothing
this pass touched them.)

**On M2b and M2c (F6 and its twin).** Both are *correct* code: after the order repair every played
turn is checked, so `turnsPlayed × count` and the count are equal for every run the engine can
produce. That is exactly why the mutation is green — the property "counted, not derived" is not
observable at those two sites by value alone. It **is** observable where a run's own count can
differ from the product, and the suite pins it there: the drawn fixture sets
`invariantChecks: 7` on a 4-turn run, and M2a fails on `280 ≠ 147`. So the repair has one real
test behind it at the batch level, and the tournament level has none. Reported rather than
explained away: a reader who believes the tournament report's figure is counted should know that
only the batch report is defended by a failing mutation.

**A note on what the mutation discipline bought.** With M1+M2c both applied — the F2 defect
restored in full — `sim-cli.test.ts` stays **green** and only `runner.test.ts` goes red. The
report-level tests cannot see the defect on their own, because the derived product masks it. One
instrument-level test is the whole defence; it is a good one, and it is the only one.

---

## AN INCIDENT IN THIS PASS, DISCLOSED

While applying M2b I truncated `packages/headless/src/sim-cli.ts` to 0 bytes — a Python
`open(p,'w').write(open(p).read()…)` in which the write-mode open ran before the read. The
working-tree file was uncommitted work and there was no copy of it on disk.

It was reconstructed and **verified byte-identical** (sha256 `95e7cd03…`, the hash taken before
the accident): `packages/headless/src/sim-cli.ts` was rebuilt from `/tmp/sim-cli.ts.bak` (a
mutation-check backup of the same file, 10 lines short) plus the 10-line paragraph the captured
`git diff` showed, then confirmed by (a) every `git diff` hunk header matching the pre-accident
diff exactly, (b) every sampled line number matching the pre-accident greps (306, 1373, 1388, 1399,
1457, 1672, 2080, 2107, 3071), and (c) the sha256 matching. No other file was affected, and the
whole gate was re-run green afterwards. It is recorded here because a verification report that
quietly repaired the artefact it was verifying would be worth nothing.

---

## COMMANDS

```bash
cd /home/box/Harness/CivGlm

# Phase A / A5
rm -rf .cache && time pnpm verify          # 52.4 s cold, EXIT 0
time pnpm verify                           # 32.0 s warm, EXIT 0
time pnpm verify:full                      # 424.2 s, EXIT 0

# B1/B2 — the counting instrument (exits non-zero on any failed claim)
npx tsx scripts/probes/q3-check-count-probe.ts

# B3 — the draw arm, mutated (then revert and re-hash)
npx vitest run packages/headless/test/sim-cli.test.ts

# B4 — the figures, and the engine's own rule
pnpm map --seed 42 --map-size tiny --civs 2
pnpm rules:provenance
npx tsx scripts/probes/starting-position-probe.ts
npx tsx scripts/probes/outcome-aggregate-probe.ts
npx tsx packages/headless/src/cli.ts sim --seeds 1..2 --turns 200 --policy none --map-size duel
grep -rn "claimed land\|any city claims" --include=*.ts packages/

# B5 — the outcome evidence, one configuration at a time
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 100 --json
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 200 --json

# B6
npx vitest list --filesOnly | wc -l         # 64, 0 e2e
```

---

## WHAT THIS REPORT WOULD NOT CLAIM

- It does not claim the domination rule is *reachable* in AI play. It is not: 0 of 100 AI-played
  games, exactly as the AMENDMENT and `KNOWN-ISSUES.md` §3.7 say. This pass reproduces that
  shortfall and adds no evidence against it.
- It does not claim the tournament report's counted-checks field is mutation-defended (F6).
- It does not claim the domination numerator counts land (F5); it counts owned tiles, water
  included. **CORRECTED (S2):** the clause that followed here — "though no AI-played game reaches
  that difference" — was false when it was written and is withdrawn. On this tree 713 of 1,793 owned
  tiles (39.8 %) are water across 8 of 8 AI-played games and 16 of 16 borders, so the difference is
  reached in every game; what no AI-played game reached is the *verdict* moving at the shipped 60 %
  threshold (probe section 3). See §B4.
- It does not claim the 200-turn wall time (195.3 s) is a budget: it is one reading on a shared
  box at load 3.0, and the recorded figure is 186.5 s.

---

## S2 — THE ONE CLAIM IN THIS REPORT THAT WAS FALSIFIED, CORRECTED IN PLACE

**What was wrong.** F5 said the land-versus-water numerator of the domination rule was "**not
observable in AI play**", on a sample of 16 games with **0** water tiles inside any border. It is
observable in *every* AI-played game on this tree and the zero was never a property of the engine:
`npx tsx scripts/probes/land-numerator-probe.ts` (re-run for this correction, 2m32.5 s, load
1.16 → 1.02, EXIT 0) reports **8 of 8 games and 16 of 16 borders holding water, 713 of 1,793 owned
tiles water (39.8 %)**. R1 measured the same figures; R2 reproduced them independently.

**Where it was corrected.** Three places, all in place rather than deleted, because a verification
report that silently rewrites a claim is worth nothing:

| site | was | is |
|---|---|---|
| §0 verdict list, F5 | "…Not observed in AI play (§B4)." | "…**R1 measured the opposite on this tree**: 8 of 8 games, 16 of 16 borders, 713 of 1,793 (39.8 %) water." |
| §B4, the F5 paragraph | "It is **not observable in AI play** — 16 games …, **0** water tiles inside any border — so this is reported as a nuance" | the sentence quoted verbatim, marked FALSE, followed by the probe's own output and the corrected reading |
| end, "would not claim" | "…though no AI-played game reaches that difference." | clause withdrawn, with the distinction between the *quantity* differing (every game) and the *verdict* moving (not at the shipped threshold) |
| §B4, new paragraph | — | **what the correction changes about the ruling that followed** |

**What it does *not* change.** The ruling itself — that the domination land share divides by the
map's land and that its numerator must be land-only (`ownedLandTiles`) — stands, and it stands on
R1's measured reasoning and the AMENDMENT rather than on the false premise. The measurement makes
that case stronger: on a map that is 38 % land, a radius-3 coastal claim is 20 land + 25 water, so
an all-tiles numerator compares a player's bays against a share of the world's land on every board
that has a coast. Nothing else in this report depends on the falsified sentence: F3-residue, F6,
§A, §B1–B3, §B5–B7 and every figure in §B4's table of re-run figures are untouched by it.

**Why it is recorded here rather than quietly fixed.** This report's whole value is that its numbers
were produced by commands a reader can re-run, and the one number that was not is the one that
collapsed under re-measurement. A verification report is not exempt from the standard it applies.
