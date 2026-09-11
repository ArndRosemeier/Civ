/**
 * Evidence for `CORE_INVARIANTS` — the registry that runs in tests *and* on every
 * turn of every simulation. See docs/INTERFACES.md, "STANDING REQUIREMENT —
 * simulation-first" (point 4) and the M3 acceptance evidence for the conservation
 * half this registry now owns.
 *
 * The file is organised so that neither direction of failure can hide:
 *
 * 1. **The registry is not vacuous.** Every named invariant is *proved to fire* on a
 *    deliberately broken state — a registry that has never failed is evidence of
 *    nothing — and proved *not* to fire on the clean state the same fixture produces.
 * 2. **The registry is not noisy.** A real game is driven headlessly, commands and
 *    ends of turn included, and the whole registry runs on every transition. A false
 *    alarm here is worse than a missed check: it stops a run, and it makes every
 *    later balance number untrustworthy. The sweep also counts the branches it took
 *    (growth, starvation, completions, work completions) so "no violations" cannot be
 *    the result of the game never doing anything.
 * 3. **Every check is total.** A corrupt or hand-built state produces a violation
 *    string, never an exception — asserted with states this engine could not have
 *    built (a city array that is not an array, a null city row).
 *
 * The driving here is a *test* driver, not the simulation loop another workstream owns:
 * it picks commands deterministically from the engine's own legal-action enumerations,
 * with a local 32-bit PRNG, and it never touches the state's RNG stream. Everything it
 * does a policy could do, which is the point — the invariant registry has to survive
 * real play, not a hand-walked script.
 */

import {
  DEFAULT_SETTINGS,
  IMPROVEMENT_KINDS,
  MIN_GROWTH_FOOD,
  applyCommand,
  asCityId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
  cityProductionOptions,
  cityRadius,
  civPlayers,
  citiesOf,
  foodBoxSize,
  legalActions,
  newGame,
  unitActions,
  unitMoveOptions,
  type BuildingId,
  type City,
  type Command,
  type CityId,
  type GameEvent,
  type GameState,
  type PlayerId,
  type PlayerState,
  type RulesetView,
  type Settings,
  type TileIndex,
  type Unit,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import { describe, expect, it } from 'vitest';

import { CORE_INVARIANTS, SIMPLE_POLICY, checkInvariants, runSimulation } from '@civts/sim';
import type { Invariant, InvariantContext, SimulationResult, Violation } from '@civts/sim';
// The **test tier** predicate: this file's long sweeps are `it.skipIf(!FULL_TIER)` —
// they run under `pnpm verify:full` and are reported as skipped by `pnpm verify`. The
// boundary and its reasoning live in `@civts/testing`'s `tier.ts`, once.
import { FULL_TIER } from '@civts/testing';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The real, validated content the CLI runs on — not a hand-made view. */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

const VIEW: RulesetView = RULESET;

const settingsFor = (seed: number, civCount: number = 2): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: 'duel',
  civCount,
});

const freshState = (seed: number, civCount: number = 2): GameState => {
  const created = newGame(seed, settingsFor(seed, civCount), RULESET);
  if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);
  return created.value;
};

/** A deterministic 32-bit PRNG: the sweep must not depend on anything ambient. */
const makePrng = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
};

const mustFind = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
};

/* ------------------------------------------------------------------ *
 * Reading and corrupting a state
 * ------------------------------------------------------------------ */

interface ContextOptions {
  readonly state: GameState;
  readonly previous?: GameState | undefined;
  readonly events?: readonly GameEvent[];
  readonly turn?: number;
  readonly ruleset?: Ruleset;
  readonly rulesetView?: RulesetView;
}

const contextFor = (options: ContextOptions): InvariantContext => ({
  state: options.state,
  previous: options.previous,
  ruleset: options.ruleset ?? RULESET,
  rulesetView: options.rulesetView ?? VIEW,
  events: options.events ?? [],
  turn: options.turn ?? options.state.turn,
});

const withCity = (state: GameState, cityId: CityId, change: (city: City) => City): GameState => ({
  ...state,
  cities: state.cities.map((city) => (city.id === cityId ? change(city) : city)),
});

const withUnit = (state: GameState, unitId: UnitId, change: (unit: Unit) => Unit): GameState => ({
  ...state,
  units: state.units.map((unit) => (unit.id === unitId ? change(unit) : unit)),
});

const withPlayer = (
  state: GameState,
  playerId: PlayerId,
  change: (player: PlayerState) => PlayerState,
): GameState => ({
  ...state,
  players: state.players.map((player) => (player.id === playerId ? change(player) : player)),
});

/**
 * A state shaped like a state but broken in a way no constructor here could write: a
 * `null` city row, a `cities` field that is not an array. The checks must report a
 * violation rather than throw, and the cast is how the test states the input the
 * types deliberately cannot express.
 */
const malformedState = (value: unknown): GameState => value as GameState;

/**
 * `count` distinct tiles inside a city's radius, the centre excluded — the centre is
 * never an entry of `workedTiles`, so it is never one of these.
 *
 * Built rather than read from the state, because the corrupt assignments these feed
 * have to be corrupt on purpose: a fixture that derived its tiles from a legitimate
 * assignment could not state "one tile more than the city has citizens".
 */
const radiusTiles = (state: GameState, city: City, count: number): readonly TileIndex[] =>
  cityRadius(state, city.tile)
    .filter((tile) => Number(tile) !== Number(city.tile))
    .slice(0, count);

/** Every invariant in the registry, by name, so a test can run exactly one. */
const invariantNamed = (name: string): Invariant => {
  const found = CORE_INVARIANTS.find((invariant) => invariant.name === name);
  if (found === undefined) throw new Error(`no invariant named ${name}`);
  return found;
};

/** The violations one named invariant reports for a context. */
const violationsOf = (name: string, ctx: InvariantContext): readonly Violation[] =>
  checkInvariants(ctx, [invariantNamed(name)]);

/** The violations one named invariant reports, as the bare messages. */
const messagesOf = (name: string, ctx: InvariantContext): readonly string[] =>
  violationsOf(name, ctx).map((violation) => violation.message);

