/**
 * `describe` tests (INTERFACES.md W3, plus M2's fog half).
 *
 * The text view is the agent's primary way of seeing the game, so these tests
 * pin the *picture* (an inline snapshot of a 4x4 glyph grid), the properties
 * that make it trustworthy (stable across calls, no trailing whitespace), the
 * viewport maths (crop + clamp), and — M2 — what a *viewer* may and may not see:
 * a viewer renders only explored tiles, and nothing about an unexplored tile
 * reaches the screen, not even through the legend or the `starts:` line.
 *
 * **Migrated to the M3 state shape** (docs/INTERFACES.md M3). The hand-built
 * fixtures here carry the new required fields: `kind: 'civ'` on a player (these
 * synthetic boards hold civilizations only — the barbarian player `newGame`
 * appends is covered by the generated-state cases), `huts` on a map, and
 * `nextCityId`/`cities` on the state. None of them is read by `describe`, and
 * that is the point of stating them explicitly: a fixture that omitted them
 * would only typecheck through a cast, and a cast would hide the next shape
 * change instead of failing on it.
 *
 * **M3 rulings pinned here.** `starts:` and the digits on the map are for
 * *civilizations only*: the barbarians are a player with no homeland, whose
 * `startingTile` is a hut, so presenting it as a start would tell the reader
 * something false (see the ruling test at the bottom). And a goody hut is drawn
 * as `%` with a legend entry, under the same fog rule as everything else: a hut
 * on a tile the viewer has not explored is not revealed, not even in the legend.
 *
 * **M4a.** A unit in the middle of a job is named on a `work:` line of its own —
 * what it is doing and how many turns are left — because the picture has no way to
 * draw a *unit*, let alone its job. The line follows the same fog rule (`describe`
 * with a `viewer`), and it is absent when nothing is being worked.
 *
 * **M4b.** `PlayerState` gained `treasury`/`rates`/`beakers`/`luxuries`, and the
 * viewer's gold joins the header as a `gold=` field beside `viewer=` — money is a
 * fact about a player, so it belongs with the one field that already names the
 * player the picture is drawn for. It is asserted to be *totally* read (a viewer no
 * player carries prints no gold, and an uncountable treasury prints 0, never
 * `NaN`), and god mode's header is asserted to gain nothing at all.
 *
 * **M5 — and the M4b sentence is now half wrong, deliberately recorded rather than
 * quietly edited.** M4b said beakers and luxuries were kept out of the header
 * because "they do nothing until M5 and M9". Beakers buy tech as of M5, so the pool
 * and the tech it is banked toward are not inert, and the header carries a second
 * viewer field — `research=<id> <banked>/<cost>`, or `research=idle banked=<n>`. This
 * file's fixtures therefore gained a `techs` row set on the ruleset and `techs: []` on
 * every player literal, and the field is asserted *totally* the same way gold is: a
 * viewer no player carries prints neither field, an uncountable pool prints 0, and a
 * selected tech this ruleset cannot price says so rather than printing a fraction.
 * **Luxuries stay out**, and that half of the M4b sentence is still exactly true:
 * they do nothing until M9, and a header number is a claim that it means something.
 *
 * **M4c.** `GameMap` gained `resources`, so the hand-built maps below carry
 * `resources: []` — a migration, not a relaxation: the field is required, and a
 * fixture that omitted it would only typecheck through a cast. A resource is drawn
 * as `$` with a legend entry naming every resource actually drawn, under **exactly
 * the hut's fog rule**: a resource on a tile the viewer has not explored is not
 * revealed — no glyph, no legend entry, and the whole view is byte-identical to the
 * same board with that resource removed. The legend entry is conditional in the
 * same way, which is why a resource-free map renders exactly as it did before this
 * wave. Every resource id in these fixtures is a stand-in for a catalog row; none
 * of them is presented as Civ 3 content.
 */

import { describe, expect, it } from 'vitest';
import {
  asGovernmentId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTerrainId,
  asTileIndex,
  asUnitId,
  asUnitTypeId,
} from '../src/ids.js';
import { asImprovementId, type ImprovementDef } from '../src/improvements.js';
import {
  compareTileResources,
  type RulesetView,
  type TerrainDef,
  type TerrainRole,
} from '../src/map.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.js';
// M5: the *type* of a tech row, so the fixture's `techs` list below is checked
// against the same shape `tech.ts` reads structurally.
import type { TechDef } from '../src/tech.js';
import {
  civPlayers,
  newGame,
  SCHEMA_VERSION,
  type GameState,
  type PlayerState,
} from '../src/state.js';

import { describe as describeState, workSummary } from '../src/textview.js';
import { withWork, type Unit, type UnitDef, type UnitWork } from '../src/units.js';

const ROLES: readonly TerrainRole[] = [
  'ocean',
  'coast',
  'grassland',
  'plains',
  'hills',
  'mountains',
];

const TERRAINS: readonly TerrainDef[] = ROLES.map((role) => ({
  id: asTerrainId(role),
  role,
  name: role,
  moveCost: 1,
  defenseBonusPct: 0,
  yields: { food: 1, shields: 0, commerce: 0 },
  impassable: role === 'ocean' || role === 'mountains',
}));

/**
 * A settler: `newGame` places one of these per player, so a ruleset without one
 * cannot start a game (M2 `missing-unit-role`). Terrain is all `describe` reads
 * for its picture; the catalog exists so the generated-map tests below can call
 * `newGame` at all.
 */
const SETTLER: UnitDef = {
  id: asUnitTypeId('settler'),
  role: 'settler',
  name: 'Settler',
  attack: 0,
  defense: 0,
  movement: 2,
  cost: 1,
  domain: 'land',
};

/**
 * A worker (M4a). `describe` reads it only to *name* the unit on the `work:` line,
 * so its stats are arbitrary — but it has to be in the catalog for the line to say
 * `Worker` rather than the raw type id.
 */
const WORKER: UnitDef = {
  id: asUnitTypeId('worker'),
  role: 'worker',
  name: 'Worker',
  attack: 0,
  defense: 0,
  movement: 1,
  cost: 2,
  domain: 'land',
};

/**
 * The improvement rows the `work:` line's activity word comes from (M4a): the
 * *kind* is the engine's vocabulary, so the row is what tells the renderer that a
 * job on `mine` is "mining". All placeholder content, as every rules row is —
 * these numbers are never read by `describe`.
 */
const IMPROVEMENTS: readonly ImprovementDef[] = [
  {
    id: asImprovementId('mine'),
    kind: 'mine',
    name: 'Mine',
    turns: 3,
    yields: { food: 0, shields: 1, commerce: 0 },
    allowedRoles: ['hills', 'mountains'],
  },
  {
    id: asImprovementId('road'),
    kind: 'road',
    name: 'Road',
    turns: 2,
    yields: { food: 0, shields: 0, commerce: 1 },
    allowedRoles: ['grassland', 'plains', 'hills', 'mountains'],
  },
];

/**
 * M5: the two tech rows the header's `research=` field is asserted against.
 *
 * Placeholder content, like every number in this file: `pottery` is a root and
 * `alphabet` requires it, which is all the header needs (an id it can price and an
 * id it cannot).
 */
const POTTERY: TechDef = {
  id: asTechId('pottery'),
  name: 'Pottery',
  era: 'ancient',
  cost: 5,
  requires: [],
};

const ALPHABET: TechDef = {
  id: asTechId('alphabet'),
  name: 'Alphabet',
  era: 'ancient',
  cost: 7,
  requires: [asTechId('pottery')],
};

