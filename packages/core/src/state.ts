/**
 * Game state assembly — the one place a `GameState` comes into existence.
 * See docs/INTERFACES.md (W3), PLAN.md 5.3 (determinism) / 5.4 (data layout)
 * and docs/ENGINE.md (state layout, determinism).
 *
 * Design notes:
 *
 * - **`GameState` is plain, JSON-serialisable data.** No classes, no hidden
 *   state, no derived caches — a save file is the state, verbatim (PLAN.md 4.3).
 * - **All randomness is carried *inside* the state.** `newGame` takes the RNG
 *   state generation returned and stores it, so every future draw is
 *   reproducible from the seed alone.
 * - **Failure is typed, never thrown.** Map generation signals a bad ruleset or
 *   an unhostable map by throwing; `newGame` is the boundary that converts those
 *   into `SetupError` values so callers (CLI, UI, goldens) react to a reason
 *   rather than to a stack trace.
 */

import { generateWorld, type GeneratedWorld } from './gen.js';
import { asPlayerId, type PlayerId, type TileIndex } from './ids.js';
import {
  TERRAIN_BY_ROLE,
  TERRAIN_ROLES,
  type GameMap,
  type RulesetView,
  type TerrainRole,
} from './map.js';
import { err, ok, type Result } from './result.js';
import type { RngState } from './rng.js';
import { MAP_DIMENSIONS, type Settings } from './settings.js';

/** Bumped whenever the persisted shape of `GameState` changes incompatibly. */
export const SCHEMA_VERSION = 1;

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string; // "Player 1".."Player N" for M1
  readonly color: string; // '#rrggbb', from a fixed palette, deterministic
  readonly startingTile: TileIndex;
}

export interface GameState {
  readonly schemaVersion: number;
  readonly revision: number; // 0 at newGame; increments on every applied command (M2+)
  readonly turn: number; // 1 at newGame
  readonly seed: number;
  readonly settings: Settings;
  readonly rng: RngState;
  readonly map: GameMap;
  readonly players: readonly PlayerState[];
}

export type SetupError =
  | { readonly kind: 'missing-terrain-role'; readonly role: TerrainRole }
  | { readonly kind: 'no-valid-starts'; readonly civCount: number }
  | { readonly kind: 'too-few-start-candidates' };

/**
 * Player colours, indexed by player index. A fixed palette (no RNG, no time),
 * so a given seed always paints the same civilization the same colour.
 * Sixteen entries cover the largest supported civilization count
 * (`Settings.civCount` is capped at 16), making the fallback unreachable.
 */
const PLAYER_COLORS: readonly string[] = [
  '#d12f2f', // red
  '#2f6fd1', // blue
  '#2f9e44', // green
  '#e8b400', // gold
  '#8b2fc9', // purple
  '#00a0a0', // teal
  '#e06b00', // orange
  '#5a3b1e', // brown
  '#c2258f', // magenta
  '#4b5563', // slate
  '#7bbf2a', // lime
  '#1f3b73', // navy
  '#b03060', // maroon
  '#00897b', // sea green
  '#9a7b1f', // olive
  '#6b7280', // grey
];

const COLOR_FALLBACK = '#000000';

/** Colour for player `index`; cycles the palette if a caller exceeds it. */
const playerColor = (index: number): string =>
  PLAYER_COLORS[index % PLAYER_COLORS.length] ?? COLOR_FALLBACK;

/**
 * The first terrain role a ruleset is missing, in the canonical role order
 * (`TERRAIN_ROLES`), or `undefined` when every role generation can emit is
 * available. Checking here — before generation runs — is what turns a thrown
 * generator error into a typed `SetupError`, and it reports the same role the
 * generator would have complained about.
 */
const firstMissingRole = (ruleset: RulesetView): TerrainRole | undefined => {
  for (const role of TERRAIN_ROLES) {
    if (TERRAIN_BY_ROLE(ruleset, role) === undefined) return role;
  }
  return undefined;
};

/** `generateWorld` reports how many candidate tiles it found in this shape. */
const FOUND_COUNT = /found (\d+)/;

/**
 * Translate a generation failure into a `SetupError`. `newGame` never lets an
 * exception escape, so this is total.
 *
 * - `found 0` means there was no legal start tile at all — `no-valid-starts`.
 * - Anything else (some candidates, but too few or too clustered for the
 *   requested count) is `too-few-start-candidates`.
 *
 * The final branch is also the landing place for an unexpected generator
 * failure: the `SetupError` union has no "internal error" member, and a
 * *recognisably* failed setup is more useful to a caller than a crash. The two
 * reachable failures above are precise; this fallback only absorbs inputs that
 * `parseSettings` and `MAP_DIMENSIONS` cannot produce.
 */
const classifyGenerationFailure = (cause: unknown, civCount: number): SetupError => {
  const found = cause instanceof Error ? FOUND_COUNT.exec(cause.message)?.[1] : undefined;
  return found === '0' ? { kind: 'no-valid-starts', civCount } : { kind: 'too-few-start-candidates' };
};

/**
 * Start a new game.
 *
 * `seed` is authoritative for generation; `settings` is stored verbatim in the
 * resulting state (callers that sweep seeds — self-play, goldens — pass the
 * swept seed here rather than mutating settings). Dimensions come from
 * `MAP_DIMENSIONS[settings.mapSize]`, the civilization count from
 * `settings.civCount`.
 *
 * Deterministic: the same `(seed, settings, ruleset)` always yields an equal
 * state. Never throws for a bad ruleset or an unhostable map — those come back
 * as `SetupError` values.
 */
export const newGame = (
  seed: number,
  settings: Settings,
  ruleset: RulesetView,
): Result<GameState, SetupError> => {
  const missingRole = firstMissingRole(ruleset);
  if (missingRole !== undefined) return err({ kind: 'missing-terrain-role', role: missingRole });

  const dimensions = MAP_DIMENSIONS[settings.mapSize];
  const civCount = settings.civCount;

  let world: GeneratedWorld;
  try {
    world = generateWorld(
      { width: dimensions.width, height: dimensions.height, seed, civCount },
      ruleset,
    );
  } catch (cause) {
    return err(classifyGenerationFailure(cause, civCount));
  }

  // Defensive: the generator promises exactly `civCount` starts. If that
  // contract were ever broken, report it as a setup failure rather than
  // assembling a state with the wrong number of players.
  if (world.starts.length < civCount) return err({ kind: 'no-valid-starts', civCount });

  // Player ids are the player's index in `players`, which is also the marker
  // `textview.describe` paints on a start tile; `name` carries the human-facing
  // "Player 1".."Player N" numbering required by INTERFACES.md.
  const players: PlayerState[] = world.starts.map((startingTile, index) => ({
    id: asPlayerId(index),
    name: `Player ${String(index + 1)}`,
    color: playerColor(index),
    startingTile,
  }));

  return ok({
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    turn: 1,
    seed,
    settings,
    rng: world.rng,
    map: world.map,
    players,
  });
};
