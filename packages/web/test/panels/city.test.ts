/**
 * The city screen: yields from the engine, a production menu the applier accepts, and worked
 * tiles whose every enabled toggle the engine approves.
 *
 * The keystone shape at this panel is the third one, and it is the reason worked tiles are
 * checkboxes rather than clickable tiles: **the UI builds a candidate assignment and asks
 * `planSetWorkedTiles`**, so a disabled control is a refusal the engine stated and an enabled
 * one is a command the applier accepts.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  asBuildingId,
  asCityId,
  asPlayerId,
  asUnitId,
  asUnitTypeId,
  cityById,
  cityRadius,
  cityYields,
  cityProductionOptions,
  happinessOf,
  isDisordered,
  newGame,
  playerCulture,
  wholeCulture,
  planSetProduction,
  planSetWorkedTiles,
  type GameState,
  type PlayerId,
  type ProductionItem,
  type RulesetView,
} from '@civts/core';
import { CATALOG, validateRuleset } from '@civts/rules';
import {
  cityFacts,
  cityListEntries,
  productionChoices,
  buildingEntry,
  queueEntries,
  workedTileOptions,
} from '../../src/panels/city.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('the shipped catalog does not validate');
const RULESET: RulesetView = validated.value;

const started = newGame(11, { ...DEFAULT_SETTINGS, civCount: 2, mapSize: 'tiny' }, RULESET);
if (!started.ok) throw new Error('newGame failed on the shipped catalog');
const P0 = asPlayerId(0);
const CITY = asCityId(0);

/** Found the first city by the engine's own command, so the board is a real one. */
const founded = applyCommand(
  started.value,
  P0,
  { type: 'FoundCity', unitId: asUnitId(0) },
  RULESET,
);
if (!founded.ok) throw new Error('founding the first city was refused');
const STATE: GameState = founded.value.state;

describe('cityListEntries', () => {
  it("lists the acting player's cities only, in state order", () => {
    const entries = cityListEntries(STATE, RULESET, P0);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(CITY);
    expect(entries[0]?.name).toBe('City 1');
    expect(cityListEntries(STATE, RULESET, asPlayerId(1))).toEqual([]);
  });
});

describe('cityFacts', () => {
  it("reports the engine's own yields, not a recomputation", () => {
    const yields = cityYields(STATE, RULESET, CITY);
    const facts = cityFacts(STATE, RULESET, CITY);
    if (facts === undefined) throw new Error('no facts for a city that exists');
    const value = (label: string): string => {
      const fact = facts.find((candidate) => candidate.label === label);
      if (fact === undefined) throw new Error(`no fact named ${label}`);
      return fact.value;
    };
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    expect(value('Population')).toBe(String(city.population));
    expect(value('Shields')).toBe(String(yields.shields));
    expect(value('Commerce')).toBe(String(yields.commerce));
    expect(value('Food')).toContain(String(yields.food));
    expect(value('Food')).toContain(String(yields.foodSurplus));
  });

  it("shows the state's own food box and stored shields", () => {
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    const facts = cityFacts(STATE, RULESET, CITY);
    if (facts === undefined) throw new Error('no facts for a city that exists');
    expect(facts.find((fact) => fact.label === 'Food box')?.value).toContain(String(city.foodBox));
    expect(facts.find((fact) => fact.label === 'Stored shields')?.value).toBe(String(city.shields));
    expect(facts.find((fact) => fact.label === 'Buildings')?.value).toBe('0');
  });

  it('answers nothing for a city that is not there', () => {
    expect(cityFacts(STATE, RULESET, asCityId(99))).toBeUndefined();
  });

  it("shows M9's culture and happiness as the ENGINE reads them, never as a recomputation", () => {
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    const mine = cityFacts(STATE, RULESET, CITY);
    if (mine === undefined) throw new Error('no facts for a city that exists');
    const of = (facts: readonly { label: string; value: string }[], label: string): string => {
      const fact = facts.find((candidate) => candidate.label === label);
      if (fact === undefined) throw new Error(`no fact named ${label}`);
      return fact.value;
    };

    // Happiness is `happiness.ts`' own count — the same call `cityYields` makes to decide whether
    // the city is in disorder, so the line on screen and the number the production, growth and
    // money loops acted on are one number.
    const mood = happinessOf(STATE, RULESET, city);
    expect(of(mine, 'Happiness')).toBe(
      `${String(mood.happy)} happy, ${String(mood.content)} content, ${String(mood.unhappy)} unhappy`,
    );

    // Culture is the city's own accumulated figure beside the player's DERIVED total — there is no
    // stored player total in the engine for a panel to disagree with (see `culture.ts`).
    expect(of(mine, 'Culture')).toContain(String(wholeCulture(city.culture)));
    expect(of(mine, 'Culture')).toContain(String(playerCulture(STATE, city.owner)));

    // Disorder is asked the OTHER way round — `isDisordered` is the same verdict by city id — so a
    // panel that re-derived the rule instead of reading it would be caught here.
    expect(of(mine, 'Disorder')).toBe(
      isDisordered(STATE, RULESET, CITY)
        ? 'civil disorder — no shields, no beakers, no gold and no growth this turn'
        : 'in good order',
    );
    expect(mood.disordered).toBe(isDisordered(STATE, RULESET, CITY));
  });

  it('says a city is in civil disorder when the engine says so', () => {
    // The fire case: a city too big for its contentment is disordered by the engine's own rule, and
    // the screen says the engine's sentence rather than inferring "fine" from a happy-looking board.
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    const crowded = {
      ...STATE,
      cities: STATE.cities.map((candidate) =>
        candidate.id === CITY ? { ...candidate, population: 30 } : candidate,
      ),
    };
    expect(
      isDisordered(crowded, RULESET, CITY),
      'a 30-citizen city with no temple, no luxuries and no luxury spending is not disordered — ' +
        'this case would then prove nothing',
    ).toBe(true);
    const facts = cityFacts(crowded, RULESET, CITY);
    const disorder = facts?.find((fact) => fact.label === 'Disorder');
    expect(disorder?.value).toContain('civil disorder');
    expect(disorder?.value).toContain('no shields');
  });
});

