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

# M2 contracts — FROZEN

Status: frozen by the chief of staff. M1 shipped in `03d2064`; the signatures below
were checked against the code that actually landed (`packages/core/src/state.ts` and
friends) and are authoritative. Escalate rather than silently diverge.

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
readonly nextUnitId: number;                  // 0 at newGame, monotonic, so ids are deterministic
readonly units: readonly Unit[];              // sorted by id
readonly explored: readonly (readonly boolean[])[];  // per player, indexed by PlayerId
```

**This changes the persisted shape, so `SCHEMA_VERSION` goes 1 → 2.** Adding those
three fields changes *every* existing state hash, so the three goldens must be
regenerated **intentionally**, in the same commit, with a `rehash:` line in the
commit message explaining why. That is expected exactly once here — it is not a
determinism regression, and the golden harness must still refuse to auto-write on a
normal test run.

`SetupError` gains a variant, because `newGame` now needs a unit to place:

```ts
| { readonly kind: 'missing-unit-role'; readonly role: UnitRole }
```

Return it (never throw) when the ruleset provides no unit of the role `newGame`
places — mirroring how `missing-terrain-role` is handled today, and checked *before*
generation so the failure stays typed.

`newGame` places one starting unit per player on its `startingTile` (a unit whose
role is `settler`), marks the tiles around each start explored, and sets
`nextUnitId` past the units it created.

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
  state: GameState, playerId: PlayerId, cmd: Command, ruleset: RulesetView,
): Result<CommandOutcome, GameError>;   // CommandOutcome = { state, events }

export type GameEvent =
  | { readonly type: 'UnitMoved'; readonly unitId: UnitId; readonly from: TileIndex;
      readonly to: TileIndex; readonly cost: number; readonly movementLeft: number }
  | { readonly type: 'TurnEnded'; readonly playerId: PlayerId; readonly turn: number };

/** The single evaluator of "may this unit step here, and at what cost?" */
export function planMove(
  state: GameState, ruleset: RulesetView, unitId: UnitId, to: TileIndex,
): Result<{ readonly cost: number; readonly movementLeft: number }, GameError>;
```

**Amendment (post-review, binding).** `ruleset` is a **required** fourth parameter.
The original three-argument form was wrong: applying a command needs the destination
tile's `moveCost`/`impassable` and each unit type's `movement`, and `GameState` carries
terrain *ids* and no max-movement field, so a three-argument call cannot decide anything.
An interim implementation made the parameter optional and refused at runtime, which is
the worst outcome: it compiles, the typechecker cannot catch it, and every command
silently fails. Required means the compiler enforces what the runtime needs.

