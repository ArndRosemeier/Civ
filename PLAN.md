# PLAN — "CivTS": a Civilization 3 clone in TypeScript

**Rev 2 (refined).** Supersedes rev 1. Status: **plan only** — no code yet.
This file is the contract a future execution goal works against. `docs/GDD.md` (numbers + provenance), `docs/ENGINE.md` (mechanics), `docs/TASKS.md` (checkbox ledger), `docs/BALANCE.md` (self-play stats) are derived at M0.

---

## 0. Revision note — what changed in rev 2 and why

Rev 1 was produced without inspecting the environment or verifying a single game fact. Rev 2 is the result of a review pass that (a) probed the actual runtime, (b) tested the plan's most load-bearing technical assumption, and (c) audited the game-data claims. Findings, in order of severity:

### 0.1 Finding — image input, its resolution, and why verification still does not depend on it

Rev 1 leaned on "render the map to PNG, then the agent inspects it with `read_image`" as *the* mechanism for playing and debugging the game. Initially that call returned `[image omitted because this model accepts text only]`.

**The cause was harness configuration, not the model.** `/home/box/.dsh/settings.yaml` declares per-model modalities: entries that support images carry an explicit `input: [text, image]` list, and models lacking it are treated as text-only by DSH, which strips attachments **locally, before any request reaches OpenRouter**. `deepseek/deepseek-v4.1-flash` had no such list, so the upstream model card was never actually exercised.

**Resolved and verified — vision works.** The principal enabled `input: [text, image]` for this model and restarted. A blind test followed: a generated image with randomised quadrant colours, a random word, and a random dot count, with ground truth written to a file deliberately left unread until after the image was described. Result: **6/6 correct** (top-left green, top-right yellow, bottom-left magenta, bottom-right orange, word `ALPHA`, 4 circles).

**Verification design still does not depend on it**, deliberately:

- Correctness criteria stay machine-checked (canvas pixel sampling, DOM/ARIA/layout assertions, coordinate hit-testing). These are deterministic, diffable, CI-friendly, and immune to a model/provider change silently removing the capability.
- Vision is the **judgement channel for aesthetics** — is the map legible, is the HUD readable, does it look like a game rather than a debug dump — where assertions cannot substitute.
- If vision disappears again, no alpha criterion breaks; only aesthetic review degrades.

UI verification stack, probed and confirmed working on this machine:

| Capability | Verified result |
|---|---|
| Headless Chromium via Playwright | downloads + launches, no sudo required |
| DOM text extraction | `"Turn 1 - Rome"` |
| Layout geometry | button box `{x:0, y:100, w:70.09, h:21}` |
| Computed styles | `rgb(17, 17, 17)` |
| **Canvas pixel sampling** | `#2a7f2a` / `#c9a227` / `#0000ff` at expected coordinates |
| Coordinate hit-testing | click at (60,50) → `{x:60, y:50}` |
| Accessibility tree, as text | `- text: Turn 1 - Rome` / `- button "End Turn"` |
| PNG output | 2900 bytes (for the human) |

Consequences:

- The **primary perception channel is text**: a deterministic text view (`describe(state, viewport)`) plus a REPL printing map + state after every command.
- **Rendering is verified by sampling**: the shared pure renderer emits a structured draw trace, and browser tests sample canvas pixels at computed tile coordinates. Both deterministic, both snapshot-testable.
- **Interaction is verified by driving**: Playwright clicks real coordinates and asserts the resulting app/engine state.
- PNG rendering stays for the *human* and for the agent's own aesthetic review (vision verified 6/6) — but never load-bearing for a correctness criterion.

### 0.2 Verified environment facts (rev 1 had these wrong)

Probed on this machine:

| Fact | Rev 1 assumed | Actual |
|---|---|---|
| Node | "Node 20 LTS" | **v24.20.0** |
| pnpm / npm | pnpm | pnpm **11.24.0**, npm 11.19.0 |
| git | unstated | 2.47.3 |
| npm registry reachable | unstated | **yes** (HTTP 200 to `registry.npmjs.org`) |
| cairo/pango system libs | unstated | present |
| `@napi-rs/canvas` | "prebuilt, prompt-free" | **confirmed**: installs in ~0.7 s, renders PNG, 5437 fonts visible |
| `read_image` usable | assumed | **yes — verified 6/6 on a blind test** (after enabling `input: [text, image]` + restart) |

