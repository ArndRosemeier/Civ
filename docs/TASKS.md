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

## M1 — Core types, RNG, map gen, text renderer, hashing — **DONE** (delegated)

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

## M2 — Units, movement, fog, text REPL + scenario DSL — **NEXT**

- [ ] unit catalog, movement points, terrain costs, stacking rules
- [ ] per-player fog: `explored` bits + derived visibility
- [ ] `play` REPL — first point where the agent genuinely plays
- [ ] scenario DSL (`defineScenario`) + 3 passing scenarios

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
  limits are explicit rather than implied.
