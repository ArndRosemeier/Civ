/**
 * The engine-side premises the map click contract rests on.
 *
 * These are not tests of our code — they are tests of facts we are *depending on*, and they exist
 * because a browser test cannot tell "the feature works" from "the situation never arose".
 *
 * `e2e/keystone.spec.ts` has a test that clicks a destination tile and nothing else, and passes. That
 * pass only means something if the tiles it clicks include a **friend-occupied** tile — the one case
 * where the click is genuinely ambiguous, because the tile is both a destination and a thing you
 * might be selecting. If the engine's starting placement ever changed so that no friendly unit began
 * adjacent to another, that e2e test would keep passing while testing nothing, and nothing would say
 * so. The first test below is what says so.
 *
 * The second is the measured premise behind `docs/UI-OVERHAUL.md` §7.3's city half, and it is the
 * reason the popup is still needed at all: the engine *does* offer a move onto your own city's tile,
 * while `main.ts` resolves such a tile to `openCity` before it ever consults the move. Delete this
 * test and the city half of §7.3 becomes an assertion nobody can check.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  asUnitId,
  DEFAULT_SETTINGS,
  newGame,
  unitMoveOptions,
  type GameState,
  type PlayerId,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

/**
 * Seeds including `31337`, which is the seed the keystone sweep plays on.
 *
 * A list rather than the single seed on purpose: the point is that the e2e test's situation is
 * *normal*, not a lucky peculiarity of one placement, and a list also means this test does not go
 * stale the moment somebody changes the sweep's seed.
 */
const SEEDS = [1, 7, 31337, 4242] as const;

const startOf = (seed: number): GameState => {
  const started = newGame(seed, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
  if (!started.ok) throw new Error(`newGame refused seed ${String(seed)}`);
  return started.value;
};

const seatOf = (state: GameState): PlayerId => state.players[0]?.id ?? (0 as PlayerId);

describe('the premises the map click contract rests on', () => {
  it('offers a move onto a FRIEND-OCCUPIED tile at game start, on every seed the sweep uses', () => {
    // If this ever fails, the keystone sweep's "map ALONE" test has become vacuous — it would be
    // clicking only unambiguous tiles — and it is this test, not that one, that reports it.
    for (const seed of SEEDS) {
      const state = startOf(seed);
      const seat = seatOf(state);
      const mine = state.units.filter((unit) => unit.owner === seat);
      expect(
        mine.length,
        `seed ${String(seed)}: the seat has too few units to collide`,
      ).toBeGreaterThanOrEqual(2);

      const occupied = new Set(mine.map((unit) => unit.tile));
      const collisions: string[] = [];
      for (const unit of mine) {
        const ontoFriend = unitMoveOptions(state, RULESET, asUnitId(unit.id)).filter((tile) =>
          occupied.has(tile),
        );
        for (const tile of ontoFriend) {
          collisions.push(`${unit.type} ${String(unit.id)} → tile ${String(tile)}`);
        }
      }
      expect(
        collisions.length,
        `seed ${String(seed)}: no friendly unit could move onto a friend-occupied tile, so the ` +
          `keystone sweep's map-only test would be passing without exercising the ambiguous case`,
      ).toBeGreaterThan(0);
    }
  });

  it('offers a move onto your OWN CITY tile — which is why the popup is still needed', () => {
    // §7.3's city half. The engine says yes; the UI's click order says "open the city". That
    // disagreement is the entire reason friendly cities need disambiguation, so it is worth pinning:
    // if the engine ever stopped offering it, the UI gap would close by itself.
    for (const seed of SEEDS) {
      const state = startOf(seed);
      const seat = seatOf(state);
      const settler = state.units.find((unit) => unit.owner === seat && unit.type === 'settler');
      if (settler === undefined) throw new Error(`seed ${String(seed)}: the seat has no settler`);

      const founded = applyCommand(state, seat, { type: 'FoundCity', unitId: settler.id }, RULESET);
      if (!founded.ok) throw new Error(`seed ${String(seed)}: founding was refused`);
      const after = founded.value.state;
      const city = after.cities.find((candidate) => candidate.owner === seat);
      if (city === undefined) throw new Error(`seed ${String(seed)}: founding produced no city`);

      const ontoOwnCity = after.units
        .filter((unit) => unit.owner === seat)
        .filter((unit) => unitMoveOptions(after, RULESET, asUnitId(unit.id)).includes(city.tile));

      expect(
        ontoOwnCity.length,
        `seed ${String(seed)}: the engine offered nobody a move onto its own city tile ` +
          `${String(city.tile)}, so §7.3's city half would be describing a situation that cannot ` +
          `arise and the popup would have no job here`,
      ).toBeGreaterThan(0);
    }
  });
});
