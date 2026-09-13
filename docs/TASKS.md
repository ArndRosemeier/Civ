# TASKS — the milestone ledger

Single writer: the main agent owns this file. Statuses: `[ ]` todo · `[~]` in
progress · `[x]` done · `[!]` blocked.

Milestone definitions and acceptance criteria live in `../PLAN.md` §12; alpha is
defined in §16. This file is the **ledger**: what landed, at which commit, and what
debt each milestone carried forward. The findings tables are kept because they are
the raw material of the lesson ledger in `docs/ENGINE.md` §7 — they are history, not
a to-do list, so a finding that has since been fixed still appears with its
resolution.

Compiled from `git log` at HEAD `d4e7f72`, 2026-09-13.

---

## The ledger, M0 → M11

| milestone | commit(s) | what landed | carried forward |
|---|---|---|---|
| **M0** Tooling & skeleton | `228ece8` | pnpm workspace; Node 24 pinned (`.nvmrc`, `engines`); strictest `tsconfig` + `@civts/*` aliases; eslint flat config with determinism bans; vitest; `verify`/`verify:full` tiers, non-interactive; `@civts/core` (branded ids, `Result`, provenance, typed settings); `@civts/rules` (catalog + validation); `@civts/testing` (invariant machinery); `@civts/headless` CLI with `provenance`. 27 tests green | determinism lint covered `core` only; `format:check` decorative until `e7f7bb0` |
| **M1** Core types, RNG, map gen, text renderer, hashing | `03d2064` (+`e7f7bb0` Prettier config) | `GameState` + `revision` + `SCHEMA_VERSION`; sfc32 integer RNG carried in state; integer-hash value noise with **quantile** sea level; deterministic `describe()` + snapshots; canonical JSON + FNV-1a 64 (outside `core`); golden harness (3 goldens) proven non-vacuous; CLI `map`. 5 agents against the frozen W1–W5 contracts, main agent wrote no implementation code | findings F1–F6 (below); `SetupError` variants; plan §5.3 reworded after F5 |
| **M2** Units, movement, fog, REPL, scenario DSL | `578282d` (+`989b05b` docs) | units in state (one settler per civ), `SCHEMA_VERSION` 1→2; terrain-cost single-step movement with typed errors; `unitMoveOptions`/`unitActions`/`legalActions`; per-player fog, one writer; `play` REPL with hash-pinned transcripts; scenario DSL + 3 acceptance scenarios; intentional rehash | findings F1–F6; 6 accepted-debt items (scenarios as player 0, no stacking limit, `pnpm scenario` unwired, `SetupError` cannot express scenario failures, `unitCatalog` assumes `ruleset.units`, TTY branch untestable here) |
| **M3** Cities v1 + goody huts | `c4f9e9c`, `274032b` (+`4750abd` docs) | `City` (population, food box, shields, queue, buildings, worked tiles); exact 21-tile radius, integer `cityYields`, `MIN_CITY_DISTANCE`; `FoundCity`/`SetWorkedTiles`/`SetProduction`; `advanceTurn` as the one definition of a turn; growth with observable carry-over + starvation; production queue; barbarians as a real `PlayerState`; huts; REPL city surface; scenarios with meta-tests; `SCHEMA_VERSION` 2→3 | findings F1–F5; debt: multi-growth unreachable, long-run invariants one-off, hut-under-city inert, hut `gold` deferred to M4, barbarian `startingTile` meaningless |
| **M4a** Tile improvements & workers | `25dd252` | sparse `(tile, kind)` improvement list with pure idempotent helpers; improvement catalog; `cityYields` applies improvements to **worked** tiles; `Unit.work` (optional); `StartWork`/`CancelWork`; work runs **before** growth and production; REPL `work`/`cancel`; scenarios | no starting worker, so improvements were unreachable from a fresh start — folded into M4b |
| **M4b** The money loop | `8ee69ef` | rates (10-slot split, default 6/4/0), commerce split with remainder to gold; treasury, income, upkeep, unit support; deterministic bankruptcy (highest unit id first, treasury floors at 0); pipeline gains the money step; `SetRates` + six events; REPL economy; **starting worker per civilization**; `SCHEMA_VERSION` 4→5 | `TreasuryShortfall` unreachable from shipped content; beakers and luxuries inert; unknown command discriminant throws; the adversarial file is the slowest in the repo |
| **M4c** Buildings, wonders & resources | `2a5137c` (+`8096f99` docs) | building `maintenance` + `effects` (commerce/beaker/shield multipliers, growth-food); wonders v1 (globally unique, never rebuilt, re-buildable after a bankruptcy disband); strategic/luxury/bonus resources; road connection by one deterministic 8-way BFS; strategic gating in the same place legality is decided; seven buildings with maintenance > 0; `SCHEMA_VERSION` 5→6 | golden coverage gap measured (no city in a golden); no `BuildingLost` event; production re-check asymmetry for hand-edited saves |
| **S** `@civts/sim`, the simulation harness | `b925b4b`, `51b196f` (+`445f693` docs) | `CORE_INVARIANTS` (21 predicates, **previous** state for conservation); `runSimulation` as a pure function of (seed, settings, ruleset, policies); `Policy` as the AI seam with its own RNG stream; per-turn metrics; order-independent batch aggregation; ruleset overrides; `civts sim` + `scripts/balance-sweep.ts` | goldens still covered no M3/M4 mechanic (closed in M5); 4 findings fixed in-wave |
| **M5** Technology | `8a46798` (+`2dd1d34` docs) | tech tree with prerequisite cycle detection and era ordering (17 rows then, 19 now); research spends the beakers that had been inert since M4b; tech gating on units, buildings, improvements and resources through one verdict; **a played, city-bearing golden** (4th); real gate tiers; `scripts/tech-balance-sweep.ts` | two real gate defects (below); no shipped row declared `requiresTech` yet; luxuries inert |
| **M6** Combat & barbarians | `9167918` | pure `resolveCombat` drawing from the world stream; per-round odds stored in the result; hit points, experience, fortification; `AttackUnit`/`FortifyUnit` (an attack spends **all** movement); city capture (population halved, non-wonder buildings destroyed maintenance-descending, wonders kept); engine-driven barbarians on the same combat path; registry 21→27; 5th golden with a real battle; `SCHEMA_VERSION` 7→8 | combat magnitudes were module constants (fixed in M6b); `CAPTURE_POPULATION_DIVISOR` still a literal (fixed in M7); four pre-existing invariants needed repair to survive live barbarians |
| **M6b** Make combat tunable | `96219a5` | the nine combat magnitudes **relocated** into a validated `combat` section (no golden hash moved — a relocation, not a rebalance); `RulesetPatch.combat`; the override surface reports unknown sections instead of ignoring them; capture bumps `revision` and folds fog like every other ownership change; the veteran-defender asymmetry documented at the odds site | the walls-bonus sweep is flat for a reason that was then unknown (diagnosed in M7/M7b) |
| **M7** A real opponent, and self-play | `381e331` | `packages/sim/src/ai/`: a policy that plays a complete game unaided, all 63 magnitudes in one patchable weights module; tournaments with per-seat aggregates, **seat rotation**, order independence and an honest budget verdict; zero violations as a PASS/FAIL condition; `capturePopulationDivisor` moved to the catalog | A5 regression (104 s wall measured, recorded not reworded) → fixed in M7b; the walls sweep only half fixed |
| **M7b** The gate budget, and an AI that besieges | `8e9ea21` | A5 restored by moving **tests** (11) to the full tier, with the arithmetic closed (1833+51 = 1884 = 1884) and a by-name skip reporter added; the 20-seed tournament became **evidence** (`scripts/tournament-evidence.ts`) rather than a gate test, cutting `verify:full` 489 s → 168 s; `civts run` defaults to a 2-game smoke run; two AI defects fixed (`battleWinPctOf` exponent, `walkTo` false arrival) so battles went 28→53 and captures 0→4 | Finding 1: A3 measured 861.8 s vs 519.4 s recorded in five files — 1.66× stale, headroom 4.2 % not 42 % |
| **M7c** An 8× cheaper AI | `19fbb69` | AI cost cut 8× with **all 20 final hashes byte-identical** (92,318 commands replayed against a pre-change worktree); `PlannerFailure` as a typed value instead of a swallowed `catch {}`; one home for the cost figures (`A3_TOURNAMENT_EVIDENCE`) plus a stale-copy guard over every shipped `.ts`; a read-counting guard for the world-RNG independence property | budget raised to 1800 s (reverted in M7d); F2-1 (reused instance reports a silent pass) recorded |
| **M7d** A failure the result carries | `d38f06c` | `SimulationResult.plannerFailures` / `TournamentResult` equivalents **required and always present**; a planner failure is counted like a violation and fails the run with exit 1; A3 re-run: 20 seeds, 106.8 s wall, 0 violations over 54,000 checks, 0 planner failures; budget restored to **900 s** because the justification for 1800 s had evaporated | F2-1 carried; process: a verifier ran `git checkout --` on a file an agent was editing and destroyed its work |
| **M7e** The reused-instance silent pass | `e0da387` | F2-1 fixed by baselining on the monotone `failureCount`; three pinned tests re-decided rather than loosened; four falsified prose sites corrected and three more found; A3 5.52 s/game, 87.7 % headroom | G2-1 (the record can *lie* about which turn failed) and G2-2 (the test pinning F2-1 was vacuous against its own mutation) |
| **M7f** A throw that really happened in that run | `5ab274e` | G2-1 closed (`failureCount` detects *that* it threw, `latestFailures` says *what*); G2-2 closed by freezing the fixture's record and re-running the mutation (9 tests red, including the two that matter; the pre-fix tree had 4 and `runner.test.ts` caught 0 of 29); full-tier figure re-measured and labelled | H2-1 (a multi-seat diagnostic can over-count) — closed in M8 |
| **M8** The web UI | `266760a` | `packages/web`: the browser **is** the engine host (no server state, no second copy of the rules); `window.__CIVTS__` test seam + an accessibility contract; 55 Playwright tests against the real app; the keystone property at the presentation layer (both directions, non-vacuity guarded); a 42-step script through real controls yields hash `5bb30583f797e496`, byte-identical to the headless replay; panels docked under the map; `SetRates` control; H2-1 fixed | two agents failed mid-write; the UI suite is load-sensitive (measured again in M11) |
| **M9+M10** Culture, borders, governments, happiness, victory, score | `d4e7f72` | culture per city, player total derived; borders as a recomputed tile-ownership layer with a culture-radius ladder and ties to the lower city id; governments in the catalog with rate caps and unit support; happiness as a pure verdict with **real civil disorder** (no shields, no beakers, no gold); four victory conditions evaluated at one point with `GameOutcome` derived and a finished game refusing commands; score from five catalog weights read by engine and UI; UI victory screen, border tint, culture/happiness panel, government selector, score column; registry 27→35; 6th golden records a **finished game**; `SCHEMA_VERSION` 8→9 | `planSetWorkedTiles` declared an error kind no code constructed; `happiness-counts-add-up` removed (tautology and false on correct play); orchestration failure below; gate budget left tight (78.3 s wall) |
| **M11** Save, load, replay + the alpha audit | `[~]` uncommitted in the working tree at `d4e7f72` | `core/src/serialize.ts` + `replay.ts` and their tests; `save`/`load`/`replay` verbs in the CLI and REPL; the gate re-drawn into a parallel, cache-backed `check:static` (with `check:static:full` for an uncached pass); the independent A1–A7 audit | see `docs/KNOWN-ISSUES.md` §3 — the tree was still moving while this ledger was written |

