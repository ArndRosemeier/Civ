# GDD — game design numbers and their provenance

**Policy: no number is presented as Civ 3-accurate without a citation.** Every
rules row carries a typed `provenance` field (`cited` | `placeholder`). Rows
marked *placeholder* are our own tuned values and are **not** claimed to match
Civ 3. `pnpm rules:provenance` prints the current ratio; `fidelity: "cited-only"`
refuses to start while any active row is a placeholder.

Current state: **0 / 6 rows cited (0%).**

## Trap to avoid

A commonly linked CivFanatics thread titled *"city growth mechanics"* resolves to
`20 + 2·pop`. That formula is **Civ IV**, not Civ III. Always verify *which game*
a number belongs to, not just the number.

## Terrain (placeholder — see `packages/rules/src/index.ts`)

| Terrain | Move | Def bonus | F/S/C | Impassable |
|---|---|---|---|---|
| Grassland | 1 | +10% | 2/1/1 | no |
| Plains | 1 | +10% | 1/2/1 | no |
| Hills | 2 | +50% | 0/2/0 | no |
| Mountains | 3 | +100% | 0/0/0 | yes |
| Ocean | — | 0% | 1/0/0 | yes (needs sea unit) |
| Coast | — | 0% | 1/0/2 | yes (needs sea unit) |

## Map sizes (placeholder)

| Size | Width × Height | Max civs |
|---|---|---|
| Duel | 40 × 40 | 2 |
| Tiny | 60 × 60 | 4 |
| Small | 80 × 80 | 6 |
| Standard | 100 × 100 | 8 |
| Large | 140 × 140 | 12 |
| Huge | 180 × 180 | 16 |

## Not yet specified

These are intentionally empty rather than filled with guesses. Each must be
either cited or explicitly marked placeholder when its milestone lands.

- **Map dimensions per size** — the width × height and max-civ table above is a
  placeholder (tuned for playability, `packages/core/src/settings.ts`); Civ 3's
  actual map sizes are unverified. Golden state hashes depend on these numbers,
  so changing one is an intentional rehash.
- **City growth** — food box formula *unverified*; the Civ IV formula must not be reused.
- **Combat** — attack/defense resolution and hit-point tiers by experience.
- **Culture** — border expansion thresholds.
- **Victory conditions** — Civ 3's actual set must be verified from an
  authoritative source (M10); no generic "score only" substitute.
- **Unit roster** — stats, costs, resource requirements, upgrade chains.
- **Tech tree** — ~40 techs across 4 ages, prerequisite DAG.
- **Wonders and buildings** — effects and costs.

## Planned mechanics beyond alpha

Corruption, city culture-flips, full diplomacy, espionage, Golden Age and
leaders are deferred. See `../PLAN.md` §16.3 for the explicit not-alpha list.