Rev 2 pins Node 24 and treats the registry as available (so dependency choice is real, not hypothetical).

### 0.3 Data-provenance finding — rev 1's numbers are partly invented

Rev 1's §12 presented confident Civ 3 statistics (growth formula, unit stats, HP tiers) while containing a literal `Scout 0/1/2?` and a bare `Galley,` with no data. Worse, the review hit a real trap: a CivFanatics thread titled *"city growth mechanics"* that yields `20 + 2·pop` — which is **Civ IV**, not Civ III. Copying it would have silently encoded the wrong game. Separately, Fandom wiki pages fetched via `web_fetch` return navigation chrome rather than article bodies, so "just look it up" is not a reliable unbounded path either.

Rev 2 therefore **stops asserting unverified numbers** and introduces a mechanical honesty rule (§6.2): every data row carries a typed `provenance` field, and fidelity mode refuses to run when active rows are unsourced placeholders.

### 0.4 Defects fixed (beyond the three above)

1. **`legalCommands` does not scale** — rev 1 made a monolithic `readonly Command[]` the keystone API. Enumerating every move for every unit on a standard map is O(units × reachable tiles) per call, on every AI decision. Rev 2 splits it into lazy, per-entity generators plus a revision-keyed cache (§5.2).
2. **Determinism was overclaimed** — "same seed ⇒ identical hash" is only true within a pinned runtime; transcendentals (`Math.pow`, `sin`, `cos`) and float formatting vary across engines/versions. Rev 2 mandates integer-only economy math, bans transcendentals in core, and scopes goldens to a recorded Node major (§5.3).
3. **The verify gate was too slow to run per commit** — rev 1 put a 3-minute AI game inside the every-commit gate, which would dominate an autonomous loop. Rev 2 tiers it (§10).
4. **Missing mechanics that make the project actually work**: barbarians, goody huts, rivers, unit support costs, a defined score formula, and Civ 3's real victory conditions (rev 1 substituted a generic "score"). Without barbarians, early military AI is untested and self-play is degenerate (§12).
5. **No scenario-construction API** — rev 1 required scenarios everywhere but never said how an arbitrary state is built. Rev 2 adds a typed scenario DSL (§8.3).
6. **Perf/architecture hand-waving** — no fog-update strategy, no pathfinding cache, no thought about shipping state to the UI worker. Added (§5.4).
7. **Subagent write conflicts** — three subagents plus the main agent editing `docs/TASKS.md` guarantees conflicts. Ownership rules added (§11).
8. **Playability arrived late for a self-debugging agent** — rev 1's first playable point was M6. Rev 2 moves an interactive text REPL to **M2**, so the agent starts genuinely *playing* the game almost immediately.

---

## 1. Vision & faithfulness

Turn-based 4X in the spirit of Civilization III: square tiles, stacking units, 21-tile city radius ("big fat cross"), culture borders, governments, wonders, tech ages.

- **Faithful where cheap:** movement, stacking, city radius, combat formula *shape*, culture thresholds, terrain yields.
- **Approximate/simplified in v1:** corruption, diplomacy, culture flips, espionage.
- **Fidelity is a mode, not a promise.** A `Ruleset` carries per-row provenance; see §6.2. We tune by self-play and label what is tuned.

Design principles (non-negotiable):

1. **Engine first, UI second.** Headless-playable before any pixel.
2. **The agent is the primary player/tester, and it reads text.** Every gameplay fact the agent needs must be expressible as text and checkable as an assertion.
3. **Determinism within a pinned runtime:** same seed + same commands ⇒ same state.
4. **No stringly-typed anything, no `any`.**
5. **Every commit is green**, via a fast tier of `pnpm verify`, fully non-interactive (approval policy here is *never*: pinned lockfile, prebuilt binaries only, `vitest --run`, no watch modes, no interactive CLIs).

## 2. Non-goals (v1)

- Multiplayer/networking; pixel-perfect Civ 3 art; animation-heavy UI; sound.
- Full corruption model, city culture-flipping, espionage, full diplomacy (stretch).
- Mod/content packs loaded at runtime (stretch).
- Bit-exact Civ 3 reproduction (see §6.2 — we track provenance instead of pretending).

## 3. Tech stack & repo layout