Documentation commits that carry no code: `e7f7bb0` (Prettier config inferred from
the codebase), `989b05b` (M2 findings), `4750abd` (M3), `8096f99` (M4c), `445f693`
(the sim harness), `2dd1d34` (M5).

---

## Findings, milestone by milestone

### M1 review findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | Determinism lint gaps: `new Date()`, `Math.exp/tan/atan2/log2/…`, `process.hrtime` uncaught; aliasing `const M = Math` unenforceable | medium-low | closed for the named calls; aliasing recorded as a guardrail limit |
| F2 | `nextBelow(bound > 2^32)` → `limit = 0` → **infinite loop**, reachable via `nextInt(rng, 0, 10**10)` | medium | fixed |
| F3 | `loadSettings({ruleset: undefined})` keeps the key, so `hashValue(state)` throws on the natural CLI wiring | medium | fixed |
| F4 | `canonicalize` invokes getters (an impure getter ⇒ unstable hash) | low (latent) | fixed |
| F5 | The plan claimed "no floats in authoritative state" while `settings.ai.aggression` is a float and is hashed | informational | **plan corrected**, not code: configuration floats are deterministic |
| F6 | `@civts/rules` `TerrainSpec` lacked `role`, so `Catalog` was not assignable to `RulesetView` | architectural | fixed; `role` is required |

