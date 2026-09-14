# R2 — INDEPENDENT VERIFICATION of the residues, and a final green reading

**Verifier:** R2, an agent that wrote none of the code under test and none of the repairs it
verifies. Every number below is a reading from a command this report names.
**Tree:** `bb85931` ("M11 + A7 …") **plus the uncommitted working tree as R1 left it** — 23 tracked
files modified (`README.md`, `docs/{BALANCE,GDD,INTERFACES,KNOWN-ISSUES}.md`,
`packages/{core/src/{borders,score,victory-rules,victory}.ts, headless/src/sim-cli.ts,
headless/test/sim-cli.test.ts, rules/src/index.ts, sim/src/*, sim/test/*}`,
`packages/testing/test/m9-m10-adversarial.test.ts`, `scripts/tournament-evidence.ts`),
`packages/core/test/victory.test.ts` and `scripts/probes/` untracked. R2 changed two files
(§C) and no source file under `packages/*/src`.
**Window:** 2026-09-14, 00:06–00:58 UTC. Box: 8 cores, **shared** — every wall figure carries the
raw load average it was taken under.
**Port 3080 / the DSH GUI:** never touched. Its listener was PID `3295461` before and after this
pass. No server was left listening on 4174 either (`ss -ltn` → 0 listeners).
**Mutation discipline:** every source a mutation touched was restored from a byte-copy and
re-hashed; §B7 records the hashes.

---

## 0. VERDICT FIRST

| # | Question | Verdict |
|---|---|---|
| A | integration: `pnpm verify` and `pnpm verify:full` green on the final tree, six goldens unmoved | **PASS** — both EXIT 0, `packages/testing/goldens/state.json` untouched (§A) |
| B1 | the dead function is genuinely gone, with no caller left behind | **PASS** — `claimedLandCount` exists nowhere in any `.ts`; only prose records it; `ownedLandTiles` is wired and `ownedLandCount` still has its one live reader (§B1) |
| B2 | the land-versus-water decision: R1 filtered the numerator | **PASS, with the headline claim narrowed (S2)** — no *outcome* changed: the six goldens and the 100/150/200-turn censuses are identical to P2/Q3's pre-filter records, and a mutation run at 150 turns produced byte-identical per-game rows (§B2). The word "nothing observable" was too wide for this report's own §B2(4): on the `m9-m10-adversarial` seed-47 fixture the greatest threshold the land half satisfies moves **3 % → 2 %**, so the readings do diverge where a threshold is set low enough to see it |
| B3 | the F6 pin can fail | **PASS** — the derived product turns the new test **RED** (`280 ≠ 141`), where Q3's mutation M2b left the whole suite green (§B3) |
| B4 | the stale sentences now match their implementations | **PASS, with one residue found and fixed** — `scoreWinner` and `highestScore` are correct and their claims are measured; the land probe's own header still described the pre-filter engine (**R2-F2**, fixed) (§B4) |
| B5 | nothing else moved: the 150-turn census | **PASS** — 13 of 20 decided, all cultural, seats 3/10, 0 violations, 0 planner failures, checks 86,975, turns 2,485 — every figure as P2/Q3 recorded it (§B5) |
| B6 | A5 with raw `time` and the load average, and the 56 skips by name | **PASS** — cold 51.129 s / warm 31.471 s against a 70 s target; full 431.921 s against 600 s; 56 skips printed by name (§B6) |
| B7 | every source restored, hashes identical | **PASS** — 3 mutations applied and reverted; every sha256 identical to the pre-mutation baseline (§B7) |

**Findings, worst first.** Two are documentation defects and both were **fixed in this pass**; the
third is informational. The report is otherwise "no finding".

- **R2-F1 (documentation, A7 — fixed).** `README.md` claimed the browser app can "start a new game
  with settings (seed, map size, civ count)". It cannot: measured on this tree, a clean page offers
  20 buttons and **not one** is game setup. This is the auditor O4's "single loudest defect", still
  unfixed after two later passes over that same file. Fixed at the sentence and recorded with its
  evidence (§B8).