Correspondingly, **`RulesetView` carries the unit catalog** (`units: readonly UnitDef[]`,
required, mirroring `@civts/rules`' `UnitSpec`). A view without units is not a view the
engine can run a game from.

`CommandOutcome` and `GameEvent` are part of the contract, not incidental: the REPL, the
UI and the scenario DSL all consume the event list rather than re-deriving what happened.

**Note (legality vs. application).** `actor` semantics are pinned: `EndTurn` is a
world-turn advance (it refills every unit and increments `turn` once), because M2 has no
active-player field. Per-player turn order is an M5 concern.

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
   *Amended after review:* this must hold in **both** directions — nothing yielded may be
   refused, and nothing accepted may be missing from what the generator yields (an
   incomplete generator is just as broken as an unsound one, because the AI would never
   consider a legal move). An adversarial sweep found one counterexample: `legalActions`
   yielded `EndTurn`, but applying it failed when a unit's `type` was absent from the
   ruleset. That state is unreachable from `newGame` or the builder, but reachable from a
   hand-built state, a foreign ruleset view, or a future save load — so `EndTurn` must be
   **total** (refill the units it can resolve and leave the rest alone) rather than
   refusing. A generator and an applier that disagree are a latent bug, not a nicety.
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

---

# M3 contracts — FROZEN

Acceptance (PLAN.md §12): found city; food-box growth; citizen assignment on the
21-tile radius; production queue; huts grant rewards or spawn barbarians; a
growth-timing scenario.

## Provenance warning — read this before writing any number

Every terrain and unit row today is `placeholder`. M3 adds sizes, costs and
thresholds that *feel* like Civ 3 constants. **Do not present a guessed number as
Civ 3's.** The project already made this mistake once: a Civ Fanatics thread titled
"city growth mechanics" yields `20 + 2·pop`, which is **Civ IV, not Civ III**.
So: every new rules row is `placeholder`, its `provenance` detail states plainly
that the value is unsourced and chosen to be playable, and any place where the real
game is known to differ is noted. `fidelity: 'cited-only'` must keep refusing to
start. "Looks right" is not provenance.

## State shape

`PlayerId` remains the index into `players` — that invariant is load-bearing for
`explored`. Barbarians are therefore **a player**, appended by `newGame` with
`kind: 'barbarian'`, rather than a special case outside the array:

```ts
export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: string;
  readonly startingTile: TileIndex;
  readonly kind: 'civ' | 'barbarian';   // NEW
}
export function civPlayers(state: GameState): readonly PlayerState[];  // kind === 'civ'
```

`players.length === settings.civCount + 1` after M3. Anything that means "how many
civilizations" must use `civPlayers`, never `players.length`.

```ts
export interface City {
  readonly id: CityId;
  readonly owner: PlayerId;
  readonly name: string;
  readonly tile: TileIndex;                    // the city centre
  readonly population: number;                 // citizens, >= 1
  readonly foodBox: number;                    // progress toward the next growth
  readonly shields: number;                    // stored production
  readonly production?: ProductionItem;        // head of the queue; ABSENT when idle
  readonly queue: readonly ProductionItem[];   // rest of the queue, FIFO
  readonly buildings: readonly BuildingId[];
  readonly workedTiles: readonly TileIndex[];  // EXCLUDES the centre, length <= population
}

export type ProductionItem =
  | { readonly kind: 'unit'; readonly id: UnitTypeId }
  | { readonly kind: 'building'; readonly id: BuildingId };
```

`GameState` gains `nextCityId: number` and `cities: readonly City[]` (sorted by
id, as with units). **`SCHEMA_VERSION` goes 2 → 3 and every golden hash changes
again** — a second intentional rehash, same rules as M2: regenerate through the
harness's documented path, never hand-edit, and put a `rehash:` line in the commit
message. `GameMap` also gains `huts: readonly TileIndex[]` (ascending), so the map
changes too.

**Amendment (foundation integration, binding):** `production` is **optional**, not
`ProductionItem | undefined`. A required field holding `undefined` is not
serialisable — a JSON save/load round trip drops the key — so every state
containing a city was unhashable (`canonicalize` rejects `undefined` by design).
Making the field optional under `exactOptionalPropertyTypes` means "nothing being
built" is expressed by the key being *absent*, and the compiler refuses to let
anyone write the unhashable spelling again. This is the third time an explicit
`undefined` blocked hashing (see the M2 `Settings.ruleset` trap); the fix belongs
in the producer and the type, never in the hasher.

## City geometry and yields

- **Radius = 21 tiles**: every tile with `max(|dx|, |dy|) <= 2` *except* the four
  corners where `|dx| == 2 && |dy| == 2`. That is the classic shape; it is a
  `placeholder` rule, not a sourced one.
- The **centre is always worked and free** (it costs no citizen). Its yields are
  the terrain's, floored at 1 food / 1 shield / 1 commerce — placeholder.
- Each citizen works **one** tile inside the radius. `workedTiles` excludes the
  centre, so `workedTiles.length <= population`.
- A tile worked by one city may not be worked by another. Two cities of the same
  or different owners may not work the same tile; assignment must reject it.
- Yields are **integers only** (PLAN.md §5.3). Sums are plain integer addition.

```ts
// cities.ts
export function cityById(state: GameState, id: CityId): City | undefined;
export function citiesOf(state: GameState, playerId: PlayerId): readonly City[];
export function cityRadius(state: GameState, tile: TileIndex): readonly TileIndex[];
export function cityYields(state: GameState, ruleset: RulesetView, cityId: CityId):
  { readonly food: number; readonly shields: number; readonly commerce: number;
    readonly foodSurplus: number };
export function cityAt(state: GameState, tile: TileIndex): City | undefined;
export const MIN_CITY_DISTANCE = 2;   // Chebyshev; a city may not be founded closer
```

## Growth (food box)

```ts
// growth.ts
export function foodBoxSize(population: number): number;   // placeholder thresholds
export function applyGrowth(state: GameState, ruleset: RulesetView): GrowthOutcome;
```

- Each turn a city adds `foodSurplus` to `foodBox`. A surplus `>= 0` never starves.
- At `foodBox >= foodBoxSize(population)`: `population += 1` and `foodBox` carries
  the remainder over (do not silently reset it — carry-over is observable).
- A deficit draws down `foodBox`; if it would go below zero, `population -= 1`
  (never below 1) and `foodBox` restarts at 0. Emit `CityStarved`.
- Growth is applied to **every** city each turn, in city-id order, so the result
  never depends on iteration order of an object.

## Production

```ts
// production.ts
export function applyProduction(state: GameState, ruleset: RulesetView): ProductionOutcome;
export function itemCost(ruleset: RulesetView, item: ProductionItem): number;   // shields
```

- `shields += cityYields(...).shields`; at `shields >= itemCost`: complete the
  item, `shields` carries the remainder, the item is consumed from the queue and
  the next queue entry becomes `production`.
- Completing a `unit` places it on the city centre (or the first free adjacent
  tile) with full movement; completing a `building` appends to `buildings` and is
  rejected as a duplicate (building it twice is a `GameError`, not a silent no-op).
- An empty queue with `shields` stored is legal — shields just accumulate.

## Commands (added to the frozen union)

```ts
| { readonly type: 'FoundCity'; readonly unitId: UnitId }
| { readonly type: 'SetWorkedTiles'; readonly cityId: CityId; readonly tiles: readonly TileIndex[] }
| { readonly type: 'SetProduction'; readonly cityId: CityId; readonly item: ProductionItem }
```

- `FoundCity` requires a settler-role unit owned by the actor, on land, not
  adjacent to another city (`MIN_CITY_DISTANCE`), and **consumes the settler**.
  New cities get `population: 1`, a deterministic name, and their centre plus the
  best-yielding radius tiles auto-assigned.
- `legalActions` must yield `FoundCity` for a settler that can found, and must
  **not** yield it where founding is illegal — the keystone invariant (both
  directions) still applies, and it now spans three generators.
- New `GameEvent` members: `CityFounded`, `CityGrew`, `CityStarved`,
  `CityProduced`, `HutEntered`, `BarbariansSpawned`.

## Turn pipeline

`advanceTurn(state, ruleset)` in `turn.ts` must be the single definition of what
"a turn" means, and its order is part of the contract:

1. **growth** for every city (city-id order), then
2. **production** for every city (city-id order), then
3. refill every unit's movement, then
4. `turn += 1`.

`EndTurn` calls it. Resolve any disagreement about ordering here rather than in a
caller.

## Goody huts

- Huts are placed by `generateWorld` (count scales with map size — placeholder),
  sit on land only, never on a start tile, and are sorted ascending.
- A land unit entering a hut tile **consumes** it and draws a reward from the
  state RNG (so it is reproducible and advances `state.rng`): a free unit, a band
  of barbarian units near the hut, or nothing. Sea units and cities never trigger.
- Barbarian units belong to the barbarian player and are ordinary `Unit`s, so
  movement and future combat need no special case.
- `{ kind: 'gold' }` is deliberately **out of scope** in M3: there is no treasury
  until M4, and inventing one here would duplicate M4's job. Say so in the
  provenance detail rather than quietly omitting it.

## Migration owners (the F6 rule)

Any amendment or shape change in M3 must name the owner of every existing consumer
before agents launch. Current consumers that WILL need migrating, by name:
`packages/core/test/state.test.ts` (`players.length === civCount`), the goldens,
`packages/testing/test/adversarial.test.ts`, `packages/testing/test/m2-adversarial.test.ts`,
`packages/testing/test/golden.test.ts` (its `formatSetupError` switch, if
`SetupError` gains a variant), `packages/core/test/textview.test.ts` (hand-built
`GameState` literals), and the REPL transcript fixture in
`packages/headless/test/repl.test.ts`. If you are not the named owner, escalate
with the exact `file:line` and the fix recipe — do not edit it.

## M3 acceptance evidence

- `pnpm verify` green, including the both-directions keystone sweep now covering
  `FoundCity`/`SetWorkedTiles`/`SetProduction`.
- A **growth-timing** scenario asserting the exact turn a city grows, with the
  exact food box remaining, plus a starvation scenario.
- A hut scenario covering each reward branch on a fixed seed.
- The REPL can found a city and show it, and a scripted session is still a
  hash-pinned regression fixture.

---

# M4a contracts — FROZEN (workers and tile improvements)

M4 is the largest milestone, so it runs in two waves. **M4a** is workers, tile
improvements, and the yield changes they cause. **M4b** (later) is the economy:
tax/science/luxury sliders, gold, unit support, buildings & wonders v1,
road-connected resources, and the bankruptcy scenario.

Provenance rule from M3 still applies, verbatim: every new row is `placeholder`,
its detail says the value is unsourced and chosen to be playable, and no number is
presented as Civ 3's. Worker turn counts, improvement yields and terrain
restrictions are all guesses.

## Where improvements live

**Improvements go on `GameState`, not on `GameMap`.** `GameMap` stays what
generation produced (terrain + huts); improvements are gameplay state, exactly
like units and cities. Keeping that boundary means a regenerated map and a played
map are never confused.

```ts
// improvements.ts
export interface TileImprovement {
  readonly tile: TileIndex;
  readonly kind: ImprovementId;
}

// GameState gains:
readonly improvements: readonly TileImprovement[];   // sorted by (tile, kind), unique pairs
```

A tile may hold **several** improvements (a road *and* a mine), which is why this
is a list of pairs rather than one value per tile. It is a **sparse** list, not a
dense per-tile array: improvements start empty, most tiles never get one, and a
dense array of the largest map would be 32 400 entries of almost entirely nothing.
Do not use a sentinel "none" id — an absent pair *is* "nothing here".

```ts
export function improvementsAt(state: GameState, tile: TileIndex): readonly ImprovementId[];
export function hasImprovement(state: GameState, tile: TileIndex, kind: ImprovementId): boolean;
export function withImprovement(state: GameState, tile: TileIndex, kind: ImprovementId): GameState;
export function withoutImprovement(state: GameState, tile: TileIndex, kind: ImprovementId): GameState;
```

`withImprovement` is idempotent (adding an existing pair returns an equal state)
and every helper is pure. Ordering is part of the contract because it is hashed.

## Rules — improvement catalog

```ts
export interface ImprovementSpec {
  readonly id: ImprovementId;
  readonly kind: ImprovementKind;            // 'road' | 'mine' | 'irrigation'
  readonly name: string;
  readonly turns: number;                    // worker turns to complete, >= 1
  readonly yields: TerrainYields;            // delta applied to the tile it sits on
  readonly allowedRoles: readonly TerrainRole[];   // where it may be built
  readonly provenance: Provenance;
}
export const IMPROVEMENT_KINDS: readonly ImprovementKind[];
```

`validateRuleset` must reject: duplicate ids, `turns < 1`, a non-integer or
negative yield delta, an unknown kind, and an empty `allowedRoles`. `cited-only`
rejects placeholder improvements like everything else. The provenance report must
count them (the existing single-function-sections-and-totals rule).

## Yields with improvements

`cityYields` must apply improvements for a **worked** tile: base terrain yields
plus every improvement's delta, clamped at zero per component (an improvement may
never make a tile yield a negative amount). The city centre is unaffected by
improvements — it is not a worked tile. `yieldDelta` sums are integer addition.

## Workers

A worker is a unit whose role is `worker`. It improves one tile at a time, over
several turns:

```ts
export interface Unit {
  readonly id: UnitId;
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  readonly tile: TileIndex;
  readonly movementLeft: number;
  readonly work?: UnitWork;      // ABSENT when idle — never `undefined`
}
export interface UnitWork {
  readonly kind: ImprovementId;
  readonly tile: TileIndex;
  readonly turnsLeft: number;    // > 0 while in progress
}
```

Optional, not `| undefined`, for the reason M3 established the hard way: a key
holding `undefined` cannot survive a JSON round trip and makes the state
unhashable. `exactOptionalPropertyTypes` makes the mistake unrepresentable.

## Commands (added to the frozen union)

```ts
| { readonly type: 'StartWork'; readonly unitId: UnitId; readonly kind: ImprovementId }
| { readonly type: 'CancelWork'; readonly unitId: UnitId }
```

