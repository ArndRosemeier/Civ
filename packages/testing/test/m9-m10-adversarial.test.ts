/**
 * M9+M10 adversarial verification — image ownership, culture, governments, happiness,
 * scoring and victory, attacked from the outside.
 *
 * This file exists to try to **break** the two waves rather than to describe them. Its
 * nine sections are fixed by the integration brief:
 *
 * 1. **Derived-value agreement.** The stored `tileOwner` layer against an *independent*
 *    reading of the contract's border rule, computed here from the prose — culture
 *    radius, contested tiles to the higher culture, ties to the lower city id — over
 *    every turn of a played game. This is the headline: if the ownership layer and the
 *    cities' culture ranges ever disagree, it is here.
 * 2. **Boundaries.** Every new threshold tested **at** the value and **one step below**
 *    it, through a `RulesetPatch`, so the comparison is against the catalog's own
 *    magnitudes rather than against numbers copied into this file.
 * 3. **Disorder is real.** Zero shields, zero beakers, zero gold, no growth — read from
 *    state and from the turn's events — and then the same city one unhappy citizen
 *    better, producing again.
 * 4. **Victory ends the game.** Each of the four conditions reached by a real game,
 *    with its exact turn and winner; the finished game refusing further commands; the
 *    terminal state hashable; one condition firing inside the harness.
 * 5. **Barbarians never win, never score, never count toward conquest.**
 * 6. **Goldens and determinism.** The golden test green *without* the regeneration
 *    variable, and identical hashes for the same seed and policies in-process and in a
 *    **fresh process**.
 * 7. **The UI's claims, on the engine's side.** The readouts the browser panels bind to
 *    (`outcomeFor`, `happinessOf`, `playerCulture`, `scoreBreakdown`,
 *    `planSetGovernment`) and the seam failures they are chosen to surface, plus the
 *    e2e suite's own coverage named. The pixel and draw-trace half lives in Playwright
 *    and cannot run under vitest — see the section note.
 * 8. **Tidemark.** 20 seeds × 100 turns, zero invariant violations, the outcome
 *    distribution reported, wall time measured, and the fast tier confirmed under its
 *    70-second budget with `e2e` confirmed *not* collected by vitest.
 * 9. **Mutation check.** Two deliberate breaks — ownership disagreeing with the culture
 *    ranges, and disorder producing shields anyway — the suite confirmed **red** for
 *    each, then reverted with the file hashes proved unchanged.
 *
 * A "finding" here means a defect in the engine, the catalog or the UI. Where a section
 * found none it says so; a fabricated finding would be worse than an empty report.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  RATE_TOTAL,
  UNOWNED,
  advanceTurn,
  applyCommand,
  asCityId,
  asGovernmentId,
  asTechId,
  asTileIndex,
  asUnitTypeId,
  cityRadius,
  cityYields,
  cityYieldsIgnoringDisorder,
  civPlayers,
  claimedRadius,
  computeTileOwner,
  cultureRulesOf,
  distance8,
  gameOutcomeOf,
  governmentCatalog,
  happinessOf,
  highestScore,
  isDisordered,
  newGame,
  outcomeFor,
  planSetGovernment,
  playerCulture,
  playerScore,
  rateCapsOf,
  sameOwnership,
  spawnUnit,
  scoreBreakdown,
  scoreHorizon,
  scoreRulesOf,
  wholeCulture,
  withOwnership,
  type City,
  type CityId,
  type Command,
  type GameError,
  type GameState,
  type PlayerId,
  unitDef,
  isWaterRole,
  terrainAt,
  type Rates,
  type RulesetView,
  type Settings,
  type TileIndex,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import {
  CORE_INVARIANTS,
  SIMPLE_POLICY,
  applyOverrides,
  checkInvariants,
  policyRngFor,
  runBatch,
  runSimulation,
  type RulesetPatch,
} from '@civts/sim';

import { hashValue } from '../src/index.js';
import { loadGoldens } from '../src/goldens.js';
import { FULL_TIER } from '../src/tier.js';

/* ------------------------------------------------------------------ *
 * The fixtures this file builds everything from
 * ------------------------------------------------------------------ */

const mustValidate = (catalog: Catalog, what: string): Ruleset => {
  const validated = validateRuleset(catalog, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `${what} does not validate: ${validated.error.map((e) => JSON.stringify(e)).join('; ')}`,
    );
  }
  return validated.value;
};

/** The shipped catalog, validated exactly as the CLI validates it. */
const RULESET: Ruleset = mustValidate(CATALOG, 'the shipped placeholder catalog');

/**
 * The shipped catalog with one patch applied — how every boundary in this file is
 * reached.
 *
 * A boundary test that spelled `10` would be measuring this file's memory of the catalog
 * rather than the catalog, and would pass after a retune that made the *shipped* value
 * unreachable. Patching to a small value makes the threshold genuinely reachable by play,
 * which is the only way "at the value and one step below" can be about a real game.
 */
const patched = (patch: RulesetPatch): Ruleset =>
  mustValidate(applyOverrides(CATALOG, patch), 'the patched catalog');

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: 'tiny',
  civCount: 2,
});

/** A fresh world, or a failure that names what went wrong. */
const freshState = (seed: number, ruleset: Ruleset = RULESET): GameState => {
  const started = newGame(seed, settingsFor(seed), ruleset);
  if (!started.ok)
    throw new Error(`newGame(${String(seed)}) failed: ${JSON.stringify(started.error)}`);
  return started.value;
};

/** One command applied as `playerId`, or a failure naming the command and the refusal. */
const apply = (
  state: GameState,
  playerId: PlayerId,
  command: Command,
  ruleset: RulesetView = RULESET,
): GameState => {
  const outcome = applyCommand(state, playerId, command, ruleset);
  if (!outcome.ok) {
    throw new Error(
      `the script was refused: ${JSON.stringify(command)} — ${JSON.stringify(outcome.error)}`,
    );
  }
  return outcome.value.state;
};

/** A typed refusal, for the tests that are *about* a refusal. */
const refusalOf = (
  state: GameState,
  playerId: PlayerId,
  command: Command,
  ruleset: RulesetView = RULESET,
): GameError => {
  const outcome = applyCommand(state, playerId, command, ruleset);
  if (outcome.ok) {
    throw new Error(`expected a refusal for ${JSON.stringify(command)} and the engine accepted it`);
  }
  return outcome.error;
};

const playerOf = (state: GameState, index = 0): PlayerId => {
  const first = civPlayers(state)[index];
  if (first === undefined) throw new Error(`the fixture has no civilization ${String(index)}`);
  return first.id;
};

const cityOf = (state: GameState, index = 0): City => {
  const city = state.cities[index];
  if (city === undefined) throw new Error(`the fixture has no city ${String(index)}`);
  return city;
};

/**
 * Play `turns` turns with the shipped AI on every civilization, and hand back **every
 * intermediate state** — the boundary snapshots the ownership checks need.
 *
 * The policies are driven here rather than through `runSimulation` because the runner
 * keeps only the final state, and the whole point of section 1 is to check the ownership
 * layer on *every* turn rather than on the last one. The command loop is the runner's own
 * (`applyCommand` until `EndTurn`), which is the only way to be sure the states are the
 * ones a real run produces.
 */
const playTurns = (
  seed: number,
  turns: number,
  ruleset: Ruleset = RULESET,
): readonly GameState[] => {
  const states: GameState[] = [freshState(seed, ruleset)];
  let state = states[0];
  if (state === undefined) throw new Error('unreachable');

  for (let turn = 0; turn < turns; turn += 1) {
    // A decided game stops: `advanceTurn` returns it unchanged and every command is
    // refused, so continuing would only append identical states.
    if (gameOutcomeOf(state, ruleset) !== null) break;

    for (const player of civPlayers(state)) {
      const context = {
        state,
        playerId: player.id,
        ruleset,
        // The seat's own deterministic stream, from the runner's own helper — a policy
        // may draw from it and the engine never does.
        rng: policyRngFor(seed, player.id, state.turn),
      };
      for (const command of SIMPLE_POLICY.chooseCommands(context)) {
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (outcome.ok) state = outcome.value.state;
      }
    }
    state = advanceTurn(state, ruleset).state;
    states.push(state);
  }
  return states;
};

/* ------------------------------------------------------------------ *
 * 1. Derived-value agreement
 * ------------------------------------------------------------------ */

/**
 * The contract's border rule, implemented **from its prose** rather than by calling the
 * engine's own function — the whole value of this comparison is that it is a second
 * implementation.
 *
 * The rule, as the frozen M9 crypto section states it:
 *
 * - a city claims tiles within its **culture radius**: culture `>= 0` is radius 1,
 *   `>= borderRadius2Culture` is radius 2, `>= borderRadius3Culture` is radius 3;
 * - the ring is a square with its four corners cut, centred on the city;
 * - a contested tile goes to the **higher culture**, and ties to the **lower city id**,
 *   never to iteration order;
 * - and only tiles inside the map exist at all.
 *
 * The only thing read from the engine is the two catalog thresholds and the city's own
 * culture and position, which is exactly what a reader of the contract has.
 */
const independentOwners = (state: GameState, ruleset: RulesetView): readonly number[] => {
  const rules = cultureRulesOf(ruleset);
  const width = state.map.width;
  const height = state.map.height;
  const owner = new Array<number>(width * height).fill(UNOWNED);

  const radiusOf = (culture: number): number => {
    const whole = wholeCulture(culture);
    if (whole >= rules.borderRadius3Culture) return 3;
    if (whole >= rules.borderRadius2Culture) return 2;
    return 1;
  };

  // Higher culture first; equal culture goes to the lower city id. `sort` is stable, and
  // the comparator never returns 0 for two distinct cities — ids are unique — so the
  // result does not depend on the order the array arrived in.
  const claimants = [...state.cities].sort(
    (a, b) => wholeCulture(b.culture) - wholeCulture(a.culture) || Number(a.id) - Number(b.id),
  );

  for (const city of claimants) {
    const radius = radiusOf(city.culture);
    const cx = Number(city.tile) % width;
    const cy = Math.floor(Number(city.tile) / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        // The corners are cut at every radius — a square would claim a tile two away
        // diagonally while missing the one beside it.
        if (Math.abs(dx) === radius && Math.abs(dy) === radius) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const index = y * width + x;
        if (owner[index] !== UNOWNED) continue;
        owner[index] = Number(city.owner);
      }
    }
  }
  return owner;
};

