# P2 — INDEPENDENT VERIFICATION of the outcome evidence, and the alpha re-check

**Verifier:** P2, an agent that wrote none of the code under test.
**Tree:** `bb85931` ("M11 + A7 …") **plus the uncommitted P1 working tree** (`git status` at the time
of writing: `docs/BALANCE.md`, `packages/{headless,sim}/…`, `scripts/tournament-evidence.ts`
modified; `scripts/probes/` added by this report).
**Window:** 2026-09-13, 20:26–21:15 UTC. Box: 8 cores, shared; **every wall figure below carries the
raw load average it was taken under**, because a timing on this box is not evidence without one.
**Port 3080 / the DSH GUI:** never touched; no server was started or bound by this pass.
**Mutation discipline:** the three sources a mutation touched were restored and re-hashed; see §B8.

The assignment: verify independently that the tournament report's new **outcome evidence** (the
victory condition and the winner) is honest, that it is the engine's own answer rather than a second
implementation, that the aggregate is order-independent, that the "no outcome" bucket really is the
turn-limit games, that the seat suspicion can be settled from the data, and that A3/A5/A7 still hold —
then try to falsify each of those.

---

## 0. VERDICT FIRST

| # | Question | Verdict |
|---|---|---|
| A | integration: `pnpm verify` and `pnpm verify:full` green, six goldens unmoved | **PASS** — after one repair (§A) |
| B1 | the outcome is the engine's, not a re-derived rule | **PASS, no finding** — one read of `gameOutcomeOf`, falsified behaviourally (§B1) |
| B2 | the distribution is honest and order-independent | **PASS, no finding** — reproduced to the game, permuted aggregate identical (§B2) |
| B3 | is there a seat effect? | **NO EFFECT SUPPORTED** at n = 20 (12/20, p = 25.2 %); the residue is a 5-game start-terrain confound (§B3) |
| B4 | is every condition reachable in a real AI-played game? | **NO — measured shortfall**: `conquest` yes (with the AI in one seat), `cultural`/`score` yes in self-play, **`domination` never** (§B4) |
| B5 | A3: games end by a *named condition*, 0 violations, 0 planner failures, in budget | **PASS**, with one measurement defect in the denominator (§B5, **F2**) |
| B6 | A5: fast and full inside their budgets, skips named, e2e not collected | **PASS**, large headroom (§B6) |
| B7 | A7 docs: at least four figures re-run | **PASS on reproducibility; ONE FALSE CLAIM** about the engine's domination rule (**F3**) and one figure that does not reproduce (**F4**) (§B7) |
| B8 | mutation check: the evidence tests can fail | **PASS** — three mutations, each RED, hashes unchanged after revert (§B8) |

**The findings, in severity order:**

- **F1 (integration, fixed).** `pnpm verify` was **RED** on this tree before any verification could
  start: two of P1's scratch probes sat at the repository root, outside `tsconfig.json`'s `include`,
  and broke eslint and prettier. §A.
- **F2 (evidence accuracy, open).** The reports' `invariants.checks` — the denominator of A3's
  "zero violations" — is **not counted, it is derived** as `turnsPlayed × invariantCount`, and the
  runner never passes the **turn that ends the game** to the registry. It over-reports by exactly 35
  checks per decided game: the 150-turn A3 run reports **86,975** and really ran **86,520**. §B5.
- **F3 (documentation, open).** `docs/GDD.md:356` and the shipped catalog's own prose
  (`packages/rules/src/index.ts:872`, `:2249`, `:2254`) state that domination needs the land share
  **or** the population share and call the land denominator "claimed land". **The engine does
  neither**: it requires **both** shares (`victory.ts:206–216`) and divides by the **map's** land
  (`landTileCount`). A reader of the docs is told a rule the engine does not implement.
- **F4 (documentation, minor).** `docs/BALANCE.md:331`'s pooled one-sided p-value is given as
  **0.9 %**; the counts in the same row (27 of 38) give **0.69 %**. The row is labelled "do not read
  this row", so nothing downstream turns on it.

Everything else the assignment asked about came back clean, and §B names each "no finding"
explicitly rather than by omission.

---

## A. INTEGRATION — the gate was red, and why

### A.1 Reproduced failure (raw)

