# INTERFACES — frozen contracts for M1

Agents implement against these exact signatures. Do not change a signature
without escalating: another workstream is coded against it, and the typechecker
is the integration mechanism.

Repo root: `/home/box/Harness/CivGlm`. Read `PLAN.md` (§5.3 determinism,
§5.4 layout) and `docs/ENGINE.md` first.

## Existing modules (already on disk — do not modify)

| File | Provides |
|---|---|
| `packages/core/src/ids.ts` | branded `PlayerId`, `UnitId`, `CityId`, `TileIndex`, `TerrainId`, … + `as*` constructors |
| `packages/core/src/result.ts` | `Result<T,E>`, `ok`, `err`, `isOk`, `isErr`, `mapResult` |
| `packages/core/src/provenance.ts` | `Provenance`, `cited`, `placeholder`, `isPlaceholder` |
| `packages/core/src/settings.ts` | `Settings`, `MapSize`, `MAP_DIMENSIONS`, `MAP_SIZES`, `DEFAULT_SETTINGS`, `parseSettings`, `loadSettings`, `SettingsIssue` |
| `packages/core/src/rng.ts` | `RngState`, `seedRng`, `nextUint32`, `nextBelow`, `nextInt`, `shuffle`, `drawMany` |
| `packages/core/src/map.ts` | `TerrainRole`, `TERRAIN_ROLES`, `TerrainDef`, `RulesetView`, `GameMap`, `tileIndex`, `indexToX`, `indexToY`, `inBounds`, `terrainAt`, `terrainAtIndex`, `neighbors4`, `neighbors8`, `distance8`, `TERRAIN_BY_ROLE` |

`GameMap` is `{ width, height, terrain: readonly TerrainId[] }` — flat row-major,
length `width * height`. x/y are **derived**, never stored.

`RulesetView` is the engine's structural view: `{ terrains: readonly TerrainDef[]; fidelity }`,
where `TerrainDef` is `{ id, role, name, moveCost, defenseBonusPct, yields:{food,shields,commerce}, impassable }`.
All RNG in `rng.ts` is **pure**: each call returns `readonly [value, nextState]`.

## Universal constraints (all workstreams)

- **Determinism.** No `Math.random`, `Date.now`, `performance.now`, `Math.pow`,
  `Math.sin`, `Math.cos`, `Math.log` anywhere in `packages/core/src` — eslint bans
  them. Integer arithmetic (incl. `Math.imul`, `Math.floor`, `Math.abs`) and
  IEEE-754 `+ - * /` are fine. Any float that influences a decision must be a
  deterministic computation of integers.
- **Strict TS.** `noUncheckedIndexedAccess` means `arr[i]` is `T | undefined` —
  handle it, don't assert. `exactOptionalPropertyTypes` is on. No `any`. No
  non-null assertions (`!`) in `src/` (they are allowed in `test/`).
- **Single writer.** Create/modify only your assigned files. Never edit another
  workstream's files; report a blocker instead.
- **Imports** use explicit `.js` extensions for relative paths (ESM + bundler
  resolution), e.g. `import { x } from './rng.js'`.
- **Before reporting done:** `cd /home/box/Harness/CivGlm && pnpm typecheck` must
  pass, and your own tests must pass via
  `npx vitest run packages/<pkg>/test/<file>.test.ts`.

## W1 — `packages/core/src/gen.ts` + `packages/core/test/gen.test.ts`

```ts
export interface GenOptions {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly civCount: number;
}

export interface GeneratedWorld {
  readonly map: GameMap;
  readonly rng: RngState;        // RNG state AFTER generation consumed its draws
  readonly starts: readonly TileIndex[];  // exactly civCount distinct, passable, on land
}

export function generateWorld(opts: GenOptions, ruleset: RulesetView): GeneratedWorld;
```

Requirements:

- Noise is **integer hash based** (hash `(x, y, salt)` with `Math.imul`), never
  the RNG stream, so terrain is position-determined and reproducible.
- Multi-octave value noise with smoothstep interpolation; a falloff term so the
  map edges tend to ocean and the landmass is coherent.
- **Choose the sea level by quantile, not a magic constant**: compute all
  elevations, sort, and set sea level so the ocean fraction is ~0.62. Then derive
  mountain/hill thresholds from land-elevation quantiles. This keeps the land
  ratio stable and makes tuning unnecessary.