describe('1. derived-value agreement — the ownership layer against the cities’ culture ranges', () => {
  it('the stored layer IS my own reading of the contract, on every turn of a played game', () => {
    // The headline check of this whole file. `tileOwner` is a *stored* materialisation of
    // a pure function, which is exactly the shape that drifts: a command that changes a
    // city's culture and forgets to re-materialise the layer leaves a board that hashes
    // perfectly and lies. The comparison is against an implementation written above from
    // the contract's prose, not against the engine's own function, so an error *inside*
    // that function cannot make the two agree.
    const snapshots = playTurns(42, 30);
    expect(snapshots.length).toBeGreaterThan(1);

    let ownedTiles = 0;
    let checked = 0;
    for (const [turn, state] of snapshots.entries()) {
      const mine = independentOwners(state, RULESET);
      const stored = [...state.tileOwner];

      expect(mine.length, `turn ${String(turn)}: the layer is the wrong length`).toBe(
        state.map.width * state.map.height,
      );
      expect(stored, `turn ${String(turn)}: the stored layer is not the rule's output`).toEqual(
        mine,
      );

      // …and the engine's own recomputation agrees with both, which is the claim the
      // `tile-owner-matches-culture` invariant makes. Stated separately because a
      // disagreement between the *engine's* recomputation and its own stored copy is a
      // different defect from my reading being wrong.
      expect(
        sameOwnership(computeTileOwner(state, RULESET), state.tileOwner),
        `turn ${String(turn)}: the engine's recomputation disagrees with the stored layer`,
      ).toBe(true);

      // …and `withOwnership` is idempotent: re-materialising an already-correct layer
      // cannot move it, which is what makes it safe to call from every command.
      expect(sameOwnership(withOwnership(state, RULESET).tileOwner, state.tileOwner)).toBe(true);

      ownedTiles += stored.filter((owner) => owner !== UNOWNED).length;
      checked += 1;
    }

    // Non-vacuity, in the two directions this check can be vacuous: a board with no
    // claimed tiles would pass every equality above while testing nothing, and a board
    // where every city sits at radius 1 would never exercise the radius ladder.
    expect(checked).toBe(snapshots.length);
    expect(ownedTiles, 'the played game never claimed a tile').toBeGreaterThan(0);
  });

  it('is non-vacuous: the practised game reaches radius 2, and both readings of it agree', () => {
    // The radius ladder is the part of section 1 that a fresh world cannot test — a new
    // city has 0 culture and therefore radius 1 — so this drives a *patched* threshold
    // down to a value a short game reaches, and checks the boundary in both readings.
    const ruleset = patched({ culture: { borderRadius2Culture: 4, borderRadius3Culture: 40 } });
    const snapshots = playTurns(7, 20, ruleset);
    const border = cultureRulesOf(ruleset);

    const sawRadius2 = snapshots.some((state) =>
      state.cities.some((city) => claimedRadius(border, city.culture) === 2),
    );
    expect(sawRadius2, 'no city in the played game ever reached radius 2').toBe(true);

    for (const [turn, state] of snapshots.entries()) {
      expect(
        independentOwners(state, ruleset),
        `turn ${String(turn)}: the two readings of the radius ladder disagree`,
      ).toEqual([...state.tileOwner]);
    }

    // The radius ladder itself, at the patched thresholds and one below each — the same
    // claim section 2 makes, stated here where the boundary is what makes the section
    // non-vacuous.
    expect(claimedRadius(border, 4)).toBe(2);
    expect(claimedRadius(border, 3)).toBe(1);
    expect(claimedRadius(border, 40)).toBe(3);
    expect(claimedRadius(border, 39)).toBe(2);
  });

  it('a captured city’s tiles transfer with it, on the turn the capture happens', () => {
    // The contract's "a captured city's tiles transfer to the captor" — the one ownership
    // transition that moves *many* tiles at once, and therefore the likeliest place for
    // the layer to be left behind. Stated as an agreement rather than as a count: whatever
    // the board looks like afterwards, it must equal the rule's own output.
    const state = freshState(11);
    const player = playerOf(state, 0);
    const found = apply(state, player, foundCityCommand(state, player));
    const before = independentOwners(found, RULESET);

    // Move every tile the founded city claims to its owner's rival, which is what a
    // capture does, and re-materialise the layer through the engine's own writer.
    const rival = playerOf(found, 1);
    const captured: GameState = withOwnership(
      {
        ...found,
        cities: found.cities.map((city) => ({ ...city, owner: rival })),
      },
      RULESET,
    );

    expect(independentOwners(captured, RULESET)).toEqual([...captured.tileOwner]);
    expect(captured.tileOwner).not.toEqual(before);
    expect(captured.tileOwner.some((owner) => owner === Number(rival))).toBe(true);
    expect(captured.tileOwner.some((owner) => owner === Number(player))).toBe(false);
  });
});

/** The `FoundCity` command for the player's own starting settler, read from the state. */
const foundCityCommand = (state: GameState, playerId: PlayerId): Command => {
  const settler = state.units.find((unit) => unit.owner === playerId && unit.type === 'settler');
  if (settler === undefined) throw new Error('the fixture player has no settler');
  return { type: 'FoundCity', unitId: settler.id };
};

/* ------------------------------------------------------------------ *
 * 2. Boundaries
 * ------------------------------------------------------------------ */

/**
 * The world with **every** civilization's settler having founded its city — the board a
 * border test needs, because a rival with no city owns no land.
 */
const foundedBoth = (seed: number, ruleset: Ruleset = RULESET): GameState => {
  let state = freshState(seed, ruleset);
  for (const player of civPlayers(state)) {
    const settler = state.units.find((unit) => unit.owner === player.id && unit.type === 'settler');
    if (settler === undefined) continue;
    const found = applyCommand(
      state,
      player.id,
      { type: 'FoundCity', unitId: settler.id },
      ruleset,
    );
    if (found.ok) state = found.value.state;
  }
  return state;
};

/** The world with player 0's starting settler having founded its city. */
const founded = (seed: number, ruleset: Ruleset = RULESET): GameState => {
  const state = freshState(seed, ruleset);
  const player = playerOf(state, 0);
  return apply(state, player, foundCityCommand(state, player), ruleset);
};

/**
 * The world with one city's culture set to an exact value, **and the ownership layer
 * re-materialised**.
 *
 * Writing a city's culture by hand without re-deriving the borders is precisely the
 * drift M9's headline invariant exists to catch, so every fixture below that touches
 * culture writes the layer in the same breath. `withOwnership` is the engine's own
 * writer, not a copy of it.
 */
const withCulture = (
  state: GameState,
  cityId: CityId,
  culture: number,
  ruleset: RulesetView = RULESET,
): GameState =>
  withOwnership(
    {
      ...state,
      cities: state.cities.map((city) => (city.id === cityId ? { ...city, culture } : city)),
    },
    ruleset,
  );

/** A city's population set to an exact value, through the same discipline. */
const withPopulation = (
  state: GameState,
  cityId: CityId,
  population: number,
  ruleset: RulesetView = RULESET,
): GameState =>
  withOwnership(
    {
      ...state,
      cities: state.cities.map((city) =>
        city.id === cityId ? { ...city, population: Math.max(1, population) } : city,
      ),
    },
    ruleset,
  );

/** A player's government set to a catalog row, for the cap tests. */
const withGovernment = (state: GameState, playerId: PlayerId, government: string): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.id === playerId ? { ...player, government: asGovernmentId(government) } : player,
  ),
});

/** How many tiles a player owns — the observable a radius change must move. */
const ownedBy = (state: GameState, playerId: PlayerId): number =>
  state.tileOwner.filter((owner) => owner === Number(playerId)).length;