### M2 review findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | The frozen `applyCommand(state, playerId, cmd)` was **unusable** — applying a command needs the destination's `moveCost` and each unit type's `movement`. The interim workaround made the ruleset an *optional* 4th parameter: it compiled and then refused every command at runtime, invisible to the typechecker | **high (silent)** | ruleset is a **required** 4th parameter; a 3-argument call is unrepresentable, pinned by a live `@ts-expect-error` |
| F2 | The keystone invariant was documented one-directionally. Sweeping the other direction found `EndTurn` *yielded* but *refused* when a unit's type was absent from the ruleset | medium | `EndTurn` made total; both directions stated; the counterexample test **inverted, not deleted** |
| F3 | `RulesetView` did not carry `units`, so the engine's view could not run a game; an interim alias papered over it | medium | `units` required; alias and structural guard removed |
| F4 | Provenance half-truth: `summarizeProvenance` counted 11 rows while the `provenance` CLI printed 6 | medium | fixed at the root — one function yields both sections and totals |
| F5 | Two writers of the explored layer: `state.ts` kept `START_EXPLORED_RADIUS`, duplicating `fog.VISIBILITY_RADIUS` | low | `newGame` folds `withExplored(visibleTiles(...))`; one radius, one writer, hash-neutral across 6 seeds |
| F6 | A contract amendment **orphaned test files whose authors had finished and been cleaned up**, so no agent owned the migration and the gate sat red | **process** | see standing rules |

