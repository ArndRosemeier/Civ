/**
 * The technology rules (`core/tech.ts`) — cost, prerequisites, what a completion
 * unlocks, and what one turn does with a civilization's banked beakers.
 *
 * Two things this file is deliberately *not*: it is not a ruleset-validation suite
 * (the tree's shape, its cycle check and its era ordering are `@civts/rules`'
 * business, asserted in `packages/rules/test/rules.test.ts`), and it is not the
 * place the turn *order* is pinned (`turn.test.ts` owns the pipeline, including the
 * position of the research step and the beaker reading that follows from it).
 *
 * What it does own is the rule itself: every one of the four typed answers
 * (`unknown-tech`, `already-known`, `unmet-prerequisite`, `nothing-being-researched`)
 * given for a state a caller could actually hold, the completion arithmetic
 * (subtract, carry the remainder, sort and dedupe, remove the key), the totality of
 * every read over a foreign or hand-built state, and the two gating readers. A rule
 * that threw here would be a rule no caller can branch on, which is why roughly half
 * of these tests hand `tech.ts` a state the type says cannot exist.
 *
 * Fixtures are local and small on purpose: five techs, two roots, one diamond, in a
 * catalog order that is **not** id order — so a helper that quietly relied on the
 * data being sorted would fail here rather than in a golden.
 */

import { describe, expect, it } from 'vitest';
import { hashValue } from '@civts/testing';
import type { BuildingDef, City } from '../src/cities.js';
import { asImprovementId, type ImprovementDef } from '../src/improvements.js';
import {
  asBuildingId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitTypeId,
} from '../src/ids.js';
import type { GameMap, ResourceDef, RulesetView, TerrainDef } from '../src/map.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import type { GameState, PlayerState } from '../src/state.js';
import {
  TECH_UNLOCK_KINDS,
  applyResearch,
  currentResearch,
  knowsTech,
  knownTechs,
  missingPrerequisites,
  prerequisitesOf,
  researchProblem,
  researchStep,
  requiresTechOf,
  researchingOf,
  techCatalog,
  techCostOf,
  techDef,
  techUnlocks,
  unmetTechRequirement,
  withResearching,
  withoutResearching,
  type TechDef,
} from '../src/tech.js';
import { advanceTurn } from '../src/turn.js';
import { isErr, isOk } from '../src/result.js';
import type { UnitDef } from '../src/units.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The one terrain this board is made of. Nothing here looks at a tile's *terrain*:
 * a map exists because `GameState` has one and the pipeline steps the research rule
 * runs beside need it. */
const TERRAIN: TerrainDef = {
  id: asTerrainId('grassland'),
  role: 'grassland',
  name: 'Grassland',
  moveCost: 1,
  defenseBonusPct: 10,
  yields: { food: 2, shields: 1, commerce: 1 },
  impassable: false,
};

const GRASSLAND = asTerrainId('grassland');

const MAP: GameMap = {
  width: 2,
  height: 2,
  terrain: [GRASSLAND, GRASSLAND, GRASSLAND, GRASSLAND],
  huts: [],
  resources: [],
};

const WARRIOR: UnitDef = {
  id: asUnitTypeId('warrior'),
  role: 'military',
  name: 'Warrior',
  attack: 1,
  defense: 1,
  movement: 1,
  cost: 10,
  domain: 'land',
};

/**
 * Five rows: two roots, a diamond (`writing` needs `alphabet` and `masonry`), and a
 * catalog order that is **not** id order — `writing` sits second, `bronze-working`
 * fourth. Every cost is distinct, so an assertion that mixes two rows up fails
 * instead of coincidentally passing.
 */
const POTTERY: TechDef = {
  id: asTechId('pottery'),
  name: 'Pottery',
  era: 'ancient',
  cost: 5,
  requires: [],
};
const WRITING: TechDef = {
  id: asTechId('writing'),
  name: 'Writing',
  era: 'medieval',
  cost: 11,
  requires: [asTechId('alphabet'), asTechId('masonry')],
};
const MASONRY: TechDef = {
  id: asTechId('masonry'),
  name: 'Masonry',
  era: 'ancient',
  cost: 9,
  requires: [asTechId('bronze-working')],
};
const BRONZE_WORKING: TechDef = {
  id: asTechId('bronze-working'),
  name: 'Bronze Working',
  era: 'ancient',
  cost: 6,
  requires: [],
};
const ALPHABET: TechDef = {
  id: asTechId('alphabet'),
  name: 'Alphabet',
  era: 'ancient',
  cost: 7,
  requires: [asTechId('pottery')],
};

/** Catalog order, deliberately unsorted: `writing` first would be blocked forever. */
const TECHS: readonly TechDef[] = [POTTERY, WRITING, MASONRY, BRONZE_WORKING, ALPHABET];

/**
 * A `RulesetView` that also carries the tree.
 *
 * `RulesetView` does not declare `techs` and this suite may not edit `map.ts`, so the
 * fixture states the extension honestly — a local interface that *adds* a field rather
 * than a cast that claims the base type has one. That is also exactly the shape a
 * future `RulesetView.techs` will take, and `tech.ts` reads it structurally, so these
 * tests keep working when the field is declared for real.
 */
interface TechRulesetView extends RulesetView {
  readonly techs: readonly TechDef[];
}

const RULESET: TechRulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR],
  buildings: [],
  improvements: [],
  resources: [],
  techs: TECHS,
  fidelity: 'tuned',
};

/**
 * A `RulesetView` whose `techs` field is *not* a list of tech rows — the shape a
 * half-foreign ruleset has, and the one every totality claim in `tech.ts` is about.
 *
 * Declared as a local interface rather than reached for with a cast: the base type has
 * no such field, so "the tree is malformed" is stated as a type, and the reader under
 * test receives exactly what a JSON file could hand it.
 */
interface MessyRulesetView extends RulesetView {
  readonly techs: unknown;
}