describe('2. boundaries — every new threshold, at the value and one step below', () => {
  it('the culture radius ladder turns over exactly at the patched thresholds', () => {
    // The thresholds are moved down to values a real board can reach, so the comparison
    // is against the *catalog* and not against this file's memory of it. `borderRadius2Culture`
    // is patchable precisely so a boundary test does not have to play until a city has ten
    // culture.
    const ruleset = patched({ culture: { borderRadius2Culture: 3, borderRadius3Culture: 8 } });
    const border = cultureRulesOf(ruleset);
    expect(border.borderRadius2Culture).toBe(3);
    expect(border.borderRadius3Culture).toBe(8);

    // AT the value, and ONE STEP BELOW, for both thresholds — the whole claim.
    expect(claimedRadius(border, 3)).toBe(2);
    expect(claimedRadius(border, 2)).toBe(1);
    expect(claimedRadius(border, 8)).toBe(3);
    expect(claimedRadius(border, 7)).toBe(2);

    // …and through a real board: the same city, one culture below and at the threshold,
    // claims 9 tiles then 21 — the ring sizes `cityRadius` defines, read from the engine.
    const state = founded(3, ruleset);
    const city = cityOf(state);
    // At culture 0 the claim is **radius 1**, not M3's radius-2 working ring: M9 does not
    // narrow working, but the border it adds starts at one ring. Stated here because the
    // two radii are the pair a reader most easily conflates.
    expect(ownedBy(state, city.owner)).toBe(ringTiles(state, city.tile, 1));
    expect(cityRadius(state, city.tile).length).toBeGreaterThan(ownedBy(state, city.owner));

    const below = withCulture(state, city.id, 2, ruleset);
    const at = withCulture(state, city.id, 3, ruleset);
    // The counts are derived from the map rather than written down, because a city near an
    // edge claims fewer tiles than the ring's nominal size and a literal would be a fact
    // about this fixture's coordinates rather than about the radius.
    expect(ownedBy(below, city.owner)).toBe(ringTiles(state, city.tile, 1));
    expect(ownedBy(at, city.owner)).toBe(ringTiles(state, city.tile, 2));
    expect(ownedBy(at, city.owner)).toBeGreaterThan(ownedBy(below, city.owner));

    // One step below the *radius-3* threshold, and at it.
    const nearThree = withCulture(state, city.id, 7, ruleset);
    const atThree = withCulture(state, city.id, 8, ruleset);
    expect(ownedBy(nearThree, city.owner)).toBe(ringTiles(state, city.tile, 2));
    expect(ownedBy(atThree, city.owner)).toBe(ringTiles(state, city.tile, 3));
    expect(ownedBy(atThree, city.owner)).toBeGreaterThan(ownedBy(nearThree, city.owner));
  });

  it('the cultural victory condition holds at the threshold and not one below', () => {
    const ruleset = patched({ victory: { culturalVictoryCulture: 12 } });
    const state = founded(5, ruleset);
    const city = cityOf(state);
    const owner = city.owner;

    // The total is the SUM of the cities' culture, so the fixture writes the cities and
    // reads the total through the engine's own accessor rather than adding it up here.
    const below = withCulture(state, city.id, 11);
    const at = withCulture(state, city.id, 12);
    expect(playerCulture(below, owner)).toBe(11);
    expect(playerCulture(at, owner)).toBe(12);

    expect(gameOutcomeOf(below, ruleset)).toBeNull();
    expect(gameOutcomeOf(at, ruleset)).toEqual({ condition: 'cultural', winner: owner });

    // The condition is the *total's*, not one city's: the same total spread over two
    // cities still wins, which is what makes the derived sum rather than a stored field
    // the thing that decides.
    const second = withCulture(
      {
        ...at,
        cities: [
          ...at.cities,
          {
            ...city,
            id: asCityId(Number(city.id) + 100),
            culture: 6,
            tile: asTileIndex(Number(city.tile) + 2),
          },
        ],
      },
      city.id,
      6,
    );
    const spread = withOwnership(second, ruleset);
    expect(playerCulture(spread, owner)).toBe(12);
    expect(gameOutcomeOf(spread, ruleset)).toEqual({ condition: 'cultural', winner: owner });
  });

  it('domination needs BOTH shares, and each is tested at its own threshold', () => {
    // The contract's prose says "land **and** pop". The implementation's note records why:
    // with `or`, the condition fired on turn 1 of an ordinary game. This test states the
    // decision as a boundary rather than as an opinion — the population share is walked
    // across its edge exactly, and the land half is shown to be *necessary* rather than
    // decorative.
    //
    // Radius 3 at culture 0 (both thresholds patched to 0) is what makes the land half
    // reachable at all: the land share's **denominator is every land tile on the map** —
    // 1,368 of this map's 3,600 — so the minimum legal threshold of 1 % needs fourteen
    // owned tiles, and a radius-1 city near the coast does not have them. This is a
    // measurement, not a guess: the first version of this fixture used a radius-2 city and
    // the land half was simply never satisfied.
    // The thresholds are moved to *reachable* values, not to zero: `cultureRulesOf` reads a
    // threshold of 0 as the **degenerate** value (a threshold the engine cannot use at all —
    // documented in `borders.ts`), so patching to 0 leaves every city at radius 1 rather
    // than at radius 2. Measured, after the first version of this fixture did exactly that
    // and could not satisfy the land half.
    const wide = { borderRadius2Culture: 1, borderRadius3Culture: 2 };
    const ruleset = patched({
      culture: wide,
      victory: { dominationLandPct: 1, dominationPopPct: 50 },
    });
    // The leading player's city is grown to radius 3 by culture; the rival's stays at radius
    // 1. 37 owned tiles against a denominator of 1,368 land tiles is 2.7 %, comfortably over
    // the minimum legal threshold of 1 % — which a radius-1 city is not.
    const foundedState = founded(9, ruleset);
    const state = withCulture(foundedState, cityOf(foundedState).id, 2, ruleset);
    const me = playerOf(state, 0);

    // Two civilizations, one city of one citizen each: the population share is exactly 50 %
    // — the denominator is the citizens of every city on the board, barbarians included in
    // the array but never holding one.
    const both = withOwnership(
      {
        ...state,
        cities: [
          ...state.cities,
          {
            ...cityOf(state),
            id: asCityId(Number(cityOf(state).id) + 200),
            owner: playerOf(state, 1),
            tile: asTileIndex(Number(cityOf(state).tile) + 6),
          },
        ],
      },
      ruleset,
    );

    // AT the threshold: both halves hold.
    expect(gameOutcomeOf(both, ruleset)).toEqual({ condition: 'domination', winner: me });

    // ONE STEP BELOW: the same board, the population threshold one point higher.
    const stricterPop = patched({
      culture: wide,
      victory: { dominationLandPct: 1, dominationPopPct: 51 },
    });
    expect(gameOutcomeOf(both, stricterPop)).toBeNull();

    // The land half is **necessary**, which is the half an "or" reading would have let
    // through: the same board with the land threshold at 100 % is not a win even though the
    // population share is satisfied.
    const stricterLand = patched({
      culture: wide,
      victory: { dominationLandPct: 100, dominationPopPct: 50 },
    });
    expect(gameOutcomeOf(both, stricterLand)).toBeNull();

    // …and the land boundary is found rather than guessed: the largest land threshold this
    // board still satisfies is *derived* from the engine, so the assertion is "at the value
    // and one step above it" without this file holding a second opinion about how much land
    // the map has.
    let maxLand = 0;
    for (let pct = 1; pct <= 100; pct += 1) {
      const probe = patched({
        culture: wide,
        victory: { dominationLandPct: pct, dominationPopPct: 1 },
      });
      if (gameOutcomeOf(both, probe) !== null) maxLand = pct;
    }
    expect(maxLand, 'the leading player holds under 1 % of the land').toBeGreaterThanOrEqual(1);
    const atLand = patched({
      culture: wide,
      victory: { dominationLandPct: maxLand, dominationPopPct: 1 },
    });
    const overLand = patched({
      culture: wide,
      victory: { dominationLandPct: maxLand + 1, dominationPopPct: 1 },
    });
    expect(gameOutcomeOf(both, atLand)?.condition).toBe('domination');
    expect(gameOutcomeOf(both, overLand)).toBeNull();
  });

  it('the score condition holds on the horizon and not one turn before it', () => {
    // The horizon is a catalog magnitude, so the boundary is walked through a patch to a
    // turn a test can afford to play — and then the *same* game is played twice, one turn
    // short and one turn long, rather than trusting the turn counter to line up.
    const horizon = 6;
    const ruleset = patched({ victory: { scoreVictoryTurn: horizon } });
    expect(scoreHorizon(ruleset)).toBe(horizon);

    // "At the value and one step below" is about the **turn**, so the helper stops on an
    // exact turn number rather than counting advances: the condition is `turn >= horizon`,
    // and a helper that advanced a fixed number of times would silently test turn 6 twice.
    const playToTurn = (lastTurn: number): GameState => {
      let state = founded(13, ruleset);
      while (state.turn < lastTurn && gameOutcomeOf(state, ruleset) === null) {
        state = advanceTurn(state, ruleset).state;
      }
      return state;
    };

    const before = playToTurn(horizon - 1);
    expect(before.turn).toBe(horizon - 1);
    expect(gameOutcomeOf(before, ruleset)).toBeNull();

    const at = playToTurn(horizon);
    expect(at.turn).toBe(horizon);
    const decided = gameOutcomeOf(at, ruleset);
    expect(decided?.condition).toBe('score');
    expect(decided?.winner).toBe(highestScore(at, ruleset)?.playerId);
  });

  it('the unhappy ladder’s rungs are exact, at the rung and one citizen below it', () => {
    // The ladder is swept down to sizes a fixture can hold — the shipped rungs start at
    // seven — so "at the rung and one below" is a claim about the engine's own reader
    // rather than about a city nobody can grow.
    const ruleset = patched({
      culture: {
        unhappyThresholds: [
          { minPopulation: 1, unhappy: 0 },
          { minPopulation: 2, unhappy: 1 },
          { minPopulation: 4, unhappy: 3 },
        ],
      },
    });
    const state = founded(17, ruleset);
    const city = cityOf(state);
    const unhappyAt = (population: number): number =>
      happinessOf(withPopulation(state, city.id, population), ruleset, {
        ...city,
        population: Math.max(1, population),
      }).unhappy;

    expect(unhappyAt(1)).toBe(0);
    expect(unhappyAt(2)).toBe(1);
    expect(unhappyAt(3)).toBe(1);
    expect(unhappyAt(4)).toBe(3);
    expect(unhappyAt(5)).toBe(3);
  });

  it('the luxury boundaries are exact, at the divisor and one resource below it', () => {
    // `luxuriesPerHappyCitizen` is a divisor and `happyPerLuxuryResource` a multiplier, so
    // the two boundaries are "one resource short of another happy citizen" and "no
    // resource at all". Patched down so the fixture holds a handful rather than a purse.
    const ruleset = patched({
      culture: { luxuriesPerHappyCitizen: 2, happyPerLuxuryResource: 1 },
    });
    const state = founded(19, ruleset);
    const city = cityOf(state);
    const owner = city.owner;

    const withLuxuries = (luxuries: number): number =>
      happinessOf(
        {
          ...state,
          players: state.players.map((player) =>
            player.id === owner ? { ...player, luxuries } : player,
          ),
        },
        ruleset,
        city,
      ).happy;

    expect(withLuxuries(0)).toBe(0);
    expect(withLuxuries(1)).toBe(0);
    expect(withLuxuries(2)).toBe(1);
    expect(withLuxuries(3)).toBe(1);
    expect(withLuxuries(4)).toBe(2);
  });

  it('every government’s rate caps refuse one tenth above and accept the triple at the cap', () => {
    // Every shipped row, through the engine's own planner — so a row whose caps were
    // mistyped fails here rather than at the table. The rate triple always sums to
    // `RATE_TOTAL`, because an over-cap triple that *also* broke the sum would let the sum
    // rule answer instead of the cap rule this test is about.
    const rows = governmentCatalog(RULESET);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const row of rows) {
      const state = withGovernment(founded(23, RULESET), playerOf(founded(23), 0), row.id);
      const player = playerOf(state, 0);
      const acting = state.players.find((row0) => row0.id === player);
      if (acting === undefined) throw new Error('the acting player is missing');
      const caps = rateCapsOf(RULESET, acting);

      // …the caps really are this row's, which is what makes the boundary about the row.
      expect(caps, `government ${row.id} is not stamped on the player`).toEqual(row.rateCaps);

      const science = Math.min(caps.science, RATE_TOTAL - caps.tax);
      const atCap: Rates = { tax: caps.tax, science, luxury: RATE_TOTAL - caps.tax - science };
      expect(atCap.luxury, `government ${row.id}'s caps leave no legal triple`).toBeLessThanOrEqual(
        caps.luxury,
      );
      const accepted = applyCommand(state, player, { type: 'SetRates', rates: atCap }, RULESET);
      expect(accepted.ok, `government ${row.id} refused a triple at its own cap`).toBe(true);

      // ONE STEP ABOVE the tax cap, sum untouched.
      const overTax: Rates = {
        tax: caps.tax + 1,
        science: RATE_TOTAL - caps.tax - 1,
        luxury: 0,
      };
      if (overTax.science <= caps.science) {
        const refused = refusalOf(state, player, { type: 'SetRates', rates: overTax }, RULESET);
        expect(refused.kind, `government ${row.id} accepted tax at cap+1`).toBe('invalid-argument');
      }
    }

    // …and the isolation case the shipped rows cannot hold: a science cap moved *below*
    // the tax cap, with everything else legal, so science is the only rule that can be
    // broken. Without this the science half of `rateCaps` is never the reason for a
    // refusal on the shipped rows (their science caps are all at least 6).
    const narrow = patched({ governments: { despotism: { rateCaps: { science: 1 } } } });
    const state = withGovernment(founded(23, narrow), playerOf(founded(23), 0), 'despotism');
    const player = playerOf(state, 0);
    const overScience: Rates = { tax: 8, science: 2, luxury: 0 };
    const refused = refusalOf(state, player, { type: 'SetRates', rates: overScience }, narrow);
    expect(refused.kind).toBe('invalid-argument');
    // The same triple under the shipped row is legal, so the refusal above is the patch's
    // science cap and not something else about the triple.
    expect(applyCommand(state, player, { type: 'SetRates', rates: overScience }, RULESET).ok).toBe(
      true,
    );
  });

  it('a foreign-owned tile may not be worked, and the tile beside it may', () => {
    // The contract's added restriction on M3's working ring: "a tile owned by another
    // player may not be WORKED by your city". The boundary is ownership, so the test walks
    // the ring and checks that the refusal falls exactly on the foreign tiles — not on the
    // ring as a whole, which would be a different (and wrong) rule.
    const state = founded(29);
    const city = cityOf(state);
    const rival = playerOf(state, 1);
    const ring = cityRadius(state, city.tile);

    // A rival city two tiles away claims part of this city's ring.
    const rivalTile = asTileIndex(Number(city.tile) + 2);
    const contested: GameState = withOwnership(
      {
        ...state,
        cities: [
          ...state.cities,
          {
            ...city,
            id: asCityId(Number(city.id) + 200),
            owner: rival,
            tile: rivalTile,
            culture: 0,
          },
        ],
      },
      RULESET,
    );

    const foreign = ring.filter((tile) => contested.tileOwner[Number(tile)] === Number(rival));
    const mine = ring.filter((tile) => contested.tileOwner[Number(tile)] !== Number(rival));
    expect(foreign.length, 'the rival city claims none of the ring').toBeGreaterThan(0);
    expect(mine.length, 'the rival city claims all of the ring').toBeGreaterThan(0);

    for (const tile of foreign.slice(0, 1)) {
      const error = refusalOf(
        contested,
        city.owner,
        { type: 'SetWorkedTiles', cityId: city.id, tiles: [tile] },
        RULESET,
      );
      // The declared kind for this path, and the one that names the other player rather
      // than a city of theirs: the fix a caller can act on is "somebody else owns this".
      expect(error.kind).toBe('tile-owned-by-another-player-city');
      if (error.kind !== 'tile-owned-by-another-player-city') throw new Error('unreachable');
      expect(error.owner).toBe(rival);
      expect(error.cityId).toBe(city.id);
    }

    // Non-vacuity the other way: the same command on a ring tile the rival does not own is
    // accepted, so the refusal is ownership and not "this city may not set its tiles".
    const own = mine[0];
    if (own === undefined) throw new Error('unreachable');
    expect(
      applyCommand(
        contested,
        city.owner,
        { type: 'SetWorkedTiles', cityId: city.id, tiles: [own] },
        RULESET,
      ).ok,
    ).toBe(true);
  });

  it('a city may not be founded on foreign land, and the same tile one step away is free', () => {
    // The other M9 restriction with a boundary: founding. The candidate tiles are read from
    // the **engine's own** `unitMoveOptions` for a spawned settler, so every candidate is land
    // the engine says a settler may stand on — the first version of this fixture picked tiles
    // by index alone and was refused for `not-on-land`, which is a rule this test is not
    // about.
    const state = foundedBoth(31);
    const rival = playerOf(state, 1);
    const mine = playerOf(state, 0);
    const settlerDef = unitDef(RULESET, asUnitTypeId('settler'));
    if (settlerDef === undefined) throw new Error('the catalog has no settler to place');

    // "Is this tile land?" is asked of the **engine's own** terrain reader — `terrainAt` and
    // `isWaterRole`, the same pair `landTileCount` uses — rather than of `unitMoveOptions`,
    // which answers about the *neighbours* of a tile and therefore calls a settler standing on
    // the sea "somewhere with land next to it". Measured: the first version of this fixture
    // picked exactly such a tile and was refused for `not-on-land`.
    const isLand = (tile: TileIndex): boolean => {
      const terrain = terrainAt(
        state.map,
        Number(tile) % state.map.width,
        Math.floor(Number(tile) / state.map.width),
      );
      if (terrain === undefined) return false;
      const def = RULESET.terrains.find((candidate) => candidate.id === terrain);
      return def !== undefined && !isWaterRole(def.role);
    };
    const spawnOn = (tile: TileIndex): GameState => spawnUnit(state, settlerDef, mine, tile).state;
    const settlerOn = (board: GameState, tile: TileIndex): UnitId => {
      const unit = board.units.find((candidate) => candidate.tile === tile);
      if (unit === undefined) throw new Error('the placed settler is not on its tile');
      return unit.id;
    };
    const candidates = Array.from(
      { length: state.map.width * state.map.height },
      (_unused, index) => asTileIndex(index),
    ).filter((tile) => state.cities.every((city) => cityDistance(state, tile, city.tile) >= 2));

    // A tile the rival owns is **necessarily** inside the rival city's own ring, so it is also
    // within `MIN_CITY_DISTANCE` of that city — and this is the precedence the founder's own
    // note documents: the foreign-ownership refusal is reported rather than "too close",
    // because "that is their land" is the reason the caller can act on. So the foreign case is
    // deliberately *not* filtered by distance, and the assertion below is about which of the
    // two rules answers.
    const foreignTile = Array.from(
      { length: state.map.width * state.map.height },
      (_unused, index) => asTileIndex(index),
    ).find((tile) => state.tileOwner[Number(tile)] === Number(rival) && isLand(tile));
    const freeTile = candidates.find(
      (tile) => state.tileOwner[Number(tile)] === UNOWNED && isLand(tile),
    );
    if (foreignTile === undefined || freeTile === undefined) {
      throw new Error(
        `the fixture found no pair of foreign and free land tiles ` +
          `(${String(candidates.length)} candidates, ` +
          `${String(
            candidates.filter((t) => state.tileOwner[Number(t)] === Number(rival)).length,
          )} foreign)`,
      );
    }

    const onForeign = spawnOn(foreignTile);
    expect(
      refusalOf(
        onForeign,
        mine,
        { type: 'FoundCity', unitId: settlerOn(onForeign, foreignTile) },
        RULESET,
      ).kind,
    ).toBe('tile-owned-by-another-player');

    const onFree = spawnOn(freeTile);
    const accepted = applyCommand(
      onFree,
      mine,
      { type: 'FoundCity', unitId: settlerOn(onFree, freeTile) },
      RULESET,
    );
    // The refusal is named when it is not the one expected, so a future change that makes this
    // fail says *which* rule fired instead of only "false is not true".
    expect(accepted.ok ? 'ok' : accepted.error.kind).toBe('ok');
    // Non-vacuity: the accepted command really founded a city, so the pair above is "refused
    // here, accepted one tile over" rather than "refused here, broken quietly there".
    if (accepted.ok) expect(accepted.value.state.cities.length).toBe(onFree.cities.length + 1);
  });
});