### M3 review findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | `City.production` was required-but-`undefined`, so **every state containing a city was unhashable**. Third occurrence of this bug class | **high** | field optional; `exactOptionalPropertyTypes` makes the unhashable spelling unrepresentable |
| F2 | `players.length` now includes the barbarian, so `play --civs 2` printed "3 civs" | medium (visible) | `civPlayers()` everywhere the question is "how many civilizations", with a regression assertion |
| F3 | `outcomeText` switched on two event kinds and returned `undefined` for the rest, joining into a **silently blank line** | medium | exhaustive over `GameEvent` with an `assertNever` tail; a test asserts one non-empty line per event |
| F4 | The conservation sweep still asserted "a legal move moves one unit and nothing else", which the hut contract deliberately breaks | medium | made **hut-aware** rather than skipping hut moves; the counterexample was reproduced before authorising the change |
| F5 | The workflow abort guard treated an out-of-scope blocker as fatal and skipped two phases | **process** | the guard must key on *who owns the blocker*, not on a `blocked` status |

### M4a / M4b / M4c

- **M4a**: `improvements.ts` documented the pair ordering as "ascending code unit"
  while the engine sorts by index in `IMPROVEMENT_KINDS`. That ordering is **hashed**,
  so a reader "correcting" the code to match the comment would have moved all three
  goldens. Comment fixed; ordering pinned by a test.
- **M4b**: `SetRates` with a null or absent payload threw a `TypeError` where every
  other malformed payload returns a typed `GameError`; now read through a total field
  reader. The verifier also mutation-checked the gate itself (removing
  remainder-to-gold and reversing the disband order produced 17 failures; both
  mutations reverted, file hash confirmed identical).
- **M4b, my own error**: my draft required `legalActions` to yield `SetRates`. The
  implementing agent declined; I verified the deciding fact myself — the module yields
  no `SetWorkedTiles` and no `SetProduction` either, because setters have been
  planner-only since M3. The contract was wrong, not the agent.
