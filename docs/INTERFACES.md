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
