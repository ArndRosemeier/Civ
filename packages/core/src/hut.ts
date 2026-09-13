/**
 * Goody huts — what a land unit finds when it walks into one.
 * See docs/INTERFACES.md M3 ("Goody huts"), PLAN.md §5.3 (determinism) and §5.4
 * (data layout).
 *
 * The frozen contract, in full:
 *
 * - Huts are placed by `generateWorld` (count scales with map size — a
 *   placeholder), sit on land only, never on a start tile, and are sorted
 *   ascending. Consuming one is *this* module's job.
 * - A land unit entering a hut tile **consumes** it and draws a reward from the
 *   state RNG (so it is reproducible and advances `state.rng`): a free unit, a
 *   band of barbarian units near the hut, or nothing. Sea units and cities never
 *   trigger.
 * - Barbarian units belong to the barbarian player (`PlayerState.kind ===
 *   'barbarian'`) and are ordinary `Unit`s, so movement and future combat need no
 *   special case.
 * - `{ kind: 'gold' }` is deliberately **out of scope** in M3: there is no
 *   treasury until M4, and inventing one here would duplicate M4's job. It is
 *   named in `HUT_REWARD_KINDS`' documentation and in `HUT_REWARD_PROVENANCE`
 *   rather than silently omitted.
 *
 * Design notes:
 *
 * - **The reward is a function of the state, not of the world.** The only
 *   randomness is `nextBelow(state.rng, HUT_REWARD_KINDS.length)`, and the state
 *   that comes back carries the advanced `RngState`. Two runs of the same seed
 *   and the same commands therefore agree exactly, in this process and in a fresh
 *   one; nothing here reads a clock, a global or the environment.
 * - **The hut is consumed whatever the reward turns out to be.** "Nothing" is a
 *   reward, not a non-event: the hut is gone, the RNG advanced, and `HutEntered`
 *   was emitted with `reward: 'nothing'`. A hut that survived an empty reward
 *   could be farmed by walking on and off it.
 * - **This module is a transition, not a command.** `resolveHutEntry` does not
 *   touch `revision`, `turn` or fog: it is applied *inside* `MoveUnit`, which owns
 *   the revision bump and the fog fold, exactly as `turn.ts` owns the order of a
 *   turn and `production.ts` owns a completion. That is also why it takes the
 *   **post-move** state: the mover must already be standing on the hut tile, and
 *   the unit is looked up by id in that state rather than passed in, so a stale
 *   `Unit` value (one still on the tile it started the step from) cannot decide
 *   the wrong tile.
 * - **A reward unit the ruleset cannot supply degenerates to nothing.** The band
 *   and the free unit are both "the **cheapest** `military`-role land unit in the
 *   ruleset, ties broken by id" (see `rewardUnitDef`); a view with no such row gives
 *   the player nothing, and the event says `nothing`, because the event reports
 *   what the player got rather than which branch the draw selected. Inventing a
 *   unit type would be content this engine does not have.
 * - **The pick is canonical, not positional.** The engine's behaviour must be a
 *   pure function of the **ruleset's identity**: price and id are content, so
 *   reordering, re-inserting or shuffling the catalog's rows cannot change which
 *   unit a hut pays. A row *position* is not content, and reading one would make a
 *   choice no reader of the rows could predict. (Two catalogs that differ only in
 *   row order do have different identities — `hashValue(validateRuleset(CATALOG))`
 *   is `e69bfbaab6d3bba4` and the same catalog with `resources` and `units` reversed
 *   is `0b6d39501ac57528` — so their differing *is* legal; see `gen.ts`' resources
 *   site, where that fact is what makes a replay against the wrong ordering
 *   detectable. The point here is narrower: a difference the reader cannot predict
 *   from the content is a difference nobody can review.)
 * - **Everything numeric here is a placeholder of ours.** The three-way reward
 *   split, the band size, and "the cheapest military land unit" are chosen to be
 *   playable and are **not** sourced from Civ 3 — see `HUT_REWARD_PROVENANCE`,
 *   which states that in machine-readable form, and every constant below.
 */

