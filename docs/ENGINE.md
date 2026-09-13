# ENGINE — architecture, and the rules that keep it honest

Companion to `PLAN.md` §5 and `INTERFACES.md`. This file records how the engine is
put together, what is mechanically enforced, and — in the last section — the defect
classes this project actually hit, milestone by milestone, so whoever continues it
does not have to rediscover them.

Written against commit `d4e7f72` (M0–M10 landed; M11 in the working tree). Every
figure is a reading taken in one session on 2026-09-13 between 18:14 and 18:44 UTC
on an eight-core shared box (load average 3.0–13.1), labelled with the time it was
taken. Numbers in this project go stale silently; assume nothing that is not dated.

---

## 1. Shape

```
packages/
  core/       the engine — pure, deterministic, zero runtime dependencies
  rules/      typed content: every row carries a provenance field
  testing/    hashing (canonical JSON → FNV-1a 64), goldens, the scenario DSL, tier predicate
  sim/        the simulation harness: invariants, policies, the AI, batch, tournaments
  headless/   the CLI (map, play/REPL, sim, tournament, provenance)
  web/        the browser host (Vite + Canvas 2D) + its Playwright suite
scripts/      evidence, run on purpose: balance sweeps, tournament evidence, behaviour probe
```

Four decisions that everything else follows from:

- **Pure functions over plain data.** No class holds hidden state. `newGame`,
  `applyCommand`, `advanceTurn` and every helper take a state and return a new one;
  the input state is never mutated (asserted against a frozen state in tests).
- **The browser is the engine host.** `core` and `rules` import nothing from Node,
  so the page runs the same source the tests do. There is no server-side game state
  and no second copy of the rules — a stateful server would be one more pair of
  things that must agree, and this project has found that defect class eight times.
- **One writer per fact.** A value is computed in exactly one function and asked
  from everywhere else. Two numbers that must agree are two numbers that will
  disagree; the M2 provenance summary learned it, the M7c tournament cost paid for
  it again, and the fix both times was "one function yields the number".
- **Derived, never stored.** Visibility, city yields, borders, happiness, victory,
  score and score totals are computed on demand. A derived value that is also
  stored can drift, and a stored copy can disagree with the board.

State is carried in branded ids (`PlayerId`, `UnitId`, `CityId`, `TileIndex`, …) so
a `CityId` cannot be passed where a `UnitId` is expected; entities are **arrays
sorted by id** (`units`, `cities`, `players`) rather than records keyed by numeric
ids, because JSON turns numeric keys into strings — a lie in the type — while arrays
keep ordering deterministic, and ordering is hashed. Sparse per-tile facts
(`improvements`, `resources`) are `(tile, id)` pair lists, sorted and unique, with
**no sentinel "none"**: an absent pair *is* "nothing here".

`SCHEMA_VERSION` is **9** at `d4e7f72`. It moves whenever the persisted shape moves,
and a move means regenerating every golden intentionally (see §6).

---

## 2. Determinism

- **RNG lives inside `GameState`** and every draw returns `[value, nextState]`.
  There is no ambient randomness and no ambient time anywhere in the engine.
  Simulation is integer-only: food, shields, commerce, gold, beakers, culture,
  happiness and score are integers, and a float that influences a decision must be a
  deterministic computation of integers.
- **The guarantee is scoped, and stated where it is made:** identical state hashes
  are guaranteed for a pinned `(engine version, Node major)`. The golden file records
  `nodeMajor` (`24`) and fails loudly on a mismatch, so a Node upgrade is an
  intentional rehash rather than a mystery diff. Cross-Node-version hashing is
  untested **by construction**. Measured here: Node `v24.20.0`, pnpm `11.24.0`.
- **The lint guard.** `Math.random`, `Date.now`, `new Date()`, `performance.now`,
  `process.hrtime`, `Math.pow`, `Math.sin`, `Math.cos`, `Math.log`, `Math.exp`,
  `Math.tan`, `Math.atan2`, `Math.log2` and friends are banned by the flat eslint
  config inside **both** `packages/core/src` and `packages/sim/src` (the sim package
  was outside the guard until the S-wave verifier found the hole: the package that
  must be deterministic was the one not covered). `scripts/` is typechecked too, for
  the same reason.