/** The same view **without** the tree: the shape a pre-M5 ruleset has. */
const NO_TECH_RULESET: RulesetView = {
  terrains: [TERRAIN],
  units: [WARRIOR],
  buildings: [],
  improvements: [],
  resources: [],
  fidelity: 'tuned',
};

const TECH_LIST: readonly (readonly [string, readonly string[]])[] = [
  ['pottery', []],
  ['writing', ['alphabet', 'masonry']],
  ['masonry', ['bronze-working']],
  ['bronze-working', []],
  ['alphabet', ['pottery']],
];

const player = (index: number, overrides: Partial<PlayerState> = {}): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(0),
  kind: 'civ',
  treasury: 10,
  rates: { tax: 6, science: 4, luxury: 0 },
  beakers: 0,
  luxuries: 0,
  techs: [],
  ...overrides,
});

const barbarians = (index: number, overrides: Partial<PlayerState> = {}): PlayerState =>
  player(index, { kind: 'barbarian', name: 'Barbarians', ...overrides });

const board = (overrides: Partial<GameState> = {}): GameState => ({
  schemaVersion: 7,
  revision: 0,
  turn: 1,
  seed: 42,
  settings: { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 },
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: MAP,
  players: [player(0), player(1)],
  nextUnitId: 100,
  units: [],
  explored: [Array.from({ length: 4 }, () => false), Array.from({ length: 4 }, () => false)],
  nextCityId: 100,
  cities: [] as readonly City[],
  improvements: [],
  ...overrides,
});

/**
 * A player object with one field *removed* — a state the type says cannot exist, built
 * deliberately, exactly as `economy.test.ts`' `withoutField` does it.
 *
 * The only reason to write such a thing is to check that a read stays *total* on it
 * (an older save, a hand-edited file), and the cast is the honest way to say "this
 * object is not a `PlayerState` and I know it" rather than a way to silence a type
 * error about code that is otherwise correct.
 */
const withoutField = (value: PlayerState, field: 'techs' | 'beakers'): PlayerState => {
  const kept = Object.entries(value).filter(([key]) => key !== field);
  // `Object.fromEntries` rather than `delete`, and never a key set to `undefined`:
  // "absent" is the only spelling of missing a save can round-trip (see `state.ts`).
  return Object.fromEntries(kept) as unknown as PlayerState;
};

/**
 * A player object with one field *replaced by a value of the wrong type*.
 *
 * No cast: `Object.assign` widens the result to `PlayerState & Record<string, unknown>`,
 * which is still a `PlayerState` — the type says the field is one thing and the value
 * says another, which is exactly the state a JSON file can produce and a totality claim
 * is about.
 */
const withWrongType = (
  value: PlayerState,
  field: 'techs' | 'researching' | 'beakers',
  wrong: unknown,
): PlayerState => Object.assign({}, value, { [field]: wrong });

/** The goldens' event-type helper, in miniature. */
const eventTypes = (events: readonly { readonly type: string }[]): readonly string[] =>
  events.map((event) => event.type);

/* ------------------------------------------------------------------ *
 * The catalog read
 * ------------------------------------------------------------------ */

describe('techCatalog — one total read of a ruleset’s tree', () => {
  it('returns the rows in catalog order, unsorted and unfiltered', () => {
    // Data order, not sorted order: a UI groups by era in the order the data was
    // written, and the replay test below depends on catalog order deciding which of
    // two available techs is picked first.
    expect(techCatalog(RULESET).map((t) => String(t.id))).toEqual(TECH_LIST.map(([id]) => id));
  });

  it('reads a ruleset without a tree as a ruleset without a tree, not as an error', () => {
    // A pre-M5 view is a *game without research*: nothing can be researched and
    // beakers simply bank. That is an answer, and this is where it is given — the
    // alternative (throwing from `applyResearch` on every turn of such a game) would
    // make an old save unrunnable.
    expect(techCatalog(NO_TECH_RULESET)).toEqual([]);
  });

  it('ignores rows that are not tech rows, keeping the ones that are', () => {
    // A foreign ruleset can carry anything. A half-formed row names no tech, so it is
    // dropped rather than read as a free tech; the well-formed rows beside it are
    // untouched, so one junk row cannot remove the tree.
    const messy: MessyRulesetView = {
      ...NO_TECH_RULESET,
      techs: [
        POTTERY,
        { id: 'nameless' },
        { id: asTechId('no-cost'), name: 'x', era: 'ancient', requires: [] },
        { id: asTechId('bad-requires'), name: 'x', era: 'ancient', cost: 3, requires: [7] },
        ALPHABET,
        null,
        42,
      ],
    };
    expect(techCatalog(messy).map((t) => String(t.id))).toEqual(['pottery', 'alphabet']);
  });

  it('reads a field that is not a list as no tree at all, without throwing', () => {
    const broken: MessyRulesetView = { ...NO_TECH_RULESET, techs: 'not a list' };
    expect(techCatalog(broken)).toEqual([]);
    const absent: MessyRulesetView = { ...NO_TECH_RULESET, techs: undefined };
    expect(techCatalog(absent)).toEqual([]);
  });

  it('finds a row by id, and answers undefined for an id no row defines', () => {
    expect(techDef(RULESET, asTechId('masonry'))).toBe(MASONRY);
    expect(techDef(RULESET, asTechId('mithril'))).toBeUndefined();
    expect(techDef(NO_TECH_RULESET, asTechId('pottery'))).toBeUndefined();
  });

  it('reports the direct prerequisites of a row, and nothing for an unknown id', () => {
    expect(prerequisitesOf(RULESET, asTechId('writing')).map(String)).toEqual([
      'alphabet',
      'masonry',
    ]);
    expect(prerequisitesOf(RULESET, asTechId('pottery'))).toEqual([]);
    expect(prerequisitesOf(RULESET, asTechId('mithril'))).toEqual([]);
  });
});