- **M4c**: `growth-food` was declared by the granary **and by the Pyramids** —
  M4c's only wonder, whose sole effect it is — validated, and applied to **nothing**:
  `cityGrowthTarget` had no caller anywhere in `src`. Fixed as a threshold change
  with a regression guard; the fix moved **no** hash, and the agent said so rather
  than inventing a rehash.

### S-wave findings (verifying the simulation harness — all fixed)

1. The food-box invariant was one turn too strict and **fired on shipped content**
   (5 of 50 seeds); it truncated 5 runs to turn 12 while 45 reached 20, so batch
   aggregates were silently mixing horizons.
2. **Two cities on one tile was caught by nothing at all** — all 20 invariants
   returned empty. `city-tile-unique` added.
3. **Catalog row order silently changed the game.** The ruleset hash covers row
   order, so a reordered catalog is a different ruleset by identity — replay-safe,
   but only once checked. Arbitrary row picks (`hut.ts`) canonicalized.
4. Two **gate holes**: the determinism lint guard covered `packages/core/src` only,
   leaving `packages/sim/src` — the package that must be deterministic — outside it,
   and `scripts/` was never typechecked.

### M5 findings

- `planSetProduction` asked only the resource gate, so `applyCommand` **accepted
  orders `cityProductionOptions` refused** — a live generator/applier disagreement.
- `planStartWork` ignored the tech gate entirely, letting a worker start an
  improvement its owner could never finish.
- **The ambiguity I created**: the contract said research "reads the pool the split
  just filled" while placing research *before* the money loop. The implementing agent
  gave the right reading (beakers have one writer and one spender, so research spends
  the *previous* turn's pool); pinned by a test that discriminates the two readings.
- **Ruling**: a half-built gated item waits, nothing is charged, shields keep banking,
  the item is requeued. Two texts asserting the old M4c behaviour were corrected, with
  M4c's original reasoning quoted so the change stays auditable.

### M6 / M6b findings

- **The headline finding**, from falsifying rather than reading: a goody hut could
  place a barbarian band **inside a civilization's city** (`bandTiles` filtered
  adjacent tiles for units but had no city filter), a state no command can produce,
  reached from ordinary play. Fixed, with the reasoning at the rule site.
- Four REPL switches silently lost their "legal:" lesson for a refused attack, because
  `unitIdOf` had no case for the new commands.
- Ruleset validation gained a cross-check nobody asked for and it was kept: a terrain
  row whose `defenseBonus` and `defenseBonusPct` spellings disagree is refused.
- One knob demonstrates that modifiers genuinely floor away: grassland defence 0 and
  10 give **identical** rows, because `floor(2 × 1.0) = floor(2 × 1.1) = 2`.
- The relocation in M6b moved no hash, and the sweep's honest "cannot move" list
  shrank from ten entries to two.

### M7 → M7f findings

- **Five bugs found by making the AI's evidence measurable rather than reading it**:
  the rate rank ordered treasury above beakers (the AI banked 272–509 gold over 45
  turns and researched **zero** techs); there was no pathfinding (a soldier 13 tiles
  from its target over open grassland had **one** candidate step and stood still for
  30 turns); the replacement route search asked from the wrong position and then from
  a board the army was standing on; the garrison rule had no army-level ceiling (29 of
  35 soldiers sat inside cities at turn 50); two declared weights were never read.
- **Two more in M7b**, both found by measuring: `battleWinPctOf` computed
  `cumulative * p` where the negative binomial needs `cumulative * p ** needed` —
  181 % (clamped) where the truth was 16 %, invisible on every 1-hp row; and `walkTo`
  reported "arrived" for a beside-walk, so eight soldiers sat one tile from a siege
  target for ten turns. Fixing both took battles 28→53 and captures 0→4.
- **The near-miss worth recording (M7c)**: a dangling reference in a scratch copy made
  a 100-turn game "complete" in 0.9 s with one city and six units instead of fifteen
  and ten — no error, no warning, plausible hash — because the `ReferenceError` was
  swallowed by `planTurn`'s `catch {}`.