describe('workedTileOptions', () => {
  const options = workedTileOptions(STATE, P0, CITY);

  it("offers exactly the engine's radius", () => {
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    expect(options.map((option) => option.tile)).toEqual([...cityRadius(STATE, city.tile)]);
  });

  it('agrees with the planner about every toggle, in both directions', () => {
    for (const option of options) {
      const decided = planSetWorkedTiles(STATE, P0, CITY, option.next).ok;
      expect(option.legal, `toggle of ${option.text}`).toBe(decided);
    }
  });

  it('never enables a toggle the applier would refuse, and every enabled toggle applies', () => {
    for (const option of options) {
      if (!option.legal) continue;
      const applied = applyCommand(
        STATE,
        P0,
        { type: 'SetWorkedTiles', cityId: CITY, tiles: option.next },
        RULESET,
      );
      expect(applied.ok, `SetWorkedTiles for ${option.text} was refused`).toBe(true);
    }
  });

  it('marks the tiles the state already works, and the toggle removes them', () => {
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the founded city is missing');
    const worked = options.filter((option) => option.worked);
    expect(worked.map((option) => option.tile)).toEqual([...city.workedTiles]);
    for (const option of worked) {
      expect(option.next.includes(option.tile)).toBe(false);
      expect(option.next.length).toBe(city.workedTiles.length - 1);
    }
  });

  it('answers nothing for a city that is not there', () => {
    expect(workedTileOptions(STATE, P0, asCityId(99))).toEqual([]);
  });
});

describe('productionChoices', () => {
  it("is the engine's own menu, unmodified", () => {
    expect(productionChoices(STATE, RULESET, CITY).map((choice) => choice.item)).toEqual([
      ...cityProductionOptions(STATE, RULESET, CITY),
    ]);
  });

  it('never offers an item the applier would refuse, and every offered item applies', () => {
    const choices = productionChoices(STATE, RULESET, CITY);
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(planSetProduction(STATE, RULESET, P0, CITY, choice.item).ok).toBe(true);
      const applied = applyCommand(
        STATE,
        P0,
        { type: 'SetProduction', cityId: CITY, item: choice.item },
        RULESET,
      );
      expect(applied.ok, `SetProduction ${choice.label} was refused`).toBe(true);
    }
  });
});

describe('buildingEntry — what the city is building right now', () => {
  it("is the engine's `production`, with the engine's price", () => {
    const item: ProductionItem = { kind: 'building', id: asBuildingId('granary') };
    const applied = applyCommand(STATE, P0, { type: 'SetProduction', cityId: CITY, item }, RULESET);
    if (!applied.ok) throw new Error('setting production to a granary was refused');

    const entry = buildingEntry(applied.value.state, RULESET, CITY);
    expect(entry?.label).toBe('Granary (building)');
    expect(entry?.current).toBe(true);
    expect(entry?.cost).toBe(10);
  });

  it('is undefined for a city building nothing', () => {
    expect(buildingEntry(STATE, RULESET, CITY)).toBeUndefined();
  });
});

describe('queueEntries — the items behind the current build', () => {
  it('stays empty when `SetProduction` sets production, because M3 leaves the queue alone', () => {
    const item: ProductionItem = { kind: 'building', id: asBuildingId('granary') };
    const applied = applyCommand(STATE, P0, { type: 'SetProduction', cityId: CITY, item }, RULESET);
    if (!applied.ok) throw new Error('setting production to a granary was refused');

    const city = cityById(applied.value.state, CITY);
    expect(city?.queue).toEqual([]);
    expect(queueEntries(applied.value.state, RULESET, CITY)).toEqual([]);
    expect(buildingEntry(applied.value.state, RULESET, CITY)).toBeDefined();
  });

  it('lists a queued item in the state order, and marks it as not current', () => {
    const city = cityById(STATE, CITY);
    if (city === undefined) throw new Error('the fixture has no city');
    const queued: GameState = {
      ...STATE,
      cities: [
        { ...city, queue: [{ kind: 'unit', id: asUnitTypeId('warrior') }] },
        ...STATE.cities.filter((candidate) => candidate.id !== CITY),
      ],
    };
    const entries = queueEntries(queued, RULESET, CITY);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe('Warrior (unit)');
    expect(entries[0]?.current).toBe(false);
  });

  it('is empty for a city with no queue', () => {
    expect(queueEntries(STATE, RULESET, CITY)).toEqual([]);
  });
});

describe('a player with no cities', () => {
  it('has an empty list rather than a broken one', () => {
    const playerOne: PlayerId = asPlayerId(1);
    expect(cityListEntries(STATE, RULESET, playerOne)).toEqual([]);
  });
});