describe('techCostOf — the one place a price is decided', () => {
  it('charges the row’s integer cost', () => {
    expect(techCostOf(RULESET, asTechId('pottery'))).toBe(5);
    expect(techCostOf(RULESET, asTechId('writing'))).toBe(11);
  });

  it('has no price for an id no row defines', () => {
    expect(techCostOf(RULESET, asTechId('mithril'))).toBeUndefined();
    expect(techCostOf(NO_TECH_RULESET, asTechId('pottery'))).toBeUndefined();
  });

  it('has no price for a free or fractional row: “researchable” is not invented', () => {
    // `validateRuleset` rejects both, so the only way to hold one is a hand-built or
    // foreign view — exactly the case this guard exists for. Reading either as a
    // price would let a tech complete for nothing, or put a fraction into a pool that
    // is part of every state hash.
    const free: MessyRulesetView = { ...NO_TECH_RULESET, techs: [{ ...POTTERY, cost: 0 }] };
    const fractional: MessyRulesetView = { ...NO_TECH_RULESET, techs: [{ ...POTTERY, cost: 2.5 }] };
    const costless: MessyRulesetView = {
      ...NO_TECH_RULESET,
      techs: [{ id: asTechId('pottery'), name: 'Pottery', era: 'ancient', requires: [] }],
    };
    expect(techCostOf(free, asTechId('pottery'))).toBeUndefined();
    expect(techCostOf(fractional, asTechId('pottery'))).toBeUndefined();
    expect(techCostOf(costless, asTechId('pottery'))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * What a player knows, and what it is researching
 * ------------------------------------------------------------------ */

describe('knownTechs — a total, canonical read of the tech list', () => {
  it('returns the list sorted by code unit and deduplicated', () => {
    const messy = player(0, {
      techs: [asTechId('pottery'), asTechId('alphabet'), asTechId('pottery'), asTechId('masonry')],
    });
    // Sorted, not catalog-ordered: the order is part of every state hash, so a state
    // that carried its list unsorted cannot be presented as canonical.
    expect(knownTechs(messy).map(String)).toEqual(['alphabet', 'masonry', 'pottery']);
  });

  it('reads a missing or malformed field as “knows nothing”, never as an error', () => {
    // Schema version 7 added `techs`, so a version-6 save has no such key at all;
    // hand-built and foreign states can carry anything. A legality check that threw
    // inside `applyCommand` on such a state would turn a stale save into a crash.
    expect(knownTechs(withoutField(player(0), 'techs'))).toEqual([]);
    expect(knownTechs(withWrongType(player(0), 'techs', 'pottery'))).toEqual([]);
    expect(knownTechs(withWrongType(player(0), 'techs', [1, null, 'pottery']))).toEqual([
      'pottery',
    ]);
  });

  it('answers knowsTech from that same read, not from the raw field', () => {
    const messy = player(0, {
      techs: [asTechId('pottery'), asTechId('pottery'), asTechId('alphabet')],
    });
    expect(knowsTech(messy, asTechId('pottery'))).toBe(true);
    expect(knowsTech(messy, asTechId('masonry'))).toBe(false);
  });
});

describe('withResearching / withoutResearching — the only two writers of the key', () => {
  it('reads an absent key as “researching nothing”, and a present one as the tech', () => {
    // The contract's distinction, unbroken by the total read: `undefined` means the
    // key is not there, and a value the engine cannot name means the same thing.
    expect(researchingOf(player(0))).toBeUndefined();
    expect(researchingOf(withResearching(player(0), asTechId('pottery')))).toBe('pottery');
    expect(researchingOf(withWrongType(player(0), 'researching', 7))).toBeUndefined();
    expect(researchingOf(withWrongType(player(0), 'researching', null))).toBeUndefined();
  });

  it('sets the key without touching anything else, and does not modify its input', () => {
    const before = player(0, { beakers: 3, techs: [asTechId('pottery')] });
    const after = withResearching(before, asTechId('masonry'));

    expect(after.researching).toBe('masonry');
    expect(after.beakers).toBe(3);
    expect(knownTechs(after).map(String)).toEqual(['pottery']);
    // Pure: the input is untouched, which is what lets `applyCommand` build a new
    // state from the old one without copying first.
    expect(Object.hasOwn(before, 'researching')).toBe(false);
  });

  it('removes the key rather than setting it to undefined', () => {
    // The M3 rule the contract repeats for M5, and the one bug class that has blocked
    // hashing three times: a key holding `undefined` cannot survive a JSON save/load
    // round trip, so `canonicalize` refuses it — such a state was never hashable, and
    // `Object.hasOwn` is what distinguishes the two spellings.
    const researching = withResearching(player(0), asTechId('pottery'));
    const cleared = withoutResearching(researching);

    expect(Object.hasOwn(cleared, 'researching')).toBe(false);
    expect(Object.keys(cleared)).toEqual(Object.keys(player(0)));
    // Clearing a player who was already researching nothing is a no-op, not an error:
    // the completion path calls it unconditionally.
    expect(withoutResearching(player(0))).toEqual(player(0));
    // And the input is untouched.
    expect(researchingOf(researching)).toBe('pottery');
  });

  it('keeps a player hashable through a set-then-clear round trip', () => {
    // The property the rule exists for, asserted by hashing rather than by reading
    // keys: a state that went through both writers is still a state `hashValue`
    // accepts, because neither ever wrote `undefined` into it.
    const base = board();
    const researching = {
      ...base,
      players: base.players.map((p) => withResearching(p, asTechId('pottery'))),
    };
    const cleared = {
      ...base,
      players: researching.players.map((p) => withoutResearching(p)),
    };
    expect(() => hashValue(researching)).not.toThrow();
    expect(() => hashValue(cleared)).not.toThrow();
    expect(hashValue(cleared)).toBe(hashValue(base));
  });
});

/* ------------------------------------------------------------------ *
 * The four typed answers
 * ------------------------------------------------------------------ */

describe('researchProblem — the one legality answer', () => {
  it('is undefined when the tech is real, unknown to the player and its prerequisites are met', () => {
    expect(researchProblem(RULESET, player(0), asTechId('pottery'))).toBeUndefined();
    // A root is researchable with an empty tech list; a second-tier tech needs its
    // prerequisite and nothing else.
    const knowsPottery = player(0, { techs: [asTechId('pottery')] });
    expect(researchProblem(RULESET, knowsPottery, asTechId('alphabet'))).toBeUndefined();
  });

  it('reports unknown-tech for an id this ruleset does not define, or cannot price', () => {
    expect(researchProblem(RULESET, player(0), asTechId('mithril'))).toEqual({
      kind: 'unknown-tech',
      tech: 'mithril',
    });
    const free: MessyRulesetView = { ...NO_TECH_RULESET, techs: [{ ...POTTERY, cost: 0 }] };
    expect(researchProblem(free, player(0), asTechId('pottery'))).toEqual({
      kind: 'unknown-tech',
      tech: 'pottery',
    });
  });

  it('reports already-known for a tech in the player’s list', () => {
    const knows = player(0, { techs: [asTechId('pottery')] });
    expect(researchProblem(RULESET, knows, asTechId('pottery'))).toEqual({
      kind: 'already-known',
      tech: 'pottery',
    });
  });

  it('reports the missing prerequisites, sorted, and only the direct ones', () => {
    // `writing` needs `alphabet` and `masonry`; a player who knows neither is told
    // about both, in canonical order, rather than about one of them.
    expect(researchProblem(RULESET, player(0), asTechId('writing'))).toEqual({
      kind: 'unmet-prerequisite',
      tech: 'writing',
      missing: ['alphabet', 'masonry'],
    });
    // Knowing `alphabet` (whose own prerequisite `pottery` is *not* known — a state
    // only a hand-built file can hold) still leaves `masonry` missing: the answer
    // lists direct prerequisites, and the transitive closure is implied by the fact
    // that a tech can only ever become known by completing its own prerequisites.
    const handEdited = player(0, { techs: [asTechId('alphabet')] });
    expect(researchProblem(RULESET, handEdited, asTechId('writing'))).toEqual({
      kind: 'unmet-prerequisite',
      tech: 'writing',
      missing: ['masonry'],
    });
  });

  it('names the missing prerequisites through the same helper the answer uses', () => {
    const missing = missingPrerequisites(player(0), WRITING);
    expect(missing.map(String)).toEqual(['alphabet', 'masonry']);
    expect(
      missingPrerequisites(
        player(0, { techs: [asTechId('alphabet'), asTechId('masonry')] }),
        WRITING,
      ),
    ).toEqual([]);
  });

  it('is a typed answer for every state, including ones the type forbids', () => {
    // A `researchProblem` that threw would be a rule no caller could branch on, and
    // `applyCommand` calls it inside the applier. Four hand-built states, four
    // answers, no exception.
    const states: readonly PlayerState[] = [
      withoutField(player(0), 'techs'),
      withWrongType(player(0), 'techs', 'nonsense'),
      withWrongType(player(0), 'beakers', Number.NaN),
      barbarians(2, { techs: [asTechId('pottery')] }),
    ];
    for (const each of states) {
      expect(() => researchProblem(RULESET, each, asTechId('pottery'))).not.toThrow();
      expect(() => researchProblem(RULESET, each, asTechId('mithril'))).not.toThrow();
    }
  });
});

describe('currentResearch — “what is this player researching?”', () => {
  it('answers nothing-being-researched when the key is absent', () => {
    const answer = currentResearch(board(), RULESET, asPlayerId(0));
    expect(isErr(answer)).toBe(true);
    if (isErr(answer)) expect(answer.error).toEqual({ kind: 'nothing-being-researched' });
  });

  it('answers with the row when a researchable tech is selected', () => {
    // "Researchable" includes the prerequisites: `masonry` needs `bronze-working`, so
    // the player is given it. With the requirement unmet the same query answers
    // `unmet-prerequisite` instead — which is the next-but-one test's subject.
    const state = board({
      players: [
        withResearching(player(0, { techs: [asTechId('bronze-working')] }), asTechId('masonry')),
        player(1),
      ],
    });
    const answer = currentResearch(state, RULESET, asPlayerId(0));
    expect(isOk(answer)).toBe(true);
    if (isOk(answer)) expect(answer.value).toBe(MASONRY);
  });

  it('answers unmet-prerequisite for a selection whose prerequisite is not known', () => {
    // A selection can be impossible for a reason other than "no such tech": here the
    // row is real and priced, and the player simply cannot have it yet.
    const state = board({
      players: [withResearching(player(0), asTechId('masonry')), player(1)],
    });
    const answer = currentResearch(state, RULESET, asPlayerId(0));
    expect(isErr(answer)).toBe(true);
    if (isErr(answer)) {
      expect(answer.error).toEqual({
        kind: 'unmet-prerequisite',
        tech: 'masonry',
        missing: ['bronze-working'],
      });
    }
  });

  it('answers unknown-tech for a selection this ruleset cannot price', () => {
    // The distinction the union exists for: a *selection* that no row describes is
    // not the same fact as "nothing selected", and reporting it as the latter would
    // quietly hide a save that names a tech the ruleset no longer ships.
    const state = board({ players: [withResearching(player(0), asTechId('mithril')), player(1)] });
    const answer = currentResearch(state, RULESET, asPlayerId(0));
    expect(isErr(answer)).toBe(true);
    if (isErr(answer)) expect(answer.error).toEqual({ kind: 'unknown-tech', tech: 'mithril' });
  });

  it('answers already-known for a selection the player already has', () => {
    const state = board({
      players: [
        withResearching(player(0, { techs: [asTechId('pottery')] }), asTechId('pottery')),
        player(1),
      ],
    });
    const answer = currentResearch(state, RULESET, asPlayerId(0));
    expect(isErr(answer)).toBe(true);
    if (isErr(answer)) expect(answer.error).toEqual({ kind: 'already-known', tech: 'pottery' });
  });

  it('answers nothing-being-researched for a player the state does not define', () => {
    // A player who does not exist is not researching anything. Inventing a fifth
    // answer ("no such player") for a *query* would give `GameError` a second home.
    const answer = currentResearch(board(), RULESET, asPlayerId(9));
    expect(isErr(answer)).toBe(true);
    if (isErr(answer)) expect(answer.error).toEqual({ kind: 'nothing-being-researched' });
  });
});

/* ------------------------------------------------------------------ *
 * One player’s research phase
 * ------------------------------------------------------------------ */

describe('researchStep — what one phase decided', () => {
  it('is nothing-being-researched when the player is researching nothing', () => {
    expect(researchStep(board(), RULESET, asPlayerId(0))).toEqual({
      kind: 'nothing-being-researched',
    });
    // Even with a pile of beakers: a pool nobody is spending stays a pool.
    const rich = board({ players: [player(0, { beakers: 999 }), player(1)] });
    expect(researchStep(rich, RULESET, asPlayerId(0))).toEqual({
      kind: 'nothing-being-researched',
    });
  });

  it('accumulates below the cost, reporting what is still needed', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 2 }), asTechId('pottery')), player(1)],
    });
    expect(researchStep(state, RULESET, asPlayerId(0))).toEqual({
      kind: 'accumulating',
      tech: 'pottery',
      cost: 5,
      beakers: 2,
      needed: 3,
    });
  });

  it('treats an empty pool as accumulating, not as a special case', () => {
    const state = board({ players: [withResearching(player(0), asTechId('pottery')), player(1)] });
    expect(researchStep(state, RULESET, asPlayerId(0))).toEqual({
      kind: 'accumulating',
      tech: 'pottery',
      cost: 5,
      beakers: 0,
      needed: 5,
    });
  });

  it('completes at exactly the cost, leaving nothing behind', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 5 }), asTechId('pottery')), player(1)],
    });
    expect(researchStep(state, RULESET, asPlayerId(0))).toEqual({
      kind: 'completed',
      tech: 'pottery',
      cost: 5,
      beakers: 0,
    });
  });

  it('completes above the cost, and `beakers` is what remains', () => {
    // The field means "left in the pool afterwards", never "the pool before the
    // payment": the carry-over rule is read off this number, so an ambiguous name
    // here would make the surplus untestable.
    const state = board({
      players: [withResearching(player(0, { beakers: 9 }), asTechId('pottery')), player(1)],
    });
    expect(researchStep(state, RULESET, asPlayerId(0))).toEqual({
      kind: 'completed',
      tech: 'pottery',
      cost: 5,
      beakers: 4,
    });
  });

  it('is stuck — never completed — when the selection cannot be researched', () => {
    // The invariant the contract asks to be asserted: completing a tech whose
    // prerequisites are not satisfied is impossible by construction, and it is made
    // impossible *structurally* here — the completion path is unreachable unless the
    // same readiness check `SetResearch` consults says "ready". A hand-built state
    // that names a locked tech is reported, not honoured.
    const locked = board({
      players: [withResearching(player(0, { beakers: 99 }), asTechId('writing')), player(1)],
    });
    expect(researchStep(locked, RULESET, asPlayerId(0))).toEqual({
      kind: 'stuck',
      tech: 'writing',
      problem: { kind: 'unmet-prerequisite', tech: 'writing', missing: ['alphabet', 'masonry'] },
    });

    const unknown = board({
      players: [withResearching(player(0, { beakers: 99 }), asTechId('mithril')), player(1)],
    });
    expect(researchStep(unknown, RULESET, asPlayerId(0))).toEqual({
      kind: 'stuck',
      tech: 'mithril',
      problem: { kind: 'unknown-tech', tech: 'mithril' },
    });

    const already = board({
      players: [
        withResearching(
          player(0, { beakers: 99, techs: [asTechId('pottery')] }),
          asTechId('pottery'),
        ),
        player(1),
      ],
    });
    expect(researchStep(already, RULESET, asPlayerId(0))).toEqual({
      kind: 'stuck',
      tech: 'pottery',
      problem: { kind: 'already-known', tech: 'pottery' },
    });
  });

  it('reads a pool it cannot use as 0 rather than as a negative or a fraction', () => {
    // The same totality discipline the movement refill applies to an unresolvable
    // unit type: a hand-built or half-corrupt state must not be able to make the turn
    // pipeline throw, and must not be able to buy a tech with `NaN` either.
    const nan = board({
      players: [
        withResearching(withWrongType(player(0), 'beakers', Number.NaN), asTechId('pottery')),
        player(1),
      ],
    });
    expect(researchStep(nan, RULESET, asPlayerId(0))).toEqual({
      kind: 'accumulating',
      tech: 'pottery',
      cost: 5,
      beakers: 0,
      needed: 5,
    });

    const missing = board({
      players: [
        withResearching(withoutField(player(0), 'beakers'), asTechId('pottery')),
        player(1),
      ],
    });
    expect(researchStep(missing, RULESET, asPlayerId(0))).toEqual({
      kind: 'accumulating',
      tech: 'pottery',
      cost: 5,
      beakers: 0,
      needed: 5,
    });
  });

  it('does not modify the state it is asked about', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 9 }), asTechId('pottery')), player(1)],
    });
    const before = hashValue(state);
    researchStep(state, RULESET, asPlayerId(0));
    expect(hashValue(state)).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * The research phase of a turn
 * ------------------------------------------------------------------ */

