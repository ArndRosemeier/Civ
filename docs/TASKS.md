# TASKS — execution ledger

Single-writer: the main agent owns this file. Subagents never edit it.
Statuses: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.

Milestone definitions and acceptance criteria live in `../PLAN.md` §12.

---

## M0 — Tooling & skeleton — **DONE**

- [x] pnpm workspace, Node 24 pinned (`.nvmrc`, `engines`)
- [x] strictest `tsconfig.json` + `@civts/*` path aliases
- [x] eslint flat config, typed strict rules, determinism bans in `core`
- [x] vitest with workspace aliases
- [x] `verify` / `verify:full` tiers, fully non-interactive
- [x] non-interactive install: `allowBuilds.esbuild` declared in `pnpm-workspace.yaml`
- [x] `@civts/core`: branded ids, `Result`, provenance, typed settings schema
- [x] `@civts/rules`: catalog with mandatory provenance + validation
- [x] `@civts/testing`: invariant machinery
- [x] `@civts/headless`: CLI with `provenance` subcommand
- [x] 27 tests green; typecheck + lint clean

## M1 — Core types, RNG, map gen, text renderer, hashing — **DONE** (commit `03d2064`)

Delivered by 5 agents against the frozen contracts in `INTERFACES.md` (§11 rev 3:
delegation-first). The main agent wrote no implementation code for this milestone.

- [x] `GameState` shape, `revision` counter, `SCHEMA_VERSION`
- [x] sfc32 integer RNG carried inside state; pure `[value, nextState]` API
- [x] seeded map generation — integer-hash value noise, **quantile** sea level (not magic constants)
- [x] deterministic text renderer `describe(state, ruleset, options)` + `describe` snapshot tests
- [x] canonical JSON + FNV-1a 64 state hash (outside `core`, as designed)
- [x] golden replay harness; 3 goldens, verified non-vacuous by fault injection
- [x] CLI `map` subcommand — the agent's text window onto the game
- [x] adversarial review: determinism reproduced in a **fresh process**, hash sensitivity probed

### M1 review findings (real defects; fixes dispatched)

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Determinism lint gaps: `new Date()`, `Math.exp/tan/atan2/log2/…`, `process.hrtime` uncaught; aliasing `const M = Math` unenforceable | medium-low | fixing |
| F2 | `nextBelow(bound > 2^32)` → `limit = 0` → **infinite loop**; reachable via `nextInt(rng, 0, 10**10)` | medium | fixing |
| F3 | `loadSettings({ruleset: undefined})` keeps the key, so `hashValue(state)` throws on the natural CLI wiring | medium | fixing |
| F4 | `canonicalize` invokes getters (Object.prototype passes the plain-object check) — impure getter ⇒ unstable hash | low (latent) | fixing |
| F5 | Plan claimed "no floats in authoritative state" while `settings.ai.aggression` is a float and is hashed | informational | **plan corrected** |
| F6 | `@civts/rules` `TerrainSpec` lacked `role`, so `Catalog` was not assignable to `RulesetView`; two consumers had ad-hoc adapters | architectural | fixing |

F5 was a documentation defect, not a code one: ECMA-262 fully specifies number→string and IEEE-754 arithmetic, so configuration floats are deterministic. The plan's rule is now stated as "integer-only *simulation* math; transcendentals banned".

## M2 — Units, movement, fog, text REPL + scenario DSL — **DONE** (commit `578282d`)

Delivered by 9 delegated agents (6 feature + 3 integration) against the frozen M2
contract in `INTERFACES.md`. This is the milestone where the agent genuinely plays.

- [x] unit catalog with mandatory provenance; `cited-only` rejects unit placeholders
- [x] units in state, one settler per player, `SCHEMA_VERSION` 1 → 2
- [x] terrain-cost single-step movement with typed `GameError`s
- [x] legal-action generator (`unitMoveOptions` / `unitActions` / `legalActions`)
- [x] per-player fog: derived visibility, persisted `explored`, one writer
- [x] `play` REPL — transcripts are hash-pinned regression fixtures
- [x] scenario DSL + 3 acceptance scenarios asserting exact costs, tiles and errors
- [x] golden rehash, intentional, recorded in the commit message

### M2 review findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | The frozen `applyCommand(state, playerId, cmd)` was **unusable**: applying a command needs the destination's `moveCost` and each unit type's `movement`, neither of which `GameState` carries. The interim workaround made the ruleset an *optional* 4th parameter — so it compiled and then refused every command at runtime, invisible to the typechecker | **high (silent)** | ruleset is now a required 4th parameter; a 3-argument call is unrepresentable, pinned by a `@ts-expect-error` assertion that was proven live |
| F2 | The keystone invariant was documented one-directionally. Sweeping the other direction found `EndTurn` was *yielded* but *refused* when a unit's type was absent from the ruleset | medium | `EndTurn` made total; the doc now states both directions; the counterexample test was **inverted, not deleted**, so it is evidence for the property |
| F3 | `RulesetView` did not carry `units`, so the engine's view of the rules could not run a game; an interim alias papered over it | medium | `units` is required; the alias and its structural guard are gone |
| F4 | Provenance half-truth: `summarizeProvenance` counted 11 rows (terrains + units) while the `provenance` CLI printed 6 | medium | fixed at the root — one function yields both the sections and the totals, so they cannot disagree |
| F5 | Two writers of the explored layer: `state.ts` kept `START_EXPLORED_RADIUS`, duplicating `fog.VISIBILITY_RADIUS`, and walked its own box | low | `newGame` folds `withExplored(visibleTiles(...))`; one radius, one writer; proven hash-neutral across 6 seeds |
| F6 | A contract amendment **orphaned test files whose authors had finished and been cleaned up**, so no agent owned the migration and the gate sat red | **process** | recorded below as a standing rule |