import { cityAt } from './cities.js';
import type { GameEvent } from './commands.js';
import { type TileIndex, type UnitId } from './ids.js';
import { isWaterRole, neighbors8, terrainAtIndex, type RulesetView } from './map.js';
import { placeholder, type Provenance } from './provenance.js';
import { nextBelow } from './rng.js';
import type { GameState, PlayerState } from './state.js';
import {
  spawnUnit,
  unitById,
  unitCatalog,
  unitDef,
  unitsOnTile,
  type Unit,
  type UnitDef,
} from './units.js';

/**
 * The rewards a hut can give, in the order the RNG selects them: draw
 * `nextBelow(state.rng, HUT_REWARD_KINDS.length)` and index this array.
 *
 * The order is part of the game's behaviour — it decides which draw gives which
 * reward, and therefore every state hash that follows a hut — so it is one
 * exported statement rather than a `switch` spelled out at the call site.
 *
 * `HUT_REWARD_KINDS` is exhaustive for M3 and deliberately **short one member**:
 * Civ 3's hut also pays gold, and M3 has no treasury at all (INTERFACES.md M3,
 * "Goody huts": "`{ kind: 'gold' }` is deliberately out of scope in M3 … say so in
 * the provenance detail rather than quietly omitting it"). Adding it here without
 * a treasury would mean inventing M4's job, so the third branch is "nothing" —
 * a real reward with a real cost (the hut is spent) — and M4 adds `gold` by
 * appending it here and re-weighing the draws, in one place.
 */
export const HUT_REWARD_KINDS = ['unit', 'barbarians', 'nothing'] as const;

/** One hut reward: a free unit, a barbarian band, or nothing. */
export type HutRewardKind = (typeof HUT_REWARD_KINDS)[number];

/**
 * How many barbarian units a hut's band contains. **Placeholder.** 2 is ours,
 * chosen to be playable — one barbarian is a nuisance a single unit can ignore,
 * and a larger band would need a stacking rule this engine does not have yet —
 * and it is **not** a Civ 3 figure. The band is capped by the number of adjacent
 * tiles a barbarian may actually stand on (see `bandTiles`).
 */
export const BARBARIAN_BAND_SIZE = 2;

/**
 * What the hut rules claim, in the project's provenance vocabulary. Every number
 * this module introduces is ours: the 1-in-3 reward split, the band size of 2,
 * and "the cheapest `military` land unit in the ruleset" as the reward unit. None
 * of them is traced to a source, and Civ 3's real hut probabilities (which vary
 * by difficulty and by whether the hut is inside a city radius) are unverified
 * here. `gold` is named because M3 leaves it out on purpose (no treasury until
 * M4), not because it was forgotten.
 */
export const HUT_REWARD_PROVENANCE: Provenance = placeholder(
  'Unsourced placeholder, chosen to be playable: the 1-in-3 hut reward split, the band size of 2, ' +
    'and "the cheapest military-role land unit in the ruleset" as the reward unit are our own ' +
    'tuned values, NOT traced to Civ 3 (whose hut outcomes vary by difficulty and by whether the ' +
    'hut sits inside a city radius, and are unverified here). The `gold` reward is deliberately ' +
    'absent in M3 because there is no treasury until M4.',
);

/**
 * The terrain roles that are water: `generateWorld` places no hut on one, and a
 * band is never spawned onto one. The two words live here and in `commands.ts`
 * (which reads "on land" for `FoundCity`); the vocabulary is the engine's own.
 */
// M10 moved the two-element list to `map.ts` (`WATER_ROLES`/`isWaterRole`) because a third
// reader appeared: the domination land share also asks what ground is land. One list, three
// readers.

/**
 * Is there a hut on `tile`? A pure read of the map, and total: a tile that is not
 * an integer, or is off the map, has no hut rather than being an error.
 */
export const hutAt = (state: GameState, tile: number): boolean =>
  state.map.huts.some((hut) => Number(hut) === tile);