- Second pass: water tile adjacent (8-way) to land becomes `coast`, else `ocean`.
- Land: highest elevations → `mountains`, next → `hills`, remainder split
  `grassland`/`plains` by a second moisture noise.
- Resolve roles to ids via `TERRAIN_BY_ROLE`. If any required role is missing
  from the ruleset, throw (W3 turns this into a typed `SetupError`).
- Starting positions: `civCount` distinct passable land tiles, spread out —
  greedy max-min distance, preferring tiles with better yields; tie-break by
  index so it stays deterministic. Consume RNG draws from a `seedRng(seed)` state
  and return the advanced state.
- Tests must assert: same seed ⇒ identical map (deep equality of `terrain`);
  different seed ⇒ different map; `starts.length === civCount`; every start is
  land and passable; starts are mutually distant (> 1).

## W2 — `packages/testing/src/{canonical.ts,hash.ts,index.ts}` + `packages/testing/test/hash.test.ts`

`packages/testing/package.json` currently depends only on `@civts/core`; add
`@civts/rules` only if you actually need it.

```ts
// canonical.ts
/** Deterministic JSON with object keys sorted recursively. Throws on
 *  undefined/function/symbol/BigInt/NaN/Infinity — state must be plain data. */
export function canonicalize(value: unknown): string;

// hash.ts
/** FNV-1a 64 over UTF-8 bytes, returned as 16 lowercase hex chars. */
export function fnv1a64(input: string): string;
/** canonicalize + fnv1a64. */
export function hashValue(value: unknown): string;
```

- 64-bit FNV via `BigInt` masked to 64 bits (`0xffffffffffffffffn`), offset basis
  `0xcbf29ce484222325n`, prime `0x100000001b3n`. Use `TextEncoder`.
- `index.ts` must re-export the existing invariant machinery **and** the new
  modules (do not drop `Invariant`, `runInvariants`, `violation`, `assertInvariants`).
- Tests: key-order independence (`{a,b}` and `{b,a}` hash equal); nested objects
  and arrays; known-answer test for `fnv1a64('')` and `fnv1a64('a')`; throws on
  `undefined` / `NaN` / `Infinity`; distinct values hash differently.
- No filesystem access in this module — pure functions only.

## W3 — `packages/core/src/state.ts` + `packages/core/src/textview.ts` + `packages/core/src/index.ts` + tests

Depends on W1's `generateWorld` (exact signature above).

```ts
// state.ts
export const SCHEMA_VERSION = 1;

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;         // "Player 1".."Player N" for M1
  readonly color: string;        // '#rrggbb', from a fixed palette, deterministic
  readonly startingTile: TileIndex;
}

export interface GameState {
  readonly schemaVersion: number;
  readonly revision: number;     // 0 at newGame; increments on every applied command (M2+)
  readonly turn: number;         // 1 at newGame
  readonly seed: number;
  readonly settings: Settings;
  readonly rng: RngState;
  readonly map: GameMap;
  readonly players: readonly PlayerState[];
}

export type SetupError =
  | { readonly kind: 'missing-terrain-role'; readonly role: TerrainRole }
  | { readonly kind: 'no-valid-starts'; readonly civCount: number }
  | { readonly kind: 'too-few-start-candidates' };

export function newGame(
  seed: number,
  settings: Settings,
  ruleset: RulesetView,
): Result<GameState, SetupError>;
```

`newGame` reads `MAP_DIMENSIONS[settings.mapSize]` for width/height and
`settings.civCount` for the player count, calls `generateWorld`, and assembles the
state. Validate that the ruleset provides every role used by generation and
return `missing-terrain-role` rather than throwing.

```ts
// textview.ts
export interface Viewport { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface DescribeOptions { readonly viewport?: Viewport; readonly showStarts?: boolean; }

export function describe(state: GameState, ruleset: RulesetView, options?: DescribeOptions): string;
```

`describe` renders a deterministic ASCII view — this is the agent's primary
"eyes" on the game, so legibility matters:

- A header line: seed, turn, map size, civ count.
- A column ruler and row numbers so coordinates are readable.
- One glyph per terrain role, with a legend below: `~` ocean, `:` coast,
  `,` grassland, `-` plains, `h` hills, `^` mountains.