**Standing rule from F6:** when the frozen contract changes, the amendment must name a
migration owner for *every* existing consumer before agents are launched. Escalating
correctly is not the same as having an owner.

### M2 accepted debt

- Scenario `run` commands apply as player 0 — M2 has no active-player field; per-player
  turn order is M5.
- No stacking limit beyond "no stacking on an enemy" — M3+.
- Scenarios live in `packages/testing/test/`, so `pnpm scenario <name>` (PLAN.md §8) is
  not wired; moving them into `src/` is a one-file change.
- `SetupError` cannot express scenario-authoring failures (off-map `setTile`, unknown unit
  type), so `build()` throws a descriptive `Error` for those rather than mislabelling them
  as an existing variant. A `bad-scenario-setup` variant is wanted before scenarios are
  built from untrusted data.
- `unitCatalog` reads `ruleset.units` directly, so an untyped/JSON-loaded view missing that
  field now throws instead of behaving as an empty catalog. A defensive guard belongs with
  save-loading in M11.
- The interactive-TTY branch of the REPL cannot be exercised here (no TTY); pipes, EOF and
  `--script` are covered. A human should run `pnpm play` once in a real terminal.

## M3 — Cities v1 + goody huts — **DONE** (commits `c4f9e9c`, `274032b`)

Delivered by 8 delegated agents in four waves (foundation → gate-closing → features →
integration), against the frozen M3 contract.

- [x] `City` entity: population, food box, shields, queue, buildings, worked tiles
- [x] the exact 21-tile city radius, integer-only `cityYields`, `MIN_CITY_DISTANCE`
- [x] `FoundCity` / `SetWorkedTiles` / `SetProduction`, and `advanceTurn` as the single
      definition of a turn (growth → production → refill → `turn++`)
- [x] food-box growth with observable carry-over, and starvation
- [x] production queue with shield carry-over and completion
- [x] barbarians as a real `PlayerState` (`kind`), so `PlayerId` stays the index into `players`
- [x] huts placed on the map, rendered as `%`, consumed on entry, drawing from the state RNG
- [x] the REPL city surface (`found`/`city`/`cities`/`work`/`build`) — M3's acceptance line
- [x] growth-timing, starvation, production and hut scenarios with **meta-tests** proving
      the assertions fail when the input is wrong

### M3 review findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | `City.production` was required-but-`undefined`, so **every state containing a city was unhashable** — goldens, `save` and all determinism checks. Third occurrence of this bug class | **high** | field made optional; `exactOptionalPropertyTypes` now makes the unhashable spelling unrepresentable. Fix belongs in the producer and the type, never the hasher |
| F2 | `players.length` now includes the barbarian, so `play --civs 2` printed "3 civs" | medium (visible) | `civPlayers()` everywhere the question is "how many civilizations", plus a regression assertion that `civs=3` cannot return |
| F3 | `outcomeText` switched on two event kinds and returned `undefined` for the rest, which joins into a **silently blank line** — a quiet failure, not a visible one | medium | exhaustive over `GameEvent` with an `assertNever` tail and no `default`; a regression test asserts one non-empty line per event |
| F4 | The conservation sweep still asserted "a legal move moves one unit and nothing else", which the hut contract deliberately breaks | medium | made **hut-aware** rather than skipping hut moves — any unit that appears must be claimed by an emitted event. I reproduced the counterexample myself before authorising the change |
| F5 | My workflow abort guard treated an out-of-scope blocker as fatal and skipped two phases | **process** | the guard must key on *who owns the blocker*, not on a `blocked` status. Same lesson as F6: escalate correctly ≠ have an owner |

### M3 accepted debt

- **The multi-growth path is unreachable with the shipped catalog.** Terrain food never
  exceeds the 2 a citizen eats, so the only possible surplus is a city centre's floor; a
  mutation probe that turns growth's `while` into an `if` passes every test in the repo that
  plays real games. It becomes live the moment anyone sources a 3+ food terrain — pin it then.
- **Long-run invariants are one-off checks, not permanent ones.** The 110-turn economy
  conservation checks live in `m3-adversarial.test.ts` only; they should be lifted into
  exported `Invariant<GameState>` values so M7's self-play harness runs them every turn.
- A hut founded *on* by a city stays on the map forever and is inert; god-mode renders a hut
  glyph on a tile that can never produce. Legibility only.