- **The guard's own limits are recorded rather than implied.** `Math` aliasing
  (`const M = Math; M.random()`) and `globalThis.Math.random()` are **not**
  lint-enforceable; the `Date` half of the aliasing gap *is* closed
  (`no-restricted-globals`). For those spellings the determinism claim rests on
  review plus the golden-hash gate, not on lint.
- **The AI cannot touch the world's RNG.** Each policy draws from its own stream
  (`policyRngFor`), never from `state.rng`. That is load-bearing rather than
  stylistic: if the AI drew from the world stream, changing the AI would change the
  world and two strategies could not be compared on the same seed. A test swaps a
  random-drawing policy for a do-nothing one and shows the world RNG trajectory is
  byte-identical while the game differs — and, after a mutation that *read* the
  stream without acting on it passed the whole file, a **read-counting** guard trips
  on that too.
- **Fresh-process determinism is verified**, not assumed: hash comparisons run in a
  second `npx tsx -e` process as well as in-process, because an in-process repeat can
  agree with itself for the wrong reason.

---

## 3. The turn pipeline

The order is a contract and lives in exactly one place,
`packages/core/src/turn.ts`:

1. work progress (unit-id order) → 2. growth (city-id order) → 3. production
(city-id order) → 4. culture (city-id order) → 5. research (player-id order) →
6. the money loop (player-id order) → 7. the barbarian step (unit-id order) →
8. movement refill → 9. ownership recomputed → 10. `turn += 1`.

`advanceTurn` is a module rather than a branch of `EndTurn` because the ordering is
exactly the kind of rule that gets quietly re-derived: the CLI, a scenario harness, a
"skip turns" convenience and the AI all want to advance the world, and if each spelled
*work, growth, production, refill, turn* in its own words the game would have several
definitions of a turn that agree only until somebody edits one.

Each position is observable and pinned by a test. The reasoning, in the code's own
terms: work first so an improvement finished this turn counts this turn; growth
before production so a city that grows also produces slightly more that turn;
research before the money loop so no beaker is credited and spent in the same step;
the money loop after production (a unit produced this turn is paid for from the turn
it appears) and before the refill (a disbanded unit gets no movement back); the
barbarian step after the money loop (a captured city still pays its former owner that
turn) and before the refill (an attack spends all movement); and a finished game
returns the state unchanged.

`docs/GDD.md` §3 carries the same order with the design consequences spelled out.

---

## 4. The keystone invariant, and the invariant registry

### 4.1 The keystone

**Every action a generator offers must apply, and every command the applier accepts
must be offered by the generator.** Both directions, always, over every generator:

- yielded actions that are refused → the AI and the UI advertise moves the engine
  rejects;
- accepted actions that are not yielded → the AI never considers a legal move.

`INTERFACES.md` M2 states it; the sweep over the full candidate universe is
`packages/testing/test/m2-adversarial.test.ts`, and it is the single most expensive
thing in the repository (measured this session: **437 s of the 491.6 s full tier**
for that one file, whose two whole-board sweeps alone took 202.1 s and 231.4 s).

The rule exists because the failure is invisible from either side alone. Found in
practice:

- **M2** — `legalActions` yielded `EndTurn`, but applying it failed when a unit's
  type was absent from the ruleset. The counterexample test was **inverted, not
  deleted**, so it is now evidence *for* the property. `EndTurn` was made total
  (refill what it can resolve, leave the rest alone).
- **M5** — `planSetProduction` asked only the resource gate, so `applyCommand`
  accepted orders `cityProductionOptions` refused — a live generator/applier
  disagreement — and `planStartWork` ignored the tech gate entirely.
- **M8** — the same property at the presentation layer: no control may offer an
  action the engine refuses, and every action the engine accepts must be reachable
  from the UI. Both directions, with non-vacuity guards, because the first draft of
  the UI sweep silently clicked nothing and looked clean.

The setters (`SetWorkedTiles`, `SetProduction`, `SetRates`, `SetGovernment`) are
**planner-only**: they are not enumerated by `legalActions` (a rate triple is a
search space, not a list, and a setter emits no event), so legality is stated once in
`plan*` and the same both-directions sweep covers them through the planner.

