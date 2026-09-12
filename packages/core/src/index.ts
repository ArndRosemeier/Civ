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
export * from './actions.js';
export * from './fog.js';
export * from './textview.js';