- **R2-F2 (documentation, a verification instrument — fixed).** R1's own probe,
  `scripts/probes/land-numerator-probe.ts`, still opened by asserting that `dominationWinner`
  "divides `ownedLandCount(player)` by `landTileCount(...)`" — the pre-repair engine. A probe whose
  stated premise contradicts the rule it measures is the F3 class one layer out. Header and the
  section-3 summary line rewritten to match the code and the printed output (§B4).
- **R2-F3 (code duplication, minor, informational — not fixed).** `borders.ts:427`' `isLandAt`
  is a private copy of the predicate inlined in `map.ts:473`' `landTileCount`, whose own doc comment
  says it exists to be the one statement of what ground is land. Behaviourally identical today; the
  recipe is one line (§B4).

---

## A. INTEGRATION (Phase A) — green on the final tree

All three readings below are on the working tree as R1 left it plus both R2 edits (`README.md` at
00:47:01 and the probe at 00:41:36 precede every gate run here), and the two runs after them — the
last block in this section — are on the tree **with this report in it**, which is the final state.
The report is prose in a root markdown file; the only thing it can change is the static tier, and
`prettier --check .` and `pnpm verify` are both green on it.

```
$ rm -rf .cache && uptime && time pnpm verify
 00:47:23 ... load average: 3.24, 3.44, 4.02
 Test Files  65 passed (65)
      Tests  2116 passed | 56 skipped (2172)
real    0m51.129s          EXIT 0
 00:48:14 ... load average: 7.42, 4.45, 4.33        # the box got busy mid-run; it still fit
```

```
$ time pnpm verify            # warm caches, on the final tree
 00:57:24 ... load average: 2.26, 3.86, 4.42
real    0m31.471s          EXIT 0    Tests 2116 passed | 56 skipped (2172)
 00:57:56 ... load average: 7.53, 4.94, 4.76
```

```
$ time pnpm verify:full
 00:48:21 ... load average: 6.66, 4.38, 4.31
 Test Files  65 passed (65)
      Tests  2170 passed | 2 skipped (2172)
real    7m11.921s  (431.921 s)      EXIT 0
 00:55:33 ... load average: 3.68, 4.65, 4.72
```

An earlier full run on the same tree (before the two documentation edits) took **433.846 s**, so the
three readings bracket the figure rather than being one lucky run.

**And once more on the tree WITH this report** — the final state of the working tree, nothing else
changed between these two runs:

```
$ rm -rf .cache && uptime && time pnpm verify
 01:13:15 ... load average: 1.14, 1.26, 2.54
 Test Files  65 passed (65)
      Tests  2116 passed | 56 skipped (2172)
real    0m48.857s          EXIT 0
 01:14:04 ... load average: 5.30, 2.31, 2.82

$ time pnpm verify:full
 01:14:06 ... load average: 5.30, 2.31, 2.82
 Test Files  65 passed (65)
      Tests  2170 passed | 2 skipped (2172)
real    7m22.053s  (442.053 s)      EXIT 0
 01:21:28 ... load average: 2.33, 3.55, 3.53
```

So the final tree's cold fast reading is **48.857 s** (quiet box, 1.14→5.30) and **51.129 s** (busy
box, 3.24→7.42); its full reading is **442.053 s**, against the two earlier 431.9 s and 433.8 s.


**The six golden hashes are unmoved.** `packages/testing/goldens/state.json` is **not** in
`git status` (untouched, byte for byte), and both gates recompute it:

```
$ npx vitest run packages/testing/test/golden.test.ts
 ✓ packages/testing/test/golden.test.ts (17 tests) 1756ms
     Tests  17 passed (17)
```

The file's authority, read from it: `781d15e49cf79357` (`tiny-civs2-seed1`), `782fe5306476b5d5`
(`tiny-civs2-seed42`), `717543ac9b22ed91` (`tiny-civs2-seed1337`), `ba1c98cb81d62c08`
(`played-civs2-seed42`), `cfb35436b3d9bfcd` (`played-civs2-seed42-combat`), `2294bc55f0ef3f3e`
(`played-civs2-seed42-victory`). The assignment's list matches the file's, entry for entry.

---

## B1. THE DEAD FUNCTION — genuinely gone, nothing calling it

```
$ grep -rn "claimedLandCount" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cache
./Q3-VERIFICATION.md:41,268,269        (the finding that named it)
./packages/core/src/borders.ts:394,401 (the tombstone R1 left in its place)
```