/**
 * Is `candidate` the better hut reward than `best`? **Cheapest first, then lowest
 * id** — both of them content, neither of them a row position.
 *
 * The id comparison is `String` code-unit order on purpose: it is a pure function of
 * the two ids, identical in every JavaScript engine and every locale. A collator or
 * `localeCompare` would order by the environment's locale, which would make a hash
 * depend on where the game was run.
 */
const beatsAsReward = (candidate: UnitDef, best: UnitDef): boolean => {
  if (candidate.cost !== best.cost) return candidate.cost < best.cost;
  return String(candidate.id) < String(best.id);
};

/**
 * The unit a hut gives away or spawns: the **cheapest** `military`-role **land** unit
 * in the ruleset, ties broken by unit id, or `undefined` when the ruleset provides
 * none.
 *
 * **A canonical pick, not a positional one.** The engine's behaviour must be a pure
 * function of the **ruleset's identity**, and a row's *position* is not part of a row.
 * Until this rule changed, the reward was "the first `military` land row", so
 * reversing `CATALOG.units` made huts pay swordsmen instead of warriors on the same
 * seed: a semantic change no reader could predict from the content and no test of the
 * content would report. Price and id are the rows themselves, so the choice is now
 * invariant under reordering, appending, or shuffling the catalog — while a ruleset
 * that genuinely ships different *content* still gives a different answer, which is
 * what a ruleset is for. (Content and row order are not the same lever: two catalogs
 * differing only in row order already have different identities —
 * `hashValue(validateRuleset(CATALOG))` is `e69bfbaab6d3bba4`, and with `resources`
 * and `units` reversed `0b6d39501ac57528` — so a replay against the wrong ordering is
 * detectable. `gen.ts`' resources site states that coupling and `gen.test.ts` pins
 * it; this rule removes one dependence that was merely accidental.)
 *
 * `military` rather than `scout` or `settler`: a hut that handed out settlers would
 * let a player skip the game's central decision, and a band of scouts would be a band
 * nothing can fight. On the catalog this project ships the cheapest military land row
 * is the **warrior** (`warrior@1`, `swordsman@3`, and the galley at 2 is excluded by
 * the `domain` half of the rule because a band of galleys dropped on land tiles would
 * be a unit the engine cannot place honestly — `spawnUnit` takes the caller's word for
 * *where*, and M4 owns domains). That is the same unit the old positional rule
 * selected, so on shipped content this is behaviour-preserving and only the *reason*
 * changed.
 *
 * **Placeholder**, like everything else here: this is our choice, not a rule
 * traced to a source.
 */
const rewardUnitDef = (ruleset: RulesetView): UnitDef | undefined => {
  let best: UnitDef | undefined;
  for (const def of unitCatalog(ruleset)) {
    if (def.role !== 'military' || def.domain !== 'land') continue;
    if (best === undefined || beatsAsReward(def, best)) best = def;
  }
  return best;
};

/** The barbarian player, or `undefined` in a state that has none (a hand-built one). */
const barbarianPlayer = (state: GameState): PlayerState | undefined =>
  state.players.find((player) => player.kind === 'barbarian');

/**
 * May a *land* unit stand on `tile`? Land (not ocean or coast) and not
 * impassable, with a terrain id the ruleset describes — the same reading
 * `generateWorld` uses when it places huts on `isWater[i] === false` tiles, plus
 * the `impassable` check so a band is never dropped inside a mountain range it
 * could not leave.
 *
 * Roles are the engine's structural vocabulary for "water": a terrain's
 * `impassable` flag cannot answer it, because mountains are impassable *and*
 * land. The two roles themselves are stated in `commands.ts` as well (for
 * `FoundCity`'s "on land"); the list is two words of the engine's own role
 * vocabulary, and this module keeps its own copy so that `hut.ts`'s only import
 * from the command layer stays a *type* import.
 */
const standable = (state: GameState, ruleset: RulesetView, tile: TileIndex): boolean => {
  const id = terrainAtIndex(state.map, Number(tile));
  if (id === undefined) return false;
  const def = ruleset.terrains.find((terrain) => terrain.id === id);
  if (def === undefined || def.impassable) return false;
  return !isWaterRole(def.role);
};