describe('applyResearch — the phase, over every civilization', () => {
  it('completes a tech and writes what the contract says it writes', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 9 }), asTechId('pottery')), player(1)],
    });

    const outcome = applyResearch(state, RULESET);

    const [player0] = outcome.state.players;
    expect(player0?.techs).toEqual([asTechId('pottery')]);
    // The cost was charged and the remainder **stays in the pool** — the carry-over
    // the contract requires, and the number the next `SetResearch` spends.
    expect(player0?.beakers).toBe(4);
    // `researching` is *removed*, not set to undefined: the player is researching
    // nothing until it chooses again.
    expect(player0 === undefined ? true : Object.hasOwn(player0, 'researching')).toBe(false);
    expect(eventTypes(outcome.events)).toEqual(['TechResearched']);
    expect(outcome.events[0]).toEqual({
      type: 'TechResearched',
      playerId: asPlayerId(0),
      tech: 'pottery',
      cost: 5,
      beakers: 4,
    });
  });

  it('banks a pool nobody is spending, and returns the very same state', () => {
    // Not merely equal — *the same object*. A phase that rebuilt the players array on
    // every turn for nothing would make "nothing happened" indistinguishable from a
    // change by reference, and would churn the state on every idle turn of every
    // game.
    const state = board({ players: [player(0, { beakers: 40 }), player(1)] });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.state).toBe(state);
    expect(outcome.events).toEqual([]);
    expect(outcome.state.players[0]?.beakers).toBe(40);
  });

  it('leaves an accumulating player alone, pool and all', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 2 }), asTechId('pottery')), player(1)],
    });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.events).toEqual([]);
    expect(outcome.state.players[0]?.beakers).toBe(2);
    expect(researchingOf(outcome.state.players[0] ?? player(0))).toBe('pottery');
  });

  it('completes at most one tech per player per turn, keeping the rest banked', () => {
    // The same rule production states for items, for the same reason: a hand-built
    // state with a thousand beakers must not complete half the tree in one step while
    // the state and the event list have to stay in step. The surplus is *not* thrown
    // away — it stays in the pool and can buy the next tech next turn.
    const state = board({
      players: [withResearching(player(0, { beakers: 1000 }), asTechId('pottery')), player(1)],
    });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.events.length).toBe(1);
    expect(outcome.state.players[0]?.techs).toEqual([asTechId('pottery')]);
    expect(outcome.state.players[0]?.beakers).toBe(995);
  });

  it('keeps the tech list sorted and unique, even from an unsorted starting state', () => {
    // A hand-built (or older) state can carry the list in any order, with repeats.
    // The completion path normalises through the same helper every reader uses, so
    // the state it writes is canonical whatever it was handed.
    const messy = player(0, {
      techs: [asTechId('masonry'), asTechId('alphabet'), asTechId('masonry')],
      beakers: 5,
    });
    const state = board({
      players: [withResearching(messy, asTechId('pottery')), player(1)],
    });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.state.players[0]?.techs).toEqual([
      asTechId('alphabet'),
      asTechId('masonry'),
      asTechId('pottery'),
    ]);
    // And it does not re-add a tech it already has: `pottery` was not in the list, so
    // it is appended once — the dedupe is what makes a double completion harmless.
    expect(knownTechs(outcome.state.players[0] ?? player(0)).length).toBe(3);
  });

  it('visits civilizations in player order, skipping barbarians', () => {
    // Barbarians have no economy, so nothing ever credits their pool (`economy.ts`
    // skips them for exactly that reason) and this phase mirrors the rule rather than
    // inventing a second one. Their selection is inert: not completed, not cleared.
    const state = board({
      players: [
        withResearching(player(0, { beakers: 5 }), asTechId('pottery')),
        withResearching(player(1, { beakers: 7 }), asTechId('bronze-working')),
        withResearching(barbarians(2, { beakers: 500 }), asTechId('writing')),
      ],
    });
    const outcome = applyResearch(state, RULESET);

    expect(
      outcome.events.map((event) => (event.type === 'TechResearched' ? event.tech : '')),
    ).toEqual(['pottery', 'bronze-working']);
    expect(outcome.state.players[0]?.techs).toEqual([asTechId('pottery')]);
    expect(outcome.state.players[1]?.techs).toEqual([asTechId('bronze-working')]);
    expect(outcome.state.players[2]?.techs).toEqual([]);
    expect(outcome.state.players[2]?.beakers).toBe(500);
    expect(researchingOf(outcome.state.players[2] ?? player(0))).toBe('writing');
  });

  it('does not complete a tech whose prerequisites are missing — it reports instead', () => {
    // The invariant, at the phase level: nothing is written, nothing is spent, and
    // the player is still selecting it — the engine does not edit a declaration to
    // repair a catalog. The player is not trapped either: `SetResearch` overwrites
    // the key for any tech that *is* researchable, without reading the old value.
    const state = board({
      players: [withResearching(player(0, { beakers: 100 }), asTechId('writing')), player(1)],
    });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.state).toBe(state);
    expect(outcome.events).toEqual([]);
    expect(outcome.state.players[0]?.beakers).toBe(100);
    expect(outcome.state.players[0]?.techs).toEqual([]);
  });

  it('leaves a selection the ruleset cannot price untouched, pool and all', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 100 }), asTechId('mithril')), player(1)],
    });
    const outcome = applyResearch(state, RULESET);

    expect(outcome.state).toBe(state);
    expect(outcome.events).toEqual([]);
    expect(researchingOf(outcome.state.players[0] ?? player(0))).toBe('mithril');
  });

  it('is pure, deterministic and does not touch the RNG', () => {
    const state = board({
      players: [
        withResearching(player(0, { beakers: 9 }), asTechId('pottery')),
        withResearching(player(1, { beakers: 6 }), asTechId('bronze-working')),
      ],
    });
    const before = hashValue(state);

    const first = applyResearch(state, RULESET);
    const second = applyResearch(state, RULESET);

    expect(hashValue(state)).toBe(before);
    expect(first.events).toEqual(second.events);
    expect(hashValue(first.state)).toBe(hashValue(second.state));
    // Research is not a random event: the same state and the same ruleset decide it
    // entirely (PLAN.md §5.3).
    expect(first.state.rng).toEqual(state.rng);
  });

  it('charges the sum of the costs through a whole played sequence', () => {
    // The beaker conservation identity, over several turns: every completion charges
    // exactly its row's cost and nothing else appears or disappears. The bank is
    // topped up between turns here because this test is about the *rule* — the
    // economy that fills the pool is `economy.test.ts`' subject.
    let state = board({ players: [player(0, { beakers: 0 }), player(1)] });
    const charged: number[] = [];
    const completed: string[] = [];

    for (let turn = 0; turn < TECHS.length; turn += 1) {
      const ready = TECHS.find(
        (tech) => researchProblem(RULESET, state.players[0] ?? player(0), tech.id) === undefined,
      );
      expect(ready, 'the tree ran out of researchable techs before it was exhausted').toBeDefined();
      if (ready === undefined) break;

      state = {
        ...state,
        players: state.players.map((p) =>
          p.id === asPlayerId(0) ? withResearching({ ...p, beakers: 20 }, ready.id) : p,
        ),
      };
      const outcome = applyResearch(state, RULESET);
      state = outcome.state;
      for (const event of outcome.events) {
        if (event.type === 'TechResearched') {
          charged.push(event.cost);
          completed.push(String(event.tech));
          // The carry-over identity, per event: banked minus cost is what the state
          // holds afterwards, and the event reports the same number.
          expect(event.beakers).toBe(20 - event.cost);
        }
      }
    }

    // Every tech of the tree was completed, exactly once, one per turn — which is
    // both the reachability proof (a player who always researches something
    // available ends up knowing the whole tree) and the at-most-one-per-turn rule.
    expect([...completed].sort()).toEqual(TECH_LIST.map(([id]) => id).sort());
    expect(new Set(completed).size).toBe(TECHS.length);
    // The order is *catalog* order among the techs that are available at each step,
    // not ascending cost: after `pottery` and `bronze-working` the fixture's catalog
    // offers `masonry` (third row, 9 beakers) before `alphabet` (fifth row, 7), and
    // `writing` — second row — stays blocked until both of its prerequisites are in.
    // A helper that had quietly sorted by cost would produce [5, 6, 7, 9, 11].
    expect(charged).toEqual([5, 6, 9, 7, 11]);
    expect(completed).toEqual(['pottery', 'bronze-working', 'masonry', 'alphabet', 'writing']);
    expect(knownTechs(state.players[0] ?? player(0)).length).toBe(TECHS.length);
  });
});