No `.ts`, `.tsx`, `.js`, `.json`, test or script contains it. `packages/core/src/index.ts` is
`export * from './borders.js'`, so removing an export cannot break a named import elsewhere, and the
typechecker agrees: `npx tsc --noEmit -p tsconfig.json` → EXIT 0 on the final tree.

**The replacement is wired, and the old function kept its one legitimate reader.** `ownedLandTiles`
is read at `packages/core/src/victory.ts:268` (the domination land half), and `ownedLandCount` —
still exported, still honest about counting land *and* water — is read at
`packages/headless/src/repl.ts:4125` for the "your borders reach N tile(s)" line, with
`borders.ts:411-422` saying exactly that and explicitly saying the victory rule does not read it.
So neither half of Q3's F3 residue survives: no dead export, and no doc claiming a rule the code
does not implement.

---

## B2. THE LAND-VERSUS-WATER DECISION — they filtered, and no outcome moved

> **S2:** this section's heading read "…and it moved nothing observable". The body below is its own
> counter-example at §B2(4) — the seed-47 fixture's greatest satisfied threshold moves 3 % → 2 % — so
> the verdict is narrowed to "no outcome moved" and the reason is recorded in §C (S2-F1). The
> measurements and every figure that follow are unchanged.

R1 **filtered the numerator** (`borders.ts`' `ownedLandTiles`, one pass over the ownership layer,
each owned tile resolved through the same `isWaterRole` test `landTileCount` uses). Both halves of
the fraction are now the same kind of quantity. Three independent readings:

**(1) The goldens.** Unmoved (§A) — but the goldens would not have caught this either way, because
the numerator is read only by the victory rule and no golden board comes near the threshold. That is
why the other two readings exist.

**(2) The three censuses, against the records taken *before* the filter.** P2 and Q3 recorded
100/150/200-turn runs on the unfiltered tree. Re-run here on the filtered tree, one configuration at
a time, nothing else on the box:

```
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 100 --json
real 2m17.922s   load 3.06 → 3.35   EXIT 0
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json
real 2m54.886s   load 1.94 → 2.49   EXIT 0
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 200 --json
real 3m13.858s   load 3.22 → 3.27   EXIT 0
```

| turns | ended | no outcome | conditions | seats 0 / 1 | Σ turnsPlayed | checks | violations | planner failures | Q3's recorded row | identical? |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 5 of 20 | 15 | cultural 5 | 0 / 5 | 1,897 | 66,395 | 0 | 0 | 5 / cultural 5 / 0–5 / 66,395 | **yes, every cell** |
| 150 | **13 of 20** | 7 | cultural 13 | 3 / 10 | 2,485 | **86,975** | **0** | **0** | 13 / cultural 13 / 3–10 / 86,975 | **yes, every cell** |
| 200 | 20 of 20 | 0 | cultural 18, score 2 | 8 / 12 | 2,678 | 93,730 | 0 | 0 | 20 / 18+2 / 8–12 / 93,730 | **yes, every cell** |

`stopReasons` agrees game for game (`game-over` 5/13/20, `max-turns` 15/7/0), `clockAgreementPct` is
0.02 % in all three, and every run is `within budget` with `overByMs: 0` and `exitCode: 0`. Cross-run
determinism holds: **all five games that decided by turn 100 have byte-identical final hashes in the
150-turn run, and all thirteen that decided by turn 150 have byte-identical hashes in the 200-turn
run** — so the census is a property of the engine, not of a horizon.

**(3) The direct test: run the *unfiltered* engine and diff.** Rather than infer "unchanged" from
agreement with someone else's record, the numerator was mutated back to `ownedLandCount`
(`victory.ts`, the exact pre-repair expression) and the same command re-run:

```
$ npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json   # numerator UNFILTERED
real 3m7.530s   load 2.46 → 4.11   EXIT 0

per-game rows differing (filtered vs unfiltered): []          # finalHash, outcome, stop reason, turns
census equal: True      checks equal: True (86,975 = 86,975)
violations/planner failures equal: True (0/0 both)
```

Every one of the 20 game rows is **byte-identical** between the two engines. The filter is a rule
correction with no outcome behind it, which is the strongest form of "unchanged" available here.