- `StartWork` requires: the unit is a worker, owned by the actor, idle, standing
  **on** the target tile (which is therefore the unit's own tile — do not add a
  target parameter, it would only invite a mismatch), the improvement is allowed
  on that terrain role, the tile is not already improved with that kind, and the
  unit has movement left. It costs the unit's remaining movement for the turn.
- `CancelWork` clears `work` and is legal only when the unit is working; it does
  **not** refund anything.
- Moving a working unit, or any other action that would relocate it, **cancels**
  its work. Say so in the event stream rather than silently dropping it.
- New `GameEvent` members: `WorkStarted`, `WorkCancelled`, `WorkCompleted`.
- `legalActions`/`unitActions` must yield `StartWork` exactly where the applier
  accepts it and nowhere else — the keystone invariant is BOTH directions and now
  spans five generators.

`advanceTurn` order gains a step, and the order is part of the contract:

1. work progress for every unit in **unit-id order** (decrementing `turnsLeft`,
   completing at zero and adding the improvement), then
2. growth for every city (city-id order), then
3. production for every city (city-id order), then
4. refill every unit's movement, then
5. `turn += 1`.

Work completes **before** growth and production deliberately: an improvement
finished this turn contributes to this turn's yields. State that reasoning in the
code, because it is observable and someone will otherwise "fix" the order.

## Acceptance evidence for M4a

- A **mine-yield scenario**: a hand-built city working a hill, asserting the exact
  shields per turn before and after a mine completes, and the exact turn it
  completes.
- A scenario asserting work is cancelled by movement, with the typed event.
- A scenario asserting an illegal `StartWork` (wrong terrain, already improved) is
  refused with the right error and leaves the state hash unchanged.
- The REPL gains worker verbs (`work`/`cancel`) and shows a unit's current job.
- Keystone sweep green with the fifth generator included.

## Migration owners (the F6 rule — do not repeat M3's omission)

Source files that consume the shapes above and MUST have a named owner before
agents launch: `packages/testing/src/scenario.ts` (builds units/states by hand),
`packages/headless/src/repl.ts` (unit rendering and verbs),
`packages/core/src/textview.ts` (unit/terrain rendering), and the hand-built
`GameState`/`Unit` literals in `packages/core/test/{state,units,commands,actions,textview,fog}.test.ts`,
`packages/testing/test/{adversarial,m2-adversarial,scenarios,hash}.test.ts` and
`packages/headless/test/repl.test.ts`. Last time I listed only the *test* files and
missed the two *source* ones; both broke.

---

# M4b contracts — FROZEN (the money loop)

The rest of M4 is split because it is genuinely large: **M4b** is the economy
(rates, treasury, upkeep, bankruptcy), and **M4c** is buildings & wonders v1 plus
resources. Provenance rule unchanged: every new row is `placeholder` and no number
is presented as Civ 3's.

## Rates and the commerce split

```ts
export interface Rates {
  readonly tax: number;       // integers, each >= 0
  readonly science: number;
  readonly luxury: number;
}
export const RATE_TOTAL = 10;   // placeholder: the three must sum to exactly this
```

`PlayerState` gains:

```ts
readonly treasury: number;    // gold, never negative
readonly rates: Rates;
readonly beakers: number;     // accumulates; MEANINGLESS until M5
readonly luxuries: number;    // accumulates; MEANINGLESS until M9
```

