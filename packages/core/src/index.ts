/**
 * `@civts/core` — the public surface of the engine.
 *
 * Everything `core` offers is re-exported here so downstream packages
 * (`rules`, `testing`, `headless`, the UI) import from one place and the
 * typechecker is the integration mechanism between workstreams.
 */

export * from './ids.js';
export * from './result.js';
export * from './provenance.js';
export * from './settings.js';
export * from './rng.js';
export * from './map.js';
export * from './gen.js';
export * from './state.js';
export * from './improvements.js';
export * from './resources.js';
export * from './cities.js';
// M4c's building effects, maintenance and the wonder rules. After `cities.js` in
// this list because `cities.ts` is the module that *asks* for an effect total; the
// runtime edge runs cities → buildings only (`buildings.ts` imports
// `BuildingDef`/`City` from `cities.ts` type-only), so the order here is a reading
// order, not an evaluation requirement.
export * from './buildings.js';
/**
 * **M9+M10's systems**, in reading order: the ownership layer, then the two counts that
 * feed it and the score, then the two rules a game ends and is graded by.
 *
 * - `borders.ts` — the tile-ownership layer and the one statement of "this tile belongs
 *   to somebody else". It sits after `cities.js` because a border is a function of the
 *   cities' culture, and `withOwnership` is the layer's only writer.
 * - `governments.ts` — the government rows and the one read of a rate cap, a per-city
 *   free allowance, a per-unit support cost and a happiness modifier. After `state.js`
 *   (it reads a `PlayerState`) and before `economy.js`, which asks it for two of those
 *   four numbers in place of the module constants M4b declared.
 * - `culture.ts` — accumulated city culture and the **derived** player total. There is
 *   deliberately no `PlayerState.culture`; see the module note for why the derived half
 *   is the contract's own insistence rather than an optimisation.
 * - `happiness.ts` — the contentment counts and the one disorder verdict. It asks
 *   `cities.js` and `buildings.js` for what a city *is* and `governments.ts` for what
 *   its ruler does to it; `cities.ts`' `cityYields` asks it back, which is the one
 *   deliberate runtime cycle in this package and is argued where it is declared.
 * - `score.ts` — the five weighted terms, the only scorer in the engine.
 * - `victory-rules.ts` — the four thresholds, read out of the catalog, and the
 *   condition order.
 * - `victory.ts` — the conditions, the caller-relative outcome, and the one function a
 *   finished game is recognised by.
 */
export * from './borders.js';
export * from './governments.js';
export * from './culture.js';
export * from './happiness.js';
export * from './score.js';
export * from './victory-rules.js';
export * from './victory.js';
export * from './growth.js';
export * from './economy.js';
// M5's technology rules. Before `production.js`/`turn.js` in reading order because
// the research step is the pipeline's step 4 (`turn.ts` calls `applyResearch`) and the
// `SetResearch` command consults `researchProblem`; the runtime edges run
// `turn.ts → tech.ts` and `commands.ts → tech.ts`, while `tech.ts` imports
// `GameEvent` from `commands.ts` type-only, so there is no cycle at runtime.
export * from './tech.js';
export * from './production.js';
export * from './turn.js';
export * from './hut.js';
export * from './units.js';
// M6's combat resolver: the ONE statement of the odds, the modifier table and the tie
// rule. After `units.js` because it reads a unit's statistics through the same
// `UnitDef` view and is the only module that does. It imports nothing but `rng.js`
// (type and `nextBelow`), so it adds no edge to the command or turn layers — those
// call it, never the other way round.
export * from './combat.js';
export * from './commands.js';
/**
 * **M11's save, load and replay**, in reading order: the one serializer, then the thing that
 * re-runs a recorded game through the same applier.
 *
 * - `serialize.ts` — `serialize`/`deserialize` and the save format, the *only* place a save is
 *   written or read. It sits after `commands.js` in this list because it is the layer that
 *   persists what every module above it produces; the hash and the invariant registry arrive as
 *   a `SaveCodec` (this package may not depend on `@civts/testing` or `@civts/sim`, which are
 *   built on it), so the two functions are pure over what they are handed.
 * - `replay.ts` — a game as `(seed, settings, ruleset identity, command log)`, re-run and
 *   checked at every turn boundary, plus the recorder that produces such a log. It imports
 *   `serialize.ts` for the codec type alone.
 */
export * from './serialize.js';
export * from './replay.js';
export * from './actions.js';
export * from './fog.js';
export * from './textview.js';