**(4) The magnitude, independently reproduced.** R1's own probe, re-run:

```
$ npx tsx scripts/probes/land-numerator-probe.ts        # 2m37.057s, load 2.89 → 2.63
  totals: 8 of 8 games and 16 borders hold at least one water tile;
          713 water tiles across 1793 owned tiles (1080 land). 8 of 8 games ended.
  land halves the all-tiles and land-only readings disagree on, over these 8 AI-played games: 0
  seed 9:  … 45 tiles (45 land + 0 water) of 1368 land tiles; all-tiles 3 %, land-only 3 % (unchanged)
  seed 47: … 45 tiles (38 land + 7 water) of 1368 land tiles; all-tiles 3 %, land-only 2 % (MOVED BY 1 POINT)
```

R1's figures (713 of 1,793 — 40 % — water) reproduce exactly, as does the claim in `victory.ts` that
tiny seed 42 player 0 holds 3.4 % of the map's land by the land count against 4.9 % counting the bay.

**And a note the measurement forces, which is not a defect.** The all-tiles and land-only readings do
diverge on the `m9-m10-adversarial` fixture at seed 47 (3 % vs 2 %), and the fixture patches the
threshold to 1 %, so **both** readings satisfy it and the test is unaffected. The new
`packages/core/test/victory.test.ts` is what pins the distinction, and its pin is real: with the
numerator mutated back to `ownedLandCount`, it goes **RED** —

```
 FAIL  packages/core/test/victory.test.ts > … counts the same kind of tile in the numerator
   AssertionError: expected { condition: 'domination', winner: +0 } to be null
  Test Files  1 failed (1)     Tests  1 failed | 1 passed (2)
```

— exactly the failure its own doc comment names, on a control board where the same claim is all land
and *does* fire. A pin that cannot fail is decoration; this one fails on the mutation it names.

---

## B3. THE F6 PIN CAN FAIL — it does, and it took the mutation Q3's was green under