| Choice | Value | Note |
|---|---|---|
| Runtime | **Node 24.x** (pin exact via `.nvmrc` + `engines`) | matches this machine (v24.20.0) |
| Package manager | pnpm 11 workspaces | verified 11.24.0 |
| Language | TypeScript ≥ 5.6, strictest flags | §4 |
| Test | Vitest + fast-check | property tests |
| Lint/format | eslint (typescript-eslint strict-type-checked) + Prettier | enforces determinism bans |
| Validation | valibot (zod acceptable) | parse-don't-validate |
| Text view | hand-rolled ANSI/ASCII renderer | **primary perception channel** |
| Image view | Canvas 2D, isomorphic; `@napi-rs/canvas` in Node | verified working; non-load-bearing |
| Web shell | Vite + Web Worker | engine never mutated by UI |

```
packages/
  core/       pure deterministic engine — ZERO runtime dependencies
  rules/      typed content + PROVENANCE metadata for every row
  ai/         agents v0/v1/v2 + personalities
  renderer/   text view (primary) + isomorphic Canvas 2D (secondary)
  headless/   CLI: play (REPL), run, replay, inspect, scenario, probe, bench, fixture:add
  ui/         Vite web app (worker-wired)
  testing/    invariants, goldens, fixtures, generators, scenario DSL
docs/         PLAN.md, GDD.md, ENGINE.md, TASKS.md, BALANCE.md
```

## 4. Type safety

### 4.1 Compiler config (`tsconfig.base.json`)

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

Plus eslint `no-restricted-globals`/`no-restricted-properties` in `packages/core` banning `Math.random`, `Date.now`, `performance.now`, **and `Math.pow`/`Math.sin`/`Math.cos`/`Math.log`** (determinism, §5.3).

### 4.2 Nominal IDs

```ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type PlayerId  = Brand<number, "PlayerId">;
export type UnitId    = Brand<number, "UnitId">;
export type CityId    = Brand<number, "CityId">;
export type TileIndex = Brand<number, "TileIndex">; // y * width + x, row-major
```

Type-level tests (`expectTypeOf`) assert these are mutually unassignable — a `CityId` must never satisfy a `UnitId`.

### 4.3 State is plain serializable data

`Record<BrandedId, T>` (not `Map`): trivial JSON round-trip, and `noUncheckedIndexedAccess` forces `undefined` handling at every lookup.

### 4.4 Commands & events are exhaustive unions

```ts
export type Command =
  | { readonly type: "MoveUnit";      readonly unitId: UnitId;  readonly to: TileIndex }
  | { readonly type: "FoundCity";     readonly unitId: UnitId }
  | { readonly type: "SetProduction"; readonly cityId: CityId;  readonly item: ProductionItem }
  | { readonly type: "AssignCitizen"; readonly cityId: CityId;  readonly work: TileIndex }
  | { readonly type: "SetResearch";   readonly techId: TechId }
  | { readonly type: "Attack";        readonly from: TileIndex; readonly to: TileIndex }
  | { readonly type: "Fortify";       readonly unitId: UnitId }
  | { readonly type: "SetSliders";    readonly tax: number; readonly lux: number } // sci = 100 - tax - lux
  | { readonly type: "SwitchGovernment"; readonly govId: GovernmentId }
  | { readonly type: "EndTurn" };

export type GameEvent =
  | { readonly type: "CityFounded";    readonly cityId: CityId; readonly playerId: PlayerId }
  | { readonly type: "CombatResolved"; readonly result: CombatResult }
  | { readonly type: "CityGrew";       readonly cityId: CityId; readonly newPop: number }
  | { readonly type: "TechResearched"; readonly playerId: PlayerId; readonly techId: TechId }
  | { readonly type: "UnitDestroyed";  readonly unitId: UnitId; readonly cause: DeathCause };
```

Consumers switch exhaustively with `assertNever`. `applyCommand` returns `Result<{ state, events }, GameError>`; exceptions are not control flow.

`GameError` is itself an exhaustive union — `IllegalCommand`, `NotEnoughMovement`, `OccupiedByEnemy`, `InsufficientFunds`, `UnknownEntity`, `PrereqMissing` — so the AI and UI react to *reasons*, not strings.

### 4.5 Typed content + provenance

Content is authored with `defineUnit(...) satisfies UnitSpec` helpers so typos fail at compile time, then cross-validated once at load (`loadRuleset(data): Result<Ruleset, RulesetError>`):

