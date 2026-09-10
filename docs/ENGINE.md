# ENGINE — architecture notes

Companion to `../PLAN.md` §5. This file records decisions as they are made.

## Shape

Pure functions over plain data. No classes with hidden state.

```ts
newGame(seed, settings, ruleset): Result<GameState, SetupError>
applyCommand(state, playerId, cmd): Result<{ state, events }, GameError>
applyDebugCommand(state, cmd): Result<{ state, events }, GameError>   // gated by settings.debug.cheats
advanceTurn(state): Result<{ state, events }, GameError>              // upkeep → growth → production → research → barbarians → next player
```

## Legal actions

A single monolithic "enumerate every command" call does not scale: on a standard
map that is O(units × reachable tiles) per AI decision. Instead:

```ts
function* legalActions(state, playerId): Generator<Command>;   // lazy, never materialised
unitMoveOptions(state, unitId): readonly TileIndex[];          // cached per (unit, revision)
unitActions(state, unitId): readonly Command[];
cityActions(state, cityId): readonly Command[];
```

`GameState.revision` increments on every applied command; caches key on it and
are dropped on mismatch. The UI derives enabled/disabled buttons from these same
functions the AI uses, so UI and AI cannot disagree with the engine about legality.

## Determinism

- RNG is integer PCG/xorshift, carried **inside** `GameState`. No ambient
  randomness, no ambient time.
- Economy maths is **integer-only** (food, shields, commerce, gold, beakers,
  culture). Floats do not appear in authoritative state.
- `Math.random`, `Date.now`, `performance.now`, `Math.pow`, `Math.sin`,
  `Math.cos`, `Math.log` are lint-banned inside `packages/core/src`. Any needed
  noise uses integer hash-based value noise.
- **Scope of the guarantee:** identical state hashes are guaranteed for a pinned
  `(engine version, Node major)`. Golden files record `nodeMajor`; a Node upgrade
  requires an intentional rehash.
- Canonical JSON (sorted keys, integer fields, NaN/±0 guards) → FNV-1a 64. The
  hasher lives outside `core` (`headless`/`testing`) so `core` stays pure.

## State layout

- `Record<BrandedId, T>` for entities — JSON-friendly, and
  `noUncheckedIndexedAccess` forces `undefined` handling at every lookup.
- Map layer uses typed arrays (`Int32Array`/`Uint8Array`) for terrain,
  improvements, owner and explored bits.
- Derived data (visibility, reachable tiles, city work options) is computed on
  demand and never serialised into saves.

## Performance notes (to be validated at M1/M7)

- Pathfinding runs over a precomputed integer cost grid per player-turn;
  movement options are computed once per unit per turn, not per query.
- Fog updates incrementally on unit move / city change rather than recomputing
  the whole map every turn.
- The UI worker receives events + derived view models, not the full state per
  turn (structured-cloning ~16k tiles per turn is wasteful).

## Type-safety rules

- Branded ids for every entity (`PlayerId`, `UnitId`, `CityId`, `TileIndex`, …).
- Commands and events are exhaustive discriminated unions; consumers switch with
  `assertNever`.
- `GameError` is a union (`IllegalCommand`, `NotEnoughMovement`, …) so callers
  react to reasons, not strings.
- Settings are parsed once at the boundary (valibot, strict objects, unknown keys
  rejected) and are immutable thereafter.
- Rules content is validated once into a `Ruleset`; downstream code uses ids.