Q3's M2b replaced the tournament report's counted total with `Σ turnsPlayed × invariantCount` and the
**whole suite stayed green** (Q3's F6). R1's answer is not a source change — `sim-cli.ts:3071` already
reduced the games' own counts — but a test that hands `buildTournamentReport` a game list the engine
cannot produce, so the two expressions differ. I re-ran Q3's mutation exactly:

```
$ npx vitest run packages/sim/test/tournament.test.ts      # with sim-cli.ts:3071 mutated to
                                                           # Σ(game.turnsPlayed) * invariantCount
 FAIL  … > the tournament report counts its checks instead of deriving them (F6)
       > sums the games' own counts — a number the derived product cannot produce
   AssertionError: expected 280 to be 141 // Object.is equality
 Test Files  1 failed (1)     Tests  1 failed | 37 passed | 1 skipped (39)
real 0m8.914s
```

Under the mutation the report says **280**; the games' own counts sum to **141**. The suite that was
green under this mutation at Q3 is now red, and only at the new test. **The vacuity is closed, at the
site Q3 said had nothing behind it.**

The honest limit stays: the pinned number is a **fabricated** `invariantChecks` on a four-turn run,
because after F2's order repair the counted and derived figures are equal for *every* tournament the
engine can produce. That is a property of the repair, not of the test, and the test says so in its
own header. The mutation is non-vacuous; the *scenario* is synthetic, and it is the only scenario
that can distinguish the two implementations.

---

## B4. THE STALE SENTENCES

**`scoreWinner`'s doc matches its implementation.** `victory.ts:317-326` returns `null` before the
horizon and otherwise `{condition: 'score', winner: best === undefined ? null : best.playerId}`; its
doc now says ties go to the lowest player id and that `winner: null` needs a world with **no
civilization at all**, and it explicitly records that the previous sentence ("a world whose
civilizations all score the same is a draw") described a value the function cannot return. Measured
against the engine rather than read:

```
$ npx tsx -e '… gameOutcomeOf on a real board at scoreHorizon …'
two civs tied at zero:  {"condition":"score","winner":0}     ← a tie names a winner
every player barbarian: {"condition":"score","winner":null}  ← the only draw
civPlayers of relabelled: 0
```

**`highestScore`'s doc matches its implementation.** `score.ts:224-244` skips `kind !== 'civ'` and
takes a strictly greater score, which is the lowest player id on a tie because `PlayerId` is the
index into `players`. Its doc says "lowest player id" and records that it used to say "city id".
Both claims are pinned by tests that exist and pass: `tournament.test.ts`'s "credits a score tie to
the lowest player id" and `m9-m10-adversarial.test.ts`'s barbarian-leads-the-board case, which
asserts the excluded barbarian's score is *higher* than the winner's.

**The probes' printed claims match their output.** `scripts/probes/invariant-check-count-probe.ts`
prints `skipped 0` on both arms and "0 checks over-reported, and the real count is 3850 against a
derived 3850", which is what it measures (EXIT 0, `real 0m1.593s`). `scripts/probes/q3-check-count-probe.ts`
still reproduces Q3's instrument exactly — `VERDICT: every check passed — the count is counted, and
the deciding turn is checked`, `EXIT=0` — including the turn-limited controls at 5/12/40 turns and
the report-level agreement at 13,930 = 2 × 199 × 35.

**R2-F2, found and fixed here.** `scripts/probes/land-numerator-probe.ts` still opened by asserting
the engine "divides `ownedLandCount(player)` by `landTileCount(map, ruleset)` — every tile the player's
cities claim, over the map's land", i.e. the pre-repair rule, and its section-3 summary said "the
filter **would** flip" as though the filter were hypothetical. R1 changed the engine and left its own
probe's premise behind; every reader of that file would have concluded the divergence it exists to
measure was still live. Header and summary rewritten to state the post-repair rule (and that the
readings are the ones the repair rests on), re-verified with `prettier --check`, `eslint` and
`tsc --noEmit` (all EXIT 0) and re-run end to end, every number unchanged (§B2.4).

**R2-F3, reported and not fixed.** `packages/core/src/borders.ts:427` defines

```ts
/** Is the tile at `index` land, by the ruleset's own terrain rows? `landTileCount`'s rule. */
const isLandAt = (state, ruleset, index) => { … return def !== undefined && !isWaterRole(def.role); };
```

which is the predicate `packages/core/src/map.ts:473-480` inlines in `landTileCount` — the function
whose own comment (`map.ts:447-461`) says it exists so that "three copies of a rule about the world"
could not drift. Today the two are textually identical and cannot disagree; the recipe is to export
`isLandTile(map, ruleset, index)` from `map.ts`, call it from `landTileCount` and from
`ownedLandTiles`, and delete `isLandAt`. Not done here on purpose: editing engine source during the
pass that certifies it would make the certification about a different tree, and this is a
maintenance finding, not a defect.

---

## B5. NOTHING ELSE MOVED — the 150-turn census, exactly as recorded

From the run in §B2 (the required configuration, raw `time` and load above):

```
$ npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json
wallMs 174,428.2   harnessElapsedMs 174,399.4   perGameMs 8,721.4   clockAgreementPct 0.02
verdict.summary "every invariant held in all 20 games; no planner failures — every turn of every
                 game was decided by its policy; within budget"
verdict         passed true, accepted true, withinBudget true, violations 0, violatingGames 0,
                plannerFailures 0, gamesWithPlannerFailures 0
budget          900,000 ms · elapsed 174,399.4 ms (19.4 %) · overByMs 0 · exitCode 0 · status ok
outcomes        games 20 · endedGames 13 · noOutcomeGames 7
                conditions: conquest 0, domination 0, cultural 13, score 0 (draws 0 everywhere)
                seats: 0 → 3 wins, 1 → 10 wins   (both seats: policy `smart`)
                stopReasons: game-over 13, max-turns 7
invariants      35 predicates · 86,975 checks · 0 violations
Σ turnsPlayed   2,485    (2,485 × 35 = 86,975 — counted and derived agree, as §B3 says they must)
```

| figure | P2/Q3 recorded | R2 measured | drift |
|---|---|---|---|
| decided | 13 of 20 | 13 of 20 | none |
| conditions | all cultural | all cultural | none |
| seats | 3 / 10 | 3 / 10 | none |
| violations / planner failures | 0 / 0 | 0 / 0 | none |
| checks | 86,975 | 86,975 | none |
| Σ turnsPlayed | 2,485 | 2,485 | none |
| wall (script's own `wallMs`) | 174,480.3 | 174,428.2 | −0.03 % |

**No drift.** The only figure that moved at all is the wall clock, by 52 ms, on a shared box.

---

## B6. A5 FINAL READING — with headroom, and the skips by name

| command | raw `time` | load average | bound | headroom | verdict |
|---|---|---|---|---|---|
| `pnpm verify` (cold, `.cache` deleted, final tree) | **51.129 s** | 3.24 → 7.42 | ≤ 70 s | **18.9 s (27 %)** | PASS, EXIT 0 |
| `pnpm verify` (cold again, on the tree with this report) | **48.857 s** | 1.14 → 5.30 | ≤ 70 s | **21.1 s (30 %)** | PASS, EXIT 0 |
| `pnpm verify` (warm, final tree) | **31.471 s** | 2.26 → 7.53 | ≤ 70 s | **38.5 s (55 %)** | PASS, EXIT 0 |
| `pnpm verify:full` (final tree) | **431.921 s** (7 m 11.9 s) | 6.66 → 3.68 | ≤ 600 s | **168.1 s (28 %)** | PASS, EXIT 0 |
| `pnpm verify:full` (same tree, earlier) | 433.846 s (7 m 13.8 s) | 6.00 → 3.75 | ≤ 600 s | 166.2 s | PASS, EXIT 0 |
| `pnpm verify:full` (on the tree with this report) | **442.053 s** (7 m 22.1 s) | 5.30 → 2.33 | ≤ 600 s | **157.9 s (26 %)** | PASS, EXIT 0 |

The cold figure is the honest one for a fresh checkout and it is the tighter of the two; every
reading was taken with the box already loaded (5.3–7.4 on the 1-minute average at the point each run
finished), so none is a quiet-box figure. Test totals: fast **65 files, 2116 passed | 56 skipped
(2172)**; full **65 files, 2170 passed | 2 skipped (2172)**. Full ⊇ fast holds, and nothing was
removed to buy the speed.

**The fast tier still reports its 56 skips BY NAME**, grouped by file, with the sentence that says
they run under `CIVTS_TEST_TIER=full`:

```
Skipped in this tier — 56 tests, reported by name so the split is readable from this output.
They RUN under `pnpm verify:full` (CIVTS_TEST_TIER=full); nothing is deleted:
  packages/sim/test/ai.test.ts (8)
    · M7 — the real AI is deterministic and cannot move the world > plays a seed identically twice
    · … (13 files in all)
```

The full tier's own 2 skips are named too (`m9-m10-adversarial`'s two mutation checks, which are
gated by `CIVTS_MUTATION_CHECK=1` rather than by the tier).

**One reading outside the gate, disclosed rather than folded in.** The A1 audit driver
(`pnpm --filter @civts/web exec playwright test --config playwright.config.ts alpha-audit-a1`) was
run once, for §B8: **1 passed (14.5 s, `real 0m15.570s`)**, matching O4's recorded 12.5 s. Port 4174
was not left listening. The full e2e suite was **not** re-run — it is not part of A5's two commands,
it is load-sensitive by its own recorded measurement, and `docs/KNOWN-ISSUES.md` §3.4's 57/4-at-load-9.4
reading stands un-re-verified by this pass. That is a gap in this report, named.

---

## B7. MUTATION CHECK — three mutations, every source restored

| # | mutation | file | result | noticed by |
|---|---|---|---|---|
| M1 | tournament report's `checks` derived as `Σ turnsPlayed × invariantCount` | `packages/headless/src/sim-cli.ts:3071` | **RED** | `tournament.test.ts`'s F6 test, `280 ≠ 141` |
| M2 | the domination numerator back to the all-tiles count (`ownedLandTiles` → `ownedLandCount`) | `packages/core/src/victory.ts:80,268` | **RED** at the unit level | `packages/core/test/victory.test.ts` (`domination` vs `null`) |
| M3 | M2 again, but measured at the evidence level (a full 150-turn tournament) | same | **GREEN — and that is the finding** | nothing; every per-game row byte-identical (§B2.3) |

M3's greenness is not vacuity: it is the *measurement* that the filtered and unfiltered numerators
produce identical games on every seeded configuration this engine ships. The rule correction is
invisible in play, which is exactly why §B2 needed the mutation to establish it and why the pin lives
in a hand-built unit test rather than in a tournament.

**Every source restored from a byte-copy, re-hashed:**

```
before/after  packages/headless/src/sim-cli.ts   95e7cd03fd907fe04f8ef2300e03f1b9ac4cf81958f6569c7c800b29e0297370
before/after  packages/core/src/victory.ts       1b38c4b2bb44b8473b5587728f786b1cd9f6efe85d853de0d5ba924718005ef8
untouched     packages/core/src/borders.ts       553294e638fd40305f71051db7247414dac345ba9f8f1a19c106112ec8de2b90
untouched     scripts/tournament-evidence.ts     573d1174fe11725ac25d9578d68ee63ee7d22481ed82198097e22852686791e5
untouched     packages/sim/src/tournament.ts     3d0c3071127a19658d6276f20789017d32793359933372e6dff2307005bae8aa  (P2's own baseline)
untouched     packages/sim/src/runner.ts         3b283e1084a2e1a9e287bd1b4f3fb66d335c34b49ecdb74f9ec79c5913b124e8  (Q3's own baseline)
```

The two "untouched" sim files re-hash to the digests P2 and Q3 recorded for them, so nothing this
pass ran moved them either.

---

## B8. R2-F1 — the README claim, measured and fixed

`README.md` said the app can "start a new game with settings (seed, map size, civ count)". O4's audit
called that "the single loudest defect in the whole audit" and it was still there — in a file two
later passes edited — when I read it. Measured on this tree with the audit's own driver, whose
annotations print the live button inventory:

```
$ pnpm --filter @civts/web exec playwright test --config playwright.config.ts alpha-audit-a1
 ✓  1 [chromium] › e2e/alpha-audit-a1.spec.ts:129:1 › A1 audit: a clean browser session is played to
     an outcome screen by clicking, and the rival seat is measured (12.6s)
  1 passed (14.5s)                                     real 0m15.570s, load 2.49 → 3.00

A1 seed                     clean load started seed=1 turn=1 settings={"mapSize":"tiny","civCount":2,…}
A1 control surface          buttons on a clean load: End turn | Set rates | Set government | Settler 0 |
                            Worker 1 | Found city | Move to 10,8 | … | Debug | Fortify          (20 buttons)
A1 finding — settings/new game
                            NO control starts a new game and NO control chooses any setting (seed, map
                            size, civ count, difficulty): 20 buttons on a clean load and 22 at the end
                            of a game, and not one of them is game setup.
A1 rival seat               rival="Player 2" at start={"cities":0,"units":2,"treasury":10,"techs":0}
                                            at end  ={"cities":0,"units":2,"treasury":10,"techs":0}
A1 result                   clicks=199 turn=200 headline=Victory detail="Player 1 won by the engine's
                            "score" condition, on turn 200."
```

The rival seat's board is **identical at turn 1 and turn 200**, while the human's went from 0 to 1
city and 10 to 1,068 gold.

**Fixed:** the sentence now says the app plays "the game a page load starts on — a fixed default seed
1, map size `tiny`, 2 civilizations", and a new paragraph after the (already-honest) no-AI-opponent
paragraph states that there is no game-setup control either, names the audit and the command that
shows it, and records that the old sentence was false. `prettier --check README.md` → clean, and both
gates were re-run after the edit (§A).

---

## C. S2 — THE CLAIM THIS REPORT NARROWED, AND THE RESIDUE IT NAMED

**S2-F1 (this report's own headline, narrowed).** §0's B2 row said the filter changed "**nothing
observable**". The measurements in §B2 support "no outcome and no stored hash moved", and that is
what the row now says. "Nothing observable" was too wide, and **this report's own §B2(4) is the
counter-example**: on the `m9-m10-adversarial` seed-47 board the greatest land threshold the land
half satisfies moves from **3 % to 2 %** — a difference the probe prints as `MOVED BY 1 POINT`, and
the same divergence `packages/core/test/victory.test.ts` was written to pin. The distinction the
correction preserves is the one that matters: the filter changes no *verdict anywhere in the
census, at the shipped thresholds*, and it does change the *quantity* — by ~40 % of every border in
play, 713 of 1,793 owned tiles (Q3 §B4, corrected by S2). A verification report's summary line is
the part most likely to be quoted, so it must not be wider than its own evidence.

**S2-F2 (R2-F3, the last residue in this area — FIXED in the S2 pass).** R2-F3 reported that
`borders.ts`' private `isLandAt` duplicated the predicate inlined in `map.ts`' `landTileCount`, and
gave the recipe as one line. It is done: `isLandAt` is **exported from `map.ts`** as the one
statement of what ground counts as land, `landTileCount` counts with it, `borders.ts`' copy is
deleted and `ownedLandTiles` calls the exported predicate. The behaviour is unchanged — the six
goldens unmoved and the full suite green — and the predicate's edges (a tile past the map's terrain,
a terrain role the ruleset does not describe, mountains as impassable *land*) are pinned by
`packages/core/test/victory.test.ts`' `isLandAt — the one land predicate, at its edges`.

**S2-F3 (R2-F1's claim checked, and it is now obsolete).** R2-F1 recorded that the browser app has
no game-setup surface. Re-measured on this tree at 02:15, a clean load offers **20 buttons** — `End
turn`, `Set rates`, `Set government`, `Settler 0`, `Worker 1`, `Found city`, eight `Move to x,y`,
two `Fortify`, `Technology`, `Save game`, `Load game`, `Debug` — and **not one of them is setup**;
the only way to choose a seed is the test seam's `seed()`. That measurement stands as R2 recorded
it. The residue S2 was asked to verify — the opponent and the settings surface — is the subject of
`S2-VERIFICATION.md`, and this file claims nothing about whether it has since landed.

---

## D. WHAT THIS PASS CHANGED

- `README.md` — the false "start a new game with settings" claim replaced with what the app does, plus
  a paragraph recording the missing game-setup surface with the command that measures it (R2-F1).
- `scripts/probes/land-numerator-probe.ts` — the header's pre-repair premise replaced with the
  post-repair rule, and the section-3 summary line reworded to match its own output (R2-F2). The
  instrument, its loops and every printed number are unchanged.

**Nothing else.** No file under `packages/*/src` was left modified by this pass, no test was weakened,
skipped or deleted, and `docs/INTERFACES.md` and `PLAN.md` were not touched.

---

## E. WHAT THIS REPORT WOULD NOT CLAIM

- It does not claim the domination victory is **reachable**. It is not: 0 of 100 AI-played games, and
  my three censuses reproduce that (0 in every configuration). Nothing here is evidence against the
  shortfall — R1's filter is a correctness fix to a rule that never fires.
- It does not claim the tournament report's counted total is defended by a **producible** fixture.
  The F6 test fabricates a count, because the repair makes the two figures equal everywhere else.
- It does not claim the browser is playable against anyone. It is not (§B8) — and that is the subject
  of the note below.
- It does not claim the e2e suite is green on a busy box; it was not re-run here (§B6).

---

## F. THE STRONGEST REMAINING WEAKNESS

**There is no opponent where a human meets the game.** The browser app — the surface A1 names —
imports no policy at all, so the rival civilization is byte-identical at turn 1 and turn 200 while
the human founds a city and wins by score, which I measured on this tree with the audit's own driver
(§B8); the AI that does exist has never won a game against a peer either, since my reproduced censuses
show `domination` and `conquest` ending **0 of 100** self-play games and every ending arriving by
`cultural` or by the turn-200 `score` horizon. That is the weakest thing in the repository because it
is the one defect that no amount of verification or documentation can compensate for — every green
number in this report was measured with the opponent switched off, so the alpha's headline claim
"play a game in your browser" is currently evidenced only against a board that never answers.

Two smaller things I would fix before handing this over, in order: `borders.ts:427`' `isLandAt`
should be `map.ts`' `landTileCount` predicate exported once (R2-F3), and the two overruled-domination
sentences in `docs/INTERFACES.md:2050-2051` stay readable as a rule only because the AMENDMENT 50
lines below overrules them — a reader who stops at the contract table still reads a rule the engine
does not implement.