### 4.2 The registry

`CORE_INVARIANTS` in `packages/sim/src/invariants.ts` — **35 named predicates**,
counted this session by importing the module. Shape checks first, transitions last.
The context each check receives carries the **previous** state as well as the current
one (`previous` is absent on the first turn) and the turn's events, because
conservation is only expressible as a transition — M6 had to repair four pre-existing
predicates when live barbarians arrived, since a sack halves population and clears
worked tiles and the food and shield conservation checks had assumed growth and
production were the only writers. A caller may run a subset.

| # | invariant | # | invariant |
|---|---|---|---|
| 1 | `treasury-non-negative` | 19 | `unit-not-inside-foreign-city` |
| 2 | `pools-non-negative` | 20 | `captured-city-consistent` |
| 3 | `player-pools-integral` | 21 | `combat-hit-point-conservation` |
| 4 | `city-population-at-least-one` | 22 | `improvements-sorted-and-unique` |
| 5 | `city-food-box-within-threshold` | 23 | `resources-sorted-and-unique` |
| 6 | `city-shields-non-negative` | 24 | `wonder-held-by-one-city` |
| 7 | `city-works-at-most-its-citizens` | 25 | `tile-owner-matches-culture` |
| 8 | `tile-worked-by-one-city` | 26 | `tile-owner-names-a-real-player` |
| 9 | `worked-tile-in-city-radius` | 27 | `tile-owned-by-a-city-in-range` |
| 10 | `city-ids-unique-and-sorted` | 28 | `government-is-in-catalog` |
| 11 | `city-tile-unique` | 29 | `rates-within-government-caps` |
| 12 | `unit-ids-unique-and-sorted` | 30 | `city-culture-non-negative-and-integral` |
| 13 | `unit-tile-in-bounds` | 31 | `disorder-zeroes-the-yields` |
| 14 | `unit-owner-exists` | 32 | `finished-game-does-not-advance` |
| 15 | `unit-movement-in-range` | 33 | `gold-conservation` |
| 16 | `unit-hit-points-in-range` | 34 | `city-food-conservation` |
| 17 | `unit-hit-points-above-zero` | 35 | `city-shield-conservation` |
| 18 | `unit-experience-in-range` | | |

Reproduce the list (names and count):

```bash
npx tsx -e 'import {CORE_INVARIANTS} from "@civts/sim";
console.log(CORE_INVARIANTS.length); console.log(CORE_INVARIANTS.map(i=>i.name).join("\n"));'
```

The registry's own history is part of the ledger below: two cities on one tile was
caught by **nothing** until `city-tile-unique` was added; a food-box check that was
one turn too strict fired on shipped content and truncated 5 of 50 runs; and
`happiness-counts-add-up` was removed for being both a tautology and false on correct
play. A check that fires on correct play is worse than no check, because it teaches
readers to ignore the harness.

---

## 5. Gate tiers, and the measured budgets

Two tiers, **one vitest config and one test glob**. Long tests mark themselves with
`it.skipIf(!FULL_TIER)` — the predicate lives once, in `@civts/testing`'s `tier.ts`
— so the full tier is the fast tier with the long tests *running* rather than an
`exclude` that leaves no trace: a skip is reported **by name** in the fast run's own
summary. A tier split that silently stops running tests is worse than a slow gate,
because the tests still look like they exist.

