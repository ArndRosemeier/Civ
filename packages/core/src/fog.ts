/**
 * Fog of war — what a player remembers, and what it can see right now.
 * See docs/INTERFACES.md M2 ("Fog"), PLAN.md §5.3 (determinism) and §5.4
 * (data layout).
 *
 * The model is the classic two-layer one, and the split is the whole design:
 *
 * - **Explored is memory, and memory is state.** `GameState.explored` holds one
 *   `readonly boolean[]` per player, one flag per tile. It only ever grows (a
 *   tile once seen stays seen), it is part of the persisted shape, and it is
 *   what `withExplored` writes.
 * - **Visible is derived, and derived data is never stored.** `visibleTiles`
 *   recomputes what a player can see *this instant* from where its units stand.
 *   Storing it would create a second source of truth that could disagree with
 *   the unit that moved — so a caller that wants current sight calls this
 *   function, and a caller that wants to record what has been seen folds the
 *   result into `explored` through `withExplored`.
 *
 * Everything here is a pure read or a pure rebuild of `GameState`: no RNG draw,
 * no clock, no ambient state. Tile order is always ascending by index, which is
 * what keeps `visibleTiles` (and therefore any hash taken over a fog-derived
 * value) stable.
 *
 * Cities will join the visibility sources in M3+; in M2 a player sees from its
 * units and nothing else. Both readers below are written as "every source the
 * player owns", so adding cities means adding one loop, not changing the shape.
 */

import { asTileIndex, type PlayerId, type TileIndex } from './ids.js';
import { inBounds, indexToX, indexToY, tileIndex } from './map.js';
import type { GameState } from './state.js';

/**
 * Tiles a unit sees, in Chebyshev distance (so a square of side `2r + 1`).
 *
 * 2 is a placeholder value: Civ 3's sight radii vary per unit and per era, and
 * M2 has one radius for every unit. It deliberately **matches the radius
 * `newGame` marks explored around a starting tile**, because a start's explored
 * area is meant to be exactly what the settler standing there can see — a
 * mismatch would make a fresh game start with fog inside a unit's own sight, or
 * with memory of tiles it never saw. That agreement is not maintained by hand:
 * `newGame` marks its starting tiles by calling `visibleTiles` from this module,
 * and `withExplored` below is the only writer of the explored layer. This
 * constant is the single statement of the radius.
 */
export const VISIBILITY_RADIUS = 2;

/**
 * A player's explored row, or `undefined` when the state has no row for that id
 * — a player that does not exist yet, or a `PlayerId` that is not a whole
 * number. Callers treat `undefined` as "has seen nothing" rather than as an
 * error: fog questions are asked from the UI and the AI about whatever id they
 * were handed, and "you have explored nothing" is the honest answer.
 */
const exploredRow = (state: GameState, playerId: PlayerId): readonly boolean[] | undefined =>
  state.explored[Number(playerId)];

/** Is `tile` a whole-number index inside this state's map? */
const onMap = (state: GameState, tile: number): boolean =>
  Number.isInteger(tile) && tile >= 0 && tile < state.map.width * state.map.height;

/**
 * Resolve a requested sight radius: absent or non-finite means the default
 * radius, and a negative or fractional radius is floored to a whole number of
 * tiles (so `-1` means "the tile the unit stands on, and no more"). Sane
 * behaviour for a garbage radius matters because radii arrive from the CLI and
 * from save files; it must never produce a NaN loop bound or hang.
 */
const normalizeRadius = (radius: number | undefined): number => {
  if (radius === undefined || !Number.isFinite(radius)) return VISIBILITY_RADIUS;
  return Math.max(0, Math.floor(radius));
};

/**
 * Has `playerId` ever seen `tile`?
 *
 * Out-of-bounds tiles, tiles past the end of a short explored row, and ids that
 * name no player are all `false` rather than errors — see `exploredRow`.
 */
export const isExplored = (state: GameState, playerId: PlayerId, tile: TileIndex): boolean => {
  if (!onMap(state, Number(tile))) return false;
  return exploredRow(state, playerId)?.[Number(tile)] === true;
};

/**
 * Every tile `playerId` can see right now, sorted ascending by index.
 *
 * Derived on demand from the player's own units (`state.units` filtered by
 * owner); nothing is written, and the result is a fresh array every call, so a
 * caller cannot corrupt the state through it. A player with no units sees
 * nothing — an empty list, which is a legitimate answer, not a failure.
 *
 * A unit standing outside the map (only reachable through a corrupt save)
 * contributes nothing: deriving a neighbourhood from an out-of-range index would
 * wrap through `indexToX`/`indexToY` and paint visibility in a place no unit is.
 */
export const visibleTiles = (
  state: GameState,
  playerId: PlayerId,
  radius?: number,
): readonly TileIndex[] => {
  const reach = normalizeRadius(radius);
  const map = state.map;
  const size = map.width * map.height;
  const seen = new Array<boolean>(size).fill(false);

  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    const centre = Number(unit.tile);
    if (!onMap(state, centre)) continue;

    const cx = indexToX(map, centre);
    const cy = indexToY(map, centre);

    // Clipping the box to the map makes the cost proportional to the tiles
    // actually marked, so a stupidly large radius cannot turn into a huge loop:
    // anything past the edge is clamped away before iterating.
    const x0 = Math.max(0, cx - reach);
    const x1 = Math.min(map.width - 1, cx + reach);
    const y0 = Math.max(0, cy - reach);
    const y1 = Math.min(map.height - 1, cy + reach);

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        // Re-checking `inBounds` keeps the clip above honest even if the centre
        // was only just inside the map.
        if (!inBounds(map, x, y)) continue;
        seen[tileIndex(map.width, x, y)] = true;
      }
    }
  }

  // Collected by walking indices in order rather than by sorting a set: the
  // output order is then a property of the loop, not of a comparison function.
  const out: TileIndex[] = [];
  for (let tile = 0; tile < size; tile += 1) {
    if (seen[tile] === true) out.push(asTileIndex(tile));
  }
  return out;
};

/**
 * A copy of `state` whose explored row for `playerId` also has `tiles` marked.
 *
 * Pure: the input is never mutated, and the returned state shares nothing
 * mutable with it — the rows are `readonly`, so a no-op update reuses the
 * existing row objects (and the outer array is still rebuilt, so the returned
 * state is always a new object for a player that exists) instead of copying
 * `width * height` flags to reproduce them.
 *
 * Deliberately **not** a command: it does not touch `revision`, `turn` or
 * `rng`. Fog is updated as part of applying a command (movement folds what the
 * unit can now see into memory), so the command layer owns those counters and
 * this function stays a pure bookkeeping step that any caller can apply.
 *
 * Tiles outside the map are ignored, and a `playerId` with no explored row
 * leaves the state unchanged — there is no row to write, and inventing one
 * would invent a player.
 */
export const withExplored = (
  state: GameState,
  playerId: PlayerId,
  tiles: readonly TileIndex[],
): GameState => {
  const index = Number(playerId);
  const row = exploredRow(state, playerId);
  if (row === undefined) return state;

  let next: boolean[] | undefined;
  for (const tile of tiles) {
    const at = Number(tile);
    if (!onMap(state, at) || row[at] === true) continue;
    const copy = next ?? [...row];
    copy[at] = true;
    next = copy;
  }

  const rows = state.explored.map((existing, at) => (at === index ? (next ?? existing) : existing));
  return { ...state, explored: rows };
};