- tech prerequisites form a DAG (cycles, unknown refs, unreachable techs → typed errors naming the offending path),
- unit upgrade chains and unique units reference real ids,
- every `requiresTech` / `requiresResource` exists,
- **every row carries `provenance`** (§6.2).

### 4.6 Settings — the explicit requirement

One valibot schema in `packages/core/settings.ts`. Pipeline: `DEFAULT_SETTINGS` → JSON file layer → CLI layer → pure typed merge → **parse** (unknown keys rejected, ranges enforced, brands applied). Post-parse `Settings` is immutable, with no `as` casts beyond branding at the boundary.

```ts
const MAP_SIZES = ["duel", "tiny", "small", "standard", "large", "huge"] as const;
export type MapSize = (typeof MAP_SIZES)[number];

const SettingsSchema = v.object({
  mapSize: v.picklist(MAP_SIZES),                                  // enum, never a bare string
  civCount: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(16)),
  seed: v.pipe(v.number(), v.integer()),
  difficulty: v.picklist(["chieftain","warlord","regent","monarch","emperor","deity"]),
  fidelity: v.picklist(["tuned", "cited-only"]),                    // §6.2 gate
  ai: v.object({
    aggression: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    expandFast: v.boolean(),
  }),
  debug: v.object({ cheats: v.boolean(), revealMap: v.boolean() }),
  ruleset: v.optional(v.string()),
});
export type Settings = v.InferOutput<typeof SettingsSchema>;
```

Rules:

- Enums are `as const` tuples with derived unions — never `string`.
- Interdependent constraints (`civCount ≤ mapSize.maxCivs`) via `refineSettings(s): Result<Settings, SettingsIssue[]>`.
- `DebugCommand` (spawn unit, grant tech, reveal map, teleport) is a **separate typed union** accepted only by `applyDebugCommand` when `settings.debug.cheats` is on — normal play cannot even express a cheat.
- `fidelity: "cited-only"` makes the engine **refuse to start** if any active data row is a placeholder (§6.2). Type-safe honesty.

## 5. Engine architecture

### 5.1 Core API

```ts
newGame(seed: GameSeed, settings: Settings, ruleset: Ruleset): Result<GameState, SetupError>
applyCommand(state, playerId, cmd: Command): Result<{ state: GameState; events: readonly GameEvent[] }, GameError>
applyDebugCommand(state, cmd: DebugCommand): Result<{ state: GameState; events: readonly GameEvent[] }, GameError>
advanceTurn(state): Result<{ state: GameState; events: readonly GameEvent[] }, GameError>
```

`advanceTurn` is the reducer: upkeep → growth/starvation → production → research → barbarians → next player.

### 5.2 Legal-action API (scales; replaces rev 1's monolithic call)

```ts
// lazy: never materializes the whole space
export function* legalActions(state: GameState, playerId: PlayerId): Generator<Command>;

// hot paths, cached per (entity, stateRevision)
export function unitMoveOptions(state: GameState, unitId: UnitId): readonly TileIndex[];
export function unitActions(state: GameState, unitId: UnitId): readonly Command[];
export function cityActions(state: GameState, cityId: CityId): readonly Command[];
```

- `GameState.revision: number` increments on every applied command; caches key on it and are dropped on mismatch.
- The UI derives enabled/disabled buttons from `unitActions`/`cityActions`; the AI drives from the same functions — **one source of truth for legality**, so UI and AI cannot disagree with the engine.
- Property tests assert *every* yielded action applies successfully; exhaustive enumeration on tiny maps only, sampled (K per state) otherwise.

### 5.3 Determinism

- RNG (PCG/xorshift, integer) lives **inside** `GameState`; no ambient randomness. Every iteration tie is broken explicitly by id.
- **Integer-only economy math** (food, shields, commerce, gold, beakers, culture). No floats in authoritative state.
- Transcendentals banned in core (lint). Any needed noise uses integer hash-based value noise.
- Canonical JSON: sorted keys, integer numeric fields, NaN/±0 guards → FNV-1a 64 hash, implemented **outside** `core` (headless/testing).
- **Scope of the guarantee:** identical hashes are guaranteed for a pinned `(engine version, Node major)`. Golden files record `nodeMajor`; a Node upgrade requires intentional rehash. Rev 1's cross-platform claim was unjustified.
- Saves: `GameState` JSON + `{ schemaVersion, engineGitSha, rulesetHash, nodeMajor }`; typed `Migration[]` chain from day one.