- **G2-2, about verification culture**: the test written to pin F2-1 was **vacuous
  against the very mutation it named**; caught only because a verifier ran the
  mutation rather than reading the test.

### M8 findings (found by building the UI, not by reading it)

- A drag-pan on the map issued a `MoveUnit` at the release point (a browser fires
  `click` after a drag) — fixed with a travel tolerance.
- A click on a tile holding your own city moved a unit instead of opening the city.
- Screenshots found the event log clipping the leading digit of every two-digit line
  number (lines past the ninth read `?4.` for a whole game), and the log not following
  its tail.
- The maps column was content-sized, and a city screen's max-content width is ~3130 px
  (twenty-one worked-tile labels on one line), which pushed the panel column off the
  window; `contain: inline-size` on the dock fixes it.
- Centring the dialogs with `position: fixed` was implemented, measured, found to
  regress three green tests, and **reverted with the evidence recorded**.

### M9+M10 findings

- `planSetWorkedTiles` declared M9's "a foreign tile may not be worked" error kind but
  **no code constructed it**: the automatic path refused and the manual path allowed,
  so a player could work a rival's land and a module note was simply false.
- `happiness-counts-add-up` was **removed** for being both a tautology about a pure
  function and false on correct play; the 200-seed full-tier sweep is what caught it.
- A fresh-process determinism fixture built a ruleset missing the new sections, so the
  child stored a degenerate government and printed a different hash for every case —
  a fixture disagreement wearing the costume of a determinism failure.
- Full-tier claims that M10 invalidated were **restated, not loosened**: a 50-run
  harness check now reports horizons of {20, 6} because a score victory ends seed 6 on
  turn 6; the M4b rate sweep expected every arithmetically legal triple to apply and
  M9's caps refuse 6048 of them, so the claim became planner/applier agreement with a
  non-zero refusal asserted; the walls fixture widened from 3 to 8 seeds because M9's
  borders and caps took its captures to zero.
