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
export * from './production.js';
export * from './turn.js';
export * from './hut.js';
export * from './units.js';
export * from './commands.js';
export * from './actions.js';
export * from './fog.js';
export * from './textview.js';