### 5.4 Performance & data layout

- Map layer: `Int32Array`/`Uint8Array` typed arrays for terrain, improvements, owner, explored bits (16k tiles on a standard map).
- Entities (units/cities) stay `Record`-based — small N, JSON-friendly.
- Pathfinding: A*/Dijkstra over a precomputed integer cost grid per player-turn; movement options computed once per unit per turn, not per query.
- Fog: incremental dirty-tile propagation on unit move / city change, not a full recompute every turn.
- UI transport: send **events + derived view models**, not the whole state per turn (structured-cloning 16k tiles per turn is wasteful).
- The caching layer is pure and derived — never serialized into saves.

## 6. Rules data & provenance discipline

### 6.1 Layout

`packages/rules` exports immutable catalogs (terrains, units, buildings, wonders, techs, civs, resources, governments); `loadRuleset` validates once and everything downstream references ids. This is what makes later "exact-Civ3 number packs" possible without touching engine code.

### 6.2 Provenance — the honesty rule (new in rev 2)

Every content row carries:

```ts
export type Provenance =
  | { readonly kind: "cited";       readonly source: string; readonly note?: string } // source = URL/page/section
  | { readonly kind: "placeholder"; readonly note: string };                          // tuned by us, not Civ3
```

Enforced at load and in CI:

- `loadRuleset` fails if provenance is missing (type-required, so this is a compile error too).
- `settings.fidelity === "cited-only"` ⇒ **startup refuses** if any *active* row is `placeholder`.
- `pnpm rules:provenance` prints a cited-vs-placeholder table; the ratio is tracked in `docs/GDD.md`, so fidelity progress is visible rather than assumed.
- A `rules:audit` task (M1) records, for each mechanic, either a citation or an explicit "placeholder, tuned by self-play". **Known trap to avoid:** Civ IV's `20 + 2·pop` growth formula is not Civ III — the audit must verify the *game* as well as the number.

### 6.3 Victory conditions

Rev 1 shipped a generic "score" victory. Civ 3's actual set must be *verified from an authoritative source* during M10 (believed to include conquest, domination, cultural, spaceship/scientific, and diplomatic/score variants) rather than asserted here. Until then they are placeholders under §6.2.

## 7. AI & self-play

| Agent | Behavior | Purpose |
|---|---|---|
| **v0 random** | uniform over `legalActions` | oracle: must never crash, cheat, or stall |
| **v1 scripted** | explore (frontier A*), settle (tile scoring), build queue (defense > growth > infra), military (defend, hunt barbarians, war when favored × `ai.aggression`), research (greedy toward unlocks), citizens (best-yield tiles) | workhorse for self-play |
| **v2 search** | 1-ply evaluation over `unitActions` in hot spots (combat target, settle site) | quality bump, still cheap |

- **One score function** shared by AI evaluation and end-of-game ranking (§13) — prevents "AI optimizes something the game doesn't award".
- Personalities = typed weight configs (`aggression`, `expandFast`, `techFocus`).
- **Self-play harness:** N seeds → per-turn JSONL telemetry → `docs/BALANCE.md` report (game-length distribution, victory spread, unit churn, per-civ win rates).
- **Invariant checker runs every turn**: no negative stockpiles, units on legal tiles, pop matches food/assignments, production ≥ 0, no orphan ids, no fog leaks into AI decisions, **no placeholder row silently active in cited-only mode**. Violations auto-capture `{seed, settings, commands}` as a fixture.
- **Perf budgets (full tier only, §10):** 6 civs / standard map / 540 turns ≤ 3 min; ≥ 1000 turns/s on tiny; bench fails at +25% over baseline.

## 8. Debug & agent-in-the-loop tooling

### 8.1 Text perception (primary, replaces rev 1's screenshot loop)

| Command | Purpose |
|---|---|
| `pnpm play --seed 42` | **interactive text REPL**: prints map + state, agent types commands, engine responds — the agent literally plays the game |
| `pnpm play --script session.txt` | same session, scripted and reproducible (regression-friendly) |
| `pnpm run --seed 42 --jsonl out.jsonl` | full AI-vs-AI game + telemetry + invariants |
| `pnpm inspect save.json --turn 137 --player 1 --slice units` | structured JSON dump of any state slice |
| `pnpm probe save.json --turn 137 --assert "city:1.pop==3"` | **machine-checked assertions about a game state** — the replacement for "looking at it" |
| `pnpm replay out.jsonl` | re-simulate and assert the state hash matches every turn |
| `pnpm scenario <name>` | scenario-suite entry point (§8.3) |
| `pnpm fixture:add out.jsonl` | convert a failing game into a regression test automatically |
| `pnpm bench` | perf budgets |
| `pnpm render --png turn137.png` | PNG for the **human** / optional vision reviewer — never load-bearing |