/**
 * The ruleset as the engine sees it in M2: terrain *and* a unit catalog — plus, since
 * M5, the tech rows.
 *
 * `RulesetView` deliberately does **not** declare `techs` (`tech.ts` reads the field
 * structurally, so a view written before M5 is still a view the engine can run a game
 * from), and `renderField` therefore has to name the field on the intersection: that
 * is how a hand-built view states "this ruleset ships a tree", and a cast would hide
 * the next shape change instead of failing on it.
 */
const RULESET: RulesetView & { readonly techs: readonly TechDef[] } = {
  terrains: TERRAINS,
  units: [SETTLER, WORKER],
  improvements: IMPROVEMENTS,
  fidelity: 'tuned',
  techs: [POTTERY, ALPHABET],
};

/**
 * The same terrains with an empty unit catalog. `RulesetView.units` is required
 * since M2's amendment, so "no units" is an empty catalog rather than a missing
 * field — and `describe` still draws the same picture, because it reads terrain
 * from the view and fog from the state.
 */
const NO_UNITS: RulesetView = {
  terrains: TERRAINS,
  units: [],
  improvements: [],
  fidelity: 'tuned',
};

/**
 * The same view with the worker row given M6's `hitPoints: 3`.
 *
 * `UnitDef.hitPoints` is optional **on the view** — a ruleset written before M6 is
 * still one the engine can run a game from, and `textview` is handed whatever the
 * caller has — so the tests below exercise both shapes: the pre-M6 row (no declared
 * maximum, where the honest maximum is the unit's own count, `1/1`) and this one
 * (a declared maximum of 3, where a wounded unit renders `1/3`). A variant rather
 * than a second catalog, so nothing else in this file moves.
 */
const HIT_POINT_RULESET: RulesetView = {
  ...RULESET,
  units: [SETTLER, { ...WORKER, hitPoints: 3 }],
};

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, mapSize: 'duel', civCount: 2 };

/** Terrain grid of the synthetic 4x4 map, in reading order. */
const GRID_4x4: readonly TerrainRole[] = [
  'ocean',
  'ocean',
  'coast',
  'coast',
  'ocean',
  'grassland',
  'grassland',
  'plains',
  'coast',
  'grassland',
  'hills',
  'mountains',
  'plains',
  'plains',
  'hills',
  'mountains',
];

/**
 * A civilization player. M3 gave `PlayerState` a `kind`, and these synthetic
 * boards are all civilizations: the barbarian player `newGame` appends (M3,
 * "State shape") is a deliberate omission here, because these tests are about a
 * *picture* and a barbarian would only add a start marker nobody asked for. The
 * generated-game cases at the bottom cover the real player list.
 *
 * M4b gave `PlayerState` its four money fields. The treasury is the same number
 * for every player this factory builds, because the viewer tests below compare two
 * rendered views byte for byte while swapping which player sits where, and a
 * per-index treasury would break those comparisons for a reason that has nothing
 * to do with what the picture shows. `GOLD` is what the header's `gold=` field is
 * asserted against.
 */
const GOLD = 7;

/**
 * M5: `techs: []` — an empty *list*, not a missing key, because `PlayerState.techs`
 * arrived in schema version 7 as a required field and "knows nothing" is what every
 * fixture here means. `researching` is left out entirely: absence is what "researching
 * nothing" means, and a key holding `undefined` could not survive a JSON round trip
 * (`tech.ts` states the rule where it writes the field).
 */
const player = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: `Player ${String(index + 1)}`,
  color: index === 0 ? '#d12f2f' : '#2f6fd1',
  startingTile: asTileIndex(tile),
  kind: 'civ',
  // M9: a player carries a government. `defaultGovernmentOf` picks the first row of
  // the ruleset's `governments` section, which is `despotism` in the shipped catalog;
  // this literal is a hand-built state, so it states the id rather than deriving it.
  government: asGovernmentId('despotism'),
  techs: [],
  // M4b: `RATE_TOTAL` is 10, so 7/3/0 is a legal split (any other sum is refused by
  // the command layer) and an arbitrary one — `describe` reads the treasury alone,
  // and nothing here is presented as a sourced rate.
  treasury: GOLD,
  rates: { tax: 7, science: 3, luxury: 0 },
  beakers: 0,
  luxuries: 0,
});

/** One settler per player, on its own start tile — what `newGame` places. */
const startingUnits = (players: readonly PlayerState[]): readonly Unit[] =>
  players.map((owner, index) => ({
    id: asUnitId(index),
    type: SETTLER.id,
    owner: owner.id,
    tile: owner.startingTile,
    movementLeft: SETTLER.movement,
  }));

/** A map-sized fog row (16 tiles: this file's synthetic board is 4x4). */
const fogRow = (seen: readonly number[]): readonly boolean[] =>
  Array.from({ length: 16 }, (_, tile) => seen.includes(tile));

/**
 * A full `GameState` — including the M2 `nextUnitId`/`units`/`explored` fields
 * and M3's `nextCityId`/`cities`, because a partial literal would only typecheck
 * through a cast. The default fog row is blank: no player has explored anything
 * until a test says so, which makes the viewer tests state their fog explicitly
 * instead of inheriting it. M3's map carries `huts`; this board has none, so its
 * picture is terrain, starts and fog, and the hut tests below put one on the map
 * where they want it.
 */
const syntheticState = (
  players: readonly PlayerState[],
  explored?: readonly (readonly boolean[])[],
): GameState => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  turn: 1,
  seed: 7,
  settings: SETTINGS,
  rng: { a: 1, b: 2, c: 3, d: 4 },
  map: {
    width: 4,
    height: 4,
    terrain: GRID_4x4.map((role) => asTerrainId(role)),
    huts: [],
    resources: [],
  },
  players,
  nextUnitId: players.length,
  units: startingUnits(players),
  explored: explored ?? players.map(() => fogRow([])),
  nextCityId: 0,
  // M9: the materialised ownership layer. `[]` is the honest value for a
  // state nobody has run a turn on: `withOwnership` fills it from the cities the
  // moment ownership matters, and `computeTileOwner` never reads it, so an empty
  // layer cannot make a border wrong — it only means none has been claimed yet.
  tileOwner: [],
  cities: [],
  // M4a: nothing is built at setup, and the key is an *empty array* rather than
  // absent — it is part of every state hash, and `canonicalize` refuses
  // `undefined`. None of `describe`'s picture reads it; the work *line* reads the
  // jobs on the units instead, which is where the state says what is being built.
  improvements: [],
});

const STATE_4x4: GameState = syntheticState([player(0, 5), player(1, 10)]);

/**
 * `state` with goody huts on the map (M3: `GameMap.huts`, ascending tile index).
 * The glyph they are drawn as, `%`, is pinned in the tests below rather than
 * imported: it is part of the picture a reader sees, not an internal detail.
 */
const withHuts = (state: GameState, huts: readonly number[]): GameState => ({
  ...state,
  map: { ...state.map, huts: huts.map((tile) => asTileIndex(tile)) },
});

/**
 * `state` with resources on the map (M4c: `GameMap.resources`, the sparse
 * `(tile, resource)` list `map.ts` keeps sorted by `(tile, resource)`).
 *
 * The pairs are written in whatever order a test finds readable and **sorted with
 * the engine's own `compareTileResources`**: the order is part of the map's shape, so
 * a fixture that relied on an order of its own would be testing a state no builder
 * can produce, and a second copy of the comparison here would be a second statement
 * of a rule `map.ts` already states. The glyph they are drawn as, `$`, is pinned in
 * the tests below rather than imported — like `%` for a hut, it is part of the
 * picture a reader sees.
 */
const withResources = (
  state: GameState,
  pairs: readonly (readonly [number, string])[],
): GameState => ({
  ...state,
  map: {
    ...state.map,
    resources: pairs
      .map(([tile, resource]) => ({ tile: asTileIndex(tile), resource: asResourceId(resource) }))
      .sort(compareTileResources),
  },
});