/** A recorded transition: the state before a turn, after it, and what happened. */
interface Transition {
  readonly previous: GameState;
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * What one driven game did, so a sweep can prove it was not vacuous.
 *
 * Counted from the event stream rather than from the state, because "the branch was
 * taken" is about what happened during the turns, not about where the game ended.
 */
interface Coverage {
  readonly transitions: number;
  readonly founded: number;
  readonly grew: number;
  readonly starved: number;
  readonly produced: number;
  readonly workCompleted: number;
  readonly improvements: number;
  readonly cities: number;
  readonly units: number;
  readonly assignedStates: number;
}

const countOf = (events: readonly GameEvent[], type: GameEvent['type']): number =>
  events.filter((event) => event.type === type).length;

/**
 * Play `worldTurns` turns of a real game, deterministically, and keep every
 * transition so the invariants can be checked on each one.
 *
 * The policy is deliberately crude and deliberately varied: it founds with every
 * settler that can, queues whatever the engine says is legal, puts every idle worker
 * on a job (so improvements really complete mid-run, which is what makes the *work
 * finishes before growth* ordering observable), walks units, and strips a city's
 * assignment on some turns so cities really starve. Nothing here is a balance claim;
 * it is a driver chosen to take the branches the invariants are about.
 */
const drive = (
  seed: number,
  worldTurns: number,
): { readonly transitions: readonly Transition[]; readonly coverage: Coverage } => {
  const random = makePrng(seed);
  /** One of `options`, chosen deterministically — the driver's whole policy. */
  const pick = <T>(options: readonly T[]): T | undefined =>
    options[random() % Math.max(options.length, 1)];
  const transitions: Transition[] = [];
  // Every line every command produced, including the ones issued *outside* a turn
  // (`FoundCity`, `SetProduction`, `StartWork`, `MoveUnit`). Counting only the turn
  // events would make "how many cities were founded" a count of nothing.
  const allEvents: GameEvent[] = [];
  let state = freshState(seed);

  for (let world = 0; world < worldTurns; world += 1) {
    for (const player of civPlayers(state)) {
      const playerId = player.id;
      /** Apply a command, keep its events, and stop on the first refusal. */
      const run = (command: Command): boolean => {
        const outcome = applyCommand(state, playerId, command, RULESET);
        if (!outcome.ok) return false;
        allEvents.push(...outcome.value.events);
        state = outcome.value.state;
        return true;
      };

      // Found with every settler that may.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const found = [...legalActions(state, RULESET, playerId)].find(
          (command) => command.type === 'FoundCity',
        );
        if (found === undefined || !run(found)) break;
      }

      // Queue something legal in every city with an empty queue.
      for (const city of citiesOf(state, playerId)) {
        if (city.production !== undefined) continue;
        const options = cityProductionOptions(state, RULESET, city.id);
        const item = pick(options);
        if (item === undefined) continue;
        run({ type: 'SetProduction', cityId: city.id, item });
      }

      // Put idle workers on a job.
      for (const unit of state.units.filter((candidate) => candidate.owner === playerId)) {
        const jobs = unitActions(state, RULESET, unit.id).filter(
          (command) => command.type === 'StartWork',
        );
        const job = pick(jobs);
        if (job !== undefined) run(job);
      }

      // Walk something, so units move and huts are entered.
      for (const unit of state.units.filter((candidate) => candidate.owner === playerId)) {
        const options = unitMoveOptions(state, RULESET, unit.id);
        const to = pick(options);
        if (to !== undefined) run({ type: 'MoveUnit', unitId: unit.id, to });
      }

      // Deliberate starvation pressure: strip a city's assignment now and then, which
      // is a deficit on grassland and a real loss of a citizen.
      if (world % 5 === 3) {
        for (const city of citiesOf(state, playerId)) {
          if (city.population < 2) continue;
          run({ type: 'SetWorkedTiles', cityId: city.id, tiles: [] });
        }
      }

      const before = state;
      const ended = applyCommand(state, playerId, { type: 'EndTurn' }, RULESET);
      if (!ended.ok) throw new Error(`EndTurn was refused: ${ended.error.kind}`);
      allEvents.push(...ended.value.events);
      transitions.push({ previous: before, state: ended.value.state, events: ended.value.events });
      state = ended.value.state;
    }
  }

  return {
    transitions,
    coverage: {
      transitions: transitions.length,
      founded: countOf(allEvents, 'CityFounded'),
      grew: countOf(allEvents, 'CityGrew'),
      starved: countOf(allEvents, 'CityStarved'),
      produced: countOf(allEvents, 'CityProduced'),
      workCompleted: countOf(allEvents, 'WorkCompleted'),
      improvements: state.improvements.length,
      cities: state.cities.length,
      units: state.units.length,
      assignedStates: transitions.filter((transition) =>
        transition.state.cities.some((city) => city.workedTiles.length > 0),
      ).length,
    },
  };
};

/**
 * The shipped buildings that bill gold every turn: the ones a bankrupt treasury can be
 * short of, and the ones `disbandBuildings` demolishes. Read from the catalog rather
 * than assumed, because "there is something to demolish" is a non-vacuity claim.
 */
const BILLING_BUILDINGS = CATALOG.buildings.filter((row) => row.maintenance > 0);

/**
 * The shipped buildings that shave a growth requirement, read from the catalog: the
 * rows whose `growth-food` amount is positive. Read rather than named, so the fixture
 * does not pin a row id the content is free to change, and non-vacuity is asserted by
 * the tests that use it.
 */
const GROWTH_FOOD_BUILDINGS = CATALOG.buildings.filter((row) =>
  row.effects.some((effect) => effect.kind === 'growth-food' && effect.amount > 0),
);

/**
 * How much one building id shaves off a growth requirement — **this test's own**
 * arithmetic over the catalog rows, the same restatement the invariant makes, so the
 * expected thresholds below cannot be read back out of the code under test.
 */
const growthFoodOfRow = (id: BuildingId): number =>
  CATALOG.buildings
    .filter((row) => row.id === id)
    .flatMap((row) => row.effects)
    .reduce((total, effect) => total + (effect.kind === 'growth-food' ? effect.amount : 0), 0);

/** The bare curve reduced by the rows this city holds, floored where the rule floors. */
const reducedThreshold = (city: City): number =>
  Math.max(
    MIN_GROWTH_FOOD,
    foodBoxSize(city.population) -
      city.buildings.reduce((total, id) => total + growthFoodOfRow(id), 0),
  );

/** `city` with `id` held (once — a row held twice would be a different, wrong fixture). */
const holding = (city: City, id: BuildingId): City =>
  city.buildings.includes(id) ? city : { ...city, buildings: [...city.buildings, id] };

/** A `CityProduced` line for a building, as the production pass writes it. */
const producedBuilding = (city: City, id: BuildingId): GameEvent => ({
  type: 'CityProduced',
  cityId: city.id,
  owner: city.owner,
  item: { kind: 'building', id },
  shields: 0,
});

/**
 * Play a real game whose cities put buildings up, so the fixture holds rows a bankrupt
 * treasury can be billed for. Buildings are queued deliberately — the driven games pick
 * their items at random — and every turn is a real `EndTurn`.
 */
const buildUp = (seed: number, worldTurns: number): GameState => {
  let state = freshState(seed);

  for (let world = 0; world < worldTurns; world += 1) {
    for (const player of civPlayers(state)) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const settler = state.units.find(
          (unit) => unit.owner === player.id && unit.type === asUnitTypeId('settler'),
        );
        if (settler === undefined) break;
        const founded = applyCommand(
          state,
          player.id,
          { type: 'FoundCity', unitId: settler.id },
          RULESET,
        );
        if (!founded.ok) break;
        state = founded.value.state;
      }

      for (const city of citiesOf(state, player.id)) {
        if (city.production !== undefined) continue;
        const row = mustFind(
          BILLING_BUILDINGS[world % Math.max(BILLING_BUILDINGS.length, 1)],
          'a building that bills gold',
        );
        const queued = applyCommand(
          state,
          player.id,
          { type: 'SetProduction', cityId: city.id, item: { kind: 'building', id: row.id } },
          RULESET,
        );
        if (queued.ok) state = queued.value.state;
      }

      const ended = applyCommand(state, player.id, { type: 'EndTurn' }, RULESET);
      if (!ended.ok) throw new Error(`EndTurn was refused: ${ended.error.kind}`);
      state = ended.value.state;
    }
  }

  return state;
};

/**
 * `count` more units of the first type the state has, owned by `owner`, with ids above
 * every id in use — the bill a bankrupt treasury cannot pay, built rather than played
 * (no honest policy marches an army it cannot afford).
 */
const muster = (state: GameState, owner: PlayerId, count: number): GameState => {
  const template = mustFind(state.units[0], 'a unit to copy');
  let nextId = state.units.reduce((highest, unit) => Math.max(highest, Number(unit.id)), 0) + 1;
  const added: Unit[] = [];
  for (let index = 0; index < count; index += 1) {
    added.push({ ...template, id: asUnitId(nextId), owner });
    nextId += 1;
  }
  return { ...state, units: [...state.units, ...added] };
};

/** Three driven games, reused by several tests so the fixture is played once each. */
const GAME_SEEDS: readonly number[] = [1, 42, 1337];
const GAMES: readonly {
  readonly seed: number;
  readonly transitions: readonly Transition[];
  readonly coverage: Coverage;
}[] = GAME_SEEDS.map((seed) => ({ seed, ...drive(seed, 12) }));

const LAST = mustFind(GAMES[0], 'the first driven game');
const FINAL: Transition = mustFind(
  LAST.transitions[LAST.transitions.length - 1],
  'the last transition of the first driven game',
);
/** A played state with cities, units and improvements — the corruption fixture. */
const BASE: GameState = FINAL.state;
const BASE_CITY: City = mustFind(BASE.cities[0], 'a city in the played state');
const BASE_UNIT: Unit = mustFind(BASE.units[0], 'a unit in the played state');
const BASE_CIV: PlayerState = mustFind(civPlayers(BASE)[0], 'a civilization in the played state');

/* ------------------------------------------------------------------ *
 * 1. The clean baseline — the registry must not fire on real play
 * ------------------------------------------------------------------ */