The text view must be good enough to substitute for eyes: full map grid with legend, per-tile annotation on demand (`--focus 12,7`), a side panel of units/cities/yields, and deterministic output so it can be snapshot-tested.

### 8.2 Dev loop

**play (text) → assert (`probe`/`scenario`) → reproduce by seed → fix → the seed becomes a test.** Every bug found by gameplay ends as an automated scenario.

### 8.3 Scenario DSL (new in rev 2)

Typed builder so scenarios are data, not bespoke code:

```ts
defineScenario({
  name: "city-grows-in-8",
  settings: { mapSize: "tiny", fidelity: "tuned" },
  map: { width: 12, height: 12, terrain: "grassland" },
  setup: (s) => s
    .addPlayer("Rome")
    .addCity("Rome", { at: [6, 6], pop: 1, foodStored: 0, works: [[6, 7]] }),
  run: ["EndTurn", "EndTurn"],            // or a scripted command list
  assert: (after) => [after.city("Rome").pop === 2, after.turn === 3],
});
```

## 9. Web UI (v1, utilitarian)

- Engine in a Web Worker; UI sends `Command`s and receives events + view models. Selection/camera are UI-local.
- Screens: map (pan/zoom, top-down first), unit panel (buttons from `unitActions`), city screen (citizens, queue, yields), tech tree, minimap, event feed, score board.
- Debug panel: state inspector, RNG state, event log, gated cheat buttons, save/load, replay scrubber (time travel = replay a command prefix).
- The human user can watch/play here; the agent verifies the same rendering via text view + probes.

## 10. Testing & tiered verification (new in rev 2)

| Tier | Contents | Budget | When |
|---|---|---|---|
| `pnpm verify` | typecheck (`tsc -b`) + lint + unit + sampled property tests + scenarios + short goldens (≤50 turns) | **≤ 90 s** | every commit |
| `pnpm verify:full` | + 20-seed tournaments + long goldens (540 turns) + bench budgets + provenance audit | ≤ 10 min (background job) | milestone boundaries |

- **Unit tests** per rule.
- **Property tests** (fast-check): every yielded action applies; arbitrary sequences preserve invariants; save/load round-trip preserves hash; same seed+commands ⇒ same hash; `unitActions`/`legalActions` never disagree.
- **Type-level tests**: branded ids mutually unassignable; settings inference exact; command switches exhaustive.
- **Golden replays**: fixed seeds + scripts, hashed every 50 turns, recording `nodeMajor`. Shifting a hash requires an intentional `rehash: <reason>` commit note.
- **Scenario suite** doubles as milestone acceptance.
- 100% non-interactive (required: approval prompts are disabled here).

## 11. Automation playbook