/**
 * The barbarian player M3 appends to `players` (`newGame` does it after the
 * civilizations): a player *identity* whose `startingTile` is a convention
 * pointing at a hut, not a homeland. Its id is the next player index, which is
 * exactly the digit it must **not** be painted as — see the ruling test at the
 * bottom of this file.
 *
 * M4b: barbarians carry the money fields too, inert. `newGame` gives them the same
 * numbers a civilization starts with (`state.ts`: one shape for every player, so
 * `PlayerId` stays an index into `players`), and the field is required, so a
 * fixture that omitted it would only typecheck through a cast — which would hide
 * the next shape change instead of failing on it.
 */
const barbarianPlayer = (index: number, tile: number): PlayerState => ({
  id: asPlayerId(index),
  name: 'Barbarians',
  color: '#3f3f46',
  startingTile: asTileIndex(tile),
  kind: 'barbarian',
  techs: [],
  government: asGovernmentId('despotism'),
  treasury: GOLD,
  rates: { tax: 7, science: 3, luxury: 0 },
  beakers: 0,
  luxuries: 0,
});

/** The glyph columns of every grid row, without the row-number gutter. */
const glyphRows = (view: string): readonly string[] =>
  view
    .split('\n')
    .filter((line) => /^ *\d+ \|/.test(line))
    .map((line) => line.slice(line.indexOf('|') + 1));

/** How many goody huts a rendered grid draws, counted as the picture shows them. */
const hutGlyphs = (grid: string): number => grid.split('%').length - 1;

/** How many resource glyphs a rendered grid draws, counted as the picture shows them. */
const resourceGlyphs = (grid: string): number => grid.split('$').length - 1;

/** The legend line of a rendered view, as a reader sees it. */
const legendOf = (view: string): string =>
  view.split('\n').find((line) => line.startsWith('legend: ')) ?? '';

/**
 * The players the `starts:` line names, as `marker=Name@x,y` entries — read off
 * the rendered line rather than from the state, so a test can assert what a
 * reader is told. The `(+N unexplored)` note carries no `=` and is filtered out.
 */
const namedStarts = (view: string): readonly string[] =>
  (view.split('\n').find((line) => line.startsWith('starts: ')) ?? '')
    .slice('starts: '.length)
    .split('  ')
    .filter((entry) => entry.includes('='));

/** A ruleset built from any terrain list, for the malformed-input cases. */
const withTerrains = (terrains: readonly TerrainDef[]): RulesetView => ({
  terrains,
  units: [],
  improvements: [],
  fidelity: 'tuned',
});