describe('the registry on real play', () => {
  it('is importable by its package name, with unique names and one-line descriptions', () => {
    // The import at the top of this file is itself the evidence that `@civts/sim`
    // resolves by name; this test pins the shape of what it resolved to.
    expect(CORE_INVARIANTS.length).toBeGreaterThanOrEqual(21);
    const names = CORE_INVARIANTS.map((invariant) => invariant.name);
    expect(new Set(names).size).toBe(names.length);
    for (const invariant of CORE_INVARIANTS) {
      expect(invariant.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(invariant.description.length).toBeGreaterThan(10);
      expect(invariant.description.includes('\n')).toBe(false);
    }
  });

  it('reports nothing on a fresh game, where there is no previous state', () => {
    for (const seed of GAME_SEEDS) {
      const ctx = contextFor({ state: freshState(seed) });
      expect(checkInvariants(ctx)).toEqual([]);
    }
  });

  it('reports nothing on every turn of every driven game', () => {
    const covered = GAMES.flatMap((game) =>
      game.transitions.flatMap((transition) =>
        checkInvariants(
          contextFor({
            state: transition.state,
            previous: transition.previous,
            events: transition.events,
          }),
        ),
      ),
    );
    expect(covered).toEqual([]);
  });

  it('drives the branches the conservation checks are about (non-vacuity)', () => {
    const totals = GAMES.reduce(
      (sum, game) => ({
        transitions: sum.transitions + game.coverage.transitions,
        founded: sum.founded + game.coverage.founded,
        grew: sum.grew + game.coverage.grew,
        starved: sum.starved + game.coverage.starved,
        produced: sum.produced + game.coverage.produced,
        workCompleted: sum.workCompleted + game.coverage.workCompleted,
        improvements: sum.improvements + game.coverage.improvements,
        cities: sum.cities + game.coverage.cities,
        units: sum.units + game.coverage.units,
        assignedStates: sum.assignedStates + game.coverage.assignedStates,
      }),
      {
        transitions: 0,
        founded: 0,
        grew: 0,
        starved: 0,
        produced: 0,
        workCompleted: 0,
        improvements: 0,
        cities: 0,
        units: 0,
        assignedStates: 0,
      },
    );

    // A registry that never fired is not evidence; a sweep where the game never grew,
    // starved, completed anything or finished a job is not evidence either.
    expect(totals.transitions).toBeGreaterThanOrEqual(60);
    expect(totals.founded).toBeGreaterThanOrEqual(6);
    expect(totals.grew).toBeGreaterThan(0);
    expect(totals.starved).toBeGreaterThan(0);
    expect(totals.produced).toBeGreaterThan(0);
    expect(totals.workCompleted).toBeGreaterThan(0);
    expect(totals.cities).toBeGreaterThanOrEqual(6);
    expect(totals.units).toBeGreaterThan(0);
    // Citizens really do work tiles: without this the "no tile is worked twice" and
    // "a worked tile is in the radius" checks are claims about empty lists.
    expect(totals.assignedStates).toBeGreaterThan(0);
  });

  it('holds across the bankruptcy branch: disbands, a shortfall, and a demolition', () => {
    // The branch the driven games never take, and the one M4c exists to make reachable:
    // a civilization whose buildings and army outrun its income. Three things happen in
    // the money step there, and each is something an invariant reads — units leave the
    // state (`UnitDisbanded`), gold the ledger cannot cover is reported
    // (`TreasuryShortfall` with `unpaid > 0`), and buildings are demolished *after*
    // growth and production ran with them.
    //
    // The setup is hand-made because no honest policy plays this badly on purpose, but
    // the **transition is a real `EndTurn`**: the invariants read a transition, and this
    // one is produced by the engine.
    let state = buildUp(3, 30);
    const citiesWithMaintenance = state.cities.filter((city) =>
      city.buildings.some((id) => BILLING_BUILDINGS.some((row) => row.id === id)),
    );
    expect(citiesWithMaintenance.length).toBeGreaterThan(0);

    // Collapse the income: no worked tiles means commerce is the city centre's alone.
    for (const player of civPlayers(state)) {
      for (const city of citiesOf(state, player.id)) {
        const stripped = applyCommand(
          state,
          player.id,
          { type: 'SetWorkedTiles', cityId: city.id, tiles: [] },
          RULESET,
        );
        if (stripped.ok) state = stripped.value.state;
      }
    }

    const owner = mustFind(civPlayers(state)[0], 'the first civilization').id;
    const before = muster(
      {
        ...state,
        players: state.players.map((player) =>
          player.kind === 'civ' ? { ...player, treasury: 0 } : player,
        ),
      },
      owner,
      24,
    );
    const buildingsBefore = before.cities.flatMap((city) => city.buildings);

    const ended = applyCommand(before, owner, { type: 'EndTurn' }, RULESET);
    if (!ended.ok) throw new Error(`EndTurn was refused: ${ended.error.kind}`);
    const transition: Transition = {
      previous: before,
      state: ended.value.state,
      events: ended.value.events,
    };

    // The branch was really taken, in all three of its parts.
    const disbands = transition.events.filter((event) => event.type === 'UnitDisbanded');
    const shortfalls = transition.events.filter((event) => event.type === 'TreasuryShortfall');
    expect(disbands.length).toBeGreaterThan(0);
    expect(shortfalls.length).toBeGreaterThan(0);
    expect(shortfalls.some((event) => event.unpaid > 0)).toBe(true);
    expect(transition.state.units.length).toBeLessThan(before.units.length);
    const buildingsAfter = transition.state.cities.flatMap((city) => city.buildings);
    expect(buildingsAfter.length).toBeLessThan(buildingsBefore.length);

    // ...and the invariants hold across it, and across the turns that follow the
    // demolition (the next turn's reads see a smaller building set than the last turn's
    // production did, which is exactly the case the shield bracket and the food skip
    // exist for).
    const violations = checkInvariants(
      contextFor({
        state: transition.state,
        previous: transition.previous,
        events: transition.events,
      }),
    );
    expect(violations).toEqual([]);

    let after = transition.state;
    for (let world = 0; world < 4; world += 1) {
      for (const player of civPlayers(after)) {
        const previous = after;
        const next = applyCommand(after, player.id, { type: 'EndTurn' }, RULESET);
        if (!next.ok) throw new Error(`EndTurn was refused: ${next.error.kind}`);
        expect(
          checkInvariants(
            contextFor({ state: next.value.state, previous, events: next.value.events }),
          ),
        ).toEqual([]);
        after = next.value.state;
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Every invariant fires on a state that breaks it
 * ------------------------------------------------------------------ */

describe('every invariant fires on a deliberately broken state', () => {
  it('treasury-non-negative: a negative treasury', () => {
    const ctx = contextFor({
      state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, treasury: -1 })),
    });
    expect(
      checkInvariants(contextFor({ state: BASE }), [invariantNamed('treasury-non-negative')]),
    ).toEqual([]);
    expect(messagesOf('treasury-non-negative', ctx)).toEqual([
      `player ${String(BASE_CIV.id)} (${BASE_CIV.name}) has treasury -1; a treasury is never ` +
        `negative (bankruptcy floors at 0)`,
    ]);
  });

  it('pools-non-negative: negative beakers and luxuries', () => {
    const ctx = contextFor({
      state: withPlayer(BASE, BASE_CIV.id, (player) => ({
        ...player,
        beakers: -2,
        luxuries: -1,
      })),
    });
    const messages = messagesOf('pools-non-negative', ctx);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('beakers');
    expect(messages[1]).toContain('luxuries');
    expect(messagesOf('pools-non-negative', contextFor({ state: BASE }))).toEqual([]);
  });

  it('player-pools-integral: a fractional pool', () => {
    const ctx = contextFor({
      state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, luxuries: 1.5 })),
    });
    expect(messagesOf('player-pools-integral', ctx)).toEqual([
      `player ${String(BASE_CIV.id)} (${BASE_CIV.name}) carries fractional luxuries 1.5`,
    ]);
    expect(messagesOf('player-pools-integral', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-population-at-least-one: an empty city', () => {
    const ctx = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, population: 0 })),
    });
    expect(messagesOf('city-population-at-least-one', ctx)[0]).toContain('population 0');
    expect(messagesOf('city-population-at-least-one', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-food-box-within-threshold: the BARE bound holds whatever the buildings, and fires', () => {
    // Bound 1 — the unconditional one. `foodBoxSize` is the requirement *before* any
    // `growth-food` reduction, and growth spends the reduced requirement, which never
    // exceeds the bare curve, so no turn leaves a box this full. This is the state the
    // `BROKEN_STATES` table uses.
    const atBare = withCity(BASE, BASE_CITY.id, (city) => ({
      ...city,
      foodBox: foodBoxSize(city.population),
    }));
    const bareMessages = messagesOf(
      'city-food-box-within-threshold',
      contextFor({ state: atBare }),
    );
    expect(bareMessages).toHaveLength(1);
    expect(bareMessages[0]).toContain('food box');
    expect(bareMessages[0]).toContain('at or above the');

    // ...and it stays unconditional when the turn's events show a growth-food building
    // arriving *after* growth ran: a reduction can only lower a threshold, so nothing
    // about a later completion can excuse a box at or above the bare size.
    const granary = mustFind(GROWTH_FOOD_BUILDINGS[0], 'a shipped growth-food building');
    const withLateCompletion = withCity(atBare, BASE_CITY.id, (city) => holding(city, granary.id));
    expect(
      messagesOf(
        'city-food-box-within-threshold',
        contextFor({
          state: withLateCompletion,
          events: [producedBuilding(BASE_CITY, granary.id)],
        }),
      ),
    ).toHaveLength(1);

    const negative = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, foodBox: -1 })),
    });
    expect(messagesOf('city-food-box-within-threshold', negative)[0]).toContain('food box -1');
    expect(messagesOf('city-food-box-within-threshold', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-food-box-within-threshold: the REDUCED bound, and the one turn it is not claimed', () => {
    // Bound 2 — the stricter statement, and the one the shipped content is the reason
    // for. Growth measures the box against the bare curve *reduced by the city's own
    // `growth-food` rows*, so a granary city one food short of a citizen it should have
    // gained is caught here and not by bound 1. It is claimed only when the state's
    // building list is the list growth measured against, which the events decide.
    const granary = mustFind(GROWTH_FOOD_BUILDINGS[0], 'a shipped growth-food building');
    const held = holding(BASE_CITY, granary.id);
    const bare = foodBoxSize(held.population);
    const reduced = reducedThreshold(held);
    // Non-vacuity: the two bounds really are different numbers for this fixture, so the
    // cases below are about the second bound and not a restatement of the first.
    expect(reduced).toBeLessThan(bare);
    expect(reduced).toBeGreaterThanOrEqual(MIN_GROWTH_FOOD);

    const withBox = (box: number): GameState =>
      withCity(BASE, BASE_CITY.id, (city) => ({ ...holding(city, granary.id), foodBox: box }));

    // Fires: a box in [reduced, bare) with nothing in the events that moved the
    // threshold, so growth saw the very threshold the state carries.
    const full = messagesOf(
      'city-food-box-within-threshold',
      contextFor({ state: withBox(reduced) }),
    );
    expect(full).toHaveLength(1);
    expect(full[0]).toContain(`outside [0, ${String(reduced)})`);
    expect(full[0]).toContain('no growth-food building was completed');

    // Clean: one food below it. The pair is what makes the case above evidence.
    expect(
      messagesOf('city-food-box-within-threshold', contextFor({ state: withBox(reduced - 1) })),
    ).toEqual([]);

    // The shipped false positive, pinned as LEGAL. `advanceTurn` runs growth before
    // production, so a granary completed this turn joins the city after the box was
    // filled against the bare curve; the reduced threshold applies to the next growth
    // check. Reporting this state stopped 5 runs in the first 50 seeds of
    // `sim --map-size tiny --turns 20` and made the batch's horizon non-uniform.
    expect(
      messagesOf(
        'city-food-box-within-threshold',
        contextFor({ state: withBox(reduced), events: [producedBuilding(held, granary.id)] }),
      ),
    ).toEqual([]);

    // **A shortfall is NOT an exemption, and this is the configuration that used to
    // escape.** The check formerly shared its threshold predicate with
    // `city-food-conservation`, which genuinely needs the shortfall case; the box bound
    // inherited it and could therefore only ever *suppress a real violation*. It cannot
    // need it: a demolition removes rows, and removing rows removes `growth-food`
    // reductions, so the after-state's threshold is **at or above** the one growth
    // measured the box against — and growth spends a box that reaches its requirement.
    // On shipped content the demolished row is never the granary either (it pays no
    // maintenance, and `disbandBuildings` skips every row whose maintenance is `<= 0`).
    const shortfall: readonly GameEvent[] = [
      { type: 'TreasuryShortfall', playerId: held.owner, unpaid: 3 },
    ];
    const caught = messagesOf(
      'city-food-box-within-threshold',
      contextFor({ state: withBox(reduced), events: shortfall }),
    );
    expect(caught).toHaveLength(1);
    expect(caught[0]).toContain(`outside [0, ${String(reduced)})`);
    expect(caught[0]).toContain('growth-food building was completed');

    // ...and it is scoped to the events, not to bankruptcy in general: ANOTHER player's
    // shortfall leaves the same box caught too (it always did — this is the paired case
    // that shows the exemption was player-scoped, not a blanket mute).
    const otherPlayer = mustFind(
      BASE.players.find((player) => player.id !== held.owner && player.kind === 'civ'),
      'a second civilization',
    );
    expect(
      messagesOf(
        'city-food-box-within-threshold',
        contextFor({
          state: withBox(reduced),
          events: [{ type: 'TreasuryShortfall', playerId: otherPlayer.id, unpaid: 3 }],
        }),
      ),
    ).toHaveLength(1);

    // A box below the reduced threshold is legal in every one of these configurations,
    // so the assertions above are about the bound and not about "any hand-built box
    // fires".
    expect(
      messagesOf(
        'city-food-box-within-threshold',
        contextFor({ state: withBox(reduced - 1), events: shortfall }),
      ),
    ).toEqual([]);

    // ...and the unconditional bound is untouched by any of it: a box at the bare size
    // still fires for the same bankrupt owner.
    expect(
      messagesOf(
        'city-food-box-within-threshold',
        contextFor({ state: withBox(bare), events: shortfall }),
      ),
    ).toHaveLength(1);

    // Clean on the played state as it stands — the paired case for every branch above.
    expect(messagesOf('city-food-box-within-threshold', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-food-conservation keeps the shortfall exemption the box bound gave up', () => {
    // The other half of the split, and the reason the predicate was SPLIT rather than
    // narrowed: this check re-runs the growth arithmetic against the after-state's rows,
    // so a demolition in the same turn leaves it unable to know what growth did — and
    // the ledger names the player who went short, never the rows that left. A shared,
    // narrowed predicate would make this check report a false positive on a real
    // bankruptcy turn, which is why the two checks no longer share one.
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const polluted = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      foodBox: candidate.foodBox + 1,
    }));
    const unexplained: readonly GameEvent[] = [
      ...FINAL.events,
      { type: 'TreasuryShortfall', playerId: city.owner, unpaid: 5 },
    ];

    // The same bookkeeping error, with and without the demolition the shortfall stands
    // for: caught in the one case, skipped in the other. Both directions asserted, so
    // the exemption cannot be a blanket mute.
    expect(
      messagesOf(
        'city-food-conservation',
        contextFor({ state: polluted, previous: FINAL.previous, events: FINAL.events }),
      ),
    ).toHaveLength(1);
    expect(
      messagesOf(
        'city-food-conservation',
        contextFor({ state: polluted, previous: FINAL.previous, events: unexplained }),
      ),
    ).toEqual([]);
  });

  /**
   * **The 200-seed safety sweep.** The bound the box check gave up its exemption for is
   * *wider* than it was, so the risk it introduces is a false positive on ordinary play —
   * a false alarm stops a run, truncates its horizon, and turns every aggregate folded
   * over the batch into a mean over games of different lengths (the FINDING A
   * consequence). This drives 200 real games of 20 turns each through the same runner the
   * CLI uses, with the shipped catalog, and asserts the whole registry stays quiet.
   *
   * The sweep is deliberately a *safety* net rather than the sensitivity evidence:
   * shipped play covers a shortfall by disbanding units (M4b), so few or no turns in it
   * carry the `TreasuryShortfall` the changed clause was about. Sensitivity lives in the
   * two tests above — the targeted `reduced`-box-with-a-shortfall configuration, and the
   * forced-bankruptcy branch test, where a demolition really happens — and in the probe
   * below, which rebuilds that configuration from every city in this very sweep.
   */
  const SWEEP_SEEDS: readonly number[] = Array.from({ length: 200 }, (_, index) => index + 1);
  const SWEEP_TURNS = 20;
  let sweepCache:
    readonly { readonly seed: number; readonly result: SimulationResult }[] | undefined;
  const sweep = (): readonly { readonly seed: number; readonly result: SimulationResult }[] => {
    sweepCache ??= SWEEP_SEEDS.map((seed) => ({
      seed,
      result: runSimulation({
        seed,
        settings: { ...DEFAULT_SETTINGS, seed, mapSize: 'tiny', civCount: 2 },
        ruleset: RULESET,
        policies: [SIMPLE_POLICY, SIMPLE_POLICY],
        maxTurns: SWEEP_TURNS,
      }),
    }));
    return sweepCache;
  };

  // Full tier: 55 s — the single slowest test in the repository, and the widest sweep: 200 seeds of
  // real play with every invariant checked on every turn. It is the evidence that the shipped content
  // does not trip the invariants, which is a claim about *scale*; ten seeds would not make it.
  it.skipIf(!FULL_TIER)(
    'reports nothing across 200 seeds of real play (the widened bound is quiet)',
    () => {
      const runs = sweep();
      expect(runs).toHaveLength(200);

      // Every violation of every turn of every game, by name: the CLI's 0-violations claim
      // over four times the seeds of the acceptance run.
      const violations = runs.flatMap(({ result }) => result.violations);
      expect(
        violations.map((violation) => `${violation.invariant}@${String(violation.turn)}`),
      ).toEqual([]);
      // ...and every run reached its horizon, so nothing was truncated and no aggregate is
      // a mean over games of different lengths.
      expect([...new Set(runs.map(({ result }) => result.stoppedBecause))]).toEqual(['max-turns']);

      // Non-vacuity, so "nothing fired" is not "nothing happened": the sweep really played
      // 8000 player-turns, cities were founded and grew, and buildings were put up — which
      // is what the food-box check needs in order to have anything to say.
      const rows = runs.flatMap(({ result }) => result.metrics);
      expect(rows).toHaveLength(SWEEP_SEEDS.length * SWEEP_TURNS * 2);
      expect(rows.filter((row) => row.population > 0).length).toBeGreaterThan(0);
      expect(rows.reduce((total, row) => total + row.population, 0)).toBeGreaterThan(rows.length);
      expect(rows.reduce((total, row) => total + row.buildings, 0)).toBeGreaterThan(0);
    },
    300_000,
  );

  // Full tier: it is the *same* sweep — `sweep()` is memoised, so this test computed the
  // 200-seed run itself once the test above started skipping, and the fast tier paid the
  // whole 54 s here instead. A skipped test that leaves its work behind is not a saved
  // second; the two go together, and the tier boundary is stated at both.
  it.skipIf(!FULL_TIER)(
    'fires for every reduced-threshold city in that sweep, shortfall or not (the escape is closed)',
    () => {
      // The configuration the old shared predicate let through, rebuilt from *real* cities
      // rather than from one fixture: every city in the 200-seed sweep whose buildings
      // genuinely lower its threshold, with its box set exactly at that threshold — caught
      // when nothing happened this turn, and (the fix) caught identically when its owner
      // reported a shortfall. The two message lists must be the same list, so the clause is
      // gone rather than merely reordered.
      const probes = sweep().flatMap(({ seed, result }) =>
        result.finalState.cities.flatMap((city) => {
          const bare = foodBoxSize(city.population);
          const reduced = reducedThreshold(city);
          if (reduced >= bare) return []; // no growth-food row: this bound is not stricter here
          return [{ seed, state: result.finalState, city, reduced }];
        }),
      );
      // Non-vacuity: the sweep really contains cities a `growth-food` building lowers the
      // threshold for, so the loop below is not an empty loop.
      expect(probes.length).toBeGreaterThan(0);

      for (const { state, city, reduced } of probes) {
        const full = withCity(state, city.id, (candidate) => ({ ...candidate, foodBox: reduced }));
        const plain = messagesOf('city-food-box-within-threshold', contextFor({ state: full }));
        const withShortfall = messagesOf(
          'city-food-box-within-threshold',
          contextFor({
            state: full,
            events: [{ type: 'TreasuryShortfall', playerId: city.owner, unpaid: 1 }],
          }),
        );

        expect(plain).toHaveLength(1);
        expect(plain[0]).toContain(`outside [0, ${String(reduced)})`);
        expect(withShortfall).toEqual(plain);
      }

      console.log(
        `food-box sweep: ${String(probes.length)} reduced-threshold city probes over ` +
          `${String(SWEEP_SEEDS.length)} seeds x ${String(SWEEP_TURNS)} turns, all caught with and ` +
          `without the owner's shortfall`,
      );
    },
    300_000,
  );

  it('city-shields-non-negative: a negative shield pool', () => {
    const ctx = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, shields: -5 })),
    });
    expect(messagesOf('city-shields-non-negative', ctx)[0]).toContain('-5 stored shields');
    expect(messagesOf('city-shields-non-negative', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-works-at-most-its-citizens: one tile too many', () => {
    // One citizen per tile, and the centre is free, so `population + 1` tiles is one
    // assignment more than the city has citizens to pay for.
    const ctx = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({
        ...city,
        workedTiles: radiusTiles(BASE, city, city.population + 1),
      })),
    });
    const messages = messagesOf('city-works-at-most-its-citizens', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('works');
    expect(messagesOf('city-works-at-most-its-citizens', contextFor({ state: BASE }))).toEqual([]);
  });

  it('tile-worked-by-one-city: two cities on one tile', () => {
    const other = mustFind(
      BASE.cities.find((city) => city.id !== BASE_CITY.id),
      'a second city',
    );
    const tile = mustFind(radiusTiles(BASE, BASE_CITY, 1)[0], 'a tile in the first city radius');
    const ctx = contextFor({
      state: withCity(
        withCity(BASE, BASE_CITY.id, (city) => ({ ...city, workedTiles: [tile] })),
        other.id,
        (city) => ({ ...city, workedTiles: [tile] }),
      ),
    });
    const messages = messagesOf('tile-worked-by-one-city', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`tile ${String(tile)} is worked by`);
    expect(messagesOf('tile-worked-by-one-city', contextFor({ state: BASE }))).toEqual([]);
  });

  it('worked-tile-in-city-radius: the centre, and a tile outside the radius', () => {
    const centre = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, workedTiles: [city.tile] })),
    });
    expect(messagesOf('worked-tile-in-city-radius', centre)[0]).toContain('its own centre');

    const far = mustFind(
      BASE.map.terrain
        .map((_, index) => index)
        .find((index) => {
          const radius = cityRadius(BASE, BASE_CITY.tile).map(Number);
          return index !== Number(BASE_CITY.tile) && !radius.includes(index);
        }),
      'a tile outside the city radius',
    );
    const outside = contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, workedTiles: [asTileIndex(far)] })),
    });
    expect(messagesOf('worked-tile-in-city-radius', outside)[0]).toContain('not in its radius');
    expect(messagesOf('worked-tile-in-city-radius', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-ids-unique-and-sorted: cities out of id order', () => {
    const ctx = contextFor({ state: { ...BASE, cities: [...BASE.cities].reverse() } });
    const messages = messagesOf('city-ids-unique-and-sorted', ctx);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('sorted ascending');
    expect(messagesOf('city-ids-unique-and-sorted', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-tile-unique: a second city on an occupied tile', () => {
    // The property `city-ids-unique-and-sorted` cannot see: ids identify cities, tiles
    // locate them. The squatter is a copy of an existing city with a fresh id and an
    // emptied assignment, so the *only* thing wrong with the state is the tile.
    const other = mustFind(
      BASE.cities.find((city) => city.id !== BASE_CITY.id),
      'a second city',
    );
    const squatter: City = {
      ...other,
      id: asCityId(Number(BASE_CITY.id) + 900),
      tile: BASE_CITY.tile,
      workedTiles: [],
    };
    const messages = messagesOf(
      'city-tile-unique',
      contextFor({
        state: { ...BASE, cities: [...BASE.cities, squatter] },
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`tile ${String(BASE_CITY.tile)} holds`);
    expect(messages[0]).toContain(`city ${String(BASE_CITY.id)}`);
    expect(messages[0]).toContain(`city ${String(squatter.id)}`);
    expect(messages[0]).toContain('two cities never stand on one tile');

    // The paired clean case: the same city, same id, on a tile no city holds, reports
    // nothing — so the case above measures the shared tile and not the appended city.
    const freeTile = mustFind(
      BASE.map.terrain
        .map((_, index) => index)
        .find((index) => !BASE.cities.some((city) => Number(city.tile) === index)),
      'a tile no city holds',
    );
    expect(
      messagesOf(
        'city-tile-unique',
        contextFor({
          state: {
            ...BASE,
            cities: [...BASE.cities, { ...squatter, tile: asTileIndex(freeTile) }],
          },
        }),
      ),
    ).toEqual([]);

    expect(messagesOf('city-tile-unique', contextFor({ state: BASE }))).toEqual([]);
    // ...and the id check is silent about the squatter, which is why both exist: its id
    // is unique and the list is still sorted, so nothing else in the registry sees it.
    expect(
      messagesOf(
        'city-ids-unique-and-sorted',
        contextFor({
          state: { ...BASE, cities: [...BASE.cities, squatter] },
        }),
      ),
    ).toEqual([]);
  });

  it('unit-ids-unique-and-sorted: a repeated unit id', () => {
    const ctx = contextFor({ state: { ...BASE, units: [BASE_UNIT, BASE_UNIT, ...BASE.units] } });
    const messages = messagesOf('unit-ids-unique-and-sorted', ctx);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('sorted ascending');
    expect(messagesOf('unit-ids-unique-and-sorted', contextFor({ state: BASE }))).toEqual([]);
  });

  it('unit-tile-in-bounds: a unit off the map', () => {
    const off = asTileIndex(BASE.map.width * BASE.map.height + 5);
    const ctx = contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, tile: off })),
    });
    expect(messagesOf('unit-tile-in-bounds', ctx)[0]).toContain('outside the');
    expect(messagesOf('unit-tile-in-bounds', contextFor({ state: BASE }))).toEqual([]);
  });

  it('unit-owner-exists: a unit owned by nobody', () => {
    const ctx = contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, owner: asPlayerId(99) })),
    });
    expect(messagesOf('unit-owner-exists', ctx)[0]).toContain('player 99');
    expect(messagesOf('unit-owner-exists', contextFor({ state: BASE }))).toEqual([]);
  });

  it('unit-movement-in-range: more movement than the unit has, and an unknown type', () => {
    const tooMuch = contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, movementLeft: 999 })),
    });
    expect(messagesOf('unit-movement-in-range', tooMuch)[0]).toContain('more than its');

    const negative = contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, movementLeft: -1 })),
    });
    expect(messagesOf('unit-movement-in-range', negative)[0]).toContain('whole number >= 0');

    // A unit type the ruleset does not describe cannot be bounded at all; the check
    // says so rather than passing it silently (the engine's `EndTurn` tolerates such a
    // unit so that it stays total, which is a different claim from "its movement is
    // within its maximum").
    const unknown = contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, type: asUnitTypeId('ghost') })),
    });
    expect(messagesOf('unit-movement-in-range', unknown)[0]).toContain('not in the ruleset');
    expect(messagesOf('unit-movement-in-range', contextFor({ state: BASE }))).toEqual([]);
  });

  it('improvements-sorted-and-unique: pairs out of order and a duplicate', () => {
    const road = asImprovementId('road');
    const mine = asImprovementId('mine');
    const unordered = contextFor({
      state: {
        ...BASE,
        improvements: [
          { tile: asTileIndex(500), kind: road },
          { tile: asTileIndex(100), kind: mine },
        ],
      },
    });
    expect(messagesOf('improvements-sorted-and-unique', unordered)[0]).toContain('contract order');

    const duplicated = contextFor({
      state: {
        ...BASE,
        improvements: [
          { tile: asTileIndex(100), kind: road },
          { tile: asTileIndex(100), kind: road },
        ],
      },
    });
    expect(messagesOf('improvements-sorted-and-unique', duplicated)[0]).toContain('contract order');
    expect(messagesOf('improvements-sorted-and-unique', contextFor({ state: BASE }))).toEqual([]);
  });

  it('improvements-sorted-and-unique: ids the kind vocabulary does not contain still have an order', () => {
    // The pair list is an order on **ids**, and the kind vocabulary is only the first key
    // (a stored id that names a kind ranks by that kind's position; see the writer in
    // `core/improvements.ts`). Two ids that name no kind both rank `-1`, and the spelling
    // tie-break is what separates them — without it the writer's insert position would
    // decide their order, and the invariant would either miss a real disorder or reject
    // the order the writer itself produced. Both directions are asserted here, so the two
    // statements cannot drift: the spelling order passes, the reverse is reported.
    const alpha = asImprovementId('alpha');
    const zeta = asImprovementId('zeta');
    const tile = asTileIndex(321);
    const ordered = contextFor({
      state: {
        ...BASE,
        improvements: [
          { tile, kind: alpha },
          { tile, kind: zeta },
        ],
      },
    });
    const reversed = contextFor({
      state: {
        ...BASE,
        improvements: [
          { tile, kind: zeta },
          { tile, kind: alpha },
        ],
      },
    });

    expect(messagesOf('improvements-sorted-and-unique', ordered)).toEqual([]);
    expect(messagesOf('improvements-sorted-and-unique', reversed)[0]).toContain('contract order');
    // Non-vacuity: the two ids really are outside the vocabulary, so the case above is
    // about the tie-break rather than about two ranked kinds.
    for (const id of [alpha, zeta]) expect(IMPROVEMENT_KINDS).not.toContain(String(id));
  });

  it('resources-sorted-and-unique: two resources on one tile, and an unordered list', () => {
    // Two *different* resources on one tile sort correctly, which is why the per-tile
    // rule is stated separately — and why this case has to be built in the order the
    // comparator accepts (tile ascending, then resource id) to isolate it.
    const [first, second] = [...CATALOG.resources].sort((a, b) => (a.id < b.id ? -1 : 1));
    const tile = asTileIndex(200);
    const sorted = mustFind(first, 'the first resource by id');
    const next = mustFind(second, 'a second resource by id');
    const both = contextFor({
      state: {
        ...BASE,
        map: {
          ...BASE.map,
          resources: [
            { tile, resource: sorted.id },
            { tile, resource: next.id },
          ],
        },
      },
    });
    expect(messagesOf('resources-sorted-and-unique', both)[0]).toContain('at most one resource');

    const unordered = contextFor({
      state: {
        ...BASE,
        map: {
          ...BASE.map,
          resources: [
            { tile: asTileIndex(900), resource: sorted.id },
            { tile: asTileIndex(100), resource: next.id },
          ],
        },
      },
    });
    expect(messagesOf('resources-sorted-and-unique', unordered)[0]).toContain('contract order');
    expect(messagesOf('resources-sorted-and-unique', contextFor({ state: BASE }))).toEqual([]);
  });

  it('wonder-held-by-one-city: two cities holding the same wonder', () => {
    const wonder = mustFind(
      CATALOG.buildings.find((row) => row.wonder === true),
      'a wonder row in the shipped catalog',
    );
    const [first, second] = BASE.cities;
    const holderA = mustFind(first, 'a city');
    const holderB = mustFind(second, 'a second city');
    const ctx = contextFor({
      state: withCity(
        withCity(BASE, holderA.id, (city) => ({
          ...city,
          buildings: [...city.buildings, wonder.id],
        })),
        holderB.id,
        (city) => ({ ...city, buildings: [...city.buildings, wonder.id] }),
      ),
    });
    expect(messagesOf('wonder-held-by-one-city', ctx)[0]).toContain('globally unique');
    expect(messagesOf('wonder-held-by-one-city', contextFor({ state: BASE }))).toEqual([]);
  });

  it('gold-conservation: a treasury that moved with nothing to explain it', () => {
    const polluted = withPlayer(FINAL.state, BASE_CIV.id, (player) => ({
      ...player,
      treasury: player.treasury + 3,
    }));
    const ctx = contextFor({ state: polluted, previous: FINAL.previous, events: FINAL.events });
    const messages = messagesOf('gold-conservation', ctx);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('the ledger says');
    expect(
      messagesOf(
        'gold-conservation',
        contextFor({ state: FINAL.state, previous: FINAL.previous, events: FINAL.events }),
      ),
    ).toEqual([]);
  });

  it('gold-conservation: a turn that claims a shortfall it never reports', () => {
    // A synthetic pair, because whether a real turn runs short depends on the seed. The
    // money loop's identity is `delta === income - upkeep + covered + unpaid`, and this
    // pair keeps the delta at zero while claiming a bill of 6 against an income of 1 —
    // the half of the identity that says *where* the missing gold went.
    const broke = withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, treasury: 0 }));
    const events: readonly GameEvent[] = [
      { type: 'IncomeCollected', playerId: BASE_CIV.id, gold: 1, beakers: 0, luxuries: 0 },
      {
        type: 'UpkeepPaid',
        playerId: BASE_CIV.id,
        gold: 6,
        maintenance: 0,
        unitSupport: 6,
        units: 6,
        freeUnits: 0,
      },
    ];
    const ctx = contextFor({ state: broke, previous: broke, events });
    const messages = messagesOf('gold-conservation', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('short');
    expect(messages[0]).toContain('covered by disbanding');
  });

  it('gold-conservation: a disband line for a unit that is still in the state', () => {
    // Every gold line here adds up — a treasury of 0, an income of 0, an upkeep of 1, one
    // unit disbanded for the 1 gold that covers it — so the only thing wrong is that the
    // unit the ledger says it destroyed is still standing there. A player that keeps a
    // unit it paid itself to lose is exactly the accounting the check exists to catch.
    const victim = mustFind(BASE.units[0], 'a unit');
    const broke = withPlayer(BASE, victim.owner, (player) => ({ ...player, treasury: 0 }));
    const events: readonly GameEvent[] = [
      { type: 'IncomeCollected', playerId: victim.owner, gold: 0, beakers: 0, luxuries: 0 },
      {
        type: 'UpkeepPaid',
        playerId: victim.owner,
        gold: 1,
        maintenance: 0,
        unitSupport: 1,
        units: 1,
        freeUnits: 0,
      },
      {
        type: 'UnitDisbanded',
        playerId: victim.owner,
        unitId: victim.id,
        unitType: victim.type,
        tile: victim.tile,
        saved: 1,
      },
    ];
    const ctx = contextFor({ state: broke, previous: broke, events });
    const messages = messagesOf('gold-conservation', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('still in the state');
  });

  it('gold-conservation: says nothing on the first turn', () => {
    expect(messagesOf('gold-conservation', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-food-conservation: a food box that moved by the wrong amount', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const polluted = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      foodBox: candidate.foodBox + 1,
    }));
    const ctx = contextFor({ state: polluted, previous: FINAL.previous, events: FINAL.events });
    const messages = messagesOf('city-food-conservation', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('food bookkeeping');
    expect(
      messagesOf(
        'city-food-conservation',
        contextFor({ state: FINAL.state, previous: FINAL.previous, events: FINAL.events }),
      ),
    ).toEqual([]);
  });

  it('city-food-conservation: a food box that moved with no turn to move it', () => {
    // The fallback for a transition whose events show no pipeline ran: a command
    // never moves a food box, so a box that moved is unexplained whatever the numbers
    // were.
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const polluted = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      foodBox: candidate.foodBox + 1,
    }));
    const messages = messagesOf(
      'city-food-conservation',
      contextFor({ state: polluted, previous: FINAL.state, events: [] }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no turn pipeline ran');
  });

  it('city-food-conservation: starvation that does not land where the rule lands', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const obese = withCity(FINAL.previous, city.id, (candidate) => ({
      ...candidate,
      population: 4,
      foodBox: 0,
      workedTiles: [],
    }));
    const starved = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      population: 1,
      foodBox: 0,
      workedTiles: [],
    }));
    const events: readonly GameEvent[] = [
      { type: 'IncomeCollected', playerId: city.owner, gold: 0, beakers: 0, luxuries: 0 },
      { type: 'CityStarved', cityId: city.id, owner: city.owner, population: 1, foodBox: 0 },
    ];
    const messages = messagesOf(
      'city-food-conservation',
      contextFor({ state: starved, previous: obese, events }),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join(' ')).toContain('the rule takes a starving city to 3');
  });

  it('city-food-conservation: a growth event that disagrees with the state', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const events: readonly GameEvent[] = [
      { type: 'IncomeCollected', playerId: city.owner, gold: 0, beakers: 0, luxuries: 0 },
      {
        type: 'CityGrew',
        cityId: city.id,
        owner: city.owner,
        population: city.population + 7,
        foodBox: 0,
      },
    ];
    const messages = messagesOf(
      'city-food-conservation',
      contextFor({ state: FINAL.state, previous: FINAL.previous, events }),
    );
    expect(messages.join(' ')).toContain('CityGrew event says population');
  });

  it('city-food-conservation: says nothing on the first turn', () => {
    expect(messagesOf('city-food-conservation', contextFor({ state: BASE }))).toEqual([]);
  });

  it('city-shield-conservation: shields that appeared from nowhere', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const polluted = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      shields: candidate.shields + 1,
    }));
    const ctx = contextFor({ state: polluted, previous: FINAL.previous, events: FINAL.events });
    const messages = messagesOf('city-shield-conservation', ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('banked');
    expect(
      messagesOf(
        'city-shield-conservation',
        contextFor({ state: FINAL.state, previous: FINAL.previous, events: FINAL.events }),
      ),
    ).toEqual([]);
  });

  it('city-shield-conservation: shields that moved with no turn to move them', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const polluted = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      shields: candidate.shields + 1,
    }));
    const messages = messagesOf(
      'city-shield-conservation',
      contextFor({ state: polluted, previous: FINAL.state, events: [] }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no turn pipeline ran');
  });

  it('city-shield-conservation: a completion that paid less than the item costs', () => {
    const city = mustFind(FINAL.state.cities[0], 'a city in the final state');
    const charged = withCity(FINAL.state, city.id, (candidate) => ({
      ...candidate,
      shields: candidate.shields + 4,
    }));
    const events: readonly GameEvent[] = [
      ...FINAL.events,
      {
        type: 'CityProduced',
        cityId: city.id,
        owner: city.owner,
        item: { kind: 'unit', id: asUnitTypeId('warrior') },
        shields: city.shields + 4,
      },
    ];
    const messages = messagesOf(
      'city-shield-conservation',
      contextFor({ state: charged, previous: FINAL.previous, events }),
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join(' ')).toContain('charge does not reconcile');
  });

  it('city-shield-conservation: says nothing on the first turn', () => {
    expect(messagesOf('city-shield-conservation', contextFor({ state: BASE }))).toEqual([]);
  });

  it('every invariant has a fire test, and the registry names line up', () => {
    // The guard against a new invariant arriving without evidence: the list of names
    // exercised by the tests above is written here, so adding one to the registry
    // without a case that makes it fail is a test failure rather than a silent gap.
    const exercised: readonly string[] = [
      'treasury-non-negative',
      'pools-non-negative',
      'player-pools-integral',
      'city-population-at-least-one',
      'city-food-box-within-threshold',
      'city-shields-non-negative',
      'city-works-at-most-its-citizens',
      'tile-worked-by-one-city',
      'worked-tile-in-city-radius',
      'city-ids-unique-and-sorted',
      'city-tile-unique',
      'unit-ids-unique-and-sorted',
      'unit-tile-in-bounds',
      'unit-owner-exists',
      'unit-movement-in-range',
      'improvements-sorted-and-unique',
      'resources-sorted-and-unique',
      'wonder-held-by-one-city',
      'gold-conservation',
      'city-food-conservation',
      'city-shield-conservation',
    ];
    expect(exercised.slice().sort()).toEqual(
      CORE_INVARIANTS.map((invariant) => invariant.name)
        .slice()
        .sort(),
    );
    for (const name of exercised) {
      const broken = BROKEN_STATES[name];
      expect(broken, `no broken state is registered for ${name}`).toBeDefined();
      const messages = broken === undefined ? [] : messagesOf(name, broken());
      expect(messages.length, `${name} did not fire on its broken state`).toBeGreaterThan(0);
      expect(messagesOf(name, contextFor({ state: BASE })).length).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * A deliberately broken context per invariant, so "every invariant can fail" is a
 * single table the test above walks — a registry entry with no entry here, or an
 * entry here that does not fire, fails the test.
 *
 * The cases mirror the individual tests above; they are kept as one table as well
 * because the *coverage claim* ("each of these fires") is itself worth one assertion
 * that cannot drift from the registry.
 */
const BROKEN_STATES: Readonly<Record<string, () => InvariantContext>> = {
  'treasury-non-negative': () =>
    contextFor({ state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, treasury: -1 })) }),
  'pools-non-negative': () =>
    contextFor({ state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, beakers: -1 })) }),
  'player-pools-integral': () =>
    contextFor({
      state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, treasury: 0.5 })),
    }),
  'city-population-at-least-one': () =>
    contextFor({ state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, population: 0 })) }),
  'city-food-box-within-threshold': () =>
    contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({
        ...city,
        foodBox: foodBoxSize(city.population),
      })),
    }),
  'city-shields-non-negative': () =>
    contextFor({ state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, shields: -1 })) }),
  'city-works-at-most-its-citizens': () =>
    contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({
        ...city,
        workedTiles: radiusTiles(BASE, city, city.population + 1),
      })),
    }),
  'tile-worked-by-one-city': () => {
    const other = mustFind(
      BASE.cities.find((city) => city.id !== BASE_CITY.id),
      'a second city',
    );
    const tile = mustFind(radiusTiles(BASE, BASE_CITY, 1)[0], 'a tile in the radius');
    return contextFor({
      state: withCity(
        withCity(BASE, BASE_CITY.id, (city) => ({ ...city, workedTiles: [tile] })),
        other.id,
        (city) => ({ ...city, workedTiles: [tile] }),
      ),
    });
  },
  'worked-tile-in-city-radius': () =>
    contextFor({
      state: withCity(BASE, BASE_CITY.id, (city) => ({ ...city, workedTiles: [city.tile] })),
    }),
  'city-ids-unique-and-sorted': () =>
    contextFor({ state: { ...BASE, cities: [...BASE.cities].reverse() } }),
  'city-tile-unique': () => {
    const other = mustFind(
      BASE.cities.find((city) => city.id !== BASE_CITY.id),
      'a second city',
    );
    return contextFor({
      state: {
        ...BASE,
        cities: [
          ...BASE.cities,
          {
            ...other,
            id: asCityId(Number(BASE_CITY.id) + 901),
            tile: BASE_CITY.tile,
            workedTiles: [],
          },
        ],
      },
    });
  },
  'unit-ids-unique-and-sorted': () =>
    contextFor({ state: { ...BASE, units: [BASE_UNIT, BASE_UNIT, ...BASE.units] } }),
  'unit-tile-in-bounds': () =>
    contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({
        ...unit,
        tile: asTileIndex(BASE.map.width * BASE.map.height),
      })),
    }),
  'unit-owner-exists': () =>
    contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, owner: asPlayerId(77) })),
    }),
  'unit-movement-in-range': () =>
    contextFor({
      state: withUnit(BASE, BASE_UNIT.id, (unit) => ({ ...unit, movementLeft: 12345 })),
    }),
  'improvements-sorted-and-unique': () =>
    contextFor({
      state: {
        ...BASE,
        improvements: [
          { tile: asTileIndex(400), kind: asImprovementId('road') },
          { tile: asTileIndex(4), kind: asImprovementId('mine') },
        ],
      },
    }),
  'resources-sorted-and-unique': () =>
    contextFor({
      state: {
        ...BASE,
        map: {
          ...BASE.map,
          resources: [
            { tile: asTileIndex(7), resource: asResourceId('gold') },
            { tile: asTileIndex(3), resource: asResourceId('iron') },
          ],
        },
      },
    }),
  'wonder-held-by-one-city': () => {
    const wonder = mustFind(
      CATALOG.buildings.find((row) => row.wonder === true),
      'a wonder row',
    );
    const first = mustFind(BASE.cities[0], 'a city');
    const second = mustFind(BASE.cities[1], 'a second city');
    return contextFor({
      state: withCity(
        withCity(BASE, first.id, (city) => ({
          ...city,
          buildings: [...city.buildings, wonder.id],
        })),
        second.id,
        (city) => ({ ...city, buildings: [...city.buildings, wonder.id] }),
      ),
    });
  },
  'gold-conservation': () =>
    contextFor({
      state: withPlayer(FINAL.state, BASE_CIV.id, (player) => ({
        ...player,
        treasury: player.treasury + 1,
      })),
      previous: FINAL.previous,
      events: FINAL.events,
    }),
  'city-food-conservation': () => {
    const city = mustFind(FINAL.state.cities[0], 'a city');
    return contextFor({
      state: withCity(FINAL.state, city.id, (candidate) => ({
        ...candidate,
        foodBox: candidate.foodBox + 1,
      })),
      previous: FINAL.previous,
      events: FINAL.events,
    });
  },
  'city-shield-conservation': () => {
    const city = mustFind(FINAL.state.cities[0], 'a city');
    return contextFor({
      state: withCity(FINAL.state, city.id, (candidate) => ({
        ...candidate,
        shields: candidate.shields + 1,
      })),
      previous: FINAL.previous,
      events: FINAL.events,
    });
  },
};