- **Measured**: 2 of 8 games in a 120-turn tournament ended by a condition rather than
  the turn limit (recorded in the commit message; the M11 session re-measured the
  same property on A3's run — 5 of 20 games ended by a condition, `docs/BALANCE.md` §8).
- **The orchestration lesson**: the schema owner died on a provider transport error
  having written **zero files**, and a second agent died the same way. Three downstream
  agents each independently reported BLOCKED with no files written — correctly, since
  every file they owned was expressed in terms of a schema that did not exist. The
  integration owner then implemented the milestone. **I sequenced agents on the
  assumption that phase one had landed, without a guard that checked.** That is this
  project's own rule about claims and verification, applied to orchestration.

---

## Standing rules (each earned by a specific failure)

1. **An amendment to a frozen contract names a migration owner for every existing
   consumer before agents launch** (M2 F6). Escalating correctly is not the same as
   having an owner.
2. **A rule is stated once and asked from everywhere.** Two numbers that must agree
   are two numbers that will disagree (M2 provenance summary, M7c tournament cost ×5).
3. **Optional means absent.** Never write a key with an explicit `undefined` into
   state or a payload (M2, M3, M4a — three times).
4. **A check that cannot fail is decoration.** Prove every new check by breaking the
   thing on purpose (M1 goldens, M7e G2-2, M8's empty sweep).
5. **A check that fires on correct play is worse than no check** (M4b food box,
   M9+M10 happiness).
6. **Every magnitude lives in the catalog or an explicit override**, never as a
   literal in logic — a system whose knobs cannot be swept cannot be balanced
   (M6 → M6b → M7).
7. **Report the command's wall time, never an inner stopwatch** (M7's A5 failure).
8. **Never `git checkout --` a file an agent is editing** (M7d).
9. **The abort guard keys on who owns the blocker, not on a `blocked` status** (M3 F5).
10. **A guard must check the predecessor's output before the next wave launches**
    (M9+M10). A claim nothing verifies is a claim that drifts.
11. **When an agent pushes back on a contract, check the precedent before defending
    the wording** (M4b).

---

## Open decisions

1. ~~Renderer~~ Canvas 2D (isometric deferred; PixiJS deferred).
2. ~~Validation lib~~ valibot.
3. ~~Vision~~ enabled and verified 6/6; correctness is still assertion-based, vision
   is advisory.
4. Node 24 pinned to this machine.

## Known issues / debt

The live list, with the measurements behind each item, is `docs/KNOWN-ISSUES.md`
(§16.3 deferrals, open defects found by running shipped commands, UI limits,
verification limits). It supersedes the ad-hoc list that used to live here; the items
below are kept because they are the *history* of that list and each one names the
milestone that accepted it.

- All 60 rules rows are `placeholder` — `fidelity: "cited-only"` is expected to fail.
  (M0 → today.)
- **`newGame` does not re-check map capacity**: `settings.civCount` is bounded by
  `MAP_DIMENSIONS[mapSize].maxCivs` in `refineSettings`, but a hand-built `Settings`
  literal bypasses parsing. The type-safe fix is branding `Settings` so only
  `parseSettings`/`loadSettings` can produce one. (M0, still open.)
- **Map composition is seed-independent**: terrain thresholds are quantiles, so every
  seed yields the same proportions (62 % water). Arrangement and starts vary by seed.
  A deliberate, asserted property. (M1.)
- **`canonicalize` blind spots**, documented and pinned by adversarial tests:
  `-0 ≡ 0`, typed arrays equal their plain-array equivalents, non-enumerable
  properties are dropped, and a lone surrogate encodes identically to U+FFFD. (M1.)
- **Determinism is only verified on Node 24.** Cross-version hashing is untested by
  construction; the golden file records `nodeMajor` and fails loudly on mismatch.
  (M1.)
- **`Math` aliasing is not lint-enforceable**; the `Date` half of that gap is closed.
  (M1.)
- **A core test imports from `@civts/testing`**, inverting the dependency direction
  for that one file. (M0, still open.)
- **Scenarios live in `packages/testing/test/`**, so `pnpm scenario <name>`
  (`PLAN.md` §8) is unwired; moving them into `src/` is a one-file change. (M2.)
- **`SetupError` cannot express scenario-authoring failures** (off-map `setTile`,
  unknown unit type), so `build()` throws a descriptive `Error` for those instead of
  mislabelling them. A `bad-scenario-setup` variant is wanted before scenarios are
  built from untrusted data. (M2.)
- **`unitCatalog` reads `ruleset.units` directly**, so an untyped/JSON-loaded view
  missing that field throws instead of behaving as an empty catalog. A defensive guard
  belongs with save-loading in M11. (M2.)
- **The interactive-TTY branch of the REPL cannot be exercised here** (no TTY). A
  human should run `pnpm play` once in a real terminal. (M2.)
- **The multi-growth path is unreachable with the shipped catalog**; a mutation probe
  that turns growth's `while` into an `if` passes every test that plays real games.
  Pin it when a 3+ food terrain is sourced. (M3.)
- **Long-run invariants are one-off checks, not permanent ones.** The 110-turn economy
  conservation checks live in `m3-adversarial.test.ts`; they should be exported
  `Invariant<GameState>` values. (M3 — partially closed by the S-wave registry.)
- **A hut founded on by a city stays on the map forever and is inert.** (M3.)
- **A bankruptcy-driven building loss emits no event.** (M4c.)
- **`production.ts` re-checks `mayStartBuilding` when a building completes but does
  not re-check `resourceGate` for a queued unit.** Proven unreachable, but it is a
  defensive asymmetry for hand-edited saves. A comment, not a behaviour change. (M4c.)
- **The goldens gate less than they look like they do** — a golden state is `newGame`
  and contains no city. Partially closed by the played (M5), combat (M6) and victory
  (M9+M10) goldens. (M4c.)
- **`beakers` and `luxuries` were inert** from M4b until M5 and M9 respectively; both
  are live now, and the M4b caveat is closed. (M4b → M9.)
- **An unknown command discriminant still throws** rather than returning a typed
  error; the exhaustive switch is the compile-time guard. (M4b.)
- **`pnpm verify:full` aliases the fast tier** — closed: the tiers are real since M5,
  re-drawn in M7b and again in M11. (M0 → closed.)