describe('describe', () => {
  it('renders a small synthetic state exactly', () => {
    expect(describeState(STATE_4x4, RULESET)).toMatchInlineSnapshot(`
      "CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2
      view: x 0..3, y 0..3 (4x4 of 4x4)
        |0
        |0123
      0 |~~::
      1 |~0,-
      2 |:,1^
      3 |--h^
      legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains
      starts: 0=Player 1@1,1  1=Player 2@2,2
      "
    `);
  });

  it('is stable across repeated calls, with and without options', () => {
    const options = { viewport: { x: 1, y: 1, width: 2, height: 2 } };
    const first = describeState(STATE_4x4, RULESET, options);

    expect(describeState(STATE_4x4, RULESET, options)).toBe(first);
    expect(describeState(STATE_4x4, RULESET)).toBe(describeState(STATE_4x4, RULESET));
    expect(describeState(STATE_4x4, RULESET, { showStarts: false })).toBe(
      describeState(STATE_4x4, RULESET, { showStarts: false }),
    );
  });

  it('heads the view with seed, turn, map size and civ count', () => {
    const lines = describeState(STATE_4x4, RULESET).split('\n');

    expect(lines[0]).toContain('seed=7');
    expect(lines[0]).toContain('turn=1');
    expect(lines[0]).toContain('revision=0');
    expect(lines[0]).toContain('map=duel(4x4)');
    expect(lines[0]).toContain('civs=2');
    expect(lines[1]).toContain('view: x 0..3, y 0..3 (4x4 of 4x4)');
  });

  it('renders one glyph per terrain role with a legend', () => {
    const view = describeState(STATE_4x4, RULESET, { showStarts: false });

    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':,h^', '--h^']);
    expect(view).toContain('legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains');
  });

  it('numeral-rules the columns and numbers the rows', () => {
    const view = describeState(STATE_4x4, RULESET).split('\n');

    expect(view[2]).toBe('  |0');
    expect(view[3]).toBe('  |0123');
    expect(view[4]).toBe('0 |~~::');
    expect(view[7]).toBe('3 |--h^');
  });

  it('marks starting tiles with the player number and explains them', () => {
    const view = describeState(STATE_4x4, RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(view).toContain('starts: 0=Player 1@1,1  1=Player 2@2,2');
  });

  it('hides markers and the start legend when showStarts is false', () => {
    const view = describeState(STATE_4x4, RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view).join('')).toBe('~~::~,,-:,h^--h^');
  });

  it('uses * for players past the digit range', () => {
    const many = Array.from({ length: 11 }, (_, index) => player(index, index));
    const state: GameState = {
      ...syntheticState(many),
      map: {
        width: 11,
        height: 1,
        terrain: many.map(() => asTerrainId('grassland')),
        huts: [],
        resources: [],
      },
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual(['0123456789*']);
    expect(view).toContain('*=Player 11@10,0');
  });

  it('marks tiles whose terrain id is not in the ruleset', () => {
    const state: GameState = {
      ...STATE_4x4,
      map: {
        width: 2,
        height: 1,
        terrain: [asTerrainId('grassland'), asTerrainId('volcano')],
        huts: [],
        resources: [],
      },
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual([',?']);
    expect(view).toContain('? unknown');
  });

  it('crops to the requested viewport', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 1, y: 1, width: 2, height: 2 },
    });

    expect(glyphRows(view)).toEqual(['0,', ',1']);
    expect(view).toContain('view: x 1..2, y 1..2 (2x2 of 4x4)');
    expect(view).toContain('starts: 0=Player 1@1,1  1=Player 2@2,2');
  });

  it('clamps a viewport that starts before the map', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: -5, y: -5, width: 99, height: 99 },
    });

    expect(view).toBe(describeState(STATE_4x4, RULESET));
  });

  it('clamps a viewport that starts past the map and flags off-view starts', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 3, y: 3, width: 99, height: 99 },
    });

    expect(view).toContain('view: x 3..3, y 3..3 (1x1 of 4x4)');
    expect(glyphRows(view)).toEqual(['^']);
    expect(view).toContain('0=Player 1@1,1 (off-view)');
    expect(view).toContain('1=Player 2@2,2 (off-view)');
  });

  it('renders an empty grid for a zero-sized viewport', () => {
    const view = describeState(STATE_4x4, RULESET, {
      viewport: { x: 1, y: 1, width: 0, height: 0 },
    });

    expect(view).toContain('view: empty (map 4x4)');
    expect(glyphRows(view)).toEqual([]);
  });

  it('emits no trailing whitespace and ends with a newline', () => {
    const state = newGame(4242, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');
    const view = describeState(state.value, RULESET, {
      viewport: { x: 7, y: 11, width: 23, height: 9 },
    });

    expect(view.endsWith('\n')).toBe(true);
    for (const line of view.split('\n')) expect(line).toBe(line.replace(/[ \t]+$/, ''));
    expect(glyphRows(view)).toHaveLength(9);
  });

  it('renders a full generated map, one glyph per tile', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');

    const first = describeState(state.value, RULESET);
    const rows = glyphRows(first);

    expect(describeState(state.value, RULESET)).toBe(first);
    expect(rows).toHaveLength(state.value.map.height);
    for (const row of rows) expect(row).toHaveLength(state.value.map.width);
    // CIVILIZATIONS ONLY — the ruling on starts. `starts:` is the legend for the
    // digits painted on the map, and both are for civilizations: barbarians are a
    // player (M3, "State shape") but have no homeland, so `newGame` points their
    // `startingTile` at the map's first hut as a field convention. Naming that
    // here as a start would tell the reader that a civilization begins where a
    // barbarian band will come from — and would hide the hut behind a digit.
    // `civPlayers`, never `players`, exactly like the header's `civs=` count.
    for (const player_ of civPlayers(state.value)) {
      expect(first).toContain(`${String(player_.id)}=${player_.name}@`);
    }
    // The barbarian player is still a player, and still not a start.
    expect(state.value.players.some((player_) => player_.kind === 'barbarian')).toBe(true);
    expect(civPlayers(state.value)).toHaveLength(SETTINGS.civCount);
    expect(first).not.toContain('Barbarians');
    expect(namedStarts(first)).toHaveLength(civPlayers(state.value).length);
  });

  it('shows the goody huts an agent has to find, and explains the glyph', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');
    const huts = state.value.map.huts;
    expect(huts.length).toBeGreaterThan(0);

    // God mode draws every hut and nothing else as `%`: `generateWorld` keeps
    // huts off start tiles, so no marker can hide one, and the count is exact.
    const god = glyphRows(describeState(state.value, RULESET)).join('');
    expect(hutGlyphs(god)).toBe(huts.length);
    expect(describeState(state.value, RULESET)).toContain('% hut');

    // The barbarian player's `startingTile` is one of those huts (M3's convention
    // for a required field), so the tile a "start" reading would put a digit on
    // shows the hut instead — the feature an agent wants to walk to.
    const barbarian = state.value.players.find((candidate) => candidate.kind === 'barbarian');
    expect(barbarian === undefined ? 'no barbarian player' : String(barbarian.startingTile)).toBe(
      String(huts[0]),
    );

    // Through the fog, exactly the huts the viewer has explored are drawn — the
    // positive half, so the count below cannot pass by both sides being zero.
    const seeing: GameState = {
      ...state.value,
      explored: state.value.explored.map((row) => row.map(() => true)),
    };
    const all = glyphRows(describeState(seeing, RULESET, { viewer: asPlayerId(0) })).join('');
    expect(hutGlyphs(all)).toBe(huts.length);

    // …and a fresh viewer draws only what its own start has revealed.
    const fresh = describeState(state.value, RULESET, { viewer: asPlayerId(0) });
    const revealed = huts.filter((hut) => state.value.explored[0]?.[hut] === true).length;
    expect(hutGlyphs(glyphRows(fresh).join(''))).toBe(revealed);
  });

  it('draws a hut as %, with a legend field, over the terrain it sits on', () => {
    const view = describeState(withHuts(STATE_4x4, [13]), RULESET);

    // Tile 13 is (1,3), the west tile of the bottom row: the hut replaces the
    // `-` it sat on rather than being drawn beside it, and `%` is not a terrain
    // glyph (`GRID_4x4[13]` is plains, and the hills tile at 14 is untouched).
    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '-%h^']);
    expect(view).toContain(
      'legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains  % hut',
    );

    // A map with no hut adds no legend field and never draws the glyph: the entry
    // is a claim that the glyph is on the map, so it is made only when it is.
    const bare = describeState(STATE_4x4, RULESET);
    expect(glyphRows(bare).join('')).not.toContain('%');
    expect(bare).not.toContain('hut');
  });

  it('lets a start marker win over a hut on the same tile', () => {
    // Unreachable from `generateWorld` (it never puts a hut on a start tile), so
    // the collision is hand-built. A marker wins, and the legend does not claim a
    // hut glyph that was never drawn.
    const view = describeState(withHuts(STATE_4x4, [5]), RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(view).not.toContain('% hut');
  });

  it('still draws huts when the start legend is switched off', () => {
    const view = describeState(withHuts(STATE_4x4, [9]), RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':%h^', '--h^']);
    expect(view).toContain('% hut');
  });

  it('draws a resource as $, with a legend field naming it, over the terrain it sits on', () => {
    // Tile 13 is (1,3), the west tile of the bottom row. The resource replaces the
    // `-` it sat on rather than being drawn beside it, and `$` is not a terrain
    // glyph (`GRID_4x4[13]` is plains, and the hills tile at 14 is untouched).
    const view = describeState(withResources(STATE_4x4, [[13, 'silk']]), RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':,1^', '-$h^']);
    expect(legendOf(view)).toContain('$ silk');
    // The legend entry is a claim about the picture, so it says nothing about the
    // glyph beyond the resource that is there: no `$` appears anywhere but the
    // legend and the one tile it marks.
    expect(resourceGlyphs(glyphRows(view).join(''))).toBe(1);

    // A map with no resource adds no legend field and never draws the glyph — the
    // rule that keeps every pre-M4c picture byte-identical.
    const bare = describeState(STATE_4x4, RULESET);
    expect(glyphRows(bare).join('')).not.toContain('$');
    expect(legendOf(bare)).not.toContain('$');
  });

  it('names every resource the grid drew, in draw order and once each', () => {
    // Three pairs, two of them the same resource on two tiles: the legend lists
    // what is *on the board*, in the order the grid draws it (row by row), and a
    // resource standing on two tiles is one entry rather than two.
    const view = describeState(
      withResources(STATE_4x4, [
        [13, 'silk'],
        [9, 'iron'],
        [6, 'iron'],
      ]),
      RULESET,
    );

    expect(glyphRows(view)).toEqual(['~~::', '~0$-', ':$1^', '-$h^']);
    expect(resourceGlyphs(glyphRows(view).join(''))).toBe(3);
    expect(legendOf(view)).toContain('$ iron, silk');
    // Draw order, not catalog order and not alphabetical: `silk` is drawn last
    // because its tile is the last one the grid reaches.
    expect(legendOf(view).indexOf('iron')).toBeLessThan(legendOf(view).indexOf('silk'));

    // A viewport that crops the silk away lists only what it still draws, so the
    // legend is a picture of the window rather than of the map.
    const cropped = describeState(
      withResources(STATE_4x4, [
        [13, 'silk'],
        [9, 'iron'],
        [6, 'iron'],
      ]),
      RULESET,
      { viewport: { x: 0, y: 0, width: 4, height: 3 } },
    );
    expect(legendOf(cropped)).toContain('$ iron');
    expect(legendOf(cropped)).not.toContain('silk');
  });

  it('draws a resource whose id no catalog can name, rather than dropping it', () => {
    // `describe` reads resources off the *map*; the ruleset's catalog is not
    // consulted, exactly as it is not consulted for terrain. An id nothing defines
    // is the id a reader can still act on (it is what `build`'s `requiresResource`
    // spelling uses), so it is printed as itself rather than vanishing — the same
    // reading an unknown terrain id gets, which is drawn as `?` rather than
    // silently skipped.
    const view = describeState(withResources(STATE_4x4, [[13, 'mithril']]), RULESET);

    expect(glyphRows(view)[3]).toBe('-$h^');
    expect(legendOf(view)).toContain('$ mithril');
    // `RULESET` ships no resource catalog at all, which is a view the engine still
    // runs: it is *not* a reason to hide what is painted on the map.
    expect(RULESET.resources).toBeUndefined();
  });

  it('lets a start marker, and a hut, win over a resource on the same tile', () => {
    // Neither collision is reachable from `generateWorld` (it places resources on
    // neither a start tile nor a hut), so both are hand-built. The marker and the
    // hut are the drawing order `describe` documents — a hut over a resource, a
    // marker over both — and a glyph that was never drawn is claimed by no legend.
    const view = describeState(
      withResources(withHuts(STATE_4x4, [9]), [
        [5, 'iron'],
        [9, 'iron'],
      ]),
      RULESET,
    );

    expect(glyphRows(view)).toEqual(['~~::', '~0,-', ':%1^', '--h^']);
    expect(view).toContain('% hut');
    expect(legendOf(view)).not.toContain('$');
    expect(legendOf(view)).not.toContain('iron');
  });

  it('still draws resources when the start legend is switched off', () => {
    // `showStarts` gates the start *markers* and their `starts:` line, nothing
    // else: a resource is map data, like a hut.
    const view = describeState(withResources(STATE_4x4, [[9, 'iron']]), RULESET, {
      showStarts: false,
    });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':$h^', '--h^']);
    expect(legendOf(view)).toContain('$ iron');
  });

  it('accepts a start tile outside the map without crashing', () => {
    const state: GameState = {
      ...STATE_4x4,
      players: [{ ...player(0, 5), startingTile: asTileIndex(9999) }],
    };

    const view = describeState(state, RULESET);

    expect(glyphRows(view)).toEqual(['~~::', '~,,-', ':,h^', '--h^']);
    expect(view).toContain('0=Player 1(invalid)');
  });

  it('renders a state whose ruleset has no terrains at all', () => {
    const view = describeState(STATE_4x4, withTerrains([]));

    expect(glyphRows(view)).toEqual(['????', '?0??', '??1?', '????']);
    expect(view).toContain('? unknown');
  });
});