/**
 * The tiles a band from the hut on `hut` may occupy: the adjacent tiles a land
 * unit may stand on that hold no unit **and no city** of another player, in
 * ascending tile index order.
 *
 * "Another player" means "not the barbarians": band members may share a tile with
 * each other or with an existing barbarian, because stacking one's own units is
 * legal in M2, but a band is never placed on top of a civilization's unit — that
 * state is unreachable through the command layer (a moving unit may not enter an
 * enemy tile), and manufacturing it here would hand the mover a tile it could
 * never have walked into.
 *
 * **M6 extends that sentence to cities, and this filter is where it is enforced.**
 * Since M6 a tile holding another player's *city* is refused by the mover with the
 * same `occupied-by-enemy`, and the registry carries the matching invariant
 * (`unit-not-inside-foreign-city`): a band placed inside a foreign city would be a
 * state no command could produce, and it is reachable from real play — a band tile
 * that a civilization had just walked out of — which is how the hole was found
 * (200-seed `duel`/3-civ sweeps in `@civts/sim`'s full tier, two runs on which the
 * invariant fired on a hut's band).
 *
 * The sort states the order outright rather than relying on `neighbors8`'s loop,
 * because *which* tiles the band occupies is part of the state and of the
 * `BarbariansSpawned` event.
 */
const bandTiles = (
  state: GameState,
  ruleset: RulesetView,
  hut: TileIndex,
  barbarian: PlayerState,
): readonly TileIndex[] =>
  [...neighbors8(state.map, Number(hut))]
    .sort((a, b) => Number(a) - Number(b))
    .filter((tile) => standable(state, ruleset, tile))
    .filter((tile) => !unitsOnTile(state, tile).some((unit) => unit.owner !== barbarian.id))
    // **The city half of the same rule (M6).** A tile held by another player's *city* is
    // no more placeable than one held by their unit: `planMove` refuses to enter it
    // (`occupied-by-enemy`), so a band standing inside a foreign city is a state the
    // command layer cannot produce — and M6 registers exactly that as the invariant
    // `unit-not-inside-foreign-city`. A band on a city tile is also *useful* to nobody:
    // the city it stands in is defended by a unit that cannot take it, and the band's
    // own step will refuse to enter any other foreign city. `cityAt` is the engine's own
    // "what city is on this tile", so this filter and the mover cannot disagree about
    // which tiles hold a city.
    .filter((tile) => {
      const city = cityAt(state, tile);
      return city === undefined || city.owner === barbarian.id;
    });

/** A `HutEntered` event for `unit`, with no unit given (the `unit` reward spells its own). */
const hutEntered = (unit: Unit, reward: HutRewardKind): GameEvent => ({
  type: 'HutEntered',
  unitId: unit.id,
  owner: unit.owner,
  tile: unit.tile,
  reward,
});

