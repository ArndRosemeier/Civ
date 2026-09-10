# CivTS

A Civilization III–shaped 4X strategy game in TypeScript, built to be played and
debugged by an autonomous agent as well as by a human.

**Status: pre-alpha (M0 complete).** Target is **alpha**: a human plays a full
game from the browser, with every system verified by machine-checked assertions.
See `PLAN.md` §16 for the exact alpha exit criteria.

## Design commitments

- **Engine first.** `packages/core` is pure, deterministic, and has zero runtime
  dependencies. Everything is playable headless before any pixel is drawn.
- **Civ 3-shaped, not bit-exact.** Mechanics come first. Every rules value is
  either `cited` (traced to a source) or `placeholder` (our own tuned number,
  explicitly *not* claimed to be Civ 3-accurate). See "Provenance" below.
- **Deterministic.** Same seed + same commands ⇒ same state, within a pinned
  runtime. No ambient randomness or time in the engine (lint-enforced).
- **Type safety everywhere.** Strictest compiler flags, branded ids so a `CityId`
  can never be passed as a `UnitId`, exhaustive unions for commands/events, and
  one parsed schema for settings.

## Layout

```
packages/
  core/       pure deterministic engine — zero runtime dependencies
  rules/      typed content + provenance for every row
  testing/    invariants and shared test machinery
  headless/   CLI: text-first tooling (play/run/inspect/provenance)
docs/         PLAN.md, GDD.md, ENGINE.md, TASKS.md, BALANCE.md
```

## Requirements

Node 24 (`engines` + `.nvmrc`) and pnpm 11.

```bash
pnpm install
```

## Verification

```bash
pnpm verify        # fast tier: typecheck + lint + tests   (must stay green on every commit)
pnpm verify:full   # adds tournaments, long goldens, bench budgets (milestone boundaries)
```

The fast tier is deliberately bounded so it can gate every commit. It is also
fully non-interactive — no watch modes, no prompts, pinned lockfile.

## Tooling

```bash
pnpm rules:provenance   # cited vs placeholder table for all rules data
pnpm play               # interactive text REPL              (M2)
pnpm run                # headless AI-vs-AI self-play        (M7)
```

## Provenance

Fidelity is tracked, not asserted:

```bash
pnpm rules:provenance
# ruleset provenance — 0/6 cited (0%), 6 placeholder
```

Rows are `cited` or `placeholder`. Setting `fidelity: "cited-only"` makes the
engine **refuse to start** while any active row is a placeholder, so
"is this Civ 3-accurate?" is a mechanical check rather than a claim.

Known trap this exists to prevent: a widely-linked "city growth mechanics"
thread that yields `20 + 2·pop` is **Civ IV**, not Civ III. Cite the game as well
as the number.