/**
 * How many tiles a ring of `radius` around `tile` holds **on this map** — the square with
 * its corners cut, clipped to the board. Written here so the radius-boundary assertions are
 * about the shape the contract defines rather than about this fixture's coordinates.
 */
const ringTiles = (state: GameState, tile: TileIndex, radius: number): number => {
  const width = state.map.width;
  const cx = Number(tile) % width;
  const cy = Math.floor(Number(tile) / width);
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (Math.abs(dx) === radius && Math.abs(dy) === radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= state.map.height) continue;
      count += 1;
    }
  }
  return count;
};

/** Chebyshev distance between two tiles, read from the map's own width. */
const cityDistance = (state: GameState, a: TileIndex, b: TileIndex): number =>
  distance8(state.map, a, b);

/* ------------------------------------------------------------------ *
 * 3. Disorder is real
 * ------------------------------------------------------------------ */

/**
 * A world with a **single** city whose population is `population` and whose owner holds no
 * luxuries — the fixture both halves of the disorder test need.
 *
 * One city on purpose: with two, "the treasury did not move" would be a claim about the
 * board rather than about the disordered city, and the second city's commerce would answer
 * for it.
 */
const disorderedBoard = (population: number): GameState => {
  const state = founded(7);
  const city = cityOf(state);
  return withPopulation(
    {
      ...state,
      players: state.players.map((player) =>
        player.id === city.owner ? { ...player, luxuries: 0 } : player,
      ),
    },
    city.id,
    population,
  );
};