/* ------------------------------------------------------------------ *
 * Gating — the read half
 * ------------------------------------------------------------------ */

describe('the tech requirement reads', () => {
  it('pins the four catalogs a requiresTech may appear in, in report order', () => {
    expect([...TECH_UNLOCK_KINDS]).toEqual(['unit', 'building', 'improvement', 'resource']);
  });

  it('reads requiresTech totally: absent means no requirement', () => {
    expect(requiresTechOf(WARRIOR)).toBeUndefined();
    expect(requiresTechOf({ requiresTech: 'pottery' })).toBe('pottery');
    // A requirement this engine cannot *name* is not a requirement it can check, and
    // the alternative — treating garbage as a gate nothing satisfies — would hide
    // content behind a typo.
    expect(requiresTechOf({ requiresTech: 7 })).toBeUndefined();
    expect(requiresTechOf(null)).toBeUndefined();
    expect(requiresTechOf('pottery')).toBeUndefined();
    expect(requiresTechOf(undefined)).toBeUndefined();
  });

  it('answers the gate: the tech this player still needs, or nothing', () => {
    // This is the one implementation of "is this tech requirement satisfied?", i.e.
    // the predicate the contract says must be enforced where production and build
    // legality are decided, so that the generator and the applier cannot disagree.
    const knows = player(0, { techs: [asTechId('pottery')] });
    expect(unmetTechRequirement(knows, undefined)).toBeUndefined();
    expect(unmetTechRequirement(knows, asTechId('pottery'))).toBeUndefined();
    expect(unmetTechRequirement(knows, asTechId('masonry'))).toBe('masonry');
    expect(unmetTechRequirement(player(0), asTechId('pottery'))).toBe('pottery');
  });

  it('derives what a tech unlocks from the catalogs, in a stated order', () => {
    // Rows that declare a requirement, in all four catalogs. They are built here
    // because no shipped row declares one yet (see the `CATALOG.techs` note in
    // `@civts/rules`): the engine must be ready for the day content does, so the
    // reader is tested rather than merely present.
    //
    // Each gated row is a *complete* row of its catalog plus the field under test —
    // an intersection type, not an object with extra keys, so nothing here needs a
    // cast and each row would still be accepted by `validateRuleset` if it declared
    // the field.
    const gates = <T extends { readonly id: string }>(
      row: T,
      requiresTech: string,
    ): T & {
      readonly requiresTech: string;
    } => ({ ...row, requiresTech });
    const gatedRows = <T extends { readonly id: string }>(
      rows: readonly T[],
      requiresTech: string,
    ): readonly (T & { readonly requiresTech: string })[] =>
      rows.map((row) => gates(row, requiresTech));

    const LEGION: UnitDef = { ...WARRIOR, id: asUnitTypeId('legion'), name: 'Legion' };
    const ARCHER: UnitDef = { ...WARRIOR, id: asUnitTypeId('archer'), name: 'Archer' };
    const WALLS: BuildingDef = {
      id: asBuildingId('walls'),
      name: 'Walls',
      cost: 20,
      maintenance: 1,
      effects: [],
    };
    const QUARRY: ImprovementDef = {
      id: asImprovementId('quarry'),
      kind: 'mine',
      name: 'Quarry',
      turns: 4,
      yields: { food: 0, shields: 1, commerce: 0 },
      allowedRoles: ['grassland'],
    };
    const MINE: ImprovementDef = { ...QUARRY, id: asImprovementId('mine'), kind: 'mine' };
    const IRON: ResourceDef = {
      id: asResourceId('iron'),
      name: 'Iron',
      kind: 'bonus',
      yields: { food: 0, shields: 1, commerce: 0 },
      allowedRoles: ['grassland'],
    };

    const gated: RulesetView = {
      ...NO_TECH_RULESET,
      units: [...gatedRows([LEGION, ARCHER], 'masonry'), WARRIOR],
      buildings: gatedRows([WALLS], 'masonry'),
      improvements: gatedRows([QUARRY, MINE], 'masonry'),
      resources: gatedRows([IRON], 'bronze-working'),
    };

    // The stated order: units, buildings, improvements, resources — catalog order
    // within each, so two runs over the same ruleset report identically and a
    // printer or a test needs no sort of its own.
    expect(techUnlocks(gated, asTechId('masonry'))).toEqual([
      { kind: 'unit', id: 'legion' },
      { kind: 'unit', id: 'archer' },
      { kind: 'building', id: 'walls' },
      { kind: 'improvement', id: 'quarry' },
      { kind: 'improvement', id: 'mine' },
    ]);
    expect(techUnlocks(gated, asTechId('bronze-working'))).toEqual([
      { kind: 'resource', id: 'iron' },
    ]);
    // A tech nothing requires unlocks nothing — and an *unknown* tech reports the same
    // honest nothing rather than everything, or an error.
    expect(techUnlocks(gated, asTechId('pottery'))).toEqual([]);
    expect(techUnlocks(gated, asTechId('mithril'))).toEqual([]);
    // An ungated row is not reported as unlocked by anything: `WARRIOR` is in the
    // same catalog and declares nothing.
    for (const tech of TECHS) {
      expect(techUnlocks(gated, tech.id).some((unlock) => unlock.id === 'warrior')).toBe(false);
    }
  });

  it('reports nothing for the shipped tree, because no shipped row declares a requirement', () => {
    // Stated as a fact about content, not as a defect in the reader: `rules.ts` says
    // in the `CATALOG.techs` note that gating is not wired in this row set, and a
    // tree whose names *implied* gates the engine does not enforce would be the worse
    // half-truth. When a row does declare one, the tests above and below already
    // cover the reader.
    for (const tech of TECHS) {
      expect(techUnlocks(RULESET, tech.id)).toEqual([]);
    }
    // And the reads work over an id no row defines, and over a ruleset with no tree.
    expect(techUnlocks(RULESET, asTechId('mithril'))).toEqual([]);
    expect(techUnlocks(NO_TECH_RULESET, asTechId('pottery'))).toEqual([]);
  });

  it('ignores a row with no usable id instead of reporting a nameless unlock', () => {
    // An unlock list is a list of things a UI can *name*. The second row is the shape
    // `techUnlocks` cannot report — a requirement with no row id — built raw here
    // because a `UnitDef` always has one; the first row is a real gated row, and its
    // presence is what makes the assertion about the second rather than about an empty
    // catalog.
    const gatedWarrior: UnitDef & { readonly requiresTech: string } = {
      ...WARRIOR,
      requiresTech: 'pottery',
    };
    const nameless: unknown = { requiresTech: 'pottery' };
    const broken: RulesetView = {
      ...NO_TECH_RULESET,
      units: [gatedWarrior, nameless as UnitDef],
    };
    expect(techUnlocks(broken, asTechId('pottery'))).toEqual([{ kind: 'unit', id: 'warrior' }]);
  });
});

