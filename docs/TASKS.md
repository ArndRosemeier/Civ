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

## M1 — Core types, RNG, map gen, provenance table — **NEXT**

- [ ] `GameState` shape, `revision` counter, schema version + migrations skeleton
- [ ] integer PCG/xorshift RNG carried inside state; determinism tests
- [ ] seeded map generation (continents, terrain, starting positions)
- [ ] deterministic text renderer v0 (`describe(state, viewport)`)
- [ ] canonical JSON + FNV-1a 64 state hash (outside `core`)
- [ ] golden replay harness; first golden
- [ ] `rules:audit` start: source or explicitly mark every mechanic

## M2 — Units, movement, fog, text REPL + scenario DSL

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