/* ------------------------------------------------------------------ *
 * M4a — work in progress
 *
 * A worker's job is the one thing on the board that the *grid* cannot draw: the
 * picture marks terrain, huts and start tiles, and has no per-unit marking at
 * all. So the job is named on a line of its own, and these tests pin what that
 * line says, when it is there, and what a viewer may see of it.
 * ------------------------------------------------------------------ */

/** The hills tile at (2,3): a mine may be built there, and it is off both starts. */
const WORKER_TILE = 14;

/** A job on the worker's own tile, as `StartWork` writes it. */
const job = (kind: string, turnsLeft: number, tile = WORKER_TILE): UnitWork => ({
  kind: asImprovementId(kind),
  tile: asTileIndex(tile),
  turnsLeft,
});

/**
 * A unit of `type` (a worker unless a test says otherwise) owned by player 0,
 * standing on `tile`, doing `work` when one is given. `work` is attached through
 * `withWork`, the only writer of the field — an idle unit carries no `work` key at
 * all, never a key holding `undefined`.
 *
 * M6 adds `hitPointsLeft`: an explicit count is written **only when a test asks for
 * one**, so every other fixture here stays exactly the unit the M4a wave built (no key
 * at all, which `hitPointsLeftOf` reads as a unit at 1) and the damaged-unit case below
 * is the only one that carries the field.
 */
const withWorkOn = (
  work: UnitWork | undefined,
  options?: { type?: string; tile?: number; hitPointsLeft?: number },
): GameState => {
  const base: Unit = {
    id: asUnitId(2),
    type: asUnitTypeId(options?.type ?? 'worker'),
    owner: asPlayerId(0),
    tile: asTileIndex(options?.tile ?? WORKER_TILE),
    movementLeft: 0,
    ...(options?.hitPointsLeft === undefined ? {} : { hitPointsLeft: options.hitPointsLeft }),
  };
  return {
    ...STATE_4x4,
    nextUnitId: 3,
    units: [...STATE_4x4.units, work === undefined ? base : withWork(base, work)],
  };
};

/** A working worker with an explicit id, owner and tile — for the two-worker cases. */
const workerOn = (id: number, owner: number, tile: number, work: UnitWork): Unit =>
  withWork(
    {
      id: asUnitId(id),
      type: asUnitTypeId('worker'),
      owner: asPlayerId(owner),
      tile: asTileIndex(tile),
      movementLeft: 0,
    },
    work,
  );

/** The same board with only the fog rows replaced — the viewer cases below. */
const foggedAs = (state: GameState, seen: readonly number[]): GameState => ({
  ...state,
  explored: [fogRow(seen), fogRow([])],
});

