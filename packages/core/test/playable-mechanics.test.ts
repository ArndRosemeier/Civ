import { describe, expect, it } from 'vitest';
import { CATALOG, validateRuleset } from '@civts/rules';
import { createScenarioBuilder, hashValue } from '@civts/testing';
import {
  DEFAULT_SETTINGS,
  applyCommand,
  advanceTurn,
  applyProduction,
  asBuildingId,
  asPlayerId,
  asUnitTypeId,
  atWar,
  happinessOf,
  deserialize,
  newGame,
  planAttackUnit,
  planSetProduction,
  relationOf,
  serialize,
  tileIndex,
  type GameState,
} from '../src/index.js';

const validated = validateRuleset(CATALOG, 'tuned');
if (!validated.ok) throw new Error('invalid shipped rules');
const rules = validated.value;
const owner = asPlayerId(0);
const rival = asPlayerId(1);
const type = asUnitTypeId;
const at = (x: number, y: number) => tileIndex(40, x, y);
const builder = () =>
  createScenarioBuilder(rules, { mapSize: 'duel', seed: 1 })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .addUnit(0, type('warrior'), [2, 2])
    .addUnit(1, type('warrior'), [30, 30]);
const built = (value: ReturnType<typeof builder>): GameState => {
  const result = value.build();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const produce = (unit: string, population: number) =>
  built(
    builder().addCity(0, [2, 2], {
      population,
      shields: 100,
      production: { kind: 'unit', id: type(unit) },
    }),
  );

describe('production uses citizens and a legal unit domain', () => {
  it('waits for population three before completing a settler, retaining its shields', () => {
    const state = produce('settler', 1);
    const result = applyProduction(state, rules);
    expect(result.events).toEqual([]);
    expect(result.state.cities[0]?.population).toBe(1);
    expect(result.state.cities[0]?.production?.id).toBe('settler');
    expect(result.state.cities[0]?.shields).toBeGreaterThanOrEqual(100);
    expect(result.state.units).toHaveLength(state.units.length);
  });
  it.each([
    ['settler', 3, 2],
    ['worker', 2, 1],
  ] as const)('%s pays its population cost once', (unit, population, cost) => {
    const state = produce(unit, population);
    const result = applyProduction(state, rules);
    const city = result.state.cities[0];
    expect(city?.population).toBe(population - cost);
    expect(city?.workedTiles.length).toBeLessThanOrEqual(population - cost);
    expect(result.state.units).toHaveLength(state.units.length + 1);
    expect(result.events[0]).toMatchObject({
      type: 'CityProduced',
      emigration: { citizens: cost, populationBefore: population },
    });
    expect(applyProduction(result.state, rules).events).toEqual([]);
    expect(state.cities[0]?.population).toBe(population);
  });
  it('refuses ship production inland and places a coastal ship on water', () => {
    const inland = produce('galley', 1);
    expect(
      planSetProduction(inland, rules, owner, inland.cities[0]!.id, {
        kind: 'unit',
        id: type('galley'),
      }).ok,
    ).toBe(false);
    expect(applyProduction(inland, rules).events).toEqual([]);
    const coastal = built(
      builder()
        .setTile(3, 2, 'coast')
        .addCity(0, [2, 2], {
          shields: 100,
          production: { kind: 'unit', id: type('galley') },
        }),
    );
    const result = applyProduction(coastal, rules);
    expect(result.state.units.find((unit) => unit.type === 'galley')?.tile).toBe(at(3, 2));
  });
  it('requires the technology for factories and medieval troops', () => {
    const state = produce('warrior', 1);
    const city = state.cities[0]!;
    expect(
      planSetProduction(state, rules, owner, city.id, {
        kind: 'building',
        id: asBuildingId('factory'),
      }),
    ).toMatchObject({ ok: false, error: { kind: 'tech-required', tech: 'steam-power' } });
    expect(
      planSetProduction(state, rules, owner, city.id, { kind: 'unit', id: type('knight') }),
    ).toMatchObject({ ok: false, error: { kind: 'tech-required', tech: 'feudalism' } });
  });
});

describe('rest restores health', () => {
  const hurt = () => built(builder().addUnit(0, type('spearman'), [4, 4], { hitPointsLeft: 1 }));
  it('heals an idle unit but not one that has spent its movement', () => {
    const state = hurt();
    const unit = state.units[2]!;
    expect(advanceTurn(state, rules).state.units.find((u) => u.id === unit.id)?.hitPointsLeft).toBe(
      2,
    );
    const spent = {
      ...state,
      units: state.units.map((u) => (u.id === unit.id ? { ...u, movementLeft: 0 } : u)),
    };
    expect(advanceTurn(spent, rules).state.units.find((u) => u.id === unit.id)?.hitPointsLeft).toBe(
      1,
    );
  });
  it('restores full health in an owned barracks', () => {
    const state = built(
      builder()
        .addUnit(0, type('spearman'), [4, 4], { hitPointsLeft: 1 })
        .addCity(0, [4, 4], { buildings: [asBuildingId('barracks')] }),
    );
    expect(advanceTurn(state, rules).state.units[2]?.hitPointsLeft).toBe(3);
  });
});

describe('combat and diplomacy', () => {
  const battlefield = () =>
    built(builder().addUnit(1, type('worker'), [3, 2]).addUnit(1, type('spearman'), [3, 2]));
  it('selects the strongest defender in a stack and leaves the others untouched', () => {
    const state = battlefield();
    const attacker = state.units[0]!;
    const plan = planAttackUnit(state, rules, owner, attacker.id, at(3, 2));
    expect(plan).toMatchObject({
      ok: true,
      value: { kind: 'battle', defender: { type: 'spearman' } },
    });
    const result = applyCommand(
      state,
      owner,
      { type: 'AttackUnit', unitId: attacker.id, target: at(3, 2) },
      rules,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.units.find((u) => u.type === 'worker')).toEqual(
      state.units.find((u) => u.type === 'worker'),
    );
  });
  it('requires war before an attack and requires an incoming offer before peace', () => {
    let state: GameState = {
      ...battlefield(),
      diplomacy: [{ a: owner, b: rival, status: 'peace' }],
    };
    const attacker = state.units[0]!;
    const attack = { type: 'AttackUnit', unitId: attacker.id, target: at(3, 2) } as const;
    expect(applyCommand(state, owner, attack, rules).ok).toBe(false);
    for (const [actor, type, targetPlayer] of [
      [owner, 'DeclareWar', rival],
      [owner, 'OfferPeace', rival],
      [rival, 'AcceptPeace', owner],
    ] as const) {
      const result = applyCommand(state, actor, { type, targetPlayer }, rules);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      state = result.value.state;
      if (type === 'DeclareWar') expect(applyCommand(state, owner, attack, rules).ok).toBe(true);
    }
    expect(atWar(state, owner, rival)).toBe(false);
    expect(relationOf(state, rival, owner).status).toBe('peace');
    expect(applyCommand(state, owner, { type: 'AcceptPeace', targetPlayer: rival }, rules).ok).toBe(
      false,
    );
    const codec = { hash: hashValue, invariants: [] };
    const save = serialize(state, codec);
    expect(deserialize(save, codec)).toMatchObject({
      ok: true,
      value: { diplomacy: state.diplomacy },
    });
  });
  it('starts new civilizations at peace and retains hostile relations in old saves', () => {
    const game = newGame(1, { ...DEFAULT_SETTINGS, seed: 1, mapSize: 'duel', civCount: 2 }, rules);
    expect(game.ok).toBe(true);
    if (game.ok) expect(atWar(game.value, owner, rival)).toBe(false);
    expect(atWar(battlefield(), owner, rival)).toBe(true);
  });
  it('refuses malformed diplomatic relations even with a matching save hash', () => {
    const state = battlefield();
    const codec = { hash: hashValue, invariants: [] };
    const pair = { a: owner, b: rival, status: 'war' } as const;
    const malformed = [
      [pair, pair],
      [{ a: rival, b: owner, status: 'peace' } as const],
      [{ ...pair, offer: asPlayerId(2) }],
      [{ ...pair, truceUntil: -1 }],
    ];
    for (const diplomacy of malformed) {
      expect(deserialize(serialize({ ...state, diplomacy }, codec), codec).ok).toBe(false);
    }
  });
  it('requires war before entering another civilization’s territory', () => {
    const base = built(builder().addCity(1, [3, 2]));
    const state = { ...base, diplomacy: [{ a: owner, b: rival, status: 'peace' } as const] };
    const command = { type: 'MoveUnit', unitId: state.units[0]!.id, to: at(3, 1) } as const;
    expect(applyCommand(state, owner, command, rules).ok).toBe(false);
    const war = applyCommand(state, owner, { type: 'DeclareWar', targetPlayer: rival }, rules);
    expect(war.ok).toBe(true);
    if (war.ok) expect(applyCommand(war.value.state, owner, command, rules).ok).toBe(true);
  });
});

describe('happiness uses ongoing city spending', () => {
  it('ignores a stockpiled luxury pool and partitions the city population', () => {
    const state = built(
      builder().setPools(0, { luxuries: 10000 }).addCity(0, [2, 2], { population: 3 }),
    );
    const city = state.cities[0]!;
    const happiness = happinessOf(state, rules, city);
    expect(happiness.happy).toBe(0);
    expect(happiness.happy + happiness.content + happiness.unhappy).toBe(city.population);
    const spending = {
      ...state,
      players: state.players.map((p) =>
        p.id === owner ? { ...p, rates: { tax: 0, science: 0, luxury: 10 } } : p,
      ),
    };
    const result = happinessOf(spending, rules, city);
    expect(result.happy).toBeGreaterThan(0);
    expect(result.happy + result.content + result.unhappy).toBe(city.population);
    expect(result.happy).toBeLessThanOrEqual(city.population);
  });
});