- Starting tiles marked with the player number (`0`-`9`, then `*`), when
  `showStarts` is true (default true).
- No trailing whitespace; stable output for the same state (snapshot-testable).

Tests: `describe` is stable across repeated calls; viewport crops correctly and
clamps out-of-bounds; a 4x4 synthetic state produces exactly the expected glyph
grid via an inline snapshot; `newGame` is deterministic (two calls, same seed ⇒
equal `map.terrain` and equal `players`).

`packages/core/src/index.ts` must additionally export `./rng.js`, `./map.js`,
`./gen.js`, `./state.js`, `./textview.js` (keep existing exports). Watch for name
collisions — `Result`/`ok`/`err` come from `result.js`, and `map.ts` exports a
`GameMap` type, not a value named `Map`.

## W4 — goldens + CLI wiring

Files: `packages/testing/src/goldens.ts`, `packages/testing/test/golden.test.ts`,
`packages/headless/src/cli.ts`, `packages/headless/package.json` (add
`@civts/testing` if needed), and `docs/GDD.md` (only the "Not yet specified"
section's map entry).

```ts
// goldens.ts
export interface GoldenEntry { readonly name: string; readonly hash: string; }
export interface GoldenFile {
  readonly note: string;
  readonly nodeMajor: number;
  readonly entries: readonly GoldenEntry[];
}
export function goldensPath(): string;   // packages/testing/goldens/state.json
export function loadGoldens(): GoldenFile | undefined;
export function saveGoldens(file: GoldenFile): void;
```

- The golden test builds states from a small fixed list of seeds
  (`[1, 42, 1337]`, `mapSize: 'tiny'`, `civCount: 2`) via `newGame` + `CATALOG`,
  hashes with `hashValue`, and compares to the stored file.
- **On mismatch or missing file, the test must FAIL with a message that shows the
  expected and actual hash and says: regenerate intentionally and record a
  `rehash: <reason>` note in the commit message.** Never auto-write goldens
  during a test run — that would make the golden useless.
- Record `nodeMajor` (`process.versions.node` major). If the stored `nodeMajor`
  differs from the running one, fail with a clear message: a Node upgrade
  requires an intentional rehash (PLAN.md §5.3).
- Commit the generated `goldens/state.json` (it is data, not an artifact).
- Add a `map` subcommand to the CLI: `pnpm tsx packages/headless/src/cli.ts map
  --seed 42 [--map-size tiny] [--civs 2]` → parse settings, `newGame`, print
  `describe(...)` plus the state hash. Add `--width`/`--height` only if natural.
  Numeric flags must be validated (reject NaN) — no silent defaults on typos.
- Add a `map` script to the root `package.json` scripts.

## W5 — adversarial review (read-only except a new test file)

Independently try to **falsify** the implementation. Do not take the authors'
word for anything. Specifically:

- Verify determinism end to end: build the same state twice in one process and in
  a fresh process (`npx tsx -e`) and compare hashes.
- Attempt to detect a **vacuous golden**: temporarily perturb an input in memory
  (do not edit committed files) and confirm the hash actually changes. A golden
  that cannot fail is worthless.
- Confirm the eslint determinism bans actually fire: check the config covers
  `packages/core/src/**`, and state whether a banned call in that directory would
  be caught.
- Check the quantile-based sea level genuinely yields a sane land fraction for
  several seeds, and that `starts` are always valid and distinct.
- Look for `noUncheckedIndexedAccess` escape hatches, `as` casts, and `any`
  that weaken the type guarantees.
- You may add exactly one new file, `packages/testing/test/adversarial.test.ts`,
  containing any falsification tests you can make pass. Do not modify other
  files; report findings you cannot turn into a test.

Report honestly, including "no finding" where you found nothing — a fabricated
finding is worse than an empty report.

---

# M2 contracts — DRAFT (freeze before M2 agents start)

Status: drafted by the chief of staff as M2 planning. **Not yet frozen.** M1 fixes
are landing concurrently; re-read the M1 modules before implementing, and treat the
frozen M1 signatures as authoritative where they differ from anything here.

Goal of M2: the first point where the agent genuinely *plays* — units that move
under terrain rules, per-player fog, and an interactive text REPL.

## Design decisions already made (do not relitigate without escalating)

- **Units are an array, not a record.** `readonly Unit[]`, kept sorted by `id`.
  A `Record<UnitId, T>` would claim numeric keys that JSON turns into strings — a
  lie in the type. Arrays keep ordering deterministic (so hashes are stable) and
  round-trip honestly. Lookups go through a helper; an index cached by `revision`
  can be added if M7 perf budgets demand it.
- **Fog is `readonly boolean[]` per player**, length `width * height`: the
  "explored" layer. *Visible* tiles are derived each turn from unit/city positions
  and are never stored. Known debt: boolean arrays are verbose in JSON; a
  bitset-as-hex encoding is the escape hatch if saves get large.
- **Moving into an enemy-occupied tile is illegal in M2.** Attacking arrives in M6,
  so an enemy tile is simply not enterable — do not half-implement combat.
- **Movement cost is the destination tile's `moveCost`** (Civ 3 style), paid from
  `movementLeft`. Roads and rail are M4; do not add them early.

## Rules — unit catalog (`packages/rules`)

Extend `Catalog`/`Ruleset` with `units: readonly UnitSpec[]`, same provenance rule
as terrains (a `UnitSpec` without `provenance` must not compile, and `cited-only`
mode rejects placeholders). Every row is a **placeholder** until sourced.

```ts
export interface UnitSpec {
  readonly id: UnitTypeId;
  readonly role: UnitRole;            // 'settler' | 'worker' | 'scout' | 'military'
  readonly name: string;
  readonly attack: number;
  readonly defense: number;
  readonly movement: number;          // movement points per turn
  readonly cost: number;              // shields
  readonly domain: 'land' | 'sea';
  readonly requiresResource?: ResourceId;   // M4; omit for now
  readonly provenance: Provenance;
}
export const UNIT_ROLES: readonly UnitRole[];
```

`validateRuleset` must additionally reject: duplicate unit ids, non-integer or
negative stats, `movement < 1`, `cost < 1`, and a unit with `domain: 'sea'` whose
terrain entry requirements cannot be satisfied (sea units belong on water — M2
only needs the flag to be consistent, not transports).

## Core — units, movement, fog (`packages/core`)

```ts
// units.ts
export interface Unit {
  readonly id: UnitId;          // dense, assigned in creation order
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  readonly tile: TileIndex;
  readonly movementLeft: number;
}

export function unitById(state: GameState, id: UnitId): Unit | undefined;
export function unitsOnTile(state: GameState, tile: TileIndex): readonly Unit[];
export function unitDef(ruleset: RulesetView, type: UnitTypeId): UnitDef | undefined;
```

`GameState` gains (additive — every existing field keeps its meaning):

```ts
readonly nextUnitId: number;                  // monotonic, so ids are deterministic
readonly units: readonly Unit[];              // sorted by id
readonly explored: readonly (readonly boolean[])[];  // per player, indexed by PlayerId
```

`newGame` places one starting unit per player on its `startingTile` (a
`settler`-role unit), and marks the tiles around each start as explored.

## Core — commands, errors, legal actions

```ts
// commands.ts
export type Command =
  | { readonly type: 'MoveUnit'; readonly unitId: UnitId; readonly to: TileIndex }
  | { readonly type: 'EndTurn' };

export type GameError =
  | { readonly kind: 'unknown-unit'; readonly unitId: UnitId }
  | { readonly kind: 'unknown-player'; readonly playerId: PlayerId }
  | { readonly kind: 'not-your-unit'; readonly unitId: UnitId; readonly owner: PlayerId }
  | { readonly kind: 'out-of-bounds'; readonly to: TileIndex }
  | { readonly kind: 'impassable'; readonly unitId: UnitId; readonly to: TileIndex }
  | { readonly kind: 'not-enough-movement'; readonly unitId: UnitId; readonly needed: number; readonly available: number }
  | { readonly kind: 'occupied-by-enemy'; readonly unitId: UnitId; readonly to: TileIndex }
  | { readonly kind: 'invalid-argument'; readonly detail: string };

export function applyCommand(
  state: GameState, playerId: PlayerId, cmd: Command,
): Result<{ state: GameState; events: readonly GameEvent[] }, GameError>;
```

```ts
// actions.ts  — ONE source of truth for legality, shared by the AI, the UI and tests
export function unitMoveOptions(state: GameState, ruleset: RulesetView, unitId: UnitId): readonly TileIndex[];
export function unitActions(state: GameState, ruleset: RulesetView, unitId: UnitId): readonly Command[];
export function* legalActions(state: GameState, ruleset: RulesetView, playerId: PlayerId): Generator<Command>;
```

Invariants that MUST be tested:

1. **Every yielded action applies successfully.** For each action from
   `unitActions`/`legalActions`, `applyCommand` returns `ok`. This is the keystone
   property the whole AI and UI depend on.
2. `applyCommand` is pure: it never mutates its arguments (assert on a frozen
   state), and `revision` strictly increases on success and is unchanged on error.
3. Wrong-owner commands fail with `not-your-unit`, never silently apply.
4. Movement respects terrain cost, `impassable`, and `movementLeft`; a unit can
   never end on a tile it could not afford.
5. Leftover movement is preserved across turns correctly: `EndTurn` refills
   `movementLeft` to the unit's `movement` and advances `turn`.

`MoveUnit` semantics for M2: a single step to an **adjacent** tile (8-way). Path
movement is *not* required in M2; the AI can chain steps. Do not silently accept a
non-adjacent `to` — reject it as `invalid-argument` with a clear message, so the
contract stays honest. (Multi-step paths are an M7 convenience.)

## Fog

```ts
// fog.ts
export function isExplored(state: GameState, playerId: PlayerId, tile: TileIndex): boolean;
export function visibleTiles(state: GameState, playerId: PlayerId, radius?: number): readonly TileIndex[];
export function withExplored(state: GameState, playerId: PlayerId, tiles: readonly TileIndex[]): GameState;
```

Visibility radius is 2 (Civ 3-ish, placeholder provenance). Visibility is derived
on demand and **never stored** except through `explored`. Moving a unit extends
`explored`. `describe` must gain a `viewer?: PlayerId` option that renders only
explored tiles (`?` for unexplored) so the agent can inspect fog from a player's
point of view; without `viewer`, the full map renders (god mode, for debugging).

## Headless — the REPL (the agent's hands)

`pnpm play --seed 42 [--map-size tiny] [--civs 2] [--player 0]`

- Prints `describe(state, ruleset, { viewer: playerId })` after every command.
- Commands are simple words, documented by `help`: `move <unitId> <x> <y>`,
  `end`, `units`, `state`, `save <path>`, `help`, `quit`. Unknown input prints a
  helpful error and does **not** advance the game.
- `--script <file>` runs a command file and exits, printing a deterministic
  transcript — this makes a play session a regression test.
- The REPL must be **non-interactive-safe**: reading EOF exits cleanly with code 0.
- Every REPL command maps to a `Command`; the REPL never mutates state directly.

## Scenario DSL (`packages/testing`)

```ts
export interface ScenarioBuilder {
  addPlayer(name: string): ScenarioBuilder;
  fillTerrain(role: TerrainRole): ScenarioBuilder;
  setTile(x: number, y: number, role: TerrainRole): ScenarioBuilder;
  addUnit(playerIndex: number, type: UnitTypeId, at: readonly [number, number]): ScenarioBuilder;
  build(): Result<GameState, SetupError>;
}

export interface Scenario {
  readonly name: string;
  readonly settings?: Partial<...>;       // layered over DEFAULT_SETTINGS
  readonly setup: (b: ScenarioBuilder) => ScenarioBuilder;
  readonly run?: readonly Command[];
  readonly assert?: (after: GameState, ruleset: RulesetView) => readonly ScenarioAssertion[];
}

export interface ScenarioAssertion { readonly ok: boolean; readonly message: string; }

export function defineScenario(scenario: Scenario): Scenario;
export function runScenario(scenario: Scenario): ScenarioRunResult;   // { passed, assertions, finalState, hash }
```

Three scenarios must exist and pass in M2, as the milestone's acceptance evidence:
a unit crossing terrain with the expected movement cost; a unit blocked from
impassable and from enemy-occupied tiles; fog expanding as a unit moves.

## M2 acceptance criteria

- `pnpm verify` green, including the keystone property ("every legal action applies").
- `pnpm play --script <file>` produces a stable transcript, asserted by a test.
- Goldens updated **intentionally** if state shape changed, with a `rehash:` note —
  adding `units`/`explored` to `GameState` will change every existing hash, so this
  is expected exactly once, in the M2 commit.
- The three scenarios above pass and are wired into `pnpm verify`.