| command | contains | bound | measured |
|---|---|---|---|
| `pnpm verify` | `check:static` + `vitest run` | ≤ 70 s internal target; A5's own bound is 90 s | **64.0 s** wall, 18:25 UTC (pre-M11 script), 61 files, 2023 passed / 56 skipped of 2079. Components of the re-drawn gate at 18:48–18:52: typecheck 8.2 s, cached lint 4.2 s (uncached `lint:full` 31.0 s), cached prettier 3.1 s, tests 24.5 s over 64 files / 2095 passed / 56 skipped of 2151. Composed `pnpm verify` did **not** go green in this window — it stopped inside `check:static` on M11's own in-flight files (8 unformatted, 1 eslint error, 1 typecheck error); the test step was green on every attempt |
| `pnpm verify:full` | `check:static:full` + `CIVTS_TEST_TIER=full vitest run` | ≤ 10 min (A5) | **491.6 s** wall, 18:27–18:35 UTC, 61 files, 2077 passed / 2 skipped of 2079 |
| `pnpm --filter @civts/web test:e2e` | the real app in headless Chromium | not part of either gate | **249.1 s**, 57 passed / 4 failed at load average 9.4; the 4 files re-run alone: 9/9 passed, 87.2 s |
| `pnpm tournament:evidence` | A3's 20 seeds × 100 turns | not a gate (M7b) | **149.8 s** wall |
| `pnpm mutation:check` | the mutation battery, alone | not a gate | **not run this session** (it edits source files on disk for ~3 s; other agents were working in the tree) |

Two things about those numbers are more important than the numbers:

- **The bound is on the command a person runs, never on vitest's internal
  duration.** M7 compared 65.9 s *inside vitest* against a bound on `pnpm verify`
  and declared A5 satisfied while the command actually took 104 s. Wall time or it
  did not happen.
- **The split must be honest.** M7b moved 11 tests behind the full tier and proved
  the arithmetic closed: 1833 passed + 51 skipped = 1884 = 1884 passed in full, 0
  missing, 0 not-passed, no test skipped in fast and run nowhere; assertion counts
  per changed file were none-down. Nothing was deleted to buy speed.

**The fast tier's headroom is thin and should be said plainly.** 64.0 s against a
70 s target leaves **6.0 s** (8.6%), and roughly half of the wall time was static
analysis rather than tests — the M9+M10 wave measured 78.3 s wall on the same box
with about 47 s of it eslint and prettier. The M11 wave therefore re-drew the scripts
into a parallel, cache-backed `check:static` (with `check:static:full`, `lint:full`
and `format:check:full` kept for an honest uncached pass); that change landed in the
working tree during this session, so the 64.0 s reading above is from the **previous**
serial script. The re-draw's own components were measured at 18:48 and are in the
table: **cached lint 4.2 s against 31.0 s uncached**, three static steps in parallel
rather than in sequence, and the test step at 26.3 s. Whether that lands the composed
command inside 70 s is a claim nobody has measured yet, so it is not made here.

Reproduce the raw numbers:

```bash
time pnpm verify
time pnpm verify:full
cd packages/web && time pnpm exec playwright test --config playwright.config.ts
time pnpm tournament:evidence
```

---

## 6. Goldens: the policy that makes them worth having

`packages/testing/goldens/state.json` maps named scenarios to state hashes. Measured
this session: **6 entries**, `nodeMajor: 24`.

| entry | what it is |
|---|---|
| `tiny-civs2-seed1`, `tiny-civs2-seed42`, `tiny-civs2-seed1337` | `newGame` at turn 0 — the schema, generation and pipeline gate |
| `played-civs2-seed42` | a played 30-turn game: founds a city, builds an improvement, produces a unit and a building, grows, researches, runs the money loop |
| `played-civs2-seed42-combat` | that game with a real `AttackUnit` applied (M6) |
| `played-civs2-seed42-victory` | that game continued to the turn limit, where the **score condition ends it** and seat 0 wins (M9+M10) |

The rules:

- **Never auto-write.** A mismatch FAILS the test with the expected and actual hash
  and the instruction to regenerate intentionally. A golden that rewrites itself on
  mismatch cannot fail, and therefore cannot detect anything. Writing happens only
  through an explicit opt-in path, never by a test run.
- **A damaged file is loud, never "missing".** Malformed JSON, a wrong field type, a
  bad digest or an empty entry list all throw — treating corruption as absence would
  let a truncated file pass as "no goldens yet".
- **A hash may only move intentionally**, in the same commit, with a `rehash:
  <reason>` line in the commit message. Every rehash so far:
  `SCHEMA_VERSION` 1→2 (M2, units/explored), 2→3 (M3, cities/huts), 3→4 (M4a, improvements), 4→5 (M4b,
  treasury/rates), 5→6 (M4c, resources), 6→7 (M5, tech), 7→8 (M6, hit points and
  combat content), 8→9 (M9+M10, culture/government/ownership). M6b and M7 each
  moved **no** hash and said so — a relocation is not a rebalance, and the
  byte-identical golden hashes are the evidence.