/* ------------------------------------------------------------------ *
 * 3. Totality — never an exception, whatever the state
 * ------------------------------------------------------------------ */

describe('every check is total on a state this engine could not have built', () => {
  it('reports a violation instead of throwing on malformed containers', () => {
    const broken: readonly GameState[] = [
      malformedState({ ...BASE, cities: null }),
      malformedState({ ...BASE, cities: [null] }),
      malformedState({ ...BASE, units: 'none' }),
      malformedState({ ...BASE, players: [{}] }),
      malformedState({ ...BASE, improvements: [{ tile: 'x', kind: 3 }] }),
      malformedState({ ...BASE, map: { width: 4, height: 4, terrain: [] } }),
      malformedState({ ...BASE, map: { ...BASE.map, resources: [null] } }),
    ];

    for (const state of broken) {
      const violations = checkInvariants(contextFor({ state, previous: BASE, events: [] }));
      // Every check must *answer*; some of these states are so broken that the answer
      // is "this check threw", which is exactly the totality the contract asks for.
      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations) {
        expect(typeof violation.message).toBe('string');
        expect(violation.message.length).toBeGreaterThan(0);
        expect(violation.invariant).toMatch(/-/);
      }
    }
  });

  it('names the check that threw, so a total answer is still a diagnosable one', () => {
    const violations = checkInvariants(
      contextFor({ state: malformedState({ ...BASE, cities: null }) }),
      [invariantNamed('city-population-at-least-one')],
    );
    expect(violations).toHaveLength(1);
    expect(mustFind(violations[0], 'the violation').invariant).toBe('city-population-at-least-one');
    expect(mustFind(violations[0], 'the violation').message).toContain(
      'threw instead of returning',
    );
  });

  it('pairs every message with the invariant name and the turn', () => {
    const ctx = contextFor({
      state: withPlayer(BASE, BASE_CIV.id, (player) => ({ ...player, treasury: -1 })),
      turn: 99,
    });
    const violations = checkInvariants(ctx);
    expect(violations.length).toBeGreaterThan(0);
    const violation = mustFind(violations[0], 'the first violation');
    expect(violation.turn).toBe(99);
    expect(violation.invariant).toBe('treasury-non-negative');
  });

  it('runs a caller-supplied registry, so a milestone can add rules without editing core', () => {
    const extra: Invariant = {
      name: 'example-milestone-rule',
      description: 'A rule this milestone adds without touching the core registry.',
      check: () => ['the example rule fired'],
    };
    const violations = checkInvariants(contextFor({ state: BASE }), [extra]);
    expect(violations).toEqual([
      { invariant: 'example-milestone-rule', turn: BASE.turn, message: 'the example rule fired' },
    ]);
    // ...and the core registry is untouched by it.
    expect(checkInvariants(contextFor({ state: BASE }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The corpus is real content, not a stand-in
 * ------------------------------------------------------------------ */

describe('the fixture is the shipped ruleset', () => {
  it('uses the validated catalog the CLI runs on', () => {
    const catalog: Catalog = CATALOG;
    expect(catalog.units.length).toBeGreaterThan(0);
    expect(RULESET.fidelity).toBe('tuned');
    expect(VIEW).toBe(RULESET);
    // The played state really has what the corruption tests corrupt.
    expect(BASE.cities.length).toBeGreaterThan(1);
    expect(BASE.units.length).toBeGreaterThan(0);
    expect(BASE_CIV.kind).toBe('civ');
    expect(asCityId(BASE_CITY.id)).toBe(BASE_CITY.id);
    expect(asTileIndex(0)).toBe(0);
  });
});