/** What resolving a hut entry did: the state after it, and what happened. */
export interface HutEntryOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * Resolve the hut the unit `unitId` is standing on, in `state` — the one place a
 * hut reward is drawn and applied.
 *
 * `undefined` means **no hut was entered**, and then nothing at all happened:
 * no consumption, no event, and `state.rng` untouched. That is the answer for a
 * unit standing on a tile with no hut, and for the three cases the contract
 * excludes outright:
 *
 * - a unit whose type the ruleset does not describe — a domain cannot be read
 *   from a row that does not exist, so it cannot be shown to be a land unit;
 * - a **sea** unit (any unit whose type's `domain` is `'sea'`), which never
 *   triggers a hut even when a hand-built state or a corrupt save puts one on a
 *   hut tile;
 * - a unit on a tile where a **city** stands. Huts are placed on land that no
 *   start tile holds, but nothing stops a settler founding a city on one, so the
 *   case is real rather than defensive: a city consumes its tile's hut
 *   permanently, and the hut stays on the map because no unit ever enters it.
 *
 * Otherwise the hut is consumed, one draw is taken from `state.rng`, and the
 * result is one of:
 *
 * - **`unit`** — a free unit of `rewardUnitDef(ruleset)` appears on the hut tile,
 *   beside the mover. That tile is a safe home for it: the step that produced this
 *   resolution was refused if another player's unit stood there
 *   (`occupied-by-enemy`), and M2 lets a player's own units stack, so the worst
 *   case is a friendly stack. Looking for a free neighbour instead would put the
 *   reward somewhere the mover may not be able to see. (This is the same placement
 *   reading `production.ts` states for a produced unit, minus the city.)
 * - **`barbarians`** — up to `BARBARIAN_BAND_SIZE` barbarian units appear on the
 *   adjacent tiles `bandTiles` allows, one per tile, at full movement and sorted
 *   by tile: they are ordinary `Unit`s owned by the barbarian player, so movement
 *   and M6's combat need no special case for them.
 * - **`nothing`** — the hut was spent and gave nothing.
 *
 * The returned state is fresh and shares nothing mutable with the input; the
 * input is never modified. `revision` is deliberately **not** touched (it counts
 * applied commands, and the command that called this is the one that bumps it),
 * and neither is `explored`: `spawnUnit`'s rule is that a unit which comes into
 * being does not grow anybody's memory, and the mover's own sight was folded into
 * its player's row by the move that got it here.
 */
export const resolveHutEntry = (
  state: GameState,
  ruleset: RulesetView,
  unitId: UnitId,
): HutEntryOutcome | undefined => {
  const unit = unitById(state, unitId);
  if (unit === undefined) return undefined;

  const tile = Number(unit.tile);
  if (!Number.isInteger(tile)) return undefined;
  if (!hutAt(state, tile)) return undefined;

  const def = unitDef(ruleset, unit.type);
  if (def === undefined || def.domain !== 'land') return undefined;
  if (cityAt(state, unit.tile) !== undefined) return undefined;

  // The hut leaves the map first, so that nothing below can leave it behind: the
  // reward may spawn units, not huts.
  const consumed: GameState = {
    ...state,
    map: { ...state.map, huts: state.map.huts.filter((hut) => Number(hut) !== tile) },
  };

  // The single draw of the whole rule, mapped through the reward table. One draw
  // per entry, whatever the branch: a second draw (for the band size, say) would
  // make the reward sequence harder to reason about without buying anything.
  const draw = nextBelow(state.rng, HUT_REWARD_KINDS.length);
  const kind = HUT_REWARD_KINDS[draw[0]] ?? 'nothing';
  const drawn: GameState = { ...consumed, rng: draw[1] };

  if (kind === 'unit') {
    const reward = rewardUnitDef(ruleset);
    if (reward === undefined) return { state: drawn, events: [hutEntered(unit, 'nothing')] };

    const spawned = spawnUnit(drawn, reward, unit.owner, unit.tile);
    return {
      state: spawned.state,
      events: [
        {
          type: 'HutEntered',
          unitId: unit.id,
          owner: unit.owner,
          tile: unit.tile,
          reward: 'unit',
          unitGiven: spawned.unit.id,
        },
      ],
    };
  }

  if (kind === 'barbarians') {
    const barbarian = barbarianPlayer(state);
    const reward = rewardUnitDef(ruleset);
    if (barbarian === undefined || reward === undefined) {
      return { state: drawn, events: [hutEntered(unit, 'nothing')] };
    }

    const tiles = bandTiles(drawn, ruleset, unit.tile, barbarian).slice(0, BARBARIAN_BAND_SIZE);
    if (tiles.length === 0) return { state: drawn, events: [hutEntered(unit, 'nothing')] };

    // Spawned one at a time so each unit takes the state's next free id: ids are
    // creation order, and creation order here is ascending tile order.
    const unitIds: UnitId[] = [];
    let current = drawn;
    for (const where of tiles) {
      const spawned = spawnUnit(current, reward, barbarian.id, where);
      current = spawned.state;
      unitIds.push(spawned.unit.id);
    }

    return {
      state: current,
      events: [
        hutEntered(unit, 'barbarians'),
        {
          type: 'BarbariansSpawned',
          owner: barbarian.id,
          tile: unit.tile,
          unitIds,
          tiles,
        },
      ],
    };
  }

  return { state: drawn, events: [hutEntered(unit, 'nothing')] };
};