describe('describe and work in progress', () => {
  it('names the job of every working unit, and says nothing when none is', () => {
    // Nothing is being worked: no line, exactly like a `% hut` legend entry that
    // would claim a glyph that is not on the map.
    const idle = describeState(withWorkOn(undefined), RULESET);
    expect(idle).not.toContain('work:');
    expect(idle).not.toContain('mining');

    // A job in progress is a line of its own, under `starts:`, naming the unit by
    // id, its owner, its type, the tile the job is on, its hit points (M6) and how
    // long it has left.
    const working = describeState(withWorkOn(job('mine', 2)), RULESET);
    const lines = working.split('\n').filter((line) => line !== '');
    expect(lines[lines.length - 1]).toBe('work: 2 p0 Worker@2,3 1/1 hp mining, 2 turns left');
    // …and the rest of the picture is untouched: the grid, the legend and the
    // starts line are byte-for-byte what the same board renders with no job.
    expect(working.replace('work: 2 p0 Worker@2,3 1/1 hp mining, 2 turns left\n', '')).toBe(idle);
  });

  it('shows a damaged unit as damaged, with its maximum asked of its own type', () => {
    // M6: the one property of combat a reader can check from this view. A wounded
    // worker must not render like a whole one — the counts differ, and the *maximum*
    // is the row's own `hitPoints` (3 in this fixture), not the unit's current count.
    const hurt = describeState(withWorkOn(job('mine', 2), { hitPointsLeft: 1 }), HIT_POINT_RULESET);
    expect(hurt).toContain('work: 2 p0 Worker@2,3 1/3 hp mining, 2 turns left');

    // The whole figure, not just the numerator: the same unit at full health on the
    // same board differs *only* in that field, which is what makes the line a
    // measurement rather than a decoration.
    const whole = describeState(
      withWorkOn(job('mine', 2), { hitPointsLeft: 3 }),
      HIT_POINT_RULESET,
    );
    expect(whole).toContain('work: 2 p0 Worker@2,3 3/3 hp mining, 2 turns left');
    expect(whole).not.toBe(hurt);

    // A *type* this ruleset cannot describe is the case the fallback exists for: the
    // maximum is then the unit's own count, because inventing one would be a claim
    // about a row the catalog does not have (and would render `1/1` for a unit the
    // state says has taken two hits out of three).
    const unknown = describeState(
      withWorkOn(job('mine', 2), { type: 'ghost', hitPointsLeft: 2 }),
      HIT_POINT_RULESET,
    );
    expect(unknown).toContain('work: 2 p0 ghost@2,3 2/2 hp mining, 2 turns left');
    expect(unknown).not.toMatch(/NaN|undefined/);
  });

  it('says one turn when one turn is left, and names every job on one line', () => {
    expect(describeState(withWorkOn(job('mine', 1)), RULESET)).toContain(
      'work: 2 p0 Worker@2,3 1/1 hp mining, 1 turn left',
    );

    // Two workers on two tiles: both jobs, two spaces apart, in `units` order.
    const pair: GameState = {
      ...STATE_4x4,
      nextUnitId: 4,
      units: [
        ...STATE_4x4.units,
        workerOn(2, 0, 9, job('road', 2, 9)),
        workerOn(3, 1, 13, job('mine', 3, 13)),
      ],
    };
    expect(describeState(pair, RULESET)).toContain(
      'work: 2 p0 Worker@1,2 1/1 hp building a road, 2 turns left  ' +
        '3 p1 Worker@1,3 1/1 hp mining, 3 turns left',
    );
  });

  it('shows a job even when the start legend is switched off', () => {
    // `showStarts` hides the markers and their legend; a job is not a start, and
    // switching one off must not hide what the workers are doing.
    const view = describeState(withWorkOn(job('mine', 2)), RULESET, { showStarts: false });

    expect(view).not.toContain('starts:');
    expect(view).toContain('work: 2 p0 Worker@2,3 1/1 hp mining, 2 turns left');
  });

  it('falls back to the raw ids for a job the ruleset cannot describe', () => {
    // An improvement no catalog row defines: the work still *happened* — the state
    // says so — and the renderer must not pretend the worker is idle. The id is
    // all that is known, so the id is what is printed.
    expect(describeState(withWorkOn(job('quarry', 2)), RULESET)).toContain(
      'work: 2 p0 Worker@2,3 1/1 hp quarry, 2 turns left',
    );

    // …and a unit type the ruleset cannot name is printed as its raw id, the same
    // rule the rest of this file applies to an unknown terrain id.
    expect(describeState(withWorkOn(job('mine', 2), { type: 'ghost' }), RULESET)).toContain(
      'work: 2 p0 ghost@2,3 1/1 hp mining, 2 turns left',
    );
    // A ruleset with no catalogs at all is the same case twice over: no crash, and
    // both the type and the job are named by their ids.
    expect(describeState(withWorkOn(job('mine', 2)), NO_UNITS)).toContain(
      'work: 2 p0 worker@2,3 1/1 hp mine, 2 turns left',
    );
  });

  it('hides a job on an unexplored tile from a viewer, and counts it', () => {
    // Player 0 has explored tiles 4, 5, 6 and 9 (the same blob the fog block below
    // uses); the hills at 14 are not among them, so the job there is not knowledge
    // this player has.
    const seen = describeState(foggedAs(withWorkOn(job('mine', 2)), [4, 5, 6, 9]), RULESET, {
      viewer: asPlayerId(0),
    });

    // The *existence* of unseen work is counted, exactly as an unexplored start is
    // (`starts: … (+1 unexplored)`): the count is a number, and it is the only
    // thing about the hidden job that reaches the screen. The hit points added in M6
    // are behind the same fog rule as the rest of the entry — a wounded worker the
    // viewer cannot see is not a fact the viewer has.
    expect(seen).toContain('work: (+1 unexplored)');
    expect(seen).not.toContain('Worker@');
    expect(seen).not.toContain('mining');
    expect(seen).not.toContain('2,3');
    expect(seen).not.toContain('hp');

    // The strongest form of "does not leak the content": two *different* hidden
    // jobs, on two different unexplored tiles, render the same bytes — so nothing
    // about a job the viewer cannot see can influence the output at all.
    const other = foggedAs(withWorkOn(job('road', 7, 13), { tile: 13 }), [4, 5, 6, 9]);
    expect(describeState(other, RULESET, { viewer: asPlayerId(0) })).toBe(seen);

    // …and the same job, on a tile the viewer *has* explored, is shown in full.
    const inSight = foggedAs(withWorkOn(job('mine', 2, 9), { tile: 9 }), [4, 5, 6, 9]);
    expect(describeState(inSight, RULESET, { viewer: asPlayerId(0) })).toContain(
      'work: 2 p0 Worker@1,2 1/1 hp mining, 2 turns left',
    );
  });

  it('renders the job of a unit in the state, never the state of the world', () => {
    // A job's line is a pure function of the state: the same state renders the same
    // line, and adding a job changes exactly one line of the picture.
    const first = describeState(withWorkOn(job('mine', 2)), RULESET);

    expect(describeState(withWorkOn(job('mine', 2)), RULESET)).toBe(first);
    expect(first).not.toBe(describeState(withWorkOn(job('mine', 1)), RULESET));
    expect(first).not.toBe(describeState(withWorkOn(job('road', 2)), RULESET));
  });

  it('describes one job as prose, from the catalog and the state alone', () => {
    // The exported helper the REPL prints too, pinned phrase by phrase: the verb
    // comes from the improvement's kind, and the count is the state's.
    expect(workSummary(RULESET, job('mine', 2))).toBe('mining, 2 turns left');
    expect(workSummary(RULESET, job('mine', 1))).toBe('mining, 1 turn left');
    expect(workSummary(RULESET, job('road', 3))).toBe('building a road, 3 turns left');
    // Nothing in the catalog describes `quarry`, so the id stands in for the verb.
    expect(workSummary(RULESET, job('quarry', 2))).toBe('quarry, 2 turns left');
    expect(workSummary(NO_UNITS, job('mine', 2))).toBe('mine, 2 turns left');
  });
});

/**
 * Fog, from a player's point of view (INTERFACES.md M2, "Fog").
 *
 * God mode — no `viewer` — is the map, and it is byte-identical to what this
 * renderer printed before the option existed (the snapshots above are the
 * regression test for that). A `viewer` sees its explored row and nothing else:
 * unexplored tiles are `?`, and nothing about them reaches the output, not the
 * terrain, not a start marker, not a start coordinate, not a legend entry.
 */