- **The goldens gate less than they look like they do, and that was measured.** A
  golden state is `newGame`, so it contains no city and no M3/M4 mechanic runs on it:
  breaking compound flooring or wonder uniqueness each turned the suite red while
  `golden.test.ts` stayed green. That is why played, combat-bearing and
  victory-bearing goldens were added.

---

## 7. The lesson ledger

The recurring defect classes this project actually hit, each with the milestone it
came from. This is the part worth reading first.

### 7.1 Two things that must agree, disagreeing

The most expensive class in the project, hit at every layer:

| milestone | what disagreed |
|---|---|
| M1 (F3) | `loadSettings({ruleset: undefined})` kept the key, so `hashValue` threw on the natural CLI wiring |
| M1 (F4) | `canonicalize` invoked getters, so a plain object with an impure getter hashed unstably |
| M2 (F4) | the provenance summary counted 11 rows while the `provenance` CLI printed 6 |
| M2 (F5) | **two writers of the explored layer**: `state.ts` kept its own `START_EXPLORED_RADIUS`, duplicating `fog.VISIBILITY_RADIUS`, and walked its own box |
| M3 (F1) | `City.production` was required-but-`undefined`, so **every state containing a city was unhashable** |
| M4c | the granary's and Pyramids' `growth-food` effect was validated, declared — and applied to **nothing**: `cityGrowthTarget` had no caller anywhere in `src` |
| M5 | `planSetProduction` asked only the resource gate, so the applier accepted what the generator refused |
| M7c | one tournament-cost figure recorded independently in **five files**, stale by 1.66× in all five; the stale-copy guard then found a **sixth** copy in `civts --help`, stale by 8× |
| M9+M10 | `planSetWorkedTiles` declared an M9 error kind that **no code constructed**, so a module note was simply false |

**Rule:** state a rule once, in one function, and ask it from everywhere. If two
places must agree, make one of them derive the answer. Derived, never stored.

### 7.2 `undefined` in a payload, and absent fields

`canonicalize` rejects `undefined` **by design** (state must be plain data), and this
project paid for that three times: M2's `Settings.ruleset`, M3's `City.production`,
M4a's `Unit.work`. Each time the fix belonged in the **producer and the type**, never
in the hasher, and `exactOptionalPropertyTypes` now makes the unhashable spelling
unrepresentable. M7d's `plannerFailures` follows the same rule in the other
direction: required and always present, an empty array when there is nothing to say —
a consumer cannot forget it, and it is never an explicit `undefined`.

**Rule:** optional means *absent*. Never write a key with an explicit `undefined`
value into state or a payload.

### 7.3 A check that cannot fail — or that fires on correct play

- **M1**: goldens must never auto-write; a golden that fixes itself proves nothing.
  The M1 review then probed the committed goldens by fault injection to show they
  *could* fail.
- **M4b/M5**: the food-box invariant was **one turn too strict** and fired on shipped
  content (5 of 50 seeds), because growth runs before production and a granary
  completing that turn lowers the threshold afterwards. Worse than a red test: it
  truncated 5 runs to turn 12 while 45 reached 20, so **batch aggregates were
  silently mixing horizons**.
- **M7e (G2-2)**: the test written to pin the reused-instance bug was **vacuous
  against the very mutation it named** — its fixture minted a fresh record per throw,
  which is exactly the property that made the old behaviour silent. It was caught
  only because a verifier *ran* the mutation instead of reading the test.
- **M9+M10**: `happiness-counts-add-up` was a tautology about a pure function **and**
  false on real play (a small city with a large luxury purse overlaps its counts by
  design). Removed; the disorder rule it was standing in for is checked by
  `disorder-zeroes-the-yields`.
- **M8**: the first UI sweep silently clicked nothing — reading a unit's action group
  before selecting the unit returns an empty list, so an empty sweep looked like a
  clean one. Non-vacuity guards are now documented helpers.