- Hut rewards defer `gold` to M4 (no treasury yet) — stated in the provenance detail rather
  than silently omitted.
- Barbarian `startingTile` is a convention pointing at a hut, not a real start; rendering
  now excludes them, but the field is still required and meaningless for barbarians.

## M4a — Tile improvements & workers — **DONE** (commit `25dd252`)

- [x] sparse `(tile, kind)` improvement list with pure, idempotent helpers
- [x] improvement catalog (road / mine / irrigation) with mandatory provenance
- [x] `cityYields` applies improvements for **worked** tiles; centre is never improved
- [x] workers (`Unit.work`, optional), `StartWork` / `CancelWork`
- [x] `advanceTurn` runs work **before** growth and production, pinned by a test
- [x] REPL `work` / `cancel`, and a unit's current job shown in the units line
- [x] mine-yield, cancellation, illegal-work and work-timing scenarios, with meta-tests

Adversarial finding worth keeping: `improvements.ts` documented the pair ordering as
"ascending code unit" while the engine sorts by index in `IMPROVEMENT_KINDS`. That
ordering is hashed, so a reader "correcting" the code to match the comment would have
moved all three goldens. Comment fixed; ordering pinned by a test.

**Known gap, folded into M4b** (not fixed immediately, to avoid two rehashes back to
back): civilizations start with a **settler only**, so a worker must be produced in a
city before any improvement can be built. Real Civ 3 starts with settler + worker, and
it makes the improvement system immediately exercisable.

## M4b — The economy — **NEXT**

- [ ] tax / science / luxury sliders; commerce split into gold, beakers, luxuries
- [ ] a treasury per player: income, maintenance, and **unit support**
- [ ] buildings & wonders v1 (effects, not just costs)
- [ ] road-connected luxury and strategic resources
- [ ] starting worker per civilization (see the M4a gap above) — bundles the rehash
- [ ] a **bankruptcy** scenario, and a treasury/conservation scenario

## Later milestones

See `../PLAN.md` §12 for M3–M11 and the stretch list.

---

## Open decisions

1. ~~Renderer~~ Canvas 2D isomorphic (PNG secondary).
2. ~~Validation lib~~ valibot.
3. ~~Vision~~ enabled and verified 6/6; correctness still assertion-based.
4. Node 24 pinned to this machine.

## Known issues / debt

- All 6 terrain rows are `placeholder` — `cited-only` mode is expected to fail.
- `moveCost` for impassable terrain is currently ignored rather than modelled as
  "requires a sea-capable unit"; revisit in M2 with unit movement.
- `pnpm verify:full` currently aliases the fast tier; tournaments land in M7.

### Accepted debt (deliberate, revisited at the named milestone)

- **`newGame` does not re-check map capacity.** `settings.civCount` is bounded by
  `MAP_DIMENSIONS[mapSize].maxCivs` in `refineSettings`, but a hand-built `Settings`
  literal bypasses parsing. The type-safe fix is to brand `Settings` so only
  `parseSettings`/`loadSettings` can produce one — planned for M2, rather than a
  runtime re-check that duplicates the schema.
- **Map composition is seed-independent.** Terrain thresholds are quantiles, so every
  seed yields the same *proportions* (62% water; fixed mountain/hill/grassland/plains
  counts). Arrangement and starts do vary by seed (hundreds of tiles differ), and the
  exact water fraction is a deliberate, asserted property. Varying composition per seed
  is an M3 quality item, not a correctness bug.
- **`canonicalize` blind spots**, all documented and pinned by adversarial tests: `-0 ≡ 0`,
  typed arrays equal their plain-array equivalents, non-enumerable properties are dropped,
  and a lone surrogate encodes identically to U+FFFD (state hashing stays distinct because
  `canonicalize` escapes lone surrogates first).
- **Determinism is only verified on Node 24.20.0.** Cross-Node-version hashing is untested by
  construction; the golden file records `nodeMajor` and fails loudly on mismatch, which is the
  designed control.
- **`Math` aliasing is not lint-enforceable** (`const M = Math; M.random()`), nor is
  `globalThis.Math.random()`. Recorded in the eslint config comment so the guardrail's
  limits are explicit rather than implied. The `Date` half of the aliasing gap *is*
  closed (`no-restricted-globals`). For those spellings the determinism claim now rests
  on review plus the golden-hash gate, not on lint.
- **A core test imports from `@civts/testing`.** `packages/core/test/settings.test.ts`
  imports `canonicalize`/`hashValue` to assert that settings survive hashing, but
  `@civts/testing` already depends on `@civts/core`, so this inverts the dependency
  direction for that test (a test-level cycle; `core/src` itself is unaffected and the
  build graph is still acyclic). Resolve in M2 by moving the "settings are hashable"
  assertion up into an integration test in `packages/testing`, which is where state
  hashing is exercised anyway.
- **`pnpm format:check` was decorative** until M1's follow-up: the repo had a Prettier
  script but no config, so it failed repo-wide against defaults that contradicted the
  codebase's actual style. Being fixed with a config inferred from the existing code
  and a real gate in `verify`, so style cannot drift as more agents author code.
