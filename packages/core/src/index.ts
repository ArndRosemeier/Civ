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
export * from './cities.js';
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