**Rule:** a check that cannot fail is decoration, and a check that fires on correct
play trains readers to ignore the harness. Prove every new check by breaking the
thing on purpose.

### 7.4 Silent failure

- **M3 (F3)**: `outcomeText` switched on two event kinds and returned `undefined` for
  the rest, which joined into a **silently blank line**.
- **M5**: the same shape in the REPL — four switches silently lost their "legal:"
  lesson for a refused attack because `unitIdOf` had no case for the new commands.
  **M6** hit it again, in the same place.
- **M7c, the near-miss worth remembering**: a dangling reference in a scratch copy
  made a 100-turn game "complete" in 0.9 s with one city and six units instead of
  fifteen and ten — no error, no warning, and a plausible hash, because the
  `ReferenceError` fired on the first military unit of every turn and was swallowed
  by `planTurn`'s `catch {}`. A tournament would have published that game's metrics
  as evidence.
- **M7d→M7f** took three rounds to close: the typed `PlannerFailure` was real but
  **unwired** (nothing read it); then fixing the silence made the record **lie** (a
  reused instance could hand run B a record produced in run A); then the (position,
  phase) key over-reported a count in a multi-seat diagnostic. Each round was found
  by falsifying, not by reading.

**Rule:** a failure that is not a value does not exist. Errors are typed, carried by
the result, counted like violations, and reflected in the exit code.

### 7.5 A literal buried in logic

The project's standing simulation-first requirement says every magnitude a system
introduces lives in the catalog (or an explicit override), never as a literal in
logic — because **a system whose knobs cannot be swept cannot be balanced**.

- **M6** shipped combat's nine most important magnitudes as module constants in
  `core/combat.ts`, and the combat sweep was reduced to *reporting* that it could
  not move them. **M6b** relocated all nine into a validated `combat` section with
  the same numbers (a relocation, not a rebalance — every golden hash stayed
  byte-identical, which is the evidence).
- **M7** moved the last one, `CAPTURE_POPULATION_DIVISOR`, out of `cities.ts`.
- **M9+M10** moved `FREE_UNITS_PER_CITY` and `UNIT_SUPPORT_COST` into the
  `governments` rows.
- **M6b** also made the override surface **report unknown sections** instead of
  accepting and ignoring them. That matters more than it sounds: a silently dropped
  override makes a sweep report "no effect" when the truth is "never applied".
  `techs` is explicitly unpatchable and says so — the tech sweep has to scale the
  catalog directly, and it prints that gap rather than papering over it.

### 7.6 Row and iteration order are real inputs

- **M4a**: `improvements.ts` documented a pair ordering that the engine did not sort
  by. That ordering is **hashed**, so a reader "correcting" the code to match the
  comment would have moved all three goldens.
- **S-wave**: catalog row order silently changed the game. Resolved by establishing
  that the ruleset hash *covers* row order — a reordered catalog is a different
  ruleset by identity, which makes replay safe, but only once checked. Coupling is
  now explicit, arbitrary row picks (`hut.ts`) are canonical, and the id/kind
  conflation in the improvement pair order is fixed.
- **M9+M10**: contested borders go to the higher culture with ties to the **lower
  city id**, "never to iteration order, because M5 proved row order is a real input".
- **M6**: barbarian tie-breaks go by **ascending tile index**, never map or catalog
  order.

### 7.7 Fixtures that lie about what they measure

- **M9+M10**: a fresh-process determinism fixture built a ruleset missing the new
  catalog sections, so the child stored a degenerate government and printed a
  different hash for every case — "a fixture disagreement wearing the costume of a
  determinism failure".
- **M7c**: the behaviour probe is required to **prove the changed paths were
  reached** — the replay recorded 538 settles, 1,154 tile assignments, 23,722
  production orders, 760 research, 965 rates, 9,235 `StartWork`, 53,581 moves, 563
  attacks and 1,800 fortifies. A comparison that never enters the changed code proves
  nothing.
- **M6/M6b/M7**: the combat sweep prints the magnitudes its override surface **cannot**
  move, with the reason, instead of a table that looks like evidence.