Each city's commerce is split by the rates. `RATE_TOTAL = 10` is a placeholder
chosen so the split is exact integer arithmetic with no rounding: `tax` tenths to
gold, `science` tenths to beakers, `luxury` tenths to luxuries, and the remainder
from integer division goes to **gold** (deterministic and stated, not "whatever
floating point did").

**Be honest about inertness.** `beakers` and `luxuries` accumulate but do nothing
until M5 (tech) and M9 (happiness). Say so in the doc comments and in the REPL,
rather than implying research or contentment is modelled.

## The money loop

Per turn, per player, in **player-id order**:

1. **income**: sum of every city's gold share, plus any building/improvement gold
   effects.
2. **upkeep**: building maintenance (M4c adds effects; M4b sums whatever
   `maintenance` the catalog already declares) plus **unit support**.
3. Unit support rule (placeholder): the first `FREE_UNITS_PER_CITY * cityCount + FREE_UNITS_BASE`
   units are free; each unit beyond that costs `UNIT_SUPPORT_COST` gold. Count only
   civilizations' units — barbarians have no economy.
4. `treasury += income - upkeep`.
5. **Bankruptcy**: if `treasury` would go below zero, it floors at 0 and the
   shortfall is paid by **disbanding units**, deterministically: repeatedly remove
   the highest-id unit of that player (barbarians excluded) until the shortfall is
   covered or no units remain, emitting `UnitDisbanded` for each. The treasury
   NEVER goes negative — assert that as an invariant, because a negative treasury
   silently breaks every later subtraction.
6. If nothing can be disbanded and the shortfall remains, emit
   `TreasuryShortfall` and record the unpaid amount in the event, rather than
   inventing a debt field.

This runs inside `advanceTurn`, after production and before the movement refill,
so a unit produced this turn costs support from the turn it appears. State that
ordering in the code.

`GameEvent` gains `IncomeCollected`, `UpkeepPaid`, `UnitDisbanded`,
`TreasuryShortfall`.

## Commands

```ts
| { readonly type: 'SetRates'; readonly rates: Rates }
```

Legal only for the actor, only for its own rates; rates must be integers `>= 0`
summing to exactly `RATE_TOTAL`, else `invalid-argument` with the actual sum in the
message. Changing rates affects **future** turns only, never the current one.

## Starting units (closes the M4a gap)

`newGame` gives each civilization a **settler and a worker** on (or adjacent to)
its starting tile; barbarians still get nothing. This is what real Civ 3 does and
it is what makes the improvement system reachable at all — without it a player
must found a city and produce a worker before it can build anything.

## Acceptance evidence for M4b

- A **bankruptcy scenario**: a player with more units than it can support loses
  treasury deterministically, disbands in the exact documented order, and never
  goes negative — asserting the exact unit ids removed and the exact final gold.
- A conservation scenario over 100+ turns: gold is accounted for (income minus
  upkeep minus spending equals the delta), and `treasury >= 0` throughout.
- A rates-split scenario: a city with known commerce yields exactly the expected
  gold/beakers/luxuries for a given rate, including the remainder-to-gold rule.
- A starting-units scenario: every civilization has exactly one settler and one
  worker, barbarians have none.
- The keystone sweep stays green **with `SetRates` covered as a queried
  generator**, not as a `legalActions` yield.

> **Amendment (mine, correcting this document).** The M4b draft said
> "`actions.ts` yields `SetRates` exactly where the applier accepts it", and the
> implementing agent declined, for two reasons that check out: (1) the committed
> adversarial sweeps require every command `legalActions` advertises to emit at
> least one event, and `SetRates` emits none; (2) enumerating the legal triples
> adds 66 options per player per call to a hot path used by the sweep and later by
> AI search.
>
> I verified the deciding fact myself rather than accepting the argument: the
> module yields **no** `SetWorkedTiles` and **no** `SetProduction` either. The
> setters have been planner-only since M3 — legality is stated once in `plan*`,
> and `actions.test.ts` sweeps the planner/applier agreement in both directions.
> So this was never a new inconsistency; it is the established pattern, and the
> draft line contradicted it. `SetRates` follows `planSetRates` and the same
> sweep.
>
> The property I actually cared about — generator/applier agreement — is still
> verified exhaustively over the whole rate space, just through the planner. The
> reworded acceptance line above is the binding one.

## Migration owners (F6 rule)

Named up front: `packages/testing/src/scenario.ts`, `packages/headless/src/repl.ts`,
`packages/core/src/textview.ts`, and the hand-built literals in
`packages/core/test/*.test.ts`, `packages/testing/test/*.test.ts` and
`packages/headless/test/repl.test.ts` — all gain `treasury`/`rates`/`beakers`/`luxuries`
on `PlayerState`, which changes every state hash again (SCHEMA_VERSION 4 → 5).

---

# M4c contracts — FROZEN (buildings, wonders, resources)

Last wave of M4. Provenance rule unchanged: every new row is `placeholder`, and no
number is presented as Civ 3's.

## Building maintenance and effects

`BuildingSpec` gains required `maintenance: number` (>= 0, integer) and
`effects: readonly BuildingEffect[]`, plus optional `wonder: true`.

```ts
export type BuildingEffect =
  | { readonly kind: 'commerce-multiplier'; readonly pct: number }   // marketplace
  | { readonly kind: 'beaker-multiplier';   readonly pct: number }   // library
  | { readonly kind: 'shield-multiplier';   readonly pct: number }   // factory
  | { readonly kind: 'growth-food';         readonly amount: number }; // granary
```

Multipliers are **integer percentages applied with a floor**, and a building's
effects apply only to its own city. `pct` must be `>= 0` and `amount` must be a
non-negative integer; `validateRuleset` rejects a negative, fractional or unknown
effect. Multiple multipliers of the same kind in one city compound by summing the
percentages first and flooring **once** — stated explicitly because flooring twice
gives a different number, and someone will otherwise "simplify" it.

`growth-food` reduces the food a city needs to grow (it is the granary), floored at
a minimum of 1 so a city can always eventually grow and cannot be made to divide by
zero.

**Maintenance must actually be reachable.** At least one shipped building declares
`maintenance > 0` in every city that can build it, so `TreasuryShortfall` becomes
reachable from real content rather than only from a hand-built ruleset view. That
gap is M4b's accepted debt and this wave closes it.

## Wonders v1

A wonder is a building with `wonder: true`. Rules, all testable:

- **Globally unique**: once ANY city anywhere holds it, no city may start it, and
  it appears in no other city's production options.
- **Never rebuilt**: there is no destruction in M4c, so "unique" and "never
  rebuilt" collapse into the same rule — say so rather than pretending otherwise.
- A wonder costs maintenance like any other building, so bankruptcy can disband it;
  if that happens it becomes buildable again. That is the one way a wonder is lost,
  so pin it.

## Resources

```ts
export interface ResourceSpec {
  readonly id: ResourceId;
  readonly name: string;
  readonly kind: 'strategic' | 'luxury' | 'bonus';
  readonly yields: TerrainYields;              // bonus only; zeros otherwise
  readonly allowedRoles: readonly TerrainRole[];
  readonly provenance: Provenance;
}
```

Placement: `GameMap` gains `resources: readonly TileResource[]` — the same **sparse
`(tile, resource)` pair** convention as improvements, sorted by `(tile, resource)`,
placed at generation on tiles whose role is allowed, never on a start tile, never on
a hut.

Connection: a resource is connected for a player if some **city of that player**
reaches the resource tile through a path of road-improved tiles (8-way, endpoints
inclusive). Deterministic BFS; no path length limit. Barbarians have no economy and
therefore no connections. State the rule once and reuse it — availability must not
be computed two different ways in two places, which is exactly the M2 bug about two
writers of the explored layer.

Gating:
- A unit whose `UnitSpec` declares `requiresResource` may only be produced by a city
  whose owner has that resource **connected**. `validateRuleset` must reject a
  `requiresResource` naming an unknown resource.
- Bonus resources add their `yields` to the tile, on top of terrain and
  improvements, and are **not** gated or connected — they are just terrain.

Luxury resources have **no happiness effect until M9**. They are placed, connected
and counted, and nothing reads them for contentment yet; say that plainly rather
than implying happiness is modelled.

## Acceptance evidence for M4c

- A building-effect scenario: exact gold/beakers/shields before and after a
  marketplace/library/factory, including the compound-flooring rule.
- A wonder scenario: a wonder started by one player disappears from every other
  city's options; a bankrupted wonder becomes buildable again.
- A resource scenario: a city connected by road to a strategic resource can build
  the unit that requires it; breaking the road (or never building it) makes the
  build illegal, with the typed error.
- A maintenance scenario: a city whose buildings outrun its income drives a real
  `TreasuryShortfall` from SHIPPED content.
- The keystone sweep green with the resource-gated production path.

## Migration owners (F6 rule)

`GameMap` gains `resources` and `BuildingSpec` gains required fields, so every
hand-built map/building literal moves, and `packages/testing/goldens/state.json`
is regenerated once more (SCHEMA_VERSION 5 → 6). Named owners:
`packages/testing/src/scenario.ts`, `packages/headless/src/repl.ts`,
`packages/core/src/textview.ts`, `packages/rules/src/index.ts`, and the hand-built
literals in `packages/core/test/*.test.ts`, `packages/testing/test/*.test.ts` and
`packages/headless/test/repl.test.ts`.

---

# STANDING REQUIREMENT — simulation-first (applies to every wave from here on)

The principal's instruction: *systems must be simulation friendly so they can be
tested and balanced.* This is not a milestone, it is a property of everything we
build from M5 onward, and it is cheapest to honour now, while the game is headless
and there is no UI to keep in sync.

Every future system must satisfy all four:

1. **Runnable without a UI, at scale, deterministically.** A game is a pure function
   of `(seed, settings, ruleset, policies)`. No wall-clock, no ambient randomness, no
   console dependency. If a system cannot be exercised headlessly, it is not finished.
2. **Observable.** A system emits structured, machine-readable state it did not have
   before, so its effect can be *measured* rather than eyeballed. "It seems to work"
   is not evidence; a metric is.
3. **Tunable.** Every magnitude it introduces lives in the rules catalog (or an
   explicit override), never as a literal buried in logic, so a value can be swept
   without editing code.
4. **Checkable in flight, not only at the end.** Its invariants are expressed as
   named predicates that a simulation can run *every turn*, so a violation is caught
   where it happens rather than at the final state.

Concretely this is delivered by a new package, **`@civts/sim`**, plus the standing
rule that **the AI is a replaceable `Policy`, never hard-wired into the engine** —
M7's self-play needs to swap strategies, and balance work needs to run the same seed
under different ones.

## `@civts/sim` contract — FROZEN

```ts
// A named, machine-checkable property of a state.
export interface Invariant {
  readonly name: string;                 // stable, kebab-case; appears in output
  readonly description: string;          // one line, plain language
  readonly check: (ctx: InvariantContext) => readonly string[];  // violations, empty = holds
}
export interface InvariantContext {
  readonly state: GameState;
  readonly previous: GameState | undefined;   // absent on the first turn
  readonly ruleset: Ruleset;
  readonly rulesetView: RulesetView;
  readonly events: readonly GameEvent[];      // what just happened
  readonly turn: number;
}
export const CORE_INVARIANTS: readonly Invariant[];
```

An invariant **returns violations, it does not throw** — so a run reports every
broken property at once instead of dying on the first. `previous` is what makes
*transition* invariants (conservation of gold, food and shields) expressible, and a
conservation invariant that cannot see the previous state is not a conservation
invariant.

**This closes M3's accepted debt**: the long-run economy checks currently live as
one-off assertions inside `m3-adversarial.test.ts`. They must be lifted here, so the
same definitions run in tests *and* every turn of every simulation.

```ts
export interface Policy {
  readonly name: string;
  readonly chooseCommands: (ctx: PolicyContext) => readonly Command[];
}
export interface PolicyContext {
  readonly state: GameState;
  readonly playerId: PlayerId;
  readonly ruleset: Ruleset;
  readonly rng: RngState;        // per-policy, derived from the seed; NEVER the state RNG
}
```

A policy draws from its **own** RNG stream, never `state.rng`. If a policy consumed
the state RNG, changing the AI would change the world, and two policies could not be
compared on the same seed — which is the whole point of having policies.

```ts
export interface SimulationOptions {
  readonly seed: number;
  readonly settings: Settings;
  readonly ruleset: Ruleset;
  readonly policies: readonly Policy[];   // by player index; barbarians are never polled
  readonly maxTurns: number;
  readonly invariants?: readonly Invariant[];
  readonly sampleEvery?: number;          // metrics sampling stride, default 1
}
export interface SimulationResult {
  readonly seed: number;
  readonly turnsPlayed: number;
  readonly finalHash: string;
  readonly finalState: GameState;
  readonly metrics: readonly TurnMetrics[];
  readonly violations: readonly Violation[];
  readonly stoppedBecause: 'max-turns' | 'violation' | 'no-commands';
}
```

`runSimulation` runs the frozen turn pipeline, polling each civilization's policy in
**player-id order**, applying commands through `applyCommand` (never mutating state
directly), advancing with `advanceTurn`, and checking every invariant every turn.
A violation is RECORDED, not swallowed, and the run stops after the first violating
turn so the state that broke can be inspected.

`TurnMetrics` (per turn, per civilization) must be enough to balance from:
population, city count, unit count, treasury, beakers, luxuries, per-channel income,
maintenance, units supported, food/shield/commerce totals, buildings held, and the
state hash. Structured, sorted keys, JSON-round-trippable.

Batch running and aggregation:

```ts
export function runBatch(options: BatchOptions): BatchResult;   // seeds, aggregate
```

`BatchResult` carries per-seed results **plus** aggregates (mean/median/min/max for
each metric, win counts when a victory condition exists), ordered deterministically.
Aggregation must never depend on object key order or on floating-point summation
order — state how you guarantee that.

## Balance knobs

`@civts/sim` provides ruleset overrides so one number can be swept without editing
the catalog:

```ts
export function applyOverrides(catalog: Catalog, patch: RulesetPatch): Catalog;
```

`RulesetPatch` is a deep-partial of the catalog by id (e.g. change one unit's cost or
one tech's price), applied **before** `validateRuleset`, so an override that would
produce an invalid ruleset fails the same way a hand-edited catalog would. Every
override is recorded in the result, because a balance number without the ruleset that
produced it is meaningless.

## Reporting

Human-readable and machine-readable output from ONE source of truth: a structured
result value plus a text renderer over it. The text renderer must never compute a
figure the structured value does not contain — that is how the M2 provenance summary
came to disagree with the CLI.

## Acceptance evidence for this wave

- The same seed and policies give an identical final hash in-process and in a fresh
  process, and a **different policy changes only the game, never the world's RNG
  stream**.
- At least one invariant is proven to FIRE: a deliberately corrupted state (or an
  override producing an invalid ruleset) is caught by name, not silently accepted.
  An invariant set that has never failed is not evidence of anything.
- A batch of 50+ games runs headlessly in a bounded time and reports aggregates.
- A balance sweep demonstrates the loop end to end: vary one catalog number, run a
  batch, and show the measured effect. This is the deliverable the principal asked
  for — the ability to *test and balance* systems, not merely to run them.

---

# M5 contracts — FROZEN (technology)

Provenance rule unchanged: every new row is `placeholder`, its detail says the value
is unsourced and chosen to be playable, and no number is presented as Civ 3's.

## The tech tree

```ts
export interface TechSpec {
  readonly id: TechId;
  readonly name: string;
  readonly era: EraId;
  readonly cost: number;                     // beakers, integer >= 1
  readonly requires: readonly TechId[];      // direct prerequisites, may be empty
  readonly provenance: Provenance;
}
export const ERAS: readonly EraId[];         // ordered, earliest first
```

`validateRuleset` must reject: a duplicate tech id, `cost < 1` or non-integer,
an unknown era, a `requires` naming an unknown tech, **and a cycle in the
prerequisites**. The cycle check is not optional — a cycle makes research
permanently unreachable, and it is the one tree defect that a play test would
never surface as an error, only as a game that quietly cannot progress.

Eras are an ordered vocabulary, not a free string. A tech's era must be reachable
from its prerequisites' eras (a tech may not sit in an earlier era than something
it requires) — again a structural check, not a runtime one.

## Research

`PlayerState` gains:

```ts
readonly techs: readonly TechId[];        // known, sorted by id
readonly researching?: TechId;            // ABSENT when nothing is being researched
```

`researching` is **optional, never `| undefined`** — the M3 rule. "Not researching"
is an absent key.

The `beakers` pool has existed since M4b and has done nothing. It now means
something, and the frozen turn pipeline gains a step. Order is contractual:

1. work progress (unit-id order)
2. growth (city-id order)
3. production (city-id order)
4. **research** — after production, because production can complete a
   science-multiplying building this turn and the M4c rule is that an effect
   finished this turn contributes to this turn
5. the money loop
6. movement refill
7. `turn += 1`

Research: accumulate the beakers the money loop has **not yet** credited — the split
happens in the money step, so research must read the pool the split just filled. If
you find that ordering makes the pool ambiguous, say so and report it rather than
picking silently; a double-credited or uncredited beaker is exactly the class of bug
the M4 conservation invariants exist to catch.

When `beakers >= cost` of the current `researching` tech: complete it (append to
`techs`, keep sorted and unique), emit `TechResearched`, **subtract the cost and
carry the remainder** into whatever is researched next. If nothing is being
researched, beakers still accumulate and are simply banked — a player may stockpile.
Completing a tech whose prerequisite list is not satisfied is impossible by
construction; assert that invariant anyway.

`GameEvent` gains `TechResearched { player, tech }`.

```ts
| { readonly type: 'SetResearch'; readonly tech: TechId }
```

Legal only for the actor, only for a tech it does not already know, whose
prerequisites it satisfies, and which the ruleset defines. Emits no event (the M3
setter precedent — setters are planner-only, reachable through `plan*`, exactly like
`SetWorkedTiles`, `SetProduction` and `SetRates`; do not add it to `legalActions`).

## Gating

A spec may declare `requiresTech?: TechId` (units, buildings, improvements) and
resources may declare `requiresTech?: TechId` (when the resource becomes visible and
connectable). Gating must be enforced in the **same place** production and build
legality are already decided, so the generator and the applier cannot disagree — the
keystone invariant is BOTH directions and this is the third gating dimension after
resources (M4c) and terrain.

`validateRuleset` rejects a `requiresTech` naming an unknown tech.

## The goldens, finally covering a real game

A golden state is `newGame` at turn 0, so **no city exists and no M3/M4 mechanic is
covered at hash level** — measured in M4c, not assumed. M5 adds at least one
**played, city-bearing golden**: a fixed seed and a fixed command script, played
enough turns to include city founding, growth, production, improvements, research
and the money loop, recording the final hash. Same rules as every golden: generated
only through the documented opt-in path, never hand-edited, `rehash:` in the commit
message, and a failure on a different engine version or Node major.

## Gate tiers (A5)

Alpha requires the fast tier ≤ 90 s and `verify:full` ≤ 10 min. The fast tier is
already ~60 s and one 200-seed sweep added ~50 s of it, so:

- **fast (`pnpm verify`)**: typecheck, lint, format:check, and the unit/scenario
  suites. Target ≤ 90 s and it must stay there as M6–M11 land.
- **full (`pnpm verify:full`)**: everything in fast **plus** the long sweeps,
  tournaments, determinism-across-processes and the UI suite. Currently an alias for
  fast — that is debt, and this wave makes it real.

Anything that runs a large batch must live in the full tier. A test that is too slow
to run is a test that gets skipped, and a gate that takes twenty minutes is a gate
people stop running.

## Acceptance evidence for M5

- A research scenario: exact turn a tech completes, with the exact beaker remainder
  carried, and banked beakers when nothing is being researched.
- A gating scenario: a tech-gated unit/building/improvement is refused with the typed
  error naming the tech before it is known, and accepted after — in BOTH the
  generator and the applier.
- A prerequisite scenario: an unmet prerequisite is refused; a completed tech
  unlocks exactly what it should and nothing else.
- A **balance sweep over a tech cost** run through `@civts/sim`, with the measured
  effect (research completion turns) reported — the milestone's balance evidence
  comes from the harness, not from eye.
- The played golden, plus the fast tier still under 90 s.

---

# M6 contracts — FROZEN (combat and barbarians)

Provenance rule unchanged: every new number is `placeholder`, unsourced, chosen to
be playable, and never presented as Civ 3's.

## Unit combat statistics

`UnitSpec` gains required: `attack: number`, `defense: number`, `hitPoints: number`
(all integers, `hitPoints >= 1`, `attack/defense >= 0`). A unit with `attack === 0`
may not attack; that is a legality rule, not a footnote.

**M6 content must actually use the gates M5 built.** No shipped row declares
`requiresTech` today, which is exactly why two gating defects survived play testing.
At least one new gated unit and one gated building/improvement must declare
`requiresTech`, and at least one unit must declare `requiresResource`, so the gates
are exercised by real content and not only by test overrides.

Terrain defence: `TerrainSpec` gains `defenseBonus: number` (integer percentage,
`>= 0`). `validateRuleset` rejects a negative or fractional bonus, a non-integer
combat stat, and `hitPoints < 1`.

## Units in play

```ts
export interface Unit {
  // ...existing...
  readonly hitPointsLeft: number;      // 1..hitPoints; a unit at 0 is DESTROYED, not stored at 0
  readonly experience?: number;        // promotions earned; ABSENT when zero — never `undefined`
  readonly fortified?: boolean;        // ABSENT when false
}
```

`experience` and `fortified` are optional-and-omitted, never `| undefined`. A unit at
0 hit points must be **removed**, not retained at 0 — a live unit with 0 HP is the
kind of state that makes every later battle wrong, so it is also an invariant.

## Combat resolution

Combat lives in `packages/core/src/combat.ts` and is the ONE statement of the odds.

```ts
export interface CombatSide { readonly attack: number; readonly defense: number; readonly bonusPct: number; }
export interface CombatResult {
  readonly rounds: number;
  readonly attackerLost: number;       // hit points lost
  readonly defenderLost: number;
  readonly outcome: 'attacker-wins' | 'defender-wins';
  readonly attackerSurvives: boolean;
  readonly defenderSurvives: boolean;
}
export function resolveCombat(ctx: CombatContext): CombatResult;   // PURE: draws from a passed RNG state
```

`resolveCombat` **takes the RNG state and returns the next one** — it does not reach
into the world. Same discipline as the rest of the engine: pure, total, integer-only.

Modifiers, all integer percentages summed then applied ONCE (the M4c compounding
rule, for the same reason — flooring twice differs):

- defender: terrain defence bonus, `+FORTIFY_BONUS_PCT` if fortified, `+CITY_DEFENSE_BONUS_PCT`
  if defending a city, `+WALLS_BONUS_PCT` if that city holds defensive walls
- attacker: `+VETERAN_ATTACK_PCT` per experience level
- the defender wins ties (state it; a tie rule that is implicit is a tie rule that
  changes when someone reorders a comparison)

## Commands

```ts
| { readonly type: 'AttackUnit'; readonly unitId: UnitId; readonly target: TileIndex }
| { readonly type: 'FortifyUnit'; readonly unitId: UnitId }
```

- `AttackUnit`: the unit is owned by the actor, has `attack > 0`, has movement left,
  and the target is **adjacent** and holds exactly one enemy-occupied thing (a unit,
  or a city). The attack consumes ALL remaining movement (attacking ends the unit's
  turn) whether or not it succeeds.
- Combat resolves unit-vs-unit. Attacking a city with a defender resolves against
  that defender; attacking an **undefended** city captures it.
- `FortifyUnit` sets `fortified`, requires movement left, costs the remaining
  movement, and is cleared when the unit moves.
- New `GameEvent` members: `CombatResolved`, `UnitDestroyed`, `UnitPromoted`,
  `CityCaptured`. `UnitDestroyed` must say *why* (combat or bankruptcy), because a
  unit vanishing with no reason is indistinguishable from a bug.
- `legalActions`/`unitActions` must yield `AttackUnit` exactly where the applier
  accepts it — the keystone invariant in BOTH directions, now an eighth generator.

## Experience and promotion

A unit that wins a combat gains one `experience` level, up to `MAX_EXPERIENCE`.
Promotion emits `UnitPromoted`. Experience never decreases and is never lost by
moving. Losing a combat that the unit survives grants nothing.

## City capture

An undefended city attacked by a unit is captured:

- ownership changes to the attacker's player
- population drops (placeholder rule: halved, floored, minimum 1)
- buildings are destroyed deterministically — the same rule as bankruptcy
  demolition (maintenance-descending), and a **wonder is never destroyed by
  capture** (it is unique; destroying it would silently make it buildable again)
- the captured city's production queue and worked tiles are cleared
- the city is NOT razed, and its tile improvements and roads stay
- emitting `CityCaptured` with the old and new owner

Barbarians may capture cities; that is the point of barbarians. A captured city's
fate must be reflected in the invariants — after capture, no invariant may be
violable merely because ownership changed.

## Barbarians are ENGINE behaviour, not a policy

`sim` policies exist for civilizations. Barbarians have no policy and must be driven
by the engine inside `advanceTurn`, deterministically:

- a barbarian unit attacks an adjacent enemy unit or undefended city when it can
- otherwise it moves toward the nearest known (to it) civilization city, breaking
  ties by ascending tile index — never by map iteration order
- barbarians never research, never build, never receive gold, and never benefit from
  another player's roads
- the step runs after the money loop and before the movement refill, and its position
  is contractual; state it in the pipeline comment

This must be deterministic and must not draw from any policy's RNG stream.

## Acceptance evidence for M6

- A combat-odds scenario: for known attack/defence/modifiers, assert the exact
  per-round win chance and the distribution over a fixed seed set, **and** assert a
  discriminating case where the compounded modifier differs from flooring twice.
- A capture scenario: exact population after capture, exact buildings destroyed, the
  wonder preserved, and the typed event.
- An experience scenario: exact promotion threshold and the exact attack bonus it
  grants.
- A barbarian scenario: engine-driven attack and approach on a fixed seed, with the
  exact tiles moved.
- A **combat balance sweep** through `@civts/sim` (`scripts/combat-balance-sweep.ts`)
  reporting measured outcomes across a modifier or stat sweep — the milestone's
  balance evidence comes from the harness.
- New invariants registered in `@civts/sim` (hit points in range, no live unit at 0
  HP, experience in range, no unit inside an enemy city it does not own), each with a
  fire case.
- A played golden that INCLUDES combat, so battles are covered at hash level.

---

# M6b contracts — FROZEN (making combat actually tunable)

Found by inspection while reviewing M6, and it is a violation of the standing
simulation-first requirement rather than a missing feature: **requirement 3 says
every magnitude a system introduces lives in the rules catalog or an explicit
override, never as a literal buried in logic.** M6 put combat's most important
numbers in `packages/core/src/combat.ts` as module constants:
`FORTIFY_BONUS_PCT`, `CITY_DEFENSE_BONUS_PCT`, `WALLS_BONUS_PCT`,
`VETERAN_ATTACK_PCT`, `MAX_EXPERIENCE`, `ROLL_BOUND`, `DAMAGE_PER_ROUND`, and the
win-percentage clamps. The combat balance sweep then had to *report* that it could
not move them. A system whose balance knobs cannot be swept cannot be balanced.

## The combat section of the catalog

The catalog gains a required `combat` section:

```ts
export interface CombatSpec {
  readonly fortifyBonusPct: number;
  readonly cityDefenseBonusPct: number;
  readonly wallsBonusPct: number;
  readonly veteranAttackPct: number;
  readonly maxExperience: number;
  readonly rollBound: number;
  readonly damagePerRound: number;
  readonly minWinPct: number;
  readonly maxWinPct: number;
  readonly provenance: Provenance;
}
```

Same values as today — this is a RELOCATION, not a rebalance, so behaviour must not
change and **the stored golden hashes must not move**. Validate every field as an
integer with the bounds each one needs (`rollBound >= 1`, `maxExperience >= 0`,
`1 <= minWinPct <= maxWinPct <= rollBound`, `damagePerRound >= 1`, the percentages
`>= 0`). `core/combat.ts` reads them **from the ruleset** and keeps NO module-level
copies; a literal left behind is exactly the bug this contract exists to prevent, so
leave nothing dual-sourced.

`RulesetPatch` gains a `combat` section (partial), so every one of these becomes
sweepable through `applyOverrides`. `scripts/combat-balance-sweep.ts` must then
demonstrate sweeping **at least one combat global** — the report currently lists
these as unsweepable, and that list should shrink to whatever genuinely cannot move.

## Two consistency repairs found during M6 review

1. **A capture does not bump `revision` and does not fold fog.** `revision` exists to
   say "the state changed"; a sack changes it more than most commands. Two sacks can
   land in one turn (a civilization's command, then the barbarian step), so this is
   reachable rather than theoretical.
2. **A veteran defender gets no bonus.** M6's contract specified
   `VETERAN_ATTACK_PCT` on the attacker only, so the implementation is correct to the
   contract — but the asymmetry is currently undocumented and a reader will assume it
   is a bug. It is a deliberate placeholder: keep the behaviour, document it where the
   odds are computed, and note what Civ 3 actually does instead (veterans get extra
   hit points, not an attack bonus) so a later reader can judge it.

## Acceptance evidence

- The golden hashes are UNCHANGED (a relocation, not a rebalance). If one moves,
  something else moved with it — report that, do not re-pin it.
- The ruleset identity hash DOES change (the catalog gained a section), so identity
  pins move deliberately and are called out.
- A combat-global sweep runs end to end and shows a measured effect, or reports
  "this proves nothing" if the knob genuinely does not matter.
- Removing the catalog values and leaving a literal in `combat.ts` must fail a test —
  prove the dual-source rule is enforced rather than merely stated.

---

# M7 contracts — FROZEN (a real opponent, and self-play)

Alpha criterion A3: *AI opponents play a complete game unaided; at least one victory
condition demonstrated ending a real game; 20-seed tournament, 0 invariant
violations, budget met.* Victory conditions arrive in M10, so M7 delivers the
opponent and the tournament machinery; the victory-ending run is demonstrated once
M10 lands.

## The AI is a `Policy`, and it must actually play

`packages/sim/src/ai/` gains a real policy (`SmartPolicy` or similar) replacing
`SIMPLE_POLICY` as the default in tournaments. It must:

- **play unaided** for a full horizon: settle, expand, work tiles, assign production,
  set rates, research with a goal, build and use military units, and respond to
  barbarians
- be **deterministic**: same seed and settings give byte-identical games, and it must
  never draw from `state.rng` (the M5 property — the AI must not be able to change
  the world)
- be **fast enough to matter**: a 20-seed tournament inside a stated budget
- be **decomposable for balance work**: its decisions read from named weights or
  thresholds that live in one place, so a balance sweep can vary them the way the
  catalog is varied. An AI whose preferences are scattered literals cannot be tuned,
  which is the same violation M6b fixed for combat.

**A policy must be shown to be playing, not merely running.** Required evidence: the
real policy must decisively beat the do-nothing baseline on a majority of seeds by
stated metrics (cities, population, techs). An AI that technically returns commands
and produces the same game as doing nothing is worse than no AI, because it looks
like an opponent.

## Self-play tournament

```ts
export interface TournamentOptions {
  readonly seeds: readonly number[];
  readonly settings: Settings;
  readonly ruleset: Ruleset;
  readonly policies: readonly Policy[];      // by seat; a policy may repeat
  readonly maxTurns: number;
  readonly budgetMs?: number;
}
export interface TournamentResult {
  readonly games: readonly SimulationResult[];
  readonly totals: TournamentTotals;         // per-seat aggregates, deterministically ordered
  readonly violations: readonly Violation[]; // MUST be empty for A3
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly withinBudget: boolean;
}
```

- Seats are assigned so the same policy plays different starting positions across
  seeds — a policy that only wins from seat 0 has not been tested.
- Aggregates are order-independent (the M4b/M5 rule) and must be stable when the seed
  list is permuted.
- **Zero invariant violations is a pass/fail condition, not a statistic.** A
  tournament that "mostly" holds invariants has found a bug; report it, do not
  average it away.
- The budget is reported honestly: if the run exceeds it, say so rather than
  trimming the seed set silently.

CLI: a `tournament` command alongside `sim`, printing per-seat aggregates and the
violation count, with `--json` for the structured result. Rendering comes from the
structured value only (the M2 rule).

## Repairs carried into this wave (standing-requirement debt)

1. `CAPTURE_POPULATION_DIVISOR` is still a literal in `cities.ts` and is listed by
   the sweep as unmovable — the same violation M6b fixed for combat. Move it into the
   catalog and make it sweepable.
2. The walls-bonus sweep was flat because the placeholder policy never fights inside
   a walled city. With a real AI reaching walled cities routinely, re-run that sweep
   and report whether it now shows an effect — and if it still does not, say whether
   that is a true finding about the knob or a limitation of the measurement.

## Acceptance evidence

- The policy beats the do-nothing baseline on a majority of seeds, by stated metrics.
- Determinism: identical seeds → identical hashes, in-process and in a fresh process.
- The 20-seed tournament runs within budget with ZERO invariant violations, and the
  result is byte-reproducible.
- Policy weights are sweepable: a sweep over one AI weight shows a measured effect.
- `CAPTURE_POPULATION_DIVISOR` is in the catalog and swept.

---

# M7b contracts — FROZEN (the gate budget, and a sane default)

## A5 is currently FAILING and the number was wrong

Alpha criterion A5: fast `pnpm verify` green in **≤ 90 s**, `verify:full` green in
**≤ 10 min**. Measured after M7, fast `pnpm verify` takes **104 s of wall time**. The
reviewing agent measured vitest's *internal* duration (65.9 s) and compared that to
the bound — the wrong number, because the bound is on the command a person runs.

Rules for this wave:

- The bound is on **`time pnpm verify`**, end to end, measured from a cold shell.
  Report wall time, never vitest's internal figure, and never a figure taken from a
  run that overlapped another job on the machine.
- Re-draw the tier boundary so the fast tier lands at **≤ 70 s**, leaving deliberate
  headroom: M8 adds a browser suite, and M9-M11 add systems. A tier that exactly
  meets its bound is a tier that is about to break it.
- `verify:full` must stay **≤ 10 min** with room left. Report its wall time too.

## The 20-seed tournament is EVIDENCE, not a gate test

A full 20-seed × 100-turn tournament measures at roughly 26 s per game, so the run
alpha's A3 requires costs about **9 minutes**. That belongs in a script whose output
is reported as evidence, **not** in the per-commit suite. The suite keeps a small
smoke tournament (a few seeds at a short horizon) that proves the machinery works and
that violations surface; the real 20-seed run is executed deliberately and its result
recorded in the docs.

Two stale claims to correct, both measured rather than guessed:

1. The tournament module documents ~7.7 s per game; the measured figure is ~26 s.
   Either re-measure and correct the arithmetic, or widen the bound deliberately —
   do not leave a number in a comment that a reader would rely on.
2. `civts run` now defaults to a ~9-minute experiment. A CLI whose plainest verb
   takes nine minutes is a footgun: give it a small, stated default and require the
   larger run to be asked for explicitly, so nobody starts a nine-minute job by
   accident while believing it is a stub.

## The AI does not besiege cities (an honest capability gap)

M7 measured 23 battles across 5 seeds and **not one targeted a city tile**, while the
AI builds walls readily. So `wallsBonusPct` still has nothing to defend in a sweep,
and the flat table is a true finding about the AI, not about the knob. The AI must
learn to attack cities — this is also what makes combat a real path to winning rather
than a way to lose units, and A3 asks for opponents that play a *complete* game.

Required: the AI besieges a city when it has the force for it, using the engine's own
combat maths for the decision (never a second implementation of the odds). Then re-run
the walls sweep and report whether it now shows an effect. If it still does not, say
which of the two it is — knob or measurement — and prove the claim.

## Acceptance evidence

- `time pnpm verify` ≤ 70 s wall, reported as the raw command output.
- `time pnpm verify:full` ≤ 10 min wall, and the gap to the bound stated.
- The fast tier still REPORTS skipped tests by name, so the split stays discoverable
  and full ⊇ fast remains structurally true.
- The 20-seed A3 tournament runs to completion with zero invariant violations, and its
  wall time and result are recorded as evidence.
- The AI attacks a city in a fixed-seed scenario, with the exact outcome asserted, and
  the walls sweep is re-run honestly.

---

# M7d contracts — FROZEN (a failure the result itself can carry)

## The gap

M7c made a thrown planner error a typed `PlannerFailure` instead of a silence, and the
verifier found the fix was real but **unwired**: the CLI prints a warning to stderr,
while `SimulationResult` and `TournamentResult` carry nothing — they are frozen and have
no failure field. So a report reader who holds only the structured result still cannot
tell a **partial turn** from a **quiet one**. That is the same silent-failure class the
fix was meant to close, one layer up.

## AMENDMENT to the frozen simulation result (F6: migration owners named)

`SimulationResult` gains:

```ts
readonly plannerFailures: readonly PlannerFailure[];
```

**Required and always present — an empty array when there are none**, exactly how
`violations` already works. Not optional, so a consumer cannot forget it, and never
`undefined`, because a key written with an explicit `undefined` is unhashable and this
project has paid for that three times.

**Migration owners, every existing consumer, named before any agent launches** (the F6
rule). Each of these constructs, transforms, or reads a `SimulationResult` and must be
updated in the same wave:

| consumer | owner duty |
|---|---|
| `packages/sim/src/runner.ts` | producer — populate from the policy's report |
| `packages/sim/src/batch.ts` | aggregate across games; keep the horizon rule intact |
| `packages/sim/src/tournament.ts` | aggregate; surface on `TournamentResult` |
| `packages/sim/src/metrics.ts` | must not silently drop the field |
| `packages/sim/src/index.ts` | export the type |
| `packages/headless/src/sim-cli.ts` | render; `--json` must carry it |
| `packages/headless/src/cli.ts` | render |
| `packages/testing/**` and `packages/sim/test/**` | any test constructing a result literal |
| `packages/testing/src/scenario.ts` | if it surfaces a result to a scenario |

`TournamentResult` gains the same, aggregated over games.

## A planner failure is a FAILED game, not a warning

A policy must be total: it has no legitimate way to throw. So a game in which the
planner threw was **not** a valid measurement of the AI, and A3 claims the AI plays a
complete game unaided. Therefore:

- a planner failure is counted like a violation, so a tournament containing one exits
  non-zero and says which game, turn and phase failed;
- the stderr warning stays, but is no longer the only evidence;
- the distinction must be provable from the result alone: a policy that legitimately
  returns no commands yields an empty `plannerFailures`; a policy that throws does not.
  A test must show both, and show that the second fails a tournament.
- re-run the 20-seed tournament and confirm zero planner failures — the A3 evidence is
  only meaningful if the AI completed every turn of every game on its own.

## Budget: restored to 900 s

The 1800 s bound was widened because the AI cost ~26-43 s per game. It now costs ~5.4 s,
so measured wall time for the full A3 run is ~110 s. The reason for widening is gone, so
the bound returns to **900 s** — with a measured 8× headroom it is a genuine runaway
detector again, where 1800 s would have tolerated a 16× regression. Single-source: the
record changes in one place and everything else follows.

## Acceptance evidence

- Both non-optional fields exist on the real results and are carried through batch,
  tournament, JSON and the CLI.
- A policy that returns no commands → empty failures; a policy that throws → a failure
  that FAILS the tournament, proven end to end through the CLI's exit code.
- The 20-seed A3 run completes with ZERO planner failures, zero violations, and its raw
  wall time under the restored 900 s bound.
- Fast gate still ≤ 70 s wall; full still ≤ 10 min.

---

# M8 contracts — FROZEN (the web UI)

Alpha criteria A1 (a human plays from the browser to a victory/defeat screen with no CLI)
and A4 (the UI covers map render + pan/zoom, unit orders, city screen, tech tree, turn/year,
event log, scoreboard, save/load, debug panel). Victory and defeat screens arrive with M10,
so M8 delivers playability and A1 is verified once M10 lands.

## Where it lives, and where the game runs

A new package `packages/web` (fits the existing `packages/*` workspace glob — no workspace
change needed). **The game runs IN THE BROWSER.** `@civts/core` and `@civts/rules` are pure
TypeScript with no Node dependencies, so the browser is the engine host: no server-side game
state, no second copy of the rules. A server that owned state would let the UI and the engine
disagree — the command-versus-generator lesson at a new layer — and M2/M4c/M5 have now found
that class of defect four times.

The dev/preview server serves STATIC FILES ONLY, binds `127.0.0.1`, and must **not** use port
3080 (the DSH GUI). Use **4174**. Port 3080 is never touched, never restarted, never proxied.

Dependencies are authorized for this milestone ONLY: `vite` and `@playwright/test` as dev
dependencies of `packages/web`. Install non-interactively (`pnpm add -D --filter`), never
`pnpm install` at the root. The Playwright Chromium binary is already cached at
`~/.cache/ms-playwright/chromium-1243`; **if the installed `@playwright/test` expects a
different revision, do NOT download browsers** — drive the already-installed Google Chrome
(`channel: 'chrome'`) instead, and say which you used.

## The UI must not contain game rules

Every action goes through `legalActions` / `applyCommand`. The UI may not compute legality,
costs or outcomes, and may not offer a control whose action the engine would refuse. This is
the keystone invariant at the presentation layer and it is directly testable: **every control
the UI offers must be accepted by the engine, and every action the engine accepts for a unit
or city must be reachable** from the UI for that unit or city.

## The test seam (frozen — the Playwright suite depends on it)

The app exposes exactly this on `window`:

```ts
interface CivtsTestApi {
  readonly ready: boolean;                       // true once the first frame is drawn
  state(): unknown;                              // the AUTHORITATIVE state object
  stateHash(): string;                           // the same hash the engine's goldens use
  dispatch(action: unknown): 'ok' | 'refused';   // through the real applier, no bypass
  actionsFor(unitId?: number, cityId?: number): unknown[]; // exactly the engine's list
  settings(): unknown;
  seed(seed: number, options?: unknown): void;   // new game, deterministic
  draws(): number;                               // monotonically increasing render counter
}
```

Namespace it `window.__CIVTS__`. Tests assert against THIS, never against a guess derived
from pixels or from a panel's text. `dispatch` must return `'refused'` rather than throw, so a
test can prove a refusal was the engine's.

## The accessibility contract (frozen — the interface between UI and tests)

Tests target by ROLE and ACCESSIBLE NAME, never by CSS class or DOM position, so the two can
be built in parallel and the tests survive a restyle. These names are contractual:

| element | role | accessible name |
|---|---|---|
| map viewport | `application` | `Map` |
| end turn | `button` | `End turn` |
| turn indicator | `status` | `Turn` (text contains `Turn <n>`) |
| year indicator | `status` | `Year` |
| treasury/science/luxury | `status` | `Treasury`, `Science`, `Luxury` |
| event log | `log` | `Events` |
| scoreboard | `table` | `Scoreboard` |
| city list | `list` | `Cities` |
| city screen | `dialog` | `City <name>` |
| tech tree | `dialog` | `Technology` |
| save | `button` | `Save game` |
| load | `button` | `Load game` |
| debug panel | `dialog` | `Debug` |
| debug state hash | `status` | `State hash` |
| unit panel | `region` | `Units` |
| selected unit actions | `group` | `Actions for unit <id>` |

The map canvas carries an accessible description naming the visible map dimensions and the
cursor's tile coordinates, updated as the pointer moves, so map interaction is assertable
without pixels.

## Rendering, and how it is tested (§16.2)

Canvas 2D for the map; DOM for every panel. The canvas must expose a deterministic **draw
trace** through the test API — an ordered list of what was drawn for the last frame, with the
tile coordinates and terrain ids, capped and documented. Tests use it to prove the map drew
the tiles it claims, and pixel sampling to prove colours actually reached the canvas (a draw
call that never lands on screen is a rendering bug the DOM cannot reveal). Click hit-testing
converts a page coordinate to a tile through the SAME function the renderer uses — a second
inverse mapping is a bug waiting to happen and must not exist.

## A4 coverage — every item needs at least one named e2e assertion

map render + pan/zoom · unit orders (move, found city, work, fortify, attack) · city screen
(worked tiles, production, queue) · tech tree (research selection, known/available/locked) ·
turn/year indicator · event log · scoreboard · save/load round-trip preserving the state hash ·
debug panel. Save/load writes to `localStorage` and must round-trip `stateHash()` unchanged.

## Determinism at the UI layer

A fixed seed plus a fixed script of dispatched actions must produce the same `stateHash()` as
the same script run headless through the engine — that equality is the proof the UI added no
rules. The UI introduces no randomness, no clock into the simulation, and no floating point.

## Also in this wave

H2-1 (carried from M7f, and the LAST item in that area): with one policy instance shared by
several seats that threw in different passes, a later seat's poll re-appends an earlier seat's
record under its own key, so the banner can report more planner failures than occurred. Every
printed line's own turn/phase/player is still a real throw, so the false-location defect stays
fixed; the count and the "names each (seat, pass) once" claim do not. Fix by taking only the
records minted during the current poll (snapshot `latestFailures` before each poll, or key on
the record's own `playerId` plus phase — the latter needs the runner test's `driven` fixture to
mint one record per seat).

## Acceptance evidence

- The app builds and serves on 127.0.0.1:4174; a screenshot of a played game is captured and
  Reviewed, and the runs are advisory evidence, never the primary assertion.
- The full e2e suite passes headlessly, with the count of passed tests reported.
- The keystone: no UI control offers an action the engine refuses, and every engine-accepted
  action for a selected unit/city is reachable — proven by sweeping both directions in a test.
- A scripted game through the UI produces the same `stateHash()` as the same script through
  the engine directly.
- Fast `pnpm verify` still ≤ 70 s wall (the e2e suite does NOT run in the fast tier — it is
  full-tier or its own command, and the tier split must keep reporting skips by name).