/* ------------------------------------------------------------------ *
 * In the pipeline
 * ------------------------------------------------------------------ */

describe('research in the turn pipeline', () => {
  it('moves a tech from “researching” to “known” when a turn ends', () => {
    // One integration check, so this file's rule is not merely correct in isolation:
    // `advanceTurn` spends the pool a player already had. The *order* — production,
    // then research, then the money loop — is `turn.test.ts`' subject.
    const state = board({
      players: [withResearching(player(0, { beakers: 5 }), asTechId('pottery')), player(1)],
    });

    const outcome = advanceTurn(state, RULESET);

    expect(outcome.state.players[0]?.techs).toEqual([asTechId('pottery')]);
    expect(eventTypes(outcome.events)).toContain('TechResearched');
    // The completion is the world's event, reported in pipeline order — before the
    // money loop's lines and after production's.
    const types = eventTypes(outcome.events);
    expect(types.indexOf('TechResearched')).toBeLessThan(types.indexOf('IncomeCollected'));
  });

  it('does not credit the pool itself: a banked tech completes from banked beakers only', () => {
    // The pipeline-delay reading, visible from here: a civilization with a city that
    // earns beakers does not spend *this* turn's science on *this* turn's choice. The
    // proof that it is spent next turn is `turn.test.ts`' job; what this asserts is
    // that research adds nothing of its own to the pool.
    const rich = board({
      players: [withResearching(player(0, { beakers: 4 }), asTechId('pottery')), player(1)],
    });
    const outcome = advanceTurn(rich, RULESET);
    // 4 banked beakers cannot cover a 5-beaker tech, and no city exists to earn one:
    // the tech stays selected and the pool is exactly as it was.
    expect(outcome.state.players[0]?.techs).toEqual([]);
    expect(outcome.state.players[0]?.beakers).toBe(4);
    expect(researchingOf(outcome.state.players[0] ?? player(0))).toBe('pottery');
  });

  it('is deterministic across a whole turn, and hashable throughout', () => {
    const state = board({
      players: [withResearching(player(0, { beakers: 9 }), asTechId('pottery')), player(1)],
    });
    const first = advanceTurn(state, RULESET);
    const second = advanceTurn(state, RULESET);

    expect(hashValue(first.state)).toBe(hashValue(second.state));
    expect(first.events).toEqual(second.events);
    expect(() => hashValue(first.state)).not.toThrow();
  });
});