- **M7b**: the walls-bonus sweep was flat for two milestones, and a flat table has two
  entirely different explanations — the knob does not matter (a finding) or the knob
  was never in play (a limitation). The report now counts and prints the **exposure**
  whether or not the table moved.

### 7.8 Prose that was true when written

- **M7e** corrected four prose sites M7d had falsified and found three more of the
  same kind; the stale-copy guard scans for known strings and **cannot** catch a
  sentence that quietly became false.
- **Measured in this session, still open**: `packages/headless/src/cli.ts:157`,
  `packages/headless/src/repl.ts:70` and `repl.ts:2708` still tell the reader
  "luxuries still do nothing (happiness is M9)" while M9 has landed and the live
  banner correctly says luxuries content citizens. See `docs/KNOWN-ISSUES.md`.

### 7.9 Measurement mistakes

- **M7**: the agent compared vitest's internal 65.9 s against a bound on the
  *command* (90 s) and reported A5 satisfied; the command actually took 104 s. The
  regression was recorded rather than reworded.
- **M7b**: three parties re-measured the same tier (54.8 / 55.7 / 58.2 s) and the
  rule became explicit — report the command's wall time, never vitest's internal
  figure, and never a run that overlapped another job.
- **M7c**: the A3 budget was widened to 1800 s because the AI cost 26–43 s per game
  — then the AI was optimised by 8× and the justification evaporated, so the bound
  went back to 900 s: "1800 s would have tolerated a 16× regression and still
  reported `withinBudget: true`, and a runaway detector that cannot detect a 16×
  runaway is decoration."

### 7.10 Orchestration and process

- **M2 (F6)**: a contract amendment orphaned test files whose authors had finished
  and been cleaned up, so no agent owned the migration and the gate sat red.
  **Standing rule: an amendment names a migration owner for *every* existing consumer
  before agents launch.** Escalating correctly is not the same as having an owner.
- **M3 (F5)**: an abort guard treated an out-of-scope blocker as fatal and skipped two
  phases. The guard must key on **who owns the blocker**, not on a `blocked` status.
- **M4b**: my draft required `legalActions` to yield `SetRates`; the implementing
  agent declined, and checking the precedent showed the agent was right and the
  contract was wrong. **Lesson: when an agent pushes back on a contract, check the
  precedent before defending the wording.**
- **M4c**: a harness restart interrupted the wave after three of five agents had
  landed; recovery was reading the disk and reproducing the claims, not trusting a
  lost report — and the gate state turned out to be fully diagnosable from disk.
- **M7d**: a verifier ran `git checkout --` on a file an agent was still editing and
  destroyed its uncommitted work (reconstructed and proven byte-identical
  afterwards). **Never revert uncommitted work in this pipeline.**
- **M8**: two agents failed mid-write; the milestone owner established what had
  actually landed from disk before writing anything.
- **M9+M10, the orchestration lesson**: the schema owner **died on a transport error
  having written zero files**, and a second agent died the same way. Three downstream
  agents each independently reported BLOCKED with no files written — correctly, since
  every file they owned was expressed in terms of a schema that did not exist, and
  inventing it would have recreated the dual-source bug. The integration owner then
  implemented the milestone itself. **I sequenced agents on the assumption that phase
  one had landed, without a guard that checked.** That is the project's own rule — a
  claim nothing verifies is a claim that drifts — applied to orchestration rather than
  to rules, and it is why a guard that checks the predecessor's output must exist
  before the successor launches.
- **Load sensitivity, measured this session**: the e2e suite failed 4 of 61 tests at
  load average 9.4 and the same specs passed 9/9 on a re-run at load average 13.1.
  A verdict that flips on machine noise is not a criterion.

---

## 8. What this document does not claim

- Cross-Node-version determinism is untested by construction.
- `Math` aliasing is not lint-enforceable; the golden gate and review are the
  control there.
- The fast tier's 6.0 s of headroom is a reading from a shared box, not a property.
- `pnpm mutation:check` was **not** run in this session (it mutates source files on
  disk while other agents were working in the tree).
- The M11 contracts (serialize/deserialize, replay) were still landing while this was
  written; §6's golden list and §5's gate numbers describe `d4e7f72` plus whatever the
  working tree held at 18:44 UTC.