```
$ pnpm verify
$ prettier --check . --cache …
[warn] p1-probe-starts.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
$ eslint . --cache …
/home/box/Harness/CivGlm/p1-probe-seat.ts
  0:0  error  Parsing error: … was not found by the project service. Consider either including it
              in the tsconfig.json or including it in allowDefaultProject
/home/box/Harness/CivGlm/p1-probe-starts.ts  0:0  error  Parsing error: … (same)
✖ 2 problems (2 errors, 0 warnings)
real 0m8.831s
```

Both files were untracked (`?? p1-probe-seat.ts`, `?? p1-probe-starts.ts`) and the seat probe's own
header said it was *"TEMPORARY … deleted before the final `pnpm verify`"*.

### A.2 What I did instead of deleting them

Deleting an instrument destroys a re-runnable measurement, and `pnpm verify` had to be green. Both
probes were **moved** to `scripts/probes/` — which **is** in `tsconfig.json`'s `include`, so they are
now typechecked and linted like every other shipped script — formatted, and left otherwise intact:

- `scripts/probes/seat-effect-probe.ts` (was `p1-probe-seat.ts`)
- `scripts/probes/starting-position-probe.ts` (was `p1-probe-starts.ts`)

Moving the second one is what exposed how little it had been checked: it imported `terrainDef` from
`@civts/core`, **a name that package does not export** (`TS2724`). The import was dead, and the file
had never been typechecked because it was outside the gate's include. The dead import is removed; the
body is P1's.

### A.3 Green, with raw times and the load each was taken under