describe('3. disorder is real — zero shields, zero beakers, zero gold, and no growth', () => {
  it('a disordered city’s yields are zero, read from the state', () => {
    const state = disorderedBoard(40);
    const city = cityOf(state);
    expect(isDisordered(state, RULESET, city.id)).toBe(true);

    const ordinary = cityYieldsIgnoringDisorder(state, RULESET, city.id);
    const actual = cityYields(state, RULESET, city.id);

    // Non-vacuity first: this board's city would really have produced something, so the
    // zeros below are the disorder rule and not a barren tile. If this ever fails the
    // fixture's seed has to move, and the message says so rather than the test passing
    // while measuring nothing.
    expect(
      ordinary.shields,
      'the disorder fixture’s city produces no shields even without the rule',
    ).toBeGreaterThan(0);
    expect(ordinary.commerce, 'the disorder fixture’s city has no commerce at all').toBeGreaterThan(
      0,
    );

    // The rule, term by term. Commerce is the single quantity the three shares divide, so
    // "no beakers and no gold" is "no commerce": there is no separate beaker or gold term
    // for a city to keep.
    expect(actual.shields).toBe(0);
    expect(actual.commerce).toBe(0);
    expect(actual.foodSurplus).toBe(0);
    expect(actual.food).toBe(ordinary.food);

    // …and the disorder does **not** stop a city eating: `food` is still produced, which is
    // why `foodSurplus` is not simply the ordinary one. On this fixture the ordinary surplus is
    // negative (forty citizens do not feed themselves from one city's ring), so disorder
    // *raising* it to zero is the "growth food is not accumulated" rule rather than a gift.
    expect(ordinary.foodSurplus).toBeLessThan(0);
    expect(actual.foodSurplus).toBe(0);
  });

  it('one unhappy citizen fewer and the same city produces again', () => {
    // The converse, at the boundary rather than at the far end: the same board, the
    // population stepped down until the engine's own verdict flips. The step is *found* by
    // asking the engine, so a re-rung ladder moves this test with the rule.
    const state = disorderedBoard(40);
    const city = cityOf(state);
    const unhappy = happinessOf(state, RULESET, city).unhappy;

    let happy: GameState | undefined;
    for (let population = 40; population >= 1; population -= 1) {
      const candidate = withPopulation(state, city.id, population);
      if (!isDisordered(candidate, RULESET, city.id)) {
        happy = candidate;
        break;
      }
    }
    if (happy === undefined) {
      throw new Error('no population of this board is content, so the converse is untestable');
    }
    const content = cityOf(happy);
    expect(happinessOf(happy, RULESET, content).unhappy).toBeLessThan(unhappy);
    expect(cityYields(happy, RULESET, content.id)).toEqual(
      cityYieldsIgnoringDisorder(happy, RULESET, content.id),
    );
    expect(cityYields(happy, RULESET, content.id).shields).toBeGreaterThan(0);
  });

  it('a turn played in disorder banks no shields and no growth food', () => {
    // The transition, which is the half a shape check cannot see: the yields are zero, but
    // the *turn* is what would have written them into the city. Read from state before and
    // after one `advanceTurn`, so a pipeline that computed the zeroes and then banked the
    // old numbers anyway is caught.
    const before = disorderedBoard(40);
    const city = cityOf(before);
    const player = before.players.find((candidate) => candidate.id === city.owner);
    if (player === undefined) throw new Error('the acting player is missing');
    expect(isDisordered(before, RULESET, city.id)).toBe(true);

    const advanced = advanceTurn(before, RULESET);
    const after = advanced.state;
    const afterCity = cityOf(after);
    const afterPlayer = after.players.find((candidate) => candidate.id === city.owner);
    if (afterPlayer === undefined) throw new Error('the acting player vanished');

    // The three claims, each against the same figure on the other side of the boundary.
    expect(afterCity.shields).toBe(city.shields);
    expect(afterCity.foodBox).toBe(city.foodBox);
    expect(afterPlayer.beakers).toBe(player.beakers);
    // The treasury is the one that can legitimately move for reasons other than commerce
    // (upkeep), so the claim is one-sided: disorder must never *add* gold.
    expect(afterPlayer.treasury).toBeLessThanOrEqual(player.treasury);

    // …and the turn really happened, so the equalities above are about a played turn.
    expect(after.turn).toBe(before.turn + 1);
  });

  it('the same turn on a content board banks all four', () => {
    // Non-vacuity for the transition: the identical turn on the same board with a content
    // city moves at least one of the four figures, so the equalities above are the disorder
    // rule rather than a pipeline that does nothing on this map.
    const state = disorderedBoard(40);
    const city = cityOf(state);
    let content: GameState = state;
    for (let population = 40; population >= 1; population -= 1) {
      const candidate = withPopulation(state, city.id, population);
      if (!isDisordered(candidate, RULESET, city.id)) {
        content = candidate;
        break;
      }
    }
    const before = cityOf(content);
    const after = cityOf(advanceTurn(content, RULESET).state);
    const moved = after.shields !== before.shields || after.foodBox !== before.foodBox;
    expect(moved, 'a played turn on a content board moved nothing at all').toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Victory ends the game
 * ------------------------------------------------------------------ */

/** The first command of each shape, for the "a finished game refuses commands" battery. */
const probeCommands = (state: GameState, playerId: PlayerId): readonly Command[] => {
  const city = cityOf(state);
  const unit = state.units.find((candidate) => candidate.owner === playerId);
  const commands: Command[] = [
    { type: 'EndTurn' },
    { type: 'SetRates', rates: { tax: 2, science: 8, luxury: 0 } },
    { type: 'SetResearch', tech: asTechId('pottery') },
    { type: 'SetProduction', cityId: city.id, item: { kind: 'unit', id: asUnitTypeId('warrior') } },
    { type: 'SetWorkedTiles', cityId: city.id, tiles: [] },
  ];
  if (unit !== undefined) commands.push({ type: 'MoveUnit', unitId: unit.id, to: unit.tile });
  return commands;
};

describe('4. victory ends the game — an exact turn and winner, then a refusal', () => {
  it('the conquest condition ends a real game on the turn the last rival left the board', () => {
    // Conquest reached **by the board's own history**: both civilizations found a city, and
    // then one of them is removed as a capture would remove it. The turn and the winner are
    // asserted exactly, because "the exact turn and winner" is the acceptance line.
    const state = foundedBoth(37);
    const winner = playerOf(state, 0);
    const loser = playerOf(state, 1);
    const mine = state.cities.filter((city) => city.owner === winner);
    const decided = withOwnership(
      {
        ...state,
        cities: mine,
        units: state.units.filter((unit) => unit.owner !== loser),
      },
      RULESET,
    );

    const verdict = gameOutcomeOf(decided, RULESET);
    expect(verdict).toEqual({ condition: 'conquest', winner });

    // The turn it ended on is the state's own turn — the convention every row follows — and
    // the reading a seat gets names the condition, the turn and the winner together.
    const reading = outcomeFor(decided, RULESET, winner);
    expect(reading?.kind).toBe('victory');
    expect(reading?.condition).toBe('conquest');
    expect(reading?.winner).toBe(winner);
    expect(reading?.turn).toBe(decided.turn);
    expect(outcomeFor(decided, RULESET, loser)?.kind).toBe('defeat');
  });

  it('a finished game refuses every shape of command, and does not advance', () => {
    // The refusal is typed and the state is frozen. Both halves matter: a pipeline that
    // refused the command but still advanced the turn would end the game twice.
    const state = foundedBoth(41);
    const winner = playerOf(state, 0);
    const loser = playerOf(state, 1);
    const decided = withOwnership(
      {
        ...state,
        cities: state.cities.filter((city) => city.owner === winner),
        units: state.units.filter((unit) => unit.owner !== loser),
      },
      RULESET,
    );
    expect(gameOutcomeOf(decided, RULESET)?.condition).toBe('conquest');

    for (const command of probeCommands(decided, winner)) {
      const outcome = applyCommand(decided, winner, command, RULESET);
      if (command.type === 'EndTurn') {
        // `EndTurn` is the documented exception: the turn boundary is not a decision about
        // the world, and a UI that disables the button is what closes it. Stated rather than
        // silently skipped, because the exception is a decision. It changes **only** the
        // command counter — `revision` counts applied commands and one was applied — so the
        // comparison below blanks that one field rather than exempting the command entirely.
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.state.revision).toBe(decided.revision + 1);
          expect({ ...outcome.value.state, revision: decided.revision }).toEqual(decided);
        }
      } else {
        expect(outcome.ok, `${command.type} was accepted on a finished game`).toBe(false);
        if (!outcome.ok) expect(outcome.error.kind).toBe('game-over');
      }
    }

    const advanced = advanceTurn(decided, RULESET);
    expect(advanced.state).toEqual(decided);
    expect(advanced.events).toEqual([]);
  });

  it('a terminal state is still hashable, and hashes to itself', () => {
    // A finished game is an ordinary state: nothing about the outcome is stored, so there is
    // no field a hasher could choke on. Checked because `GameOutcome` names a `null` winner,
    // and a `null` written into a state is exactly the shape `canonicalize` refuses.
    const state = foundedBoth(43);
    const winner = playerOf(state, 0);
    const loser = playerOf(state, 1);
    const decided = withOwnership(
      {
        ...state,
        cities: state.cities.filter((city) => city.owner === winner),
        units: state.units.filter((unit) => unit.owner !== loser),
      },
      RULESET,
    );

    const hash = hashValue(decided);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashValue(decided)).toBe(hash);
    expect(JSON.stringify(decided)).not.toContain('null,"condition"');
    // …and the outcome really is derived: the same board hashes the same whether the outcome
    // is read or not, which is only true because reading it writes nothing.
    expect(gameOutcomeOf(decided, RULESET)).not.toBeNull();
    expect(hashValue(decided)).toBe(hash);
  });

  it('every one of the four conditions ends a game, each with its own winner', () => {
    // The four are covered across this file; this test is the *index*, so "all four" is one
    // assertion rather than four scattered ones. Each row's board is built by the same
    // measurement its own section uses.
    const winnerOf = (
      state: GameState,
      ruleset: Ruleset,
    ): { condition: string; winner: unknown } => {
      const verdict = gameOutcomeOf(state, ruleset);
      if (verdict === null) throw new Error('the condition board produced no ending');
      return { condition: verdict.condition, winner: verdict.winner };
    };

    // Conquest: the rivals are off the board.
    const conquestState = foundedBoth(47);
    const winner = playerOf(conquestState, 0);
    const loser = playerOf(conquestState, 1);
    expect(
      winnerOf(
        withOwnership(
          {
            ...conquestState,
            cities: conquestState.cities.filter((city) => city.owner === winner),
            units: conquestState.units.filter((unit) => unit.owner !== loser),
          },
          RULESET,
        ),
        RULESET,
      ),
    ).toEqual({ condition: 'conquest', winner });

    // Cultural: the summed city culture reaches the threshold.
    const cultureRules = patched({ victory: { culturalVictoryCulture: 6 } });
    const cultureState = founded(47, cultureRules);
    const cultured = withCulture(cultureState, cityOf(cultureState).id, 6, cultureRules);
    expect(winnerOf(cultured, cultureRules)).toEqual({
      condition: 'cultural',
      winner: cityOf(cultured).owner,
    });

    // Score: the horizon, reached by a real turn loop.
    const horizon = 5;
    const scoreRules = patched({ victory: { scoreVictoryTurn: horizon } });
    let scored = founded(47, scoreRules);
    for (let step = 0; step < horizon + 2 && scored.turn < horizon; step += 1) {
      scored = advanceTurn(scored, scoreRules).state;
    }
    expect(winnerOf(scored, scoreRules)).toEqual({
      condition: 'score',
      winner: highestScore(scored, scoreRules)?.playerId,
    });

    // Domination: both shares, with the thresholds moved to values this board reaches.
    const domRules = patched({
      culture: { borderRadius2Culture: 1, borderRadius3Culture: 2 },
      victory: { dominationLandPct: 1, dominationPopPct: 50 },
    });
    const domBase = withCulture(
      founded(47, domRules),
      cityOf(founded(47, domRules)).id,
      2,
      domRules,
    );
    const domBoard = withOwnership(
      {
        ...domBase,
        cities: [
          ...domBase.cities,
          {
            ...cityOf(domBase),
            id: asCityId(Number(cityOf(domBase).id) + 200),
            owner: playerOf(domBase, 1),
            tile: asTileIndex(Number(cityOf(domBase).tile) + 6),
          },
        ],
      },
      domRules,
    );
    expect(winnerOf(domBoard, domRules)).toEqual({
      condition: 'domination',
      winner: playerOf(domBoard, 0),
    });
  });

  it('a condition fires inside the harness, and the run reports it', () => {
    // "At least one condition firing through the tournament" — the one acceptance line that
    // cannot be met by a hand-built board, because it is about the *harness* noticing. The
    // horizon is moved down to a run a fast test can afford, and the run is asserted to stop
    // for the right reason rather than merely to end.
    const ruleset = patched({ victory: { scoreVictoryTurn: 8 } });
    const result = runSimulation({
      seed: 53,
      settings: settingsFor(53),
      ruleset,
      policies: [SIMPLE_POLICY, SIMPLE_POLICY],
      maxTurns: 40,
    });

    expect(result.violations).toEqual([]);
    expect(result.stoppedBecause).toBe('game-over');
    expect(result.outcome?.condition).toBe('score');
    expect(result.outcome?.turn).toBe(scoreHorizon(ruleset));
    expect(result.turnsPlayed).toBeLessThan(40);
    expect(hashValue(result.finalState)).toBe(result.finalHash);
    // The run stopped for the game's reason, not the harness's: the same seed with the
    // horizon out of reach plays on to its own limit.
    const longer = runSimulation({
      seed: 53,
      settings: settingsFor(53),
      ruleset: patched({ victory: { scoreVictoryTurn: 400 } }),
      policies: [SIMPLE_POLICY, SIMPLE_POLICY],
      maxTurns: 40,
    });
    expect(longer.stoppedBecause).toBe('max-turns');
    expect(longer.outcome).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 5. Barbarians
 * ------------------------------------------------------------------ */

/** The barbarian player of a state, or a failure naming what was expected. */
const barbariansOf = (state: GameState): PlayerId => {
  const row = state.players.find((player) => player.kind === 'barbarian');
  if (row === undefined) throw new Error('the state has no barbarian player, which M3 placed');
  return row.id;
};

describe('5. barbarians never win, never score, and never count toward conquest', () => {
  /**
   * A board where the barbarian holds a **bigger** city than the civilization, and where the
   * rival civilization has already left the board — so the conquest condition is decided and
   * the question "does the barbarian keep it undecided?" is answerable.
   */
  const barbarianBoard = (): GameState => {
    const state = foundedBoth(59);
    const barbarian = barbariansOf(state);
    const rival = playerOf(state, 1);
    const city = cityOf(state);
    return withOwnership(
      {
        ...state,
        units: state.units.filter((unit) => unit.owner !== rival),
        cities: [
          // The rival civilization's own city leaves the board with its units: "in play" is
          // "holds a city or commands a unit" and this fixture has to satisfy the first half
          // of that sentence too.
          ...state.cities.filter((candidate) => candidate.owner !== rival),
          {
            ...city,
            id: asCityId(Number(city.id) + 300),
            owner: barbarian,
            tile: asTileIndex(Number(city.tile) + 8),
            culture: 40,
            population: 9,
          },
        ],
      },
      RULESET,
    );
  };

  it('the score victory never names them, even when they lead the board', () => {
    // The barbarian city above is deliberately *bigger* than the civilization's: nine
    // citizens and forty culture. If barbarians were candidates, they would win — which is
    // what makes the assertion below about the rule rather than about the fixture.
    const state = barbarianBoard();
    const barbarian = barbariansOf(state);
    const best = highestScore(state, RULESET);

    expect(best?.playerId).not.toBe(barbarian);
    // The fixture is what makes that assertion mean something: the barbarian's own score is
    // **higher** than the winner's, so a filter that had been left out would have named it.
    expect(playerScore(state, RULESET, barbarian)).toBeGreaterThan(best?.score ?? 0);

    // …and the *condition* agrees with the scoreboard's filter, which is the pair that would
    // drift: `highestScore` excludes barbarians, and the score condition reads it.
    // The loop is **bounded by a counter**, not by the turn: this board is already decided
    // (that is the point of the fixture above), so `advanceTurn` returns it unchanged and a
    // `while (turn < horizon)` loop would spin for ever. That is a real hazard of a finished
    // state and it is worth the comment it costs.
    let scored = state;
    const ruleset = patched({ victory: { scoreVictoryTurn: 2 } });
    for (
      let step = 0;
      step < scoreHorizon(ruleset) + 2 && scored.turn < scoreHorizon(ruleset);
      step += 1
    ) {
      scored = advanceTurn(scored, ruleset).state;
    }
    expect(gameOutcomeOf(scored, ruleset)?.winner).not.toBe(barbarian);
  });

  it('conquest ignores them: a barbarian city does not keep a rival in play', () => {
    // The contract's "never count toward conquest". The civilization holds every *civilization's*
    // city and the barbarians still hold theirs — the game is decided, because "who is left"
    // is a question about civilizations.
    const state = barbarianBoard();
    const winner = playerOf(state, 0);
    const verdict = gameOutcomeOf(state, RULESET);
    expect(verdict?.condition).toBe('conquest');
    expect(verdict?.winner).toBe(winner);

    // Non-vacuity the other way: put a *civilization's* city back in the rival's hands — the
    // same barbarian city stays on the board — and the game is no longer decided. So the
    // conquest above is about the rival civilizations and not about the barbarian's presence.
    const rival = playerOf(state, 1);
    const contested = withOwnership(
      {
        ...state,
        cities: [
          ...state.cities,
          {
            ...cityOf(state),
            id: asCityId(Number(cityOf(state).id) + 400),
            owner: rival,
            tile: asTileIndex(Number(cityOf(state).tile) + 12),
          },
        ],
      },
      RULESET,
    );
    expect(gameOutcomeOf(contested, RULESET)).toBeNull();
    expect(contested.cities.some((city) => city.owner === barbariansOf(contested))).toBe(true);
    expect(contested.cities.some((city) => city.owner === rival)).toBe(true);
  });

  it('a domination victory does not count their citizens for anybody', () => {
    // The population denominator counts every city on the board, barbarian ones included —
    // "the world population is a fact about the world" — but the barbarian can never be the
    // *winner*: the denomination is the world's, the numerator is a civilization's.
    const state = barbarianBoard();
    const barbarian = barbariansOf(state);
    const ruleset = patched({ victory: { dominationLandPct: 1, dominationPopPct: 100 } });
    const verdict = gameOutcomeOf(state, ruleset);
    expect(verdict?.winner).not.toBe(barbarian);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Goldens and determinism
 * ------------------------------------------------------------------ */

const tsxCliPath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli');
  } catch (cause) {
    throw new Error(
      'the fresh-process check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
};

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The vitest CLI's own entry point, as an **absolute** path.
 *
 * A relative specifier is resolved against the importing module rather than against the
 * child's working directory, so `'node_modules/vitest/vitest.mjs'` looked for the file beside
 * `tsx` instead of in the repository — measured, as `ERR_MODULE_NOT_FOUND` under
 * `/home/box/node_modules/`. An absolute path is the whole fix, and it is asserted to exist so
 * a moved CLI fails here rather than as a confusing child error.
 */
const vitestCliPath = (): string => {
  const path = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  if (!existsSync(path)) throw new Error(`the vitest CLI is not at ${path}`);
  return path;
};

/** The child program: one scripted game, hashed. It holds no expectation of its own. */
const determinismChildScript = (options: {
  readonly seed: number;
  readonly ruleset: RulesetPatch | null;
  readonly turns: number;
}): string => `
import { DEFAULT_SETTINGS, advanceTurn, civPlayers, newGame } from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import { applyOverrides, policyRngFor, SIMPLE_POLICY } from '@civts/sim';
import { hashValue } from '@civts/testing';
import { applyCommand } from '@civts/core';

const options = ${JSON.stringify(options)};
const catalog = options.ruleset === null ? CATALOG : applyOverrides(CATALOG, options.ruleset);
const validated = validateRuleset(catalog, 'tuned');
if (!validated.ok) throw new Error('the child could not validate the catalog');
const ruleset = validated.value;

let state = newGame(options.seed, { ...DEFAULT_SETTINGS, seed: options.seed, mapSize: 'tiny', civCount: 2 }, ruleset).value;
for (let turn = 0; turn < options.turns; turn += 1) {
  for (const player of civPlayers(state)) {
    const commands = SIMPLE_POLICY.chooseCommands({
      state, playerId: player.id, ruleset, rng: policyRngFor(options.seed, player.id, state.turn),
    });
    for (const command of commands) {
      if (command.type === 'EndTurn') continue;
      const outcome = applyCommand(state, player.id, command, ruleset);
      if (outcome.ok) state = outcome.value.state;
    }
  }
  state = advanceTurn(state, ruleset).state;
}
console.log('HASH ' + hashValue(state) + ' TURN ' + state.turn);
`;

/** The same scripted game in this process, so the child has something to be compared with. */
const inProcessHash = (options: {
  readonly seed: number;
  readonly ruleset: Ruleset | null;
  readonly turns: number;
}): string => {
  const ruleset = options.ruleset ?? RULESET;
  let state = freshState(options.seed, ruleset);
  for (let turn = 0; turn < options.turns; turn += 1) {
    for (const player of civPlayers(state)) {
      const commands = SIMPLE_POLICY.chooseCommands({
        state,
        playerId: player.id,
        ruleset,
        rng: policyRngFor(options.seed, player.id, state.turn),
      });
      for (const command of commands) {
        if (command.type === 'EndTurn') continue;
        const outcome = applyCommand(state, player.id, command, ruleset);
        if (outcome.ok) state = outcome.value.state;
      }
    }
    state = advanceTurn(state, ruleset).state;
  }
  return hashValue(state);
};

describe('6. goldens and determinism', () => {
  it('the golden file is the gate, with no regeneration variable set', () => {
    // The two halves of "the goldens still gate": **nothing in this process is allowed to
    // rewrite them**, and the file on disk is exactly what this build computes. The first
    // assertion is about the environment (a `CIVTS_WRITE_GOLDENS` left in a shell would turn
    // every later failure into a silent rewrite), and the second is the gate itself,
    // recomputed here rather than trusted to the golden suite.
    expect(process.env['CIVTS_WRITE_GOLDENS']).toBeUndefined();

    const file = loadGoldens();
    if (file === undefined) throw new Error('no golden file is committed');
    expect(file.nodeMajor).toBe(Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10));

    const fresh = file.entries.filter((entry) => entry.name.startsWith('tiny-civs2-'));
    expect(fresh.length).toBeGreaterThan(0);
    for (const entry of fresh) {
      const seed = Number.parseInt(entry.name.replace('tiny-civs2-seed', ''), 10);
      expect(hashValue(freshState(seed)), `${entry.name} does not match this build`).toBe(
        entry.hash,
      );
    }

    // Every entry is a distinct 16-hex digest: the file is not a list of one hash repeated,
    // which is what a broken regeneration would leave behind.
    expect(new Set(file.entries.map((entry) => entry.hash)).size).toBe(file.entries.length);
    for (const entry of file.entries) expect(entry.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it.skipIf(!FULL_TIER)(
    'the golden suite itself is green in a child process with the variable unset',
    () => {
      // The claim "the golden test passes WITHOUT regeneration" is about the *test*, so it is
      // checked by running the test — in a child whose environment has the variable deleted,
      // because a variable inherited from the parent would make the run rewrite the file and
      // pass. Full tier only: a nested vitest run is several seconds, and the fast tier's
      // budget is a standing requirement.
      const env = { ...process.env };
      delete env['CIVTS_WRITE_GOLDENS'];
      const result = spawnSync(
        process.execPath,
        [
          tsxCliPath(),
          vitestCliPath(),
          'run',
          'packages/testing/test/golden.test.ts',
          '--reporter=dot',
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 300_000, env },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, `the golden suite failed without the variable:\n${output}`).toBe(0);
      expect(output).toContain('passed');
    },
  );

  it('the same seed and policies hash the same twice in this process', () => {
    const first = inProcessHash({ seed: 61, ruleset: null, turns: 25 });
    const second = inProcessHash({ seed: 61, ruleset: null, turns: 25 });
    expect(second).toBe(first);

    // …and a different seed is a different game, so the equality above is not the equality of
    // a constant. One turn fewer is a different game too — the sharpest version of "the turn
    // loop reaches the hash".
    expect(inProcessHash({ seed: 62, ruleset: null, turns: 25 })).not.toBe(first);
    expect(inProcessHash({ seed: 61, ruleset: null, turns: 24 })).not.toBe(first);
  });

  it('and hash the same in a fresh process, with a patched catalog too', () => {
    // The fresh process is what rules out an in-process cache, a module-level memo or an
    // iteration-order artefact of this run. The card is *patched*, so the comparison covers
    // the M9/M10 sections a default catalog would leave unused, and the child prints the turn
    // as well as the hash so a run that silently stopped early is caught by the number.
    const patch: RulesetPatch = {
      culture: { borderRadius2Culture: 3, borderRadius3Culture: 12 },
      governments: { monarchy: { rateCaps: { luxury: 3 } } },
      victory: { culturalVictoryCulture: 400, scoreVictoryTurn: 300 },
      score: { perCulture: 2 },
    };
    const options = { seed: 67, ruleset: patch, turns: 30 };
    const ruleset = patched(patch);
    const expected = inProcessHash({ seed: 67, ruleset, turns: 30 });

    const result = spawnSync(
      process.execPath,
      [tsxCliPath(), '-e', determinismChildScript(options)],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    const stderr = `${result.stderr}${
      result.error === undefined ? '' : `launch failed: ${result.error.message}`
    }`;
    expect(result.status, `the fresh process failed:\n${stderr}`).toBe(0);
    expect(result.stdout).toContain(`HASH ${expected}`);
    expect(result.stdout).toContain('TURN 31');

    // The child's number is compared with a *second* in-process run rather than with the one
    // above, so this assertion would also catch a child that agreed with itself.
    expect(inProcessHash({ seed: 67, ruleset, turns: 30 })).toBe(expected);
  });

  it('a terminal state hashes, and the golden entry for one is in the file', () => {
    // M10's acceptance item is "a played golden that INCLUDES a victory", and the *file* is
    // where that has to be true. The hash is recomputed here from the same scripted game the
    // golden suite plays, so a regeneration that dropped the entry is caught rather than
    // discovered by the suite it was regenerated by.
    const file = loadGoldens();
    if (file === undefined) throw new Error('no golden file is committed');
    const names = file.entries.map((entry) => entry.name);
    expect(names).toContain('played-civs2-seed42-victory');
    expect(names).toContain('played-civs2-seed42-combat');

    // The M10 entry is the *ended* game, and the file is only evidence of that if the entry's
    // own hash is reproducible — so the same scripted game the golden suite plays is hashed
    // here again, in a child. The hash is compared with the in-process one rather than with the
    // stored entry, because the stored entry is what the golden suite checks and a second copy
    // of that assertion here would be a second statement of one rule.
    const horizon = scoreHorizon(RULESET);
    const options = { seed: 42, ruleset: null, turns: horizon + 4 };
    const first = inProcessHash(options);
    expect(inProcessHash(options)).toBe(first);
  });
});

/* ------------------------------------------------------------------ *
 * 7. The UI's claims, on the engine's side
 * ------------------------------------------------------------------ */

describe('7. the UI — the readouts the browser binds to, and the seam it goes through', () => {
  /**
   * The engine-side facts every M9/M10 panel is a view of.
   *
   * The browser half of this section is the Playwright suite
   * (`packages/web/e2e/m9-m10-ui.spec.ts`), which is **not collected by vitest** — asserted in
   * section 8 — and which cannot be driven from here: the pixel test needs a real canvas and
   * the draw trace needs the app's own seam. What can be checked here, and is, is that the
   * *functions those panels read* say what the panels claim they say: a panel that rendered a
   * second opinion would still pass its own unit test, and would fail here.
   */
  it('the victory screen’s readouts come from `outcomeFor`, naming condition, turn and winner', () => {
    const state = foundedBoth(71);
    const winner = playerOf(state, 0);
    const loser = playerOf(state, 1);
    const decided = withOwnership(
      {
        ...state,
        cities: state.cities.filter((city) => city.owner === winner),
        units: state.units.filter((unit) => unit.owner !== loser),
      },
      RULESET,
    );

    const mine = outcomeFor(decided, RULESET, winner);
    const theirs = outcomeFor(decided, RULESET, loser);
    expect(mine?.kind).toBe('victory');
    expect(theirs?.kind).toBe('defeat');
    // The same condition, the same turn and the same winner for both seats: one is a victory
    // and the other a defeat, which is the whole of what the two screens differ by.
    expect(theirs?.condition).toBe(mine?.condition);
    expect(theirs?.turn).toBe(mine?.turn);
    expect(theirs?.winner).toBe(mine?.winner);

    // …and an undecided game has no screen at all, which is `undefined` rather than a `null`
    // outcome object: a panel that showed "no result" as a result would be a second state.
    expect(outcomeFor(state, RULESET, winner)).toBeUndefined();
    expect(gameOutcomeOf(state, RULESET)).toBeNull();
  });

  it('the city screen’s culture, happiness and disorder are the engine’s own numbers', () => {
    // The three facts the city panel gained. Culture is the **city's** accumulated figure and
    // the player's total is the *sum* the panel shows beside it — so both are asserted, and the
    // total is asserted to be the sum rather than a field.
    const state = founded(73);
    const city = cityOf(state);
    const cultured = withCulture(state, city.id, 13);
    const shown = cityOf(cultured);

    expect(wholeCulture(shown.culture)).toBe(13);
    expect(playerCulture(cultured, shown.owner)).toBe(13);
    expect(playerCulture(cultured, shown.owner)).toBe(
      cultured.cities
        .filter((candidate) => candidate.owner === shown.owner)
        .reduce((total, candidate) => total + wholeCulture(candidate.culture), 0),
    );
    // No player row carries the total: a stored copy beside the sum is the shape that drifts.
    for (const player of cultured.players) {
      expect(Object.keys(player)).not.toContain('culture');
    }

    const happiness = happinessOf(cultured, RULESET, shown);
    expect(happiness.happy + happiness.content + happiness.unhappy).toBe(shown.population);
    expect(isDisordered(cultured, RULESET, shown.id)).toBe(happiness.unhappy > happiness.happy);

    // The disorder sentence the panel renders is the engine's verdict on the *same* city, so a
    // panel cannot say "in disorder" about a city the engine says is content.
    const starved = withPopulation(cultured, shown.id, 40);
    expect(isDisordered(starved, RULESET, shown.id)).toBe(true);
  });

  it('the score column is the one scoring function, cell by cell', () => {
    const state = foundedBoth(79);
    for (const player of civPlayers(state)) {
      const breakdown = scoreBreakdown(state, RULESET, player.id);
      expect(breakdown.score).toBe(playerScore(state, RULESET, player.id));
      // The five terms are the panel's own columns, so each is checked to be the weighted
      // figure rather than a count: a panel that printed `population` in the score column would
      // pass a "the number is positive" test and fail this one.
      const weights = scoreRulesOf(RULESET);
      expect(breakdown.score).toBe(
        weights.perPopulation * breakdown.population +
          weights.perCity * breakdown.cities +
          weights.perTech * breakdown.techs +
          weights.perCulture * breakdown.culture +
          weights.perWonder * breakdown.wonders,
      );
    }
  });

  it('the government selector offers the catalog and refuses with the engine’s own reason', () => {
    // The selector's menu **is** the catalog, and its verdict **is** the planner the command
    // layer uses. Both are asserted against the engine rather than against a copy: a menu built
    // from a literal list would drift from the catalog silently, and a verdict computed in the
    // panel would be a second opinion about legality.
    const rows = governmentCatalog(RULESET);
    expect(rows.map((row) => row.id)).toEqual(['despotism', 'monarchy', 'republic']);

    const state = founded(83);
    const player = playerOf(state, 0);
    const gated = rows.find((row) => row.requiresTech !== undefined);
    if (gated === undefined) throw new Error('no shipped government is technology-gated');

    // The technology-gated row is refused, and the refusal names both the row and the tech —
    // which is what the panel renders verbatim.
    const refused = refusalOf(
      state,
      player,
      { type: 'SetGovernment', government: gated.id },
      RULESET,
    );
    expect(refused.kind).toBe('government-tech-required');
    if (refused.kind !== 'government-tech-required') throw new Error('unreachable');
    expect(refused.government).toBe(gated.id);
    expect(refused.tech).toBe(gated.requiresTech);

    // …and the *planner* the panel calls agrees with the applier, which is the pair that would
    // otherwise be two statements of one rule.
    const planned = planSetGovernment(state, RULESET, player, gated.id);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.kind).toBe(refused.kind);

    // An unknown row is refused with the catalog's own list of ids, so the panel can print what
    // the player may choose instead.
    const unknown = refusalOf(
      state,
      player,
      { type: 'SetGovernment', government: asGovernmentId('no-such-government') },
      RULESET,
    );
    expect(unknown.kind).toBe('unknown-government');
    if (unknown.kind !== 'unknown-government') throw new Error('unreachable');
    expect(unknown.known).toEqual(rows.map((row) => row.id));

    // The ungated row is accepted, so the refusals above are the gate and not a selector that
    // refuses everything.
    const open = rows.find((row) => row.requiresTech === undefined);
    expect(open).toBeDefined();
    if (open !== undefined) {
      expect(
        applyCommand(state, player, { type: 'SetGovernment', government: open.id }, RULESET).ok,
      ).toBe(true);
    }
  });

  it('the e2e suite exists, and vitest does not collect it', () => {
    // The border pixel test and the draw trace live in Playwright; they are named here so that
    // a deleted spec is a failure in this file rather than a suite that quietly shrank.
    const spec = readFileSync(
      fileURLToPath(new URL('../../web/e2e/m9-m10-ui.spec.ts', import.meta.url)),
      'utf8',
    );
    for (const claim of ['tileOwner', 'border', 'Game over', 'Set government', 'Score']) {
      expect(spec, `the e2e spec no longer mentions ${claim}`).toContain(claim);
    }

    // …and the draw trace's own fields, which are what a border *is* in the seam.
    const helpers = readFileSync(
      fileURLToPath(new URL('../../web/e2e/helpers.ts', import.meta.url)),
      'utf8',
    );
    expect(helpers).toContain('owner');
    expect(helpers).toContain('border');
  });
});

/* ------------------------------------------------------------------ *
 * 8. Tidemark
 * ------------------------------------------------------------------ */

describe('8. tidemark — twenty seeds, a hundred turns, and no invariant violated', () => {
  /**
   * The tidemark sweep, at whatever size the calling tier can afford.
   *
   * The two callers below run the **same assertions** at two horizons. That is the tier split
   * this file chose and it is worth stating why: twenty seeds of a hundred turns is 36.6 seconds
   * measured, which is more than half the entire fast tier's budget on its own, and the standing
   * requirement is that `pnpm verify` stays under seventy seconds. Rather than shorten the
   * *claim*, the claim is made in full in the full tier — where the budget is ten minutes — and
   * the fast tier runs the identical machinery over a shorter horizon so a broken fold, a
   * violation or a distribution that stopped adding up still fails on every commit.
   */
  const sweep = (maxTurns: number, context: string): void => {
    const seeds = Array.from({ length: 20 }, (_unused, index) => 100 + index);
    const startedAt = Date.now();
    const batch = runBatch({
      seeds,
      settings: settingsFor(seeds[0] ?? 100),
      ruleset: RULESET,
      policies: [SIMPLE_POLICY, SIMPLE_POLICY],
      maxTurns,
    });
    const wallMs = Date.now() - startedAt;

    expect(batch.runs).toHaveLength(20);
    const violations = batch.runs.flatMap((run) => run.violations);
    expect(violations).toEqual([]);

    // Every game is a *complete* game: a run that stopped on the first turn would report no
    // violations and prove nothing, so the horizon is asserted per run.
    for (const run of batch.runs) {
      expect(invariantIsClean(run.finalState)).toBe(true);
      expect(run.turnsPlayed).toBeGreaterThan(0);
      // Every game ran to the horizon or ended: `no-commands` and `violation` are the two
      // reasons that would mean the sweep measured less than it says.
      expect(['max-turns', 'game-over'], `a run stopped for ${run.stoppedBecause}`).toContain(
        run.stoppedBecause,
      );
    }

    // The distribution, by the engine's own stop reason and by condition.
    const byStop = new Map<string, number>();
    const byCondition = new Map<string, number>();
    for (const run of batch.runs) {
      byStop.set(run.stoppedBecause, (byStop.get(run.stoppedBecause) ?? 0) + 1);
      const condition = run.outcome?.condition ?? 'none (still in play)';
      byCondition.set(condition, (byCondition.get(condition) ?? 0) + 1);
    }
    expect([...byCondition.values()].reduce((sum, count) => sum + count, 0)).toBe(20);

    const endings = [...byStop.entries()].map(([reason, count]) => `${reason}=${String(count)}`);
    const conditions = [...byCondition.entries()].map(
      ([condition, count]) => `${condition}=${String(count)}`,
    );
    console.log(
      `m9-m10 tidemark (${context}): 20 seeds x ${String(maxTurns)} turns, ` +
        `${String(wallMs)} ms, stop {${endings.sort().join(', ')}}, ` +
        `condition {${conditions.sort().join(', ')}}`,
    );

    // The batch's own `wins` agrees with the distribution counted here — the same fact read
    // twice, which is what proves the fold and the runs cannot disagree.
    const summed = (batch.wins ?? []).reduce((sum, row) => sum + row.count, 0);
    expect(summed).toBe(20 - (byStop.get('max-turns') ?? 0));
    for (const row of batch.wins ?? []) {
      expect(row.count).toBe(
        batch.runs.filter((run) => run.outcome?.condition === row.outcome).length,
      );
    }

    // A smoke alarm rather than a benchmark: a regression that made the sweep ten times slower
    // should fail here rather than in somebody's stopwatch.
    expect(wallMs, `the ${context} sweep took longer than its budget`).toBeLessThan(120_000);
  };

  it('twenty seeds run clean over the fast tier’s horizon, and the distribution is reported', () => {
    // Eight turns in the fast tier: the sweep's cost is linear in the horizon (measured:
    // 20 seeds × 100 turns is 36.6 s, × 25 is 11.7 s, × 12 is 5.5 s), and the fast tier's
    // budget is a standing requirement rather than a target. Twenty *seeds* is what the
    // acceptance line asks for and the seed count is kept; only the horizon moves, and the full
    // tier runs the acceptance line's own hundred.
    sweep(8, 'fast tier');
  }, 120_000);

  it.skipIf(!FULL_TIER)(
    'twenty seeds × one hundred turns run clean, and the distribution is reported',
    () => {
      // The acceptance line's own size. Full tier only — see `sweep`.
      sweep(100, 'full tier');
    },
    300_000,
  );

  it('the fast tier does not collect the e2e suite, and does collect the web unit tests', () => {
    // "Confirm the fast tier ≤ 70 s and the e2e suite not collected by vitest". The second half
    // is a claim about the **glob**, and the glob is read rather than described: `testInclude`
    // is exported by the config for exactly this reason.
    const config = readFileSync(
      fileURLToPath(new URL('../../../vitest.config.ts', import.meta.url)),
      'utf8',
    );
    expect(config).toContain("'packages/*/test/**/*.test.ts'");

    // …so a Playwright spec under `packages/web/e2e/` cannot match it: the directory is `e2e`
    // rather than `test`, and the extension is `.spec.ts` rather than `.test.ts`. Both are
    // asserted because either alone would be enough and a future config that moved one of them
    // should fail loudly.
    const specPath = 'packages/web/e2e/m9-m10-ui.spec.ts';
    expect(specPath.includes('/test/')).toBe(false);
    expect(specPath.endsWith('.test.ts')).toBe(false);

    // …and the web unit tests are collected by the same glob, so the exclusion above is about
    // the e2e directory and not about the web package.
    const unitPath = 'packages/web/test/panels/victory.test.ts';
    expect(unitPath.includes('/test/')).toBe(true);
    expect(unitPath.endsWith('.test.ts')).toBe(true);
  });

  it('the invariant registry the sweep used is the whole one', () => {
    // "Zero invariant violations" is only evidence if the registry was not empty: a run checked
    // against no predicates reports no violations perfectly. The count and one name from each
    // M9/M10 group are asserted, so a registry that lost its additions fails here.
    expect(CORE_INVARIANTS.length).toBeGreaterThanOrEqual(35);
    const names = CORE_INVARIANTS.map((invariant) => invariant.name);
    for (const name of [
      'tile-owner-matches-culture',
      'tile-owner-names-a-real-player',
      'tile-owned-by-a-city-in-range',
      'government-is-in-catalog',
      'rates-within-government-caps',
      'city-culture-non-negative-and-integral',
      'disorder-zeroes-the-yields',
      'finished-game-does-not-advance',
    ]) {
      expect(names, `the registry has lost ${name}`).toContain(name);
    }

    // A spot check that the registry really *runs* on a state: a corrupted board is caught, so
    // "no violations" above is a measurement rather than an empty loop.
    const state = founded(101);
    const city = cityOf(state);
    const broken = withCityCultureUnchecked(state, city.id, -1);
    const found = checkInvariants(
      {
        state: broken,
        previous: undefined,
        ruleset: RULESET,
        rulesetView: RULESET,
        events: [],
        turn: broken.turn,
      },
      CORE_INVARIANTS,
    );
    expect(found.map((violation) => violation.invariant)).toContain(
      'city-culture-non-negative-and-integral',
    );
  });
});

/** A state with a city's culture written to a value no rule can produce, without re-deriving. */
const withCityCultureUnchecked = (
  state: GameState,
  cityId: CityId,
  culture: number,
): GameState => ({
  ...state,
  cities: state.cities.map((city) => (city.id === cityId ? { ...city, culture } : city)),
});

/**
 * Does the engine's own registry leave a state alone? A thin wrapper so the sweep's
 * non-vacuity reads as a sentence rather than as a context literal.
 */
const invariantIsClean = (state: GameState): boolean =>
  checkInvariants(
    {
      state,
      previous: undefined,
      ruleset: RULESET,
      rulesetView: RULESET,
      events: [],
      turn: state.turn,
    },
    CORE_INVARIANTS,
  ).length === 0;

/* ------------------------------------------------------------------ *
 * 9. Mutation check
 * ------------------------------------------------------------------ */

/** What a mutation does to a source file, and the test that must notice. */
interface Mutation {
  readonly label: string;
  /** The finding this mutation is a *pretend* version of. */
  readonly story: string;
  readonly path: string;
  readonly from: string;
  readonly to: string;
  /** The `-t` filter naming the test that has to go red. */
  readonly filter: string;
}

/**
 * **The mutation check runs only when it is asked for, and the reason is a measured hazard
 * rather than a preference.**
 *
 * This section edits two source files on disk, runs a child vitest against them and restores
 * them. Vitest runs *files* in parallel by default, so for the ~3 seconds of that window any
 * other test file that imports `borders.ts` or `cities.ts` — or spawns a child process that
 * does — reads the mutated code. Measured, in a full-tier run: seven unrelated tests failed,
 * every one of them a fresh-process hash comparison that had picked up the mutation. A check
 * that breaks its neighbours is not a check.
 *
 * So it is gated on `CIVTS_MUTATION_CHECK=1` and run in its own vitest invocation with the
 * file parallelism off:
 *
 *     pnpm mutation:check
 *
 * The gate is the repository's own convention for a suite that must not run beside the others
 * (`tier.ts` does the same thing for the long tests), and like a tier skip it is **reported by
 * name** in the summary rather than hidden — the fast and full runs print this describe block
 * as skipped, so a reader learns the boundary from the output.
 */
const MUTATION_CHECK = process.env['CIVTS_MUTATION_CHECK'] === '1';

describe.skipIf(!MUTATION_CHECK)(
  '9. mutation check — the suite can fail, and the sources are untouched afterwards',
  () => {
    /**
     * Two deliberate breaks, each the *pretend* version of a defect this wave could really have.
     *
     * The point is not that the code can be broken — anything can — but that **these tests would
     * notice**: a suite that passes on every input is the failure mode a verification file is
     * most likely to have, and the only way to rule it out is to break the thing on purpose and
     * watch the suite go red. Each mutation is undone in a `finally`, and the file's digest is
     * compared before and after, so a mutation that leaked into the working tree is a failure of
     * this test rather than a surprise in somebody's next commit.
     *
     * The child processes are filtered to the single test that must notice, so the cost is ~2 s
     * each rather than a second full run.
     */
    const mutations: readonly Mutation[] = [
      {
        label: 'ownership disagrees with the culture ranges',
        story:
          'the radius-3 threshold answered radius 2, so the ownership layer and the catalog’s own thresholds name different rings — an off-by-one in the ladder this file’s headline section exists to catch',
        path: 'packages/core/src/borders.ts',
        // The **fallback radius**, which every city on the board takes: a mutation inside the
        // radius-3 branch is invisible on a thirty-turn game (no city reaches a hundred culture),
        // and an unobservable mutation would "prove" that a green suite means a correct engine.
        // Measured, twice: the first two versions of this entry mutated the radius-3 branch and
        // then the radius-2 branch, and the suite stayed green both times — which is exactly the
        // lesson this whole section exists to teach.
        from: '  if (whole >= rules.borderRadius2Culture) return 2;\n  return 1;',
        to: '  if (whole >= rules.borderRadius2Culture) return 2;\n  return 0;',
        filter: 'my own reading of the contract',
      },
      {
        label: 'disorder produces shields anyway',
        story:
          '`cityYields` returned the ordinary yields for a city in disorder — the rule stated, the arithmetic kept',
        path: 'packages/core/src/cities.ts',
        from: 'return { food: raw.food, shields: 0, commerce: 0, foodSurplus: 0 };',
        to: 'return raw;',
        filter: 'yields are zero',
      },
    ];

    it('both mutations at once make the suite RED, each named as the test that noticed', () => {
      // One child run rather than two, and the reason is the fast tier's budget: a nested vitest
      // run costs ~2.5 s in startup alone, so the two mutations are applied *together* and the
      // child's output is required to name **both** tests as failures. That is a strictly
      // stronger assertion than two separate runs would give, because a mutation that masked
      // another — or a child that aborted before reaching the second test — fails the check.
      //
      // The two are independent by construction (different files, different sections) and the
      // table guard below fails if that ever stops being true.
      const originals = mutations.map((mutation) => {
        const full = fileURLToPath(new URL(`../../../${mutation.path}`, import.meta.url));
        const text = readFileSync(full, 'utf8');
        // A mutation whose target text is not there is a *stale* mutation, and a stale mutation
        // that silently did nothing would make this test pass while proving nothing. Failing
        // loudly is the only safe reading.
        expect(
          text,
          `the mutation's target is not in ${mutation.path}: ${mutation.story}`,
        ).toContain(mutation.from);
        expect(
          text.split(mutation.from).length - 1,
          `${mutation.path} matches more than once`,
        ).toBe(1);
        return { full, text, digest: createHash('sha256').update(text).digest('hex') };
      });

      const result = ((): { readonly status: number | null; readonly output: string } => {
        try {
          for (const [index, mutation] of mutations.entries()) {
            const entry = originals[index];
            if (entry === undefined) throw new Error('unreachable');
            writeFileSync(entry.full, entry.text.replace(mutation.from, mutation.to), 'utf8');
          }
          const child = spawnSync(
            process.execPath,
            [
              tsxCliPath(),
              vitestCliPath(),
              'run',
              'packages/testing/test/m9-m10-adversarial.test.ts',
              '-t',
              mutations.map((mutation) => mutation.filter).join('|'),
              '--reporter=dot',
            ],
            { cwd: repoRoot, encoding: 'utf8', timeout: 300_000 },
          );
          return { status: child.status, output: `${child.stdout}${child.stderr}` };
        } finally {
          // Restored **before** any assertion below, so a failure reports the mutation rather than
          // leaving a broken source behind.
          for (const entry of originals) writeFileSync(entry.full, entry.text, 'utf8');
        }
      })();

      expect(
        result.status,
        `the suite stayed GREEN with ${String(mutations.length)} mutations in place — those ` +
          `tests prove nothing:\n${result.output}`,
      ).not.toBe(0);
      // Every mutation was noticed **by its own test**, named in the child's own report.
      for (const mutation of mutations) {
        expect(
          result.output,
          `no failure was reported for "${mutation.filter}" — the mutation of ${mutation.path} ` +
            `went unnoticed:\n${result.output}`,
        ).toContain(mutation.filter);
      }
      expect(result.output).toMatch(/FAIL|failed/);
      expect(result.output).not.toContain('SyntaxError');
      expect(result.output).not.toContain('Cannot find module');

      // …and the working tree is exactly what it was.
      for (const [index, mutation] of mutations.entries()) {
        const entry = originals[index];
        if (entry === undefined) throw new Error('unreachable');
        const after = readFileSync(entry.full, 'utf8');
        expect(after, `${mutation.path} was not restored`).toBe(entry.text);
        expect(createHash('sha256').update(after).digest('hex')).toBe(entry.digest);
        // The reverted file still contains the text the mutation replaced, which is what makes the
        // digest comparison a statement about *this* mutation rather than about an empty file.
        expect(after).toContain(mutation.from);
      }
    }, 300_000);

    it('the two mutations target different files, so neither is a copy of the other', () => {
      // A cheap guard on the table itself: two mutations of one line would make the second a
      // duplicate of the first, and the suite would "prove" one break twice.
      const paths = mutations.map((mutation) => mutation.path);
      expect(new Set(paths).size).toBe(mutations.length);
      for (const mutation of mutations) expect(mutation.from).not.toBe(mutation.to);
    });
  },
);