- Start with `create_goal`: *"implement CivTS per PLAN.md through M10, fast `pnpm verify` green at every commit"*. Milestones tracked with `todo_write`; `docs/TASKS.md` is the checkbox ledger.
- Per work item: pick task → implement → `pnpm verify` (background if slow) → collect `job_output` → update ledger → conventional commit.
- **Ownership rules (fixes rev 1's conflict risk):** only the main agent writes `PLAN.md`, `TASKS.md`, `GDD.md`. Subagents return results or write to **disjoint files** (one content file per subagent). No two writers on one file; no subagent edits `core` concurrently with the main agent.
- Delegation: main agent owns `core` for coherence; subagents for (a) content authoring + provenance research, (b) adversarial review of formulas, (c) independent test authoring.
- Guardrails: never weaken a failing test without written justification; never commit red; rehash requires a recorded reason; no interactive tooling; keep lockfile pinned.
- **Decision authority & escalation:** the agent decides everything cheap and reversible — naming, file layout, internal APIs, tuning constants, test structure, task decomposition — and records the choice in the ledger. Escalate to the principal only when: (a) scope or fidelity ambition changes, (b) a public engine contract or save format changes incompatibly, (c) cost moves beyond local compute, or (d) two options produce materially different user-visible outcomes. Every escalation carries a recommendation *and* a default, so no answer still means progress. Never escalate a bare question.
- **Status contract:** report at milestone granularity (or immediately on a blocker, a scope risk, or a finding that invalidates earlier work). Bad news is reported first and with its evidence, never deferred to a tidy moment.

## 12. Milestones

| # | Milestone | Size | Acceptance criteria (automated) |
|---|---|---|---|
| M0 | Tooling & skeleton | S | workspaces + strict tsconfig + vitest + eslint; tiered `verify`/`verify:full` both green on skeleton; docs stubbed; Node 24 pinned; zero interactive steps |
| M1 | Core types, RNG, map gen, provenance | M | branded ids; `GameState`; seeded terrain/starts; text renderer v0; `loadRuleset` enforces provenance; `rules:provenance` table; same seed ⇒ same hash; golden #1 |
| M2 | Units, movement, fog, **text REPL + scenario DSL** | M | MP/terrain costs; Civ3-style stacking (no passing through enemies); per-player fog; **`pnpm play` REPL works and the agent completes a scripted session**; scenario DSL with 3 passing scenarios |
| M3 | Cities v1 + goody huts | M | found city; food-box growth; citizen assignment on 21-tile radius; production queue; huts grant rewards/spawn barbs; growth-timing scenario |
| M4 | Economy & improvements | L | workers (road/mine/irrigate); yields; tax/sci/lux sliders; gold; unit support; buildings & wonders v1; luxury/strategic resources (road-connected); mine-yield + bankruptcy scenarios |
| M5 | Tech tree | M | ~40 techs / 4 ages with provenance rows; DAG validated; research choice; unlocks; graph check (no unreachable/duplicate); AI completes a full tree |
| M6 | Combat + barbarians | M | A/D, HP by experience, round resolution, terrain/fortify/veteran modifiers, retreat; **barbarian camps spawn and raid**; statistical tests vs analytic expectation on fixed seeds |
| M7 | AI v1 + self-play harness | L | scripted agents; tournament runner; telemetry; invariant checker; fixture generator; **20 full games, 0 invariant violations, budget met**; first `BALANCE.md` |
| M8 | Web UI v1 | L | worker-wired; map render/pan/zoom; unit orders from `unitActions`; city screen; research picker; end turn; debug panel v1; UI emits Commands only (type-enforced) |
| M9 | Culture, borders, governments, happiness | L | border expansion at culture thresholds; simplified culture pressure; government effects; luxury/happiness loop; leader/Golden Age; border + government scenarios |
| M10 | Victory & endgame | M | verified Civ 3 victory set; shared score function; end screen + summary JSON; AI games declare a winner |
| M11 | Save/load, replay, polish | M | autosave; replay scrubber; migrations; perf pass; round-trip hash property test; 10-seed replay determinism |
| M12+ | Stretch | — | diplomacy-lite; city flips; corruption; iso renderer + sprites; mod packs; difficulty handicaps; auto-explore/auto-improve; unit undo; bigger tournaments |

**Revised playability ladder (fixes rev 1's late payoff):** the agent is *playing* in **M2** via the text REPL; a human can play in **M8**; end-to-end self-verification lands in **M7/M10**.

## 13. Score & victory (shared function)

`score(state, playerId): ScoreBreakdown` returns typed components (territory, population, techs, wonders, culture, military) so the AI, the UI scoreboard, and the end-game ranking all read one function. Component weights are `placeholder` provenance until tuned by tournaments; target: no single component dominates (verified by a balance test asserting win-rate sensitivity to each component).

## 14. Risks

| Risk | Mitigation |
|---|---|
| **Image input gated by harness config** — found in review | resolved: modality enabled + restart, vision verified 6/6 by blind test. Correctness still never depends on it: **UI verified via Playwright (DOM/layout/ARIA text + canvas pixel sampling at tile coords + coordinate hit-testing)**; vision is the aesthetics channel only |
| **Fidelity theatre** — shipping wrong-game numbers (Civ IV `20+2P` trap) | mandatory `provenance` rows; `cited-only` mode refuses placeholders; `rules:audit` verifies the *game* as well as the value |
| Scaling of legality enumeration | lazy generators + revision-keyed caches (§5.2) |
| Determinism overclaim | integer-only math, banned transcendentals, `nodeMajor` in goldens |
| Slow verify dominating the dev loop | tiered verify (§10) |
| Scope creep | vertical slices; text REPL at M2; UI at M8; rest is stretch |
| AI degenerate (no military pressure) | barbarians in M6; tournaments with invariant checks |
| Subagent write conflicts | single-writer ownership rules (§11) |
| Perf regressions | budgets in full tier; typed-array map layer |

## 15. Open decisions (defaults chosen)

1. **Perception:** text-first; PNG retained for humans/optional reviewer. *(rev 2 default — forced by the text-only finding)*
2. **Renderer:** Canvas 2D isomorphic; PixiJS deferred.
3. **Validation:** valibot (zod acceptable).
4. **Node 24.x pinned** to this machine; `engines` + `.nvmrc` + lockfile.
5. **Faithfulness:** mechanics-first; every number either cited or explicitly placeholder-tuned.
6. **UI engine transport:** events + view models (not full-state per turn).

## 16. Alpha definition — the stop condition

Instruction from the principal: coordinate the project to **alpha stage**, then stop and ask for feedback. This section fixes what "alpha" means so that stopping is a checkable event rather than a judgement call, and so no beta work begins without direction.

**Alpha = the whole core loop is present, integrated, and playable by a human from the browser.** Balance, polish, and Civ 3 fidelity are knowingly incomplete — that is the point of alpha. Alpha corresponds to completion of **M0–M11** in §12; M12+ is post-alpha.

### 16.1 Alpha exit criteria (all must hold)

| # | Criterion | Verified by |
|---|---|---|
| A1 | A human can start a new game from the web UI, choose settings, and play to a victory/defeat screen **without touching the CLI** | Playwright happy-path suite |
| A2 | All core systems present and integrated: map gen, units + movement + fog, cities (growth, production, citizens), economy (sliders, gold, maintenance, workers, improvements, resources), tech tree, combat + barbarians, culture + borders + governments + happiness, victory conditions, score | per-system scenarios + `verify:full` |
| A3 | AI opponents play a complete game unaided; at least one victory condition demonstrated ending a real game | 20-seed tournament, 0 invariant violations, budget met |
| A4 | UI covers map render + pan/zoom, unit orders, city screen, tech tree, turn/year indicator, event log, scoreboard, save/load, debug panel | Playwright UI suite (§16.2) |
| A5 | Fast `pnpm verify` green ≤ 90 s and `verify:full` green ≤ 10 min | CI-style run |
| A6 | Golden replays stable; save/load round-trip preserves state hash; a game resumes correctly from a save | property + golden tests |
| A7 | Handoff docs complete: README (how to run/play), GDD with provenance table, ENGINE notes, BALANCE report, known-issues + explicit "not in alpha" list | doc review |

### 16.2 UI verification method (how "test the UI myself" is satisfied)

Every UI acceptance criterion is a machine-checked assertion — never "the agent looked at it":

1. **Drive the real app** in headless Chromium (Playwright) against the real engine, served on its own port (separate from the DSH GUI on 3080).
2. **Assert on text**: DOM content, accessibility tree, computed styles, layout geometry.
3. **Assert on pixels**: sample the canvas at computed tile coordinates and compare to expected terrain/unit/overlay colours. This is the primary correctness check for rendering, and it catches "the map renders but is offset / dark / blank".
4. **Assert on interaction**: click real coordinates (tile select, unit orders, city screen buttons) and assert resulting app + engine state.
5. **Assert on the draw trace**: the shared pure renderer records structured draw ops, so rendering bugs stay diagnosable in text even when pixels look plausible.
6. **Vision review (supplementary)**: render the app and inspect the PNG directly (verified working) for judgements assertions cannot make — legibility, hierarchy, does-it-look-like-a-game. Advisory for aesthetics, never the gate for correctness.
7. Screenshots are captured for the human, and for the principal at the alpha hand-off.

### 16.3 Explicitly NOT alpha-blocking (deferred to beta or later)

Balance tuning beyond playability; corruption; city culture-flips; full diplomacy (alliances, treaties, trade) beyond war/peace; espionage; isometric renderer and sprites; audio; animation polish; mod packs; difficulty handicaps; auto-explore/auto-improve; multiplayer.

### 16.4 The stop

When A1–A7 hold, **stop**. Present the built game, how to run it, the Playwright-verified evidence, tournament results, the provenance/fidelity table, the known-issues list, and a recommendation for beta. Begin no beta work until the principal responds.