| command | raw `time` | load average before → after | result |
|---|---|---|---|
| `pnpm verify` (warm caches) | **0m31.414s** | 2.11 → 4.89 | EXIT 0 |
| `pnpm verify` (warm, earlier) | 0m33.083s | 5.83 → 8.08 | EXIT 0 |
| `pnpm verify` (cold: `.cache` deleted first) | **0m56.153s** | 2.87 → 6.16 | EXIT 0 |
| `pnpm verify:full` (#1) | 7m11.121s = **431.1 s** | 2.33 → 1.77 | EXIT 0 |
| `pnpm verify:full` (#2) | 7m2.101s = **422.1 s** | 1.34 → 2.11 | EXIT 0 |
| `pnpm check:static:full` (uncached static alone) | 0m26.299s | 0.67 → 1.37 | EXIT 0 |

Fast tier: `Test Files 64 passed (64)`, `Tests 2109 passed | 56 skipped (2165)`.
Full tier: `Test Files 64 passed (64)`, `Tests 2163 passed | 2 skipped (2165)`.

The two tests the **full** tier still skips are `m9-m10-adversarial`'s mutation checks, which run only
under `CIVTS_MUTATION_CHECK=1` (`pnpm mutation:check`); they are printed by name, with the sentence
that says they RUN under the tier that runs them.

### A.4 The six golden hashes have not moved

`packages/testing/goldens/state.json` is **unmodified** in `git status`, and it is the gate's own
input: `golden.test.ts` recomputes every entry and diffs the file, and asserts the exact name list and
that the six digests are distinct. The set, read from the file (the assignment's list is from an
older revision; the file is the authority, as the assignment says):

```
781d15e49cf79357  tiny-civs2-seed1
782fe5306476b5d5  tiny-civs2-seed42
717543ac9b22ed91  tiny-civs2-seed1337
ba1c98cb81d62c08  played-civs2-seed42
cfb35436b3d9bfcd  played-civs2-seed42-combat
2294bc55f0ef3f3e  played-civs2-seed42-victory   ← the victory golden
```

Both full-tier runs were green, so all six recomputed to themselves.

---

## B. THE VERIFICATION

### B1. The outcome is not recomputed — **no finding**

The read-through chain, with every site:

| site | line | what it does |
|---|---|---|
| `packages/core/src/victory.ts` | `316` | `gameOutcomeOf` — the **only** statement of the victory rule |
| `packages/sim/src/runner.ts` | `735`, `777`, `794–802` | the run's ending: `gameOutcomeOf(state, rulesetView)` read **once** from the final state; `outcome` is that value |
| `packages/sim/src/tournament.ts` | `1070` (fn), `1118–1121` | `outcomeDistributionOf` counts `game.outcome` — it does not evaluate a rule |
| `packages/headless/src/sim-cli.ts` | `2905–2956` | `gameOutcomeReport` copies `outcome.condition` / `kind` / `turn` / `winner`; the only work it does is resolving the winner's seat to a policy label |
| `packages/sim/src/batch.ts` | `238`, `268–296` | the batch's `wins` folds each run's own `outcome` |
| `scripts/tournament-evidence.ts` | `341–380` | renders `report.totals.outcomes`; the script's own histogram was deleted in P1 |

**Search for a duplicate: none.** Every consumer of `conquestWinner` / `dominationWinner` /
`culturalWinner` / `scoreWinner` and of the `victory` thresholds in `packages/*/src` and `scripts/`
is either `core/victory.ts` itself or a test. There is no second evaluation in the report path.

**Behavioural falsification** (reading source can pass a duplicate that happens to agree). The catalog
threshold was moved out of reach through the same `applyOverrides` surface the sweeps use, and the
same seed played twice:

```
$ npx tsx scripts/probes/report-follows-engine-probe.ts        # 17.8 s, load 1.38 → …
seed 1, tiny, 2 civs, smart in both seats, 200 turns
  shipped catalog: stopped game-over after 151 turns; report says cultural / winner 0 / turn 152;
    gameOutcomeOf on the final state says cultural / winner 0        the two agree: true
  culturalVictoryCulture = 1,000,000: stopped game-over after 199 turns; report says score / winner 0
    / turn 200; gameOutcomeOf on the final state says score / winner 0   the two agree: true
```

A report that re-derived the condition, or held a hard-coded threshold, would have kept saying
`cultural`. It followed the catalog, and it agreed with an independent `gameOutcomeOf` read of the
same final state in this process.

*Not a finding, but worth naming:* both reports derive the **checks** denominator rather than counting
it, and that derivation is wrong for decided games — that is **F2**, §B5.

### B2. The distribution is honest — **no finding**

`20 seeds × 150 turns` is the configuration in the assignment. Reproduced end to end, through the
shipped script:

```
$ time npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json > ev-150.json
real 2m57.456s (177.456 s)          load average 8.92 (1 min) at start → 2.48 at end
wallMs 176,924.1   harnessElapsedMs 176,892.4   perGameMs 8,846.2   clockAgreementPct 0.02
budgetMs 900,000   withinBudget true   verdict.passed true   violations 0   plannerFailures 0
```

I re-counted everything from the per-game records with my own script, not from the report's totals:

| figure | P1 (`docs/BALANCE.md` §8) | P2, reproduced |
|---|---|---|
| games | 20 | 20 |
| ended by a condition | 13 of 20 | **13 of 20** |
| `max-turns` (no outcome) | 7 | **7** |
| by condition | cultural 13 | **cultural 13** |
| wins by seat | seat 0 = 3, seat 1 = 10 | **3 / 10** |
| violations / planner failures | 0 / 0 | **0 / 0** |
| budget | within | **within (19.7 % of 900,000 ms)** |

A second, independent configuration — `20 seeds × 200 turns` — was run too, and reproduces P1's other
row exactly: **20 of 20 ended, cultural 18, score 2, wins seat 0 = 8, seat 1 = 12**, 0 violations,
0 planner failures, within budget (`real 3m8.793s` = 188.793 s, load 1.93 → 1.58; harness elapsed
188,253.2 ms = 20.9 % of the budget, matching §8's "the 200-turn run uses 21 % of it").

**The two runs agree game for game.** All **13** games that decided within 150 turns have
**byte-identical final hashes, condition and winner** in the 200-turn run taken by a separate
process — including the six that decided at 66–123 turns. Nothing in this evidence is a coin flip.

**Order independence: confirmed, and structurally guaranteed.** Two checks, because they are
different questions:

1. *Does a permuted seed list change anything?* `scripts/probes/outcome-aggregate-probe.ts` plays the
   same six seeds ascending and scrambled (`[6,3,1,5,2,4]`) with the real AI and a do-nothing control
   on a `duel` map: **per-game records identical, census identical** (`conquest 6, seats 0=3 1=3`).
2. *Is the aggregate independent of the order it is handed the games in?* A permuted seed list does
   **not** test this, because `runTournament` sorts the list before it starts and the shipped CLI
   sorts it even earlier (`parseIntegerSpec`). So the aggregate was re-run over the same
   `(game, seat-plan)` **pairs** handed over in the order `3,0,5,1,4,2`: **census identical**.
3. Confirmed at the CLI as well: `tournament --seeds 6,3,1,5,2,4` reports `seedSpec` as typed but
   `seeds: [1,2,3,4,5,6]`, so a caller's order cannot reach the harness through the shipped command.

**The "no outcome" bucket is genuinely the turn-limit games** — cross-checked per game against
`stoppedBecause` *and* `turnsPlayed`, not trusted:

```
150 turns:  no outcome but stop !== 'max-turns'      0
            no outcome but turnsPlayed !== 150       0
            ended but stop !== 'game-over'           0
            'game-over' but no outcome               0
200 turns:  the same four counts, all 0 (and no-outcome is 0 of 20)
```

### B3. The seat question, answered from the raw per-game records

Both seats are the **same policy** (`smart` vs `smart`, seats rotated), so a per-seat win total is a
measurement of the **position** and mixes no strategy. Counted here from the report's own game rows:

| sample | endings | seat 1 wins | seat 0 wins | one-sided binomial p (fair coin) |
|---|---|---|---|---|
| 100 turns, 20 seeds (derived, see note) | 5 | **5** | 0 | **3.13 %** |
| 150 turns, 20 seeds | 13 | **10** | 3 | **4.61 %** |
| 200 turns, 20 seeds | 20 | **12** | 8 | **25.17 %** |
| 200 turns, the 15 games **not** on a plains start | 15 | 8 | 7 | **50.0 %** |
| 200 turns, the 5 plains-start games only | 5 | **5** | 0 | 3.13 % |
| the three pooled — nested, double-counted | 38 | 27 | 11 | 0.69 % — *do not read this row* |

*Note on the 100-turn row:* I did not spend 142 s re-running that horizon, because determinism makes
it derivable and I checked the derivation rather than assuming it: the 100-turn endings are the games
of the 150-turn run whose ending arrived within 100 played turns, and every one of those final hashes
is byte-identical to the same seed's hash in the independent 200-turn run. The derived row is
**5 of 20, all cultural, seat 1 = 5, seat 0 = 0** — exactly P1's row.

**Verdict: no seat effect is supported.** P1 claims none, and the claim survives my attempt to refute
it in the other direction — the strongest version of the suspicion is real and still not significant:

- The auditor's "seat 1 won 5 of 5" is the whole 100-turn sample, and it is **not** a pure
  start-terrain artefact: seeds 18 and 19 are grassland starts that seat 1 also won. But at n = 5,
  5 of 5 is p = 3.1 %, the p-value of a coincidence.
- At the largest sample, seat 1 wins 12 of 20 — 60 %, p = 25 %.
- The **entire** residue lives in the starting position, which P1 measured and I reproduced with the
  relocated probe (`npx tsx scripts/probes/starting-position-probe.ts`, 0.99 s): **seat 0 starts on
  grassland in all 20 seeds; seat 1 starts on plains (1 food / 2 shields instead of 2/1) in exactly 5**
  — seeds 3, 8, 12, 16, 20 — in every configuration, because map generation is deterministic. Remove
  those five games and the 200-turn split is **8–7**, dead even.
- No wrong-player crediting was found: the winner credited every game is the seat `gameOutcomeOf`
  names, checked against an independent read of the board (§B1), and no game credits a barbarian.

**What would have to be true to be convincing at this sample size.** At n = 20 endings, a one-sided
result needs **≥ 15 of 20** (2.07 %); **14 of 20 is 5.77 %** and does not clear 5 %. And because three
nested horizons were examined, a single nominal p < 5 % at one of them is weak on its own: under the
null, the chance that the *best* of three nested looks reaches the best p actually observed (3.1 %) is
about **9 %**. So the convincing shape is not "one horizon crosses 5 %" but: **≥ 15 of 20 endings at a
horizon chosen before looking, with the excess still present in the 15 non-plains-start games.** A
plains-only effect (5 of 5, twice over, in two independent runs) is a **map-generation** finding — a
systematic start asymmetry worth its own look — not a seat effect, and it is not alpha-blocking.

### B4. Victory reachability — a measured shortfall, stated plainly

For **each** of the four conditions the engine defines (`VICTORY_CONDITIONS`, catalog order):

| condition | ever ended a real AI-played game? | evidence (command) |
|---|---|---|
| `cultural` | **YES, and it is the AI's whole game** | `npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json` → 13 of 20 games, every one with a named winner and turn; at 200 turns, 18 of 20 |
| `score` | **YES** — at the catalog's own horizon of turn 200 | same command with `--turns 200` → seeds 3 and 7, `game-over`, `score`, winner named at turn 200. Also `packages/testing/goldens`' `played-civs2-seed42-victory` and `civts sim --seeds 1..2 --turns 200 --policy none --map-size duel` (2 score endings, winner player 0) |
| `conquest` | **YES, but only with the AI in ONE seat** — never in self-play | `npx tsx scripts/probes/outcome-aggregate-probe.ts` → 6 of 6 games, seeds 1–6, `duel`, smart vs the do-nothing control, conquest at turns 35–42, winners alternating 0/1 with the rotation. **0 of 60** self-play games (P1's run) and **0 of 40** (mine) |
| `domination` | **NO — never, anywhere** | 0 of 100 AI-played games across P1's three horizons (60) and my two (40). The only demonstrations are hand-built boards with patched thresholds: `packages/testing/test/m9-m10-adversarial.test.ts:590–681` (a city added by hand, `dominationLandPct: 1, dominationPopPct: 50`) and `:1314–1338` |

**This is a shortfall against the M9+M10 acceptance line, not a dead rule, and I will not round it
up.** `domination` holds in the engine and is boundary-tested at each of its two thresholds; what it
has never done is end a game that a policy played. At the shipped magnitudes (60 % of the **map's**
land and 40 % of the world's citizens) the AI neither takes nor grows that far in 200 turns. The
`conquest` case is a genuinely weaker demonstration than the table makes it look: the do-nothing
control never founds a second city, so "the AI conquers" here means "the AI takes an undefended
capital", not "two AIs fight a war".

A3's own wording is *"at least one victory condition demonstrated ending a real game"*, and that is
**met** by `cultural` and `score` in self-play. A reader who takes A3 to mean "the victory system
works" should take the paragraph above with it.

### B5. A3 re-check — **PASS**, with **F2** in the denominator

At the assignment's configuration (`20 seeds × 150 turns`, the shipped script, raw `time` above):

```
$ npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json
verdict.summary  "every invariant held in all 20 games; no planner failures — every turn of every
                  game was decided by its policy; within budget"
verdict          passed true, accepted true, withinBudget true, violations 0, violatingGames 0,
                 plannerFailures 0, gamesWithPlannerFailures 0
budget           900,000 ms  ·  elapsed 176,892.4 ms  ·  19.7 % used
```

- **Games end by a condition, not only by the turn limit:** 13 of 20, every one naming a condition,
  a winner, a seat and a turn; at 200 turns **20 of 20**. A3's "ended AND nameable" is satisfied.
- **Violations: ZERO. Planner failures: ZERO** — reproduced twice at 150 turns and once at 200, plus
  40 more games in probes, all zero.
- **Budget: met**, with 80 % headroom.

**F2 — the checks denominator is derived, and the deciding turn is never checked.** `civts sim` and
`civts tournament` both report `invariants.checks` as
`Σ turnsPlayed × invariantCount` (`sim-cli.ts:1640` and `:3037`), and the field's own doc comment says
*"Whole-registry checks run: one per turn played, per run"* (`sim-cli.ts:1436`). The runner checks the
game-over condition **before** it runs the registry and **breaks** on the turn that ends the game
(`runner.ts:735` before `:746`), so that turn is never handed to the 35 predicates. Measured, not
argued — `scripts/probes/invariant-check-count-probe.ts` installs a one-invariant registry that
records every turn it is really given:

```
a game decided by a VICTORY CONDITION (smart vs do-nothing, duel, 80 turns)
  seed 1: game-over, turnsPlayed 35, outcome conquest on turn 35, checks really run 34, skipped 1
  seed 2: game-over, turnsPlayed 34, outcome conquest on turn 34, checks really run 33, skipped 1
  seed 3: game-over, turnsPlayed 41, outcome conquest on turn 41, checks really run 40, skipped 1
a game stopped by the TURN LIMIT (nobody has a command, 5 turns)
  stopped no-commands, turnsPlayed 5, checks really run 5, skipped 0
```

So the A3 figures are over-reported by exactly `35 × (decided games)`:

| run | reported `checks` | really run | over-reported |
|---|---|---|---|
| 20 × 150 turns | **86,975** | **86,520** | 455 (0.52 %) |
| 20 × 200 turns | **93,730** | **93,030** | 700 (0.75 %) |

Two things follow, and I state both rather than only the flattering one. (1) The **verdict is
unaffected**: 0 violations is 0 violations, and the reported count is larger than the real one, so
nothing was hidden by it. (2) The **coverage claim is overstated**, and the gap is not academic: the
skipped turn is the one where the game was decided, i.e. exactly the turn on which a capture or a
completion happens — `captured-city-consistent`, the invariant that really does fire on this engine
(`docs/KNOWN-ISSUES.md` §3.1, reproduced in §B7 below), is a capture invariant. Had that capture also
been the decisive one, the run would have reported no violation at all. The suite cannot catch this:
`packages/headless/test/sim-cli.test.ts:500` **pins the derived identity**
`checks === count × turnsPlayed` on a fixture whose runs do not end, and `m7-adversarial.test.ts:1935`
computes the same product and asserts only that it exceeds 5,000.

*Not fixed here.* Changing it means either counting in the runner (a behaviour change to the harness
P1 owns, which would move BALANCE §8's figures) or checking the registry before the game-over break
(a change to what a decided state is allowed to report). Both are the owner's call, not the
verifier's; what a verifier owes is the measurement, and it is above.

### B6. A5 re-check — **PASS** (raw `time`, quiet box, headroom for both)

| bound | raw measured | headroom |
|---|---|---|
| fast `pnpm verify` ≤ **70 s** internal target (A5's own bound 90 s) | **31.414 s** warm / **56.153 s** cold, load 2.11→4.89 and 2.87→6.16 | 38.6 s warm (55 %) · 13.8 s cold (20 %) against the 70 s target; 58.6 s / 33.8 s against the 90 s bound |
| `pnpm verify:full` ≤ **600 s** | **431.1 s** and **422.1 s**, load 2.33→1.77 and 1.34→2.11 | 168.9 s / 177.9 s (28–30 %) |

The cold reading is the honest one for a fresh checkout and it is the tighter of the two; the README's
64.0 s reading (its own note says it is from the previous serial script) is not a figure I could
reproduce, and the README already says so.

- **Skipped tests are still reported BY NAME.** The fast run prints
  `Skipped in this tier — 56 tests, reported by name so the split is readable from this output`
  followed by one line per test, grouped by file. Nothing was removed to make the gate faster.
- **The e2e suite is not collected by vitest.** `vitest.config.ts:219`'s include is
  `packages/*/test/**/*.test.ts`; `vitest list --filesOnly` returns **64** files and **0** under
  `packages/web/e2e`; the 64 collected files are exactly the files that glob matches. The two
  `m9-m10-adversarial` tests that assert this are green in both tiers.
- The e2e suite itself was **not re-run** by this pass (it is not part of A5's two commands, and it is
  load-sensitive by its own recorded measurement); `docs/KNOWN-ISSUES.md` §3.4's 57/4-at-load-9.37
  reading stands as recorded, unre-verified here. That is a gap in this report, named.

### B7. A7 docs spot-check — reproducibility, and one false claim

Re-run figures (nine, not four):

| doc | figure | command | result |
|---|---|---|---|
| `README.md:104` | `state hash: 782fe5306476b5d5`, starts `0=Player 1@45,15  1=Player 2@49,52` | `pnpm map --seed 42 --map-size tiny --civs 2` | **reproduced exactly** |
| `README.md:178`, `GDD.md:18` | `0/60 cited (0%), 60 placeholder` + the per-section counts (6/10/8/3/6/19/1/1/3/1/1/1) | `pnpm rules:provenance` | **reproduced exactly** |
| `README.md:198`, `ENGINE.md:264` | goldens: `6 entries`, `nodeMajor: 24`, with the six names | read `packages/testing/goldens/state.json` | **reproduced exactly** |
| `GDD.md:70–76` | seed 42 tiny 2 civs: `treasury 10`, `rates {6,4,0}`, `despotism`, units `settler,worker,settler,worker`, `28 huts`, `30 resources`, `0 improvements`, `SCHEMA_VERSION 9` | `GDD.md:407`'s own `npx tsx -e` block | **reproduced exactly** |
| `ENGINE.md:164` | `CORE_INVARIANTS` = **35 named predicates** | `civts sim --json` → `invariants.count 35` + 35 names | **reproduced** |
| `KNOWN-ISSUES.md:3.1` | `sim --seeds 3 --map-size duel --civs 2 --turns 60 --policy simple --override units.warrior.attack=3 --json` → exit 1, `captured-city-consistent`, seed 3, turn 27 | the command, verbatim | **reproduced exactly**, message and turn included |
| `KNOWN-ISSUES.md:3.2` | three stale "luxuries still do nothing (happiness is M9)" sites | `grep -rn "still do nothing" packages/*/src` | **still present**: `cli.ts:178`, `repl.ts:68-70`, `repl.ts:2820-2821` (the doc warned that the numbers would move) |
| `BALANCE.md:304–306` | the 100/150/200-turn rows | the three commands in the block above | **150 and 200 reproduced exactly** (§B2); 100 derived and cross-checked |
| `BALANCE.md:312` | "the 200-turn run uses 21 % of it" | `188,284.5 / 900,000` | **reproduced** (20.9 %) |

**F3 — a documented rule the engine does not implement.** `docs/GDD.md:356` says

> | domination | you own enough of the claimed land **or** of the world population | 60% land, 40% population |

and the shipped catalog says the same in its own prose (`packages/rules/src/index.ts:872`
"land **or** population share"; `:2249` "60% of claimed land **or** 40% of civilian population";
`:2254` "exactly 60% of the claimed land wins"; `:917` "the share of the world's **claimed** land").
The engine does neither of those things:

- **both** shares must hold — `packages/core/src/victory.ts:235` returns early when the land half
  fails, and `:245` then tests the population half; the deviation from the contract's word is argued
  at `:204–216`, and `m9-m10-adversarial.test.ts:649–656` pins it ("the land half is **necessary**,
  which is the half an 'or' reading would have let through");
- the land denominator is the **map's** land (`landTileCount`, `core/map.ts:473`), not claimed land —
  `victory.ts:206–208` records the change and why the claimed-land denominator made domination fire
  on turn 1.

So 872/2249/2254/356 and the "claimed land" field doc are stale in two independent ways, in the two
places a reader is told to trust — the GDD and the catalog. Nothing in the repository records this
(`KNOWN-ISSUES.md` §3 lists the luxury prose, not this). Two extra notes: the frozen contract itself
says "or" (`docs/INTERFACES.md:2050`, which I may not edit), and
`m9-m10-adversarial.test.ts:591` says *"The contract's prose says 'land **and** pop'"* — which is the
opposite of what `INTERFACES.md:2050` actually says. **This is the one place where the docs overstate
what the system does**: they promise an easier rule than the engine implements.

**F4 — one figure that does not reproduce.** `docs/BALANCE.md:331` gives the pooled, double-counted
row as **0.9 %**. The counts in the same row (27 seat-1 wins of 38 endings) give
`P(X ≥ 27 | n = 38, p = ½) = 0.69 %` (verified two ways: `Math`-free integer combinatorics and an
independent `python3` `math.comb` computation). No neighbouring count gives 0.9 %. The row is labelled
"*do not read this row*", so nothing downstream turns on it, but a figure in the docs that a reader
cannot reproduce is exactly the class A7 exists to catch.

**Also checked and honest, so recorded as no-finding:** the README's own flags on its stale numbers
(`README.md:130` and `:150–170` say the 64.0 s reading is from the previous script and that the
composed `pnpm verify` was not measured green — that was true, and it is measured green above);
`BALANCE.md:346–373`'s shortfall table for `conquest`/`domination` (0 of 60) — reproduced;
`ENGINE.md:495–505`'s "what this document does not claim", which is accurate.

### B8. Mutation check — three mutations, each RED, sources restored

Baseline hashes taken before, restored and re-checked after:

```
3d0c3071127a19658d6276f20789017d32793359933372e6dff2307005bae8aa  packages/sim/src/tournament.ts
590523d3bb098bf8c327834be5d6c0eb6f438680740242970187678fc1b5e962  packages/headless/src/sim-cli.ts
94cb4c293386bc61d244409764a92a615c293076198dc5715034d5080aa2882a  packages/headless/src/repl.ts
e0e8098ed9631cb395978984504b5120bed9bd5753b8e794860e970b073b260d  packages/sim/src/batch.ts
→ after the three mutations and their reverts: identical (diff of the two hash files is empty)
```

| # | mutation | file:line | test run | result |
|---|---|---|---|---|
| A | the census counts every ending under `cultural` (`tallies.get(outcome.condition)` → `tallies.get('cultural')`) | `packages/sim/src/tournament.ts:1121` | `npx vitest run packages/sim/test/tournament.test.ts` | **RED — 2 failed** (`conditions` row for `score` came back `games: 0`) |
| B | the per-game report names the wrong condition on the live path (`condition: outcome.condition` → `'conquest'`) | `packages/headless/src/sim-cli.ts:2947` | `npx vitest run packages/headless/test/sim-cli.test.ts` | **RED — 1 failed** |
| C | the winner is dropped from the per-game report (`winner: {…}` line deleted) | `packages/headless/src/sim-cli.ts:2949` | both files | **RED — 3 failed** |

Mutation **B′ (a first attempt) is itself a small finding.** I first applied the same
wrong-condition mutation to the **`winner === null` arm** (`sim-cli.ts:2926`) and **nothing failed**:
the whole `sim-cli` suite stayed green. That arm is the draw path, which no shipped condition
reaches in a tournament, so the mutation was vacuous rather than the tests being absent — but it is
worth writing down that the draw arm of `gameOutcomeReport` is not covered, and that a mutation there
proves nothing.

---

## C. What I changed, and what I deliberately did not

**Changed:**

- `p1-probe-seat.ts` → `scripts/probes/seat-effect-probe.ts`, `p1-probe-starts.ts` →
  `scripts/probes/starting-position-probe.ts` (relocated into the typechecker's include, formatted,
  dead `terrainDef` import removed, header updated to say where they came from and why).
- **Added** four verification instruments, all in `scripts/probes/`, all typechecked, linted and
  formatted: `outcome-aggregate-probe.ts`, `invariant-check-count-probe.ts`,
  `report-follows-engine-probe.ts`, and the two relocated ones. They exist so every claim in this
  report has a command anyone can re-run.
- **Nothing else.** No source file under `packages/` was left modified by this pass, and no test was
  weakened, skipped or deleted.

**Not changed, on purpose:**

- **F2** (the derived `checks` figure) — the fix is a semantic decision about what a decided game
  should report, in files P1 owns; I measured it instead.
- **F3/F4** (the stale domination prose and the 0.9 % figure) — a docs pass owns its own numbers, and
  the correct text has to be chosen with the engine's AND as the authority, not silently rewritten by
  a verifier.
- `docs/INTERFACES.md` (frozen, including its own "or" at line 2050) and `PLAN.md`, as instructed.

---

## D. Every claim in one line, with its command

```bash
pnpm verify                                     # EXIT 0, 31.4 s warm / 56.2 s cold, load 2.11→4.89 / 2.87→6.16
pnpm verify:full                                # EXIT 0, 431.1 s and 422.1 s, 2163 passed, 2 skipped by name
pnpm map --seed 42 --map-size tiny --civs 2     # hash 782fe5306476b5d5, starts 0@45,15 1@49,52
pnpm rules:provenance                           # 0/60 cited, 60 placeholder
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json   # 13/20 ended, all cultural, seats 3/10
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 200 --json   # 20/20 ended, cultural 18 + score 2, seats 8/12
npx tsx scripts/probes/outcome-aggregate-probe.ts          # permuted seeds + permuted aggregate: identical census
npx tsx scripts/probes/starting-position-probe.ts          # seat 0 grassland ×20; seat 1 plains ×5 (seeds 3,8,12,16,20)
npx tsx scripts/probes/report-follows-engine-probe.ts      # move the catalog threshold, watch the report follow
npx tsx scripts/probes/invariant-check-count-probe.ts      # the deciding turn is never checked
npx tsx packages/headless/src/cli.ts sim --seeds 3 --map-size duel --civs 2 --turns 60 \
  --policy simple --override units.warrior.attack=3 --json # EXIT 1, captured-city-consistent, seed 3, turn 27
npx vitest list --filesOnly | wc -l                        # 64 collected, 0 of them e2e
```