describe('describe with a viewer', () => {
  /** Player 0 has explored tiles 4, 5, 6 and 9 — a blob around its start at 5. */
  const FOGGED: GameState = syntheticState(
    [player(0, 5), player(1, 10)],
    [fogRow([4, 5, 6, 9]), fogRow([])],
  );

  it('renders the explored tiles and ? for the rest', () => {
    expect(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) })).toMatchInlineSnapshot(`
      "CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2 viewer=0 gold=7 research=idle banked=0
      view: x 0..3, y 0..3 (4x4 of 4x4)
        |0
        |0123
      0 |????
      1 |~0,?
      2 |?,??
      3 |????
      legend: ~ ocean  : coast  , grassland  - plains  h hills  ^ mountains  ? unexplored
      starts: 0=Player 1@1,1  (+1 unexplored)
      "
    `);
  });

  it('hides unexplored tiles that god mode still shows', () => {
    expect(glyphRows(describeState(FOGGED, RULESET))).toEqual(['~~::', '~0,-', ':,1^', '--h^']);
    expect(glyphRows(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }))).toEqual([
      '????',
      '~0,?',
      '?,??',
      '????',
    ]);
  });

  it('does not leak the terrain under an unexplored tile', () => {
    // Everything player 0 has not explored becomes mountains; only those tiles
    // change, and a viewer must not be able to tell.
    const swapped: GameState = {
      ...FOGGED,
      map: {
        width: 4,
        height: 4,
        terrain: GRID_4x4.map((role, tile) =>
          asTerrainId([4, 5, 6, 9].includes(tile) ? role : 'mountains'),
        ),
        huts: [],
        resources: [],
      },
    };

    expect(describeState(swapped, RULESET, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
    expect(glyphRows(describeState(swapped, RULESET))).not.toEqual(
      glyphRows(describeState(FOGGED, RULESET)),
    );
  });

  it('does not leak an unexplored terrain id the ruleset does not know', () => {
    // `?` under fog is fog, not a broken ruleset: the tile's id is never read,
    // so the legend must not acquire `? unknown` from it.
    const state: GameState = {
      ...FOGGED,
      map: {
        width: 2,
        height: 1,
        terrain: [asTerrainId('volcano'), asTerrainId('grassland')],
        huts: [],
        resources: [],
      },
    };

    expect(glyphRows(describeState(state, RULESET, { viewer: asPlayerId(0) }))).toEqual(['??']);
    expect(describeState(state, RULESET, { viewer: asPlayerId(0) })).toContain('? unexplored');
    expect(describeState(state, RULESET, { viewer: asPlayerId(0) })).not.toContain('? unknown');
    // God mode sees the same tile and does report the unknown id.
    expect(describeState(state, RULESET)).toContain('? unknown');
  });

  it('does not leak the start marker, or the coordinates, of an unexplored start', () => {
    const view = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });

    // Player 1's start (tile 10) is unexplored, so it is neither drawn nor named.
    expect(glyphRows(view)[2]?.[2]).toBe('?');
    expect(view).toContain('starts: 0=Player 1@1,1  (+1 unexplored)');
    expect(view).not.toContain('Player 2@');

    // Moving that unseeable start must not change a byte of the view.
    const moved: GameState = {
      ...FOGGED,
      players: [player(0, 5), player(1, 12)],
    };
    expect(describeState(moved, RULESET, { viewer: asPlayerId(0) })).toBe(view);
    expect(describeState(moved, RULESET)).not.toBe(describeState(FOGGED, RULESET));
  });

  it('names the viewer, its gold and its research, and explains ? only then', () => {
    const seen = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });
    const god = describeState(FOGGED, RULESET);

    // M5: the header carries the research field as well as gold, so the pinned line
    // moved — and the assertion is *stronger* than the M4b one it replaces, because
    // the field is asserted twice: on the whole line, and on its own by the
    // research-specific test below.
    expect(seen.split('\n')[0]).toBe(
      `CivTS state: seed=7 turn=1 revision=0 map=duel(4x4) civs=2 viewer=0 gold=${String(GOLD)} ` +
        'research=idle banked=0',
    );
    expect(seen).toContain('? unexplored');
    expect(god).not.toContain('viewer=');
    // M4b: with no viewer there is no player whose money or research this could be,
    // so god mode's header gains nothing at all — it stays byte-identical to what this
    // renderer printed before either option existed.
    expect(god).not.toContain('gold=');
    expect(god).not.toContain('research=');
    expect(god).not.toContain('unexplored');
  });

  it('shows what the viewer is researching, and what the pool has reached', () => {
    // M5. The field is read from the state through `tech.ts` (`researchingOf` and
    // `techCostOf`), so the two figures are the ones the turn pipeline will compare:
    // the id is the one the REPL's `research <techId>` spells, and the denominator is
    // the price the research step charges.
    const researching = (beakers: number, tech: string | undefined): GameState => ({
      ...FOGGED,
      players: [
        {
          ...player(0, 5),
          beakers,
          ...(tech === undefined ? {} : { researching: asTechId(tech) }),
        },
        player(1, 10),
      ],
    });

    expect(describeState(researching(0, 'pottery'), RULESET, { viewer: asPlayerId(0) })).toContain(
      'research=pottery 0/5',
    );
    // Progress is shown as banked/cost, not as a percentage or a turn estimate: both
    // are figures the engine published, and a "2 turns" guess would be a fourth
    // number nothing computed.
    expect(describeState(researching(3, 'alphabet'), RULESET, { viewer: asPlayerId(0) })).toContain(
      'research=alphabet 3/7',
    );
    // A pool that already covers the cost keeps printing both numbers, so a reader
    // can see that the next turn's research step will complete it.
    expect(describeState(researching(9, 'pottery'), RULESET, { viewer: asPlayerId(0) })).toContain(
      'research=pottery 9/5',
    );
    // No key is "idle": the field still says what is banked, because beakers are no
    // longer inert and a hidden pool would be a hidden decision.
    expect(describeState(researching(4, undefined), RULESET, { viewer: asPlayerId(0) })).toContain(
      'research=idle banked=4',
    );
  });

  it('reads the research field totally: no such tech, no such player, no such pool', () => {
    // A tech row this ruleset cannot price is *not* a free tech and not a fraction:
    // the field says so in words rather than printing a number nobody could act on.
    const uncosted: GameState = {
      ...FOGGED,
      players: [{ ...player(0, 5), beakers: 2, researching: asTechId('telegraph') }, player(1, 10)],
    };
    const header = describeState(uncosted, RULESET, { viewer: asPlayerId(0) }).split('\n')[0] ?? '';
    expect(header).toContain('research=telegraph (uncosted) banked=2');

    // A pool the engine cannot count reads as 0, exactly as an uncountable treasury
    // does: `research=idle banked=NaN` in the agent's primary view would be worse
    // than a conservative zero.
    for (const beakers of [Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      const broken: GameState = {
        ...FOGGED,
        players: [{ ...player(0, 5), beakers }, player(1, 10)],
      };
      expect(describeState(broken, RULESET, { viewer: asPlayerId(0) })).toContain(
        'research=idle banked=0',
      );
    }
  });

  it('reads the viewer gold totally: a player the state does not have, and a broken number', () => {
    // A viewer id no player carries has no gold to name, and inventing `gold=0`
    // would be a claim about a player who does not exist. The rest of the header
    // still names the viewer, which is what the fog tests below rely on.
    const stranger = describeState(FOGGED, RULESET, { viewer: asPlayerId(7) });
    expect(stranger.split('\n')[0]).toContain('viewer=7');
    expect(stranger.split('\n')[0]).not.toContain('gold');

    // A treasury the engine cannot count (a state from before M4b, a hand-built
    // object, a JSON round trip with a fractional value) renders as 0 rather than
    // as `gold=NaN`: the header is the agent's primary view, and a NaN there is
    // worse than a conservative zero.
    const broken = (treasury: number): GameState => ({
      ...FOGGED,
      players: [{ ...player(0, 5), treasury }, player(1, 10)],
    });
    for (const value of [Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      expect(describeState(broken(value), RULESET, { viewer: asPlayerId(0) })).toContain('gold=0');
    }
    // …and a whole number is printed verbatim, not clamped or rounded.
    expect(describeState(broken(0), RULESET, { viewer: asPlayerId(0) })).toContain('gold=0');
    expect(describeState(broken(1234), RULESET, { viewer: asPlayerId(0) })).toContain('gold=1234');
    expect(describeState(broken(-3), RULESET, { viewer: asPlayerId(0) })).toContain('gold=-3');
  });

  it('treats a viewer with no explored row as seeing nothing', () => {
    const blind = describeState(FOGGED, RULESET, { viewer: asPlayerId(7) });

    expect(glyphRows(blind)).toEqual(['????', '????', '????', '????']);
    expect(blind).toContain('viewer=7');
    expect(blind).toContain('(+2 unexplored)');
  });

  it('renders every tile, and no fog note, once the row is complete', () => {
    const all = syntheticState(
      [player(0, 5), player(1, 10)],
      [fogRow(Array.from({ length: 16 }, (_, tile) => tile)), fogRow([])],
    );
    const seen = describeState(all, RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(seen)).toEqual(glyphRows(describeState(all, RULESET)));
    expect(seen).not.toContain('unexplored');
  });

  it('still crops to a viewport, and flags a start that falls outside it', () => {
    const view = describeState(FOGGED, RULESET, {
      viewer: asPlayerId(0),
      viewport: { x: 3, y: 3, width: 99, height: 99 },
    });

    expect(view).toContain('view: x 3..3, y 3..3 (1x1 of 4x4)');
    expect(glyphRows(view)).toEqual(['?']);
    expect(view).toContain('0=Player 1@1,1 (off-view)');
  });

  it('hides the starts line for a viewer when showStarts is false', () => {
    const view = describeState(FOGGED, RULESET, {
      viewer: asPlayerId(0),
      showStarts: false,
    });

    expect(view).not.toContain('starts:');
    expect(glyphRows(view)).toEqual(['????', '~,,?', '?,??', '????']);
    expect(view).toContain('? unexplored');
  });

  it('is stable across repeated calls with a viewer', () => {
    const first = describeState(FOGGED, RULESET, { viewer: asPlayerId(0) });

    expect(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) })).toBe(first);
  });

  it('starts a viewer in fog its own settler can see out of', () => {
    const state = newGame(42, SETTINGS, RULESET);
    if (!state.ok) throw new Error('expected a state');

    const view = describeState(state.value, RULESET, { viewer: asPlayerId(0) });
    const fogged = glyphRows(view).join('').split('?').length - 1;

    // Fog everywhere except the tiles around the starting settler...
    expect(fogged).toBeGreaterThan(0);
    expect(fogged).toBeLessThan(state.value.map.width * state.value.map.height);
    expect(view).toContain('? unexplored');
    // ...so the viewer's own start is drawn and named, and the fog is explained.
    expect(view).toContain('0=Player 1@');
  });

  it('needs no unit catalog: a viewer works with an empty one', () => {
    // `describe` reads fog from the state, so callers whose view ships no units
    // keep working.
    expect(describeState(FOGGED, NO_UNITS, { viewer: asPlayerId(0) })).toBe(
      describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }),
    );
  });

  it('draws a hut the viewer has explored, and adds its legend field', () => {
    // Tile 9 is one of the four player 0 has explored (4, 5, 6, 9).
    const view = describeState(withHuts(FOGGED, [9]), RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(view)[2]).toBe('?%??');
    expect(view).toContain('% hut');
  });

  it('does not reveal a hut on a tile the viewer has not explored', () => {
    // Tile 13 is unexplored, so the fog hides the feature as well as the terrain
    // under it — including from the legend, which would otherwise announce that
    // the glyph is somewhere on the map.
    const hutInTheFog = withHuts(FOGGED, [13]);
    const view = describeState(hutInTheFog, RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(view)[3]).toBe('????');
    expect(view).not.toContain('%');
    // The strongest form of "does not leak": the whole view is byte-identical to
    // the same board with no hut at all.
    expect(view).toBe(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }));
    // …while god mode, which is allowed to know, shows it.
    expect(glyphRows(describeState(hutInTheFog, RULESET))[3]).toBe('-%h^');
  });

  it('draws a resource the viewer has explored, and adds its legend field', () => {
    // Tile 9 is one of the four player 0 has explored (4, 5, 6, 9) — the positive
    // half of the fog rule below, so that test cannot pass by nothing ever being
    // drawn.
    const view = describeState(withResources(FOGGED, [[9, 'iron']]), RULESET, {
      viewer: asPlayerId(0),
    });

    expect(glyphRows(view)[2]).toBe('?$??');
    expect(legendOf(view)).toContain('$ iron');
    expect(resourceGlyphs(glyphRows(view).join(''))).toBe(1);
  });

  it('does not reveal a resource on a tile the viewer has not explored, in the grid or the legend', () => {
    // M4c's resource glyph is drawn under *exactly* the hut's fog rule: a resource
    // is map data with a strategic consequence, so a tile the player has not
    // explored contributes neither a glyph nor a legend entry. Tile 13 is
    // unexplored and tile 9 is not, so this board has one of each and the test
    // proves both halves in one view.
    const partlyInTheFog = withResources(FOGGED, [
      [13, 'silk'],
      [9, 'iron'],
    ]);
    const view = describeState(partlyInTheFog, RULESET, { viewer: asPlayerId(0) });

    expect(glyphRows(view)[3]).toBe('????');
    expect(glyphRows(view)[2]).toBe('?$??');
    // The silk is nowhere in the output — not as a glyph, not as a legend entry,
    // and not as the id itself.
    expect(view).not.toContain('$ silk');
    expect(view).not.toContain('silk');

    // The strongest form of "does not leak", the same one the hut test makes: the
    // whole view is byte-identical to the same board with the hidden resource
    // removed altogether.
    expect(view).toBe(
      describeState(withResources(FOGGED, [[9, 'iron']]), RULESET, { viewer: asPlayerId(0) }),
    );

    // …and two *different* resources on two different unexplored tiles render the
    // same bytes, so nothing about a resource the viewer cannot see can influence
    // the output at all — not its id, not its kind, not which tile it is on.
    const other = withResources(FOGGED, [
      [12, 'gems'],
      [9, 'iron'],
    ]);
    expect(describeState(other, RULESET, { viewer: asPlayerId(0) })).toBe(view);

    // …while god mode, which is allowed to know, draws the silk and names it.
    const god = describeState(partlyInTheFog, RULESET);
    expect(glyphRows(god)[3]).toBe('-$h^');
    expect(legendOf(god)).toContain('$ iron, silk');
  });

  it('adds no resource legend entry when every resource on the map is in the fog', () => {
    // The conditional-legend rule, stated on its own: a board whose *only*
    // resources are unexplored has no `$` in its legend at all, because the legend
    // entry is a claim that the glyph is on the pictured map. (The hut-free views
    // of M2 and M3 stay byte-identical for exactly this reason.)
    const hidden = withResources(FOGGED, [
      [13, 'silk'],
      [10, 'gems'],
    ]);
    const view = describeState(hidden, RULESET, { viewer: asPlayerId(0) });

    expect(view).not.toContain('$');
    expect(glyphRows(view)).toEqual(['????', '~0,?', '?,??', '????']);
    // The picture is exactly the board with no resources on it, byte for byte.
    expect(view).toBe(describeState(FOGGED, RULESET, { viewer: asPlayerId(0) }));
  });

  it('never presents the barbarians as a start, in god mode or through the fog', () => {
    // The barbarian player M3 appends: id 2, no units, and a `startingTile` that
    // is really the map's first hut. Player 0 has explored 4, 5, 6 and 9.
    const barbarians = barbarianPlayer(2, 13);
    const base = syntheticState(
      [player(0, 5), player(1, 10), barbarians],
      [fogRow([4, 5, 6, 9]), fogRow([]), fogRow([])],
    );
    const state: GameState = {
      ...base,
      // `newGame` places one settler per *civilization*, so the barbarians own
      // nothing: they are an identity for the band a hut will spawn.
      units: base.units.filter((unit) => unit.owner !== barbarians.id),
      nextUnitId: 2,
      map: { ...base.map, huts: [asTileIndex(13)] },
    };

    // It *is* still a player — an id, a name and a fog row of its own — and it
    // owns nothing: `newGame` places one settler per civilization, so the only
    // units the barbarians ever have are the band a hut spawns for them. That is
    // what "a player without a homeland" means, and it is why the two readings
    // below are about *presentation*, not about the player existing.
    const inGame = state.players.find((player_) => player_.kind === 'barbarian');
    expect(inGame?.id).toBe(barbarians.id);
    expect(inGame?.name).toBe('Barbarians');
    expect(state.explored[Number(barbarians.id)]).toHaveLength(GRID_4x4.length);
    expect(state.units.filter((candidate) => candidate.owner === barbarians.id)).toEqual([]);

    // God mode: the civs are named, the barbarians are not, and their tile is
    // drawn as the hut it is rather than as the digit `2`.
    const god = describeState(state, RULESET);
    expect(namedStarts(god)).toEqual(['0=Player 1@1,1', '1=Player 2@2,2']);
    expect(god).not.toContain(barbarians.name);
    expect(god).not.toContain('2=');
    expect(glyphRows(god)[3]).toBe('-%h^');

    // Through the fog, the count of hidden starts counts *civilization* starts:
    // player 1's is unexplored, the barbarians' hut is not a start at all and is
    // therefore neither drawn nor counted.
    const seen = describeState(state, RULESET, { viewer: asPlayerId(0) });
    expect(namedStarts(seen)).toEqual(['0=Player 1@1,1']);
    expect(seen).toContain('starts: 0=Player 1@1,1  (+1 unexplored)');
    expect(seen).not.toContain(barbarians.name);
    expect(glyphRows(seen)[3]).toBe('????');
  });
});
