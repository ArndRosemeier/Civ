/**
 * M5 adversarial review (W5: integration owner, then adversarial review) — an attempt to
 * **falsify** the frozen M5 contracts in docs/INTERFACES.md, not to confirm them.
 *
 * This file was written after driving `pnpm verify` green from a red gate, so it starts from
 * the code that actually exists rather than from the prose. What it attacks, what the attack
 * found, and where the finding is asserted:
 *
 * ## Findings, first, because that is the honest order
 *
 * 1. **FIXED — the gating contract was not enforced by every asker (found in the integration
 *    wave that wrote this file, and asserted fixed by items 1 and 5 below).** M5's contract
 *    says gating must be enforced "in the **same place** production and build legality are
 *    already decided, so the generator and the applier cannot disagree — the keystone
 *    invariant is BOTH directions and this is the third gating dimension". Two of the three
 *    askers did not ask: `planSetProduction` consulted `resourceGate` alone, so `applyCommand`
 *    **accepted** a unit or building whose own row declares `requiresTech` that
 *    `cityProductionOptions` would not offer — a live generator/applier disagreement in
 *    exactly the direction the keystone property is about — and `planStartWork` did not
 *    consult the tech gate at all, so a worker could start an improvement its owner could
 *    never finish. No *shipped* row declares `requiresTech`, which is why no play test
 *    surfaced either one; R2 had named the gap in `resources.ts` and R4 had pinned it as a
 *    deliberately-failing scenario assertion. Both call sites now ask the one verdict and
 *    refuse with typed errors (`tech-required`, `improvement-tech-required`), and every
 *    assertion below is written to the **correct** behaviour the contract requires — strictly
 *    stronger than the debt it replaced. Nothing in this file found a *new* engine defect
 *    after that fix, and that is reported as such rather than dressed up.
 * 2. **NO FINDING — the tech tree (item 2).** Every shipped tech is reachable from the empty
 *    set, both as a graph and through the engine's own research rule (driven through the
 *    applier, with the pool as a stated fixture); a cycle is rejected *by name*, in
 *    prerequisite order with the entry point repeated; a self-cycle, which no row-level check
 *    could catch, is rejected too; an era that precedes its prerequisite's era is rejected;
 *    and I could not construct a validated catalog with a permanently unresearchable tech —
 *    both attempts are in the test, and the argument for why they *must* fail (a finite graph
 *    in which every node has an unsatisfied prerequisite contains a cycle) is stated there.
 * 3. **NO FINDING, and it is now measured rather than asserted — beaker conservation
 *    (item 3).** Beakers are conserved to the unit across completions and rate changes over
 *    long played runs, checked against a ledger rebuilt from the *events* rather than from
 *    the engine's own claims; the `stuck` branch leaves the pool and the declared research
 *    exactly alone; and the frozen step order is pinned by a measurement built so that the two
 *    readings of the pipeline give different answers (one beaker short of the price when the
 *    research step runs ⇒ no completion this turn, pool above the price afterwards ⇒ the
 *    completion lands next turn).
 * 4. **NO FINDING — prerequisite honesty (item 4).** A tech is never known without its
 *    prerequisites, under any order I could construct, including a hand-built state that
 *    *declares* an unready tech as its research: the completion path re-asks the readiness
 *    check `SetResearch` asks, so it is structural rather than lucky. The `researching` key is
 *    **absent** (never present-with-`undefined`) after a completion, and the state stays
 *    hashable throughout.
 * 5. **NO FINDING — gating composition (item 5), after the fix in item 1.** The two
 *    dimensions compose without masking each other, and each branch of the tech gate is
 *    exercised **by name**: an item whose own row declares a tech is refused naming *that*
 *    tech; an item that declares none but whose *resource* does is refused naming the
 *    resource row's tech; with an item's own tech known and its deposit's tech not, the
 *    verdict is `blocked(iron)` — the resource — because the shipped doc conditions the
 *    second branch on "the item declares none", and the same state puts those two readings
 *    one field apart, which is the sharpest available test of that sentence. Every verdict is
 *    also asserted *truthful* against the engine's own connection rule, and in every state the
 *    applier's typed refusal **is** the gate's verdict, payload included.
 * 6. **FINDING — reported, not fixed: the played golden is real, and narrower than its name
 *    suggests (item 6).** It is not vacuous: the stored `played-civs2-seed42` hash is
 *    reproduced by replaying the script (which is what makes the replay *the same script*), it
 *    differs from the fresh seed-42 entry, its state carries a founded city, growth, a
 *    completed improvement, a produced unit *and* a produced building, a completed tech and a
 *    money loop, and it **moves when a game rule moves** — measured for two different kinds of
 *    rule (a tech's price, a terrain's yield). But a *state* hash covers state and nothing
 *    else. Item 8 measures the boundary three ways, and the third finding below is the one that
 *    matters most for how the goldens are described.
 * 7. **NO FINDING — determinism (item 7).** The same seed and the same policies give the same
 *    hash in-process with M5's research step live; a different seed does not; and (full tier)
 *    a fresh `npx tsx` process reproduces it twice, with the non-vacuity checks that the run
 *    really played its turns and really ended up knowing techs.
 * 8. **Item 8's answer: the goldens are a real gate on schema and on ONE played state, and
 *    not a gate on behaviour — measured, three ways.** (a) A *refusal* leaves no trace at all:
 *    the applier declining a command does not move the state hash, so a golden can never fail
 *    because refusal behaviour changed — and refusal behaviour is precisely what the M5 gating
 *    work changed. (b) A *rules* change the script never touches moves nothing either: this
 *    file's four added gates change what the ruleset permits and not one of the four stored
 *    hashes moves, because the three fresh entries are `newGame` output and the played script's
 *    improvement, tech and production order are road / pottery / granary. (c) The file stores a
 *    name and a hash and nothing else — no events, no metrics, no transcript — so "the golden is
 *    green" can never mean "the game behaved well". Coverage is exactly the path the script
 *    walks, no more: item 6 is what makes that path worth having.
 *
 * ## What is a fixture here, and what is not
 *
 * The **gated ruleset** (`GATED`) is *this file's own fixture*: it adds `requiresTech` to four
 * shipped rows (the swordsman, the library, the mine, and the iron deposit's own row) and gives
 * the warrior an iron requirement so that the gate's second branch has a row that can reach it.
 * Nothing claims those gates are Civ 3-accurate — the shipped rows are `placeholder` already,
 * and every one of the five fields is this review's invention. Where a number is asserted it is
 * read from the catalog or from the engine, never restated in the test body.
 *
 * ## What this file's own first drafts got wrong
 *
 * Recorded because it is the evidence that these checks bite, and because a review that only
 * reports other people's mistakes is not a review: the first keystone sweep compared an
 * item-keyed generator map against command-keyed candidates and reported **390** phantom
 * completeness violations; the first `StartWork` gate test used a `newGame` board where the
 * worker usually stands on grassland, so it passed for the wrong reason on most seeds; the
 * first composition fixture pre-placed a mine on the worker's tile, so the tech gate was never
 * the thing being refused; the first composition walk assumed the deposit's tech would be named
 * for a composite item (see item 5); the first conservation run never founded a city, so there
 * was no commerce and not one beaker moved; the first rate split rounded the science share to
 * zero beakers a turn; and the first played-turn helper drove `EndTurn` once per civilization,
 * which plays one *game turn* per civilization and double-credits every pool — the ledger
 * caught it (229 beakers against 193 credited). None of those was an engine defect. Every one
 * was a test that would have passed. They are listed here so the next reviewer knows which
 * assumptions this file already paid for.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  MAP_DIMENSIONS,
  applyCommand,
  advanceTurn,
  applyResearch,
  asBuildingId,
  asImprovementId,
  asPlayerId,
  asResourceId,
  asTechId,
  asTileIndex,
  asUnitTypeId,
  buildingCatalog,
  cityProductionOptions,
  civPlayers,
  connected,
  knownTechs,
  knowsTech,
  legalActions,
  missingPrerequisites,
  newGame,
  planCancelWork,
  planSetProduction,
  planSetRates,
  planSetResearch,
  planStartWork,
  prerequisitesOf,
  productionGate,
  requiredResourceOf,
  resourceDef,
  requiredTechOf,
  researchProblem,
  researchStep,
  researchingOf,
  techCatalog,
  techCostOf,
  techDef,
  techUnlocks,
  tileIndex,
  unmetTechFor,
  unitActions,
  unitCatalog,
  // M6: the shipped gates are asserted row by row, so the test reads the rows — through
  // the engine's own readers (`unitDef` for the row, `requiresTechOf` for its gate).
  unitDef,
  unitMoveOptions,
  requiresTechOf,
  type City,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type ProductionGate,
  type PlayerId,
  type ProductionItem,
  type Rates,
  type RulesetView,
  type Settings,
  type SetupError,
  type TechDef,
  type TechId,
  type TileIndex,
} from '@civts/core';
import { CATALOG, ERAS, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import { SIMPLE_POLICY, runSimulation } from '@civts/sim';

import { createScenarioBuilder, hashValue } from '../src/index.js';
import { loadGoldens } from '../src/goldens.js';
import { FULL_TIER } from '../src/tier.js';

/* ------------------------------------------------------------------ *
 * The two rulesets: shipped, and shipped plus this file's gates
 * ------------------------------------------------------------------ */

const mustValidate = (catalog: Catalog, what: string): Ruleset => {
  const validated = validateRuleset(catalog, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `${what} does not validate: ${validated.error.map((e) => JSON.stringify(e)).join('; ')}`,
    );
  }
  return validated.value;
};

/** The shipped catalog, validated exactly as the CLI validates it. */
const RULESET: Ruleset = mustValidate(CATALOG, 'the shipped placeholder catalog');

const TECH = (id: string): TechId => asTechId(id);

/**
 * `RulesetView` does not *declare* `techs` yet — `tech.ts` reads the field
 * structurally, and the interface comment says the declaration will come with the
 * gating workstream. A test that wants to hand a view a tech catalog therefore has to
 * say so, which is what every other `TechView` in this repository does.
 */
type TechView = RulesetView & { readonly techs: readonly TechDef[] };

/**
 * The shipped catalog with four gates added — **this review's fixture**, not shipped
 * content. `requiresTech` is M5's third gating dimension and no shipped row declares
 * one, so a review that only used shipped content could not attack the gate at all.
 *
 * The four rows are chosen for what each one makes possible:
 *
 * - `swordsman` gets `requiresTech: iron-working` on **its own row** and already
 *   requires the `iron` resource, whose row this fixture *also* gates — so it is gated
 *   by **both** dimensions, by two *different* techs, which is what item 5 composes;
 * - `library` (a building) and `mine` (an improvement) give the production path a second
 *   item kind and the worker path its gate;
 * - `iron` (a resource row) is the tech-gated *connectability* case.
 *
 * Which tech each names is arbitrary-but-plausible and **this fixture's choice**. The
 * shipped tree is `placeholder` throughout; nothing here claims Civ 3 accuracy for any
 * row or for any gate.
 */
const gatedCatalog = (): Catalog => ({
  ...CATALOG,
  units: CATALOG.units.map((unit) =>
    unit.id === asUnitTypeId('swordsman')
      ? { ...unit, requiresTech: TECH('iron-working') }
      : // `warrior` gains the iron requirement and **no tech**, which is the only shape that
        // reaches `unmetItemTech`'s second branch: an item that declares no `requiresTech`
        // of its own, whose *resource's* row does. Without a row like this the branch would
        // be documented and unexercised — and this fixture is the place to state it.
        unit.id === asUnitTypeId('warrior')
        ? { ...unit, requiresResource: asResourceId('iron') }
        : unit,
  ),
  buildings: CATALOG.buildings.map((building) =>
    building.id === asBuildingId('library')
      ? { ...building, requiresTech: TECH('alphabet') }
      : building,
  ),
  improvements: CATALOG.improvements.map((improvement) =>
    improvement.id === asImprovementId('mine')
      ? { ...improvement, requiresTech: TECH('masonry') }
      : improvement,
  ),
  resources: CATALOG.resources.map((resource) =>
    resource.id === asResourceId('iron')
      ? { ...resource, requiresTech: TECH('bronze-working') }
      : resource,
  ),
});

const GATED: Ruleset = mustValidate(gatedCatalog(), 'the gated fixture catalog');

const SWORDSMAN: ProductionItem = { kind: 'unit', id: asUnitTypeId('swordsman') };
const WARRIOR: ProductionItem = { kind: 'unit', id: asUnitTypeId('warrior') };
const LIBRARY: ProductionItem = { kind: 'building', id: asBuildingId('library') };
const MINE = asImprovementId('mine');

/* ------------------------------------------------------------------ *
 * Small tools
 * ------------------------------------------------------------------ */

/** A deterministic 32-bit PRNG: nothing here may depend on anything ambient. */
const makePrng = (seed: number): (() => number) => {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * The findings collector. A sweep that stopped at its first problem would hide the
 * rest, so every check pushes a message and the test asserts the list is empty — and
 * prints *all* of it when it is not.
 */
interface Recorder {
  readonly problems: string[];
  check: (condition: boolean, message: string) => void;
}

const recorder = (): Recorder => {
  const problems: string[] = [];
  return {
    problems,
    check: (condition, message) => {
      if (!condition) problems.push(message);
    },
  };
};

const errorText = (error: GameError): string => JSON.stringify(error);

/** One canonical key per command, so a yielded command and an accepted one compare. */
const cmdKey = (cmd: Command): string => {
  switch (cmd.type) {
    case 'MoveUnit':
      return `MoveUnit ${String(cmd.unitId)} ${String(cmd.to)}`;
    case 'FoundCity':
      return `FoundCity ${String(cmd.unitId)}`;
    case 'StartWork':
      return `StartWork ${String(cmd.unitId)} ${String(cmd.kind)}`;
    case 'CancelWork':
      return `CancelWork ${String(cmd.unitId)}`;
    case 'SetWorkedTiles':
      return `SetWorkedTiles ${String(cmd.cityId)} ${cmd.tiles.join(',')}`;
    case 'SetProduction':
      return `SetProduction ${String(cmd.cityId)} ${cmd.item.kind}:${String(cmd.item.id)}`;
    case 'SetRates':
      return `SetRates ${String(cmd.rates.tax)}/${String(cmd.rates.science)}/${String(cmd.rates.luxury)}`;
    case 'SetResearch':
      return `SetResearch ${String(cmd.tech)}`;
    case 'EndTurn':
      return 'EndTurn';
    // M6's two combat commands, keyed by their payload for the M4a reason: two
    // `AttackUnit`s naming different targets are different commands, and a key that
    // dropped the target would call them equal — the exact false equivalence this
    // comparator exists to prevent. `FortifyUnit` carries only its unit, so the unit
    // is the whole key. Both are keyed although `actions.ts` yields only
    // `AttackUnit` (`FortifyUnit` is a setting, reachable through `planFortifyUnit`):
    // the switch is exhaustive on purpose, so a `Command` variant this comparator
    // cannot name would be a typecheck failure rather than two different commands
    // comparing equal.
    case 'AttackUnit':
      return `AttackUnit ${String(cmd.unitId)} -> ${String(cmd.target)}`;
    case 'FortifyUnit':
      return `FortifyUnit ${String(cmd.unitId)}`;

    // M9: the government setter, keyed by the government it names for the same M4a
    // reason as its neighbours — two `SetGovernment`s naming different rows are
    // different commands, and a key that dropped the id would call them equal.
    case 'SetGovernment':
      return `SetGovernment ${String(cmd.government)}`;
  }
};

const itemKey = (item: ProductionItem): string => `${item.kind}:${String(item.id)}`;

const playerOf = (state: GameState, playerId: PlayerId): GameState['players'][number] | undefined =>
  state.players.find((player) => player.id === playerId);

const civIds = (state: GameState): readonly PlayerId[] => civPlayers(state).map((p) => p.id);

const cityOf = (state: GameState, owner: PlayerId): City | undefined =>
  state.cities.find((city) => city.owner === owner);

/**
 * A state the engine can hash: **no key holds an explicit `undefined`**.
 *
 * This is the bug class the M3 doc calls out (a key written with an `undefined` value is
 * unhashable), and it is worth re-checking here because M5 added an *optional* field
 * (`PlayerState.researching`) whose removal is a write: `withoutResearching` must delete
 * the key rather than set it to `undefined`.
 */
const undefinedKeyIn = (state: unknown): string | undefined => {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return `${path} is undefined`;
    if (value === null || typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const bad = walk(value[i], `${path}[${String(i)}]`);
        if (bad !== undefined) return bad;
      }
      return undefined;
    }
    for (const [key, each] of Object.entries(value)) {
      if (each === undefined) return `${path}.${key} holds an explicit undefined`;
      const bad = walk(each, `${path}.${key}`);
      if (bad !== undefined) return bad;
    }
    return undefined;
  };
  return walk(state, 'state');
};

const settingsFor = (seed: number, civCount = 2): Settings => ({
  ...DEFAULT_SETTINGS,
  mapSize: 'duel',
  civCount,
  seed,
});

const setupErrorText = (error: SetupError): string => JSON.stringify(error);

const mustStart = (seed: number, ruleset: RulesetView = RULESET, civCount = 2): GameState => {
  const result = newGame(seed, settingsFor(seed, civCount), ruleset);
  if (!result.ok) {
    throw new Error(`newGame(seed ${String(seed)}) failed: ${setupErrorText(result.error)}`);
  }
  return result.value;
};

/** Grant techs to every civilization. A fixture, hence a hand-built `players` rewrite. */
const grantAll = (state: GameState, techs: readonly string[]): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.kind === 'civ'
      ? {
          ...player,
          techs: [...techs.map(TECH)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        }
      : player,
  ),
});

/**
 * Found the first city of `owner` by applying `FoundCity` to its settler — the applier,
 * not a hand-built city, so the fixture cannot disagree with the engine about what a
 * city is.
 */
const foundCity = (
  state: GameState,
  owner: PlayerId,
  ruleset: RulesetView = RULESET,
): { state: GameState; city: City } => {
  const settler = state.units.find((unit) => unit.owner === owner && unit.type === 'settler');
  if (settler === undefined) throw new Error('the fixture world has no settler');
  const outcome = applyCommand(state, owner, { type: 'FoundCity', unitId: settler.id }, ruleset);
  if (!outcome.ok) throw new Error(`FoundCity was refused: ${errorText(outcome.error)}`);
  const city = outcome.value.state.cities.find((candidate) => candidate.owner === owner);
  if (city === undefined) throw new Error('FoundCity produced no city');
  return { state: outcome.value.state, city };
};

/**
 * Give every civilization a capital by applying `FoundCity` to its settler.
 *
 * Measured, because the first draft of this file did without it: a game in which nobody
 * founds a city has no commerce, so the money loop credits **zero beakers a turn**, no
 * tech ever completes, and the production generators have nothing to be asked about. Every
 * conservation and coverage claim below would then have been a claim about an empty board.
 */
const withCapitals = (state: GameState, ruleset: RulesetView): GameState => {
  let current = state;
  for (const player of civIds(state)) {
    const settler = current.units.find((unit) => unit.owner === player && unit.type === 'settler');
    if (settler === undefined) continue;
    const outcome = applyCommand(
      current,
      player,
      { type: 'FoundCity', unitId: settler.id },
      ruleset,
    );
    if (outcome.ok) current = outcome.value.state;
  }
  return current;
};

/* ------------------------------------------------------------------ *
 * 1. THE KEYSTONE, over every generator, with the tech gate live
 * ------------------------------------------------------------------ */

/** A command together with the player that may issue it. */
interface Offer {
  readonly player: PlayerId;
  readonly cmd: Command;
}

interface KeystoneTotals {
  states: number;
  /** Per generator, how many commands it yielded (so coverage is measured). */
  readonly yieldedBy: Record<string, number>;
  /** Per generator, how many times it was asked — including the empty answers. */
  readonly askedBy: Record<string, number>;
  accepted: number;
  gatedItemsSeen: number;
  gatedItemsAccepted: number;
  researchOffers: number;
  refusalsNamingTheGate: number;
}

const emptyTotals = (): KeystoneTotals => ({
  states: 0,
  yieldedBy: {},
  askedBy: {},
  accepted: 0,
  gatedItemsSeen: 0,
  gatedItemsAccepted: 0,
  researchOffers: 0,
  refusalsNamingTheGate: 0,
});

interface KeystoneRun {
  readonly failures: readonly string[];
  readonly totals: KeystoneTotals;
}

/** Every production item a city could be asked to build, duplicates collapsed. */
const itemUniverse = (ruleset: RulesetView): readonly ProductionItem[] => {
  const candidates: readonly ProductionItem[] = [
    ...unitCatalog(ruleset).map((def): ProductionItem => ({ kind: 'unit', id: def.id })),
    ...buildingCatalog(ruleset).map((def): ProductionItem => ({ kind: 'building', id: def.id })),
  ];
  const seen = new Set<string>();
  const items: ProductionItem[] = [];
  for (const item of candidates) {
    const key = itemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
};

/** A small exhaustive rate space — small, so it is swept rather than sampled. */
/**
 * The splits the conservation run uses: science-heavy on purpose, because with a small
 * capital at the default 6/4/0 split the science share can round to **zero beakers a
 * turn** and nothing would ever complete — a sweep that proved conservation over a run
 * where research never happened would be evidence of nothing. (Measured the first time
 * this test ran: zero completions, which is how the comment got here.)
 */
const RESEARCH_RATES: readonly Rates[] = [
  { tax: 2, science: 8, luxury: 0 },
  // M9+M10: was `0/10/0`, which `despotism`'s science cap of 8 now refuses. The
  // replacement keeps the science share as high as the cap allows and spends the rest of
  // the budget on luxuries, so it is still the most scientific triple available.
  { tax: 0, science: 8, luxury: 2 },
  { tax: 4, science: 6, luxury: 0 },
  { tax: 3, science: 7, luxury: 0 },
];

/**
 * A small exhaustive rate space — small, so it is swept rather than sampled.
 *
 * **Every entry is legal under the opening government** (M9+M10). Before M9 the only rule
 * was "three integers >= 0 summing to `RATE_TOTAL`", so this list held the three extremes
 * `10/0/0`, `0/10/0` and `0/0/10`. `despotism` caps tax at 8, science at 8 and luxury at
 * 2, so all three are now refused — and because the sweep below treats a refusal as a
 * *problem* (its precondition is "the planner accepts the in-range triple"), the whole
 * keystone went red with 90 reports about triples that are correctly refused. The corners
 * of the capped space are what the sweep is for now: the tax ceiling, the science ceiling,
 * the luxury ceiling, and three interior points.
 */
const RATE_UNIVERSE: readonly Rates[] = [
  { tax: 6, science: 4, luxury: 0 },
  { tax: 2, science: 8, luxury: 0 },
  { tax: 8, science: 2, luxury: 0 },
  { tax: 4, science: 4, luxury: 2 },
  { tax: 0, science: 8, luxury: 2 },
  { tax: 8, science: 0, luxury: 2 },
];

const rateUniverse = (): readonly Rates[] => RATE_UNIVERSE;

/**
 * Tile indices this sweep tries for `MoveUnit`: the eight neighbours, the tiles other
 * units of the same player stand on, and a deterministic sample of the rest.
 *
 * **Deliberately not the whole map.** The exhaustive tile sweep lives in the M4c review
 * (`m4c-adversarial.test.ts`), where movement was the milestone under attack; M5's
 * novelty is the tech dimension, so this file spends its budget on the gate instead and
 * says so rather than pretending the sample is a sweep. The *sampled* set is still built
 * from the map, not from `unitMoveOptions`, so a generator that forgot a legal move
 * cannot hide behind the sample — and the soundness direction (every option applies) is
 * checked over every option the generator does yield, which is the direction a sample
 * cannot weaken.
 */
const moveCandidates = (
  state: GameState,
  unitId: string,
  prng: () => number,
): readonly TileIndex[] => {
  const unit = state.units.find((candidate) => String(candidate.id) === unitId);
  if (unit === undefined) return [];
  const width = state.map.width;
  const height = state.map.height;
  const found = new Set<TileIndex>();
  const x = Number(unit.tile) % width;
  const y = Math.floor(Number(unit.tile) / width);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      found.add(tileIndex(width, nx, ny));
    }
  }
  for (const other of state.units) {
    if (other.owner === unit.owner) found.add(other.tile);
  }
  const total = width * height;
  for (let i = 0; i < 12; i += 1) {
    found.add(asTileIndex(Math.floor(prng() * total)));
  }
  return [...found].sort((a, b) => Number(a) - Number(b));
};

/**
 * Walk real games forward and check **both** directions of the keystone property over
 * every generator the engine exposes — including M5's `SetResearch` evaluator and the
 * tech-gated production path.
 *
 * The property, stated once as the contract states it: *a generator and an applier that
 * disagree are a latent bug, not a nicety.* So:
 *
 * - **soundness** — every command any generator yields is accepted by `applyCommand`,
 *   bumps `revision` by exactly one, emits at least one event and leaves a hashable
 *   state. An unsound generator is the bug the contract names first.
 * - **completeness** — every command the applier accepts is yielded by some generator.
 *   The candidate universe is built from the *catalogs and the map* (every item, every
 *   improvement, every tech, the rate space, movement candidates), never from the
 *   generators, so a generator that forgot an option cannot hide by also not being asked.
 * - **the tech gate** — for every city and every item: the menu, the planner, the gate
 *   and the applier are one verdict read four ways, and where the gate says
 *   `tech-required` the applier's typed refusal names the *same* tech. This is the
 *   property the review opened with a finding about.
 *
 * The seven generators are counted by name in `totals.yieldedBy`, so "we covered them"
 * is a measurement rather than a claim: the last assertion of the keystone test requires
 * every one of the seven to have produced at least one command.
 */
const keystoneSweep = (
  seeds: readonly number[],
  steps: number,
  ruleset: RulesetView = RULESET,
  granted: readonly string[] = [],
): KeystoneRun => {
  const rec = recorder();
  const items = itemUniverse(ruleset);
  const totals = emptyTotals();
  const bump = (name: string): void => {
    totals.yieldedBy[name] = (totals.yieldedBy[name] ?? 0) + 1;
  };
  const asked = (name: string): void => {
    totals.askedBy[name] = (totals.askedBy[name] ?? 0) + 1;
  };
  expect(items.length).toBeGreaterThan(0);

  for (const seed of seeds) {
    let state = withCapitals(grantAll(mustStart(seed, ruleset), granted), ruleset);
    const prng = makePrng(seed);
    const where = (step: number, extra: string): string =>
      `seed ${String(seed)} step ${String(step)}: ${extra}`;

    for (let step = 0; step < steps; step += 1) {
      totals.states += 1;
      const undefinedKey = undefinedKeyIn(state);
      if (undefinedKey !== undefined) {
        rec.check(false, where(step, `the state is unhashable: ${undefinedKey}`));
        break;
      }

      /** Everything a generator yielded this step, keyed, with its actor. */
      const yielded = new Map<string, Offer>();

      for (const player of state.players) {
        if (player.kind !== 'civ') continue;

        // (a) `legalActions` — which folds in `unitActions`.
        asked('legalActions');
        for (const cmd of legalActions(state, ruleset, player.id)) {
          bump('legalActions');
          const key = cmdKey(cmd);
          const outcome = applyCommand(state, player.id, cmd, ruleset);
          if (!outcome.ok) {
            rec.check(
              false,
              where(
                step,
                `legalActions yielded ${key} but applyCommand refused it: ${errorText(outcome.error)}`,
              ),
            );
            continue;
          }
          rec.check(
            outcome.value.state.revision === state.revision + 1,
            where(step, `${key} did not bump revision by exactly one`),
          );
          rec.check(
            outcome.value.events.length > 0,
            where(step, `${key} applied without emitting an event`),
          );
          const bad = undefinedKeyIn(outcome.value.state);
          rec.check(
            bad === undefined,
            where(step, `the state after ${key} is unhashable: ${bad ?? ''}`),
          );
          yielded.set(key, { player: player.id, cmd });
        }

        // (b) the per-unit generators, called directly: the UI and the AI call these
        // with no acting player (a per-unit query acts as the unit's own owner).
        for (const unit of state.units) {
          if (unit.owner !== player.id) continue;

          asked('unitActions');
          for (const cmd of unitActions(state, ruleset, unit.id)) {
            bump('unitActions');
            const outcome = applyCommand(state, unit.owner, cmd, ruleset);
            rec.check(
              outcome.ok,
              where(
                step,
                `unitActions(${String(unit.id)}) yielded ${cmdKey(cmd)} and the applier refused ` +
                  `it: ${outcome.ok ? '' : errorText(outcome.error)}`,
              ),
            );
            if (outcome.ok) yielded.set(cmdKey(cmd), { player: unit.owner, cmd });
          }

          asked('unitMoveOptions');
          for (const to of unitMoveOptions(state, ruleset, unit.id)) {
            bump('unitMoveOptions');
            const cmd: Command = { type: 'MoveUnit', unitId: unit.id, to };
            const outcome = applyCommand(state, unit.owner, cmd, ruleset);
            rec.check(
              outcome.ok,
              where(
                step,
                `unitMoveOptions(${String(unit.id)}) offered tile ${String(to)} and the applier ` +
                  `refused it: ${outcome.ok ? '' : errorText(outcome.error)}`,
              ),
            );
            if (outcome.ok) yielded.set(cmdKey(cmd), { player: unit.owner, cmd });
          }

          // (c) M5's worker-path gate: `planStartWork` and `planCancelWork` are the
          // generators `unitActions` filters through, and the applier must agree with
          // each of them — including the typed tech refusal.
          asked('planStartWork');
          for (const row of ruleset.improvements) {
            const planned = planStartWork(state, ruleset, unit.owner, unit.id, row.id);
            bump('planStartWork');
            const cmd: Command = { type: 'StartWork', unitId: unit.id, kind: row.id };
            const outcome = applyCommand(state, unit.owner, cmd, ruleset);
            rec.check(
              planned.ok === outcome.ok,
              where(
                step,
                `planStartWork and the applier disagree about StartWork(${String(row.id)}) on ` +
                  `unit ${String(unit.id)}: planner=${planned.ok ? 'accepted' : planned.error.kind}, ` +
                  `applier=${outcome.ok ? 'accepted' : outcome.error.kind}`,
              ),
            );
            if (planned.ok && outcome.ok) {
              yielded.set(cmdKey(cmd), { player: unit.owner, cmd });
            }
            if (planned.ok && !outcome.ok) {
              rec.check(false, where(step, 'the planner accepted a StartWork the applier refused'));
            }
            if (!planned.ok && outcome.ok) {
              rec.check(false, where(step, 'the planner refused a StartWork the applier accepted'));
            }
            if (!planned.ok && !outcome.ok) {
              const unmet = unmetTechFor(state, unit.owner, row);
              if (unmet !== undefined) {
                const names =
                  outcome.error.kind === 'improvement-tech-required' &&
                  outcome.error.tech === unmet;
                rec.check(
                  names,
                  where(
                    step,
                    `the tech gate named ${String(unmet)} for StartWork(${String(row.id)}) and the ` +
                      `applier's refusal was ${errorText(outcome.error)}`,
                  ),
                );
                if (names) totals.refusalsNamingTheGate += 1;
              }
            }
          }

          asked('planCancelWork');
          const cancelled = planCancelWork(state, unit.owner, unit.id);
          if (cancelled.ok) bump('planCancelWork');
          const cancelCmd: Command = { type: 'CancelWork', unitId: unit.id };
          const cancelOutcome = applyCommand(state, unit.owner, cancelCmd, ruleset);
          rec.check(
            cancelled.ok === cancelOutcome.ok,
            where(
              step,
              `planCancelWork and the applier disagree about unit ${String(unit.id)}: ` +
                `planner=${cancelled.ok ? 'accepted' : cancelled.error.kind}, ` +
                `applier=${cancelOutcome.ok ? 'accepted' : cancelOutcome.error.kind}`,
            ),
          );
          if (cancelled.ok && cancelOutcome.ok) {
            yielded.set(cmdKey(cancelCmd), { player: unit.owner, cmd: cancelCmd });
          }
        }

        // (d) M5's generator: the research evaluator. A *queried* generator like
        // `SetRates` — main's contract says "do not add it to `legalActions`" — so it is
        // swept here and asserted absent from `legalActions` below.
        asked('planSetResearch');
        for (const tech of techCatalog(ruleset)) {
          const planned = planSetResearch(state, ruleset, player.id, tech.id);
          bump('planSetResearch');
          if (!planned.ok) {
            rec.check(
              planned.error.kind !== 'invalid-argument',
              where(step, `planSetResearch(${String(tech.id)}) refused with invalid-argument`),
            );
            continue;
          }
          totals.researchOffers += 1;
          const cmd: Command = { type: 'SetResearch', tech: tech.id };
          const outcome = applyCommand(state, player.id, cmd, ruleset);
          if (!outcome.ok) {
            rec.check(
              false,
              where(
                step,
                `planSetResearch accepted ${String(tech.id)} and the applier refused it: ` +
                  errorText(outcome.error),
              ),
            );
            continue;
          }
          yielded.set(cmdKey(cmd), { player: player.id, cmd });
        }

        // (e) `SetRates` (M4b), swept over the small rate space.
        asked('planSetRates');
        for (const rates of rateUniverse()) {
          const planned = planSetRates(state, ruleset, player.id, rates);
          bump('planSetRates');
          if (!planned.ok) {
            rec.check(
              false,
              where(step, `planSetRates refused the in-range triple ${JSON.stringify(rates)}`),
            );
            continue;
          }
          const cmd: Command = { type: 'SetRates', rates };
          const outcome = applyCommand(state, player.id, cmd, ruleset);
          rec.check(
            outcome.ok,
            where(
              step,
              `planSetRates accepted ${JSON.stringify(rates)} and the applier refused it: ` +
                (outcome.ok ? '' : errorText(outcome.error)),
            ),
          );
          if (outcome.ok) yielded.set(cmdKey(cmd), { player: player.id, cmd });
        }

        // (f) the production path, over the whole item universe, per city — the gate
        // read four ways, plus the *completeness* direction the review opened with: what
        // the applier accepts, the menu must offer, and vice versa.
        for (const city of state.cities) {
          if (city.owner !== player.id) continue;
          const menu = new Set(cityProductionOptions(state, ruleset, city.id).map(itemKey));

          asked('planSetProduction');
          for (const item of items) {
            const key = itemKey(item);
            const gate = productionGate(state, ruleset, player.id, item);
            const planned = planSetProduction(state, ruleset, player.id, city.id, item);
            const cmd: Command = { type: 'SetProduction', cityId: city.id, item };
            const outcome = applyCommand(state, player.id, cmd, ruleset);
            if (planned.ok) bump('planSetProduction');

            rec.check(
              menu.has(key) === (gate.kind === 'open'),
              where(
                step,
                `the menu and the gate disagree about ${key}: menu=${String(menu.has(key))}, ` +
                  `gate=${gate.kind}`,
              ),
            );
            rec.check(
              planned.ok === outcome.ok,
              where(
                step,
                `the planner and the applier disagree about ${key}: ` +
                  `planner=${planned.ok ? 'accepted' : planned.error.kind}, ` +
                  `applier=${outcome.ok ? 'accepted' : outcome.error.kind}`,
              ),
            );
            rec.check(
              outcome.ok === menu.has(key),
              where(
                step,
                `the applier ${outcome.ok ? 'accepted' : 'refused'} ${key} while the menu ` +
                  `${menu.has(key) ? 'offered' : 'omitted'} it — the generator/applier ` +
                  'disagreement the M5 gating contract forbids',
              ),
            );
            if (gate.kind === 'tech-required') {
              totals.gatedItemsSeen += 1;
              const names =
                !outcome.ok &&
                outcome.error.kind === 'tech-required' &&
                outcome.error.tech === gate.tech;
              rec.check(
                names,
                where(
                  step,
                  `the gate said tech-required(${String(gate.tech)}) for ${key} and the applier's ` +
                    `refusal was ${outcome.ok ? 'ACCEPTED' : errorText(outcome.error)}`,
                ),
              );
              if (names) totals.refusalsNamingTheGate += 1;
            }
            if (gate.kind === 'blocked') {
              totals.gatedItemsSeen += 1;
              rec.check(
                !outcome.ok && outcome.error.kind === 'resource-not-connected',
                where(step, `the gate said blocked for ${key} and the applier said otherwise`),
              );
            }
            if (outcome.ok && gate.kind !== 'open') {
              totals.gatedItemsAccepted += 1;
            }
            // Keyed by COMMAND, not by item: the completeness direction below builds
            // `cmdKey`s, and keying one side by item while the other side compares command
            // keys is a comparison that can only fail — it did, loudly, on the first run of
            // this sweep, with 390 counts of "accepted and no generator yielded it".
            if (outcome.ok) yielded.set(cmdKey(cmd), { player: player.id, cmd });
          }
        }
      }

      /**
       * Completeness, from the *catalog* rather than from the generators: every command
       * the applier accepts, over candidate commands this file constructs itself, must
       * appear in what the generators yielded (or be a queried generator's own command,
       * which is why the queried ones are keys in `yielded` above rather than a hole).
       */
      const candidates: Offer[] = [];
      for (const player of state.players) {
        if (player.kind !== 'civ') continue;
        for (const unit of state.units) {
          if (unit.owner !== player.id) continue;
          candidates.push({ player: player.id, cmd: { type: 'FoundCity', unitId: unit.id } });
          candidates.push({ player: player.id, cmd: { type: 'CancelWork', unitId: unit.id } });
          for (const to of moveCandidates(state, String(unit.id), prng)) {
            candidates.push({ player: player.id, cmd: { type: 'MoveUnit', unitId: unit.id, to } });
          }
          for (const row of ruleset.improvements) {
            candidates.push({
              player: player.id,
              cmd: { type: 'StartWork', unitId: unit.id, kind: row.id },
            });
          }
        }
        for (const city of state.cities) {
          if (city.owner !== player.id) continue;
          for (const item of items) {
            candidates.push({
              player: player.id,
              cmd: { type: 'SetProduction', cityId: city.id, item },
            });
          }
        }
        candidates.push({ player: player.id, cmd: { type: 'EndTurn' } });
      }

      for (const candidate of candidates) {
        const outcome = applyCommand(state, candidate.player, candidate.cmd, ruleset);
        if (!outcome.ok) continue;
        const key = cmdKey(candidate.cmd);
        rec.check(
          yielded.has(key),
          where(
            step,
            `applyCommand accepted ${key} for player ${String(candidate.player)} and no generator ` +
              'yielded it — an incomplete generator is as broken as an unsound one',
          ),
        );
      }

      // Advance the game with one random *legal* action, so research, production and the
      // money loop actually happen rather than being analysed on a turn-0 board.
      const offers = [...yielded.values()];
      const pick = offers[Math.floor(prng() * offers.length)];
      if (pick === undefined) break;
      const outcome = applyCommand(state, pick.player, pick.cmd, ruleset);
      if (!outcome.ok) break;
      state = outcome.value.state;
    }
  }

  return { failures: rec.problems, totals };
};

describe('1. keystone — every generator and the applier agree, in both directions', () => {
  it('holds over played games on a catalog that really declares tech gates', () => {
    const run = keystoneSweep([1, 42, 1337], 5, GATED, ['pottery', 'alphabet', 'masonry']);
    expect(run.failures).toEqual([]);
    expect(run.totals.states).toBeGreaterThanOrEqual(15);
    expect(run.totals.accepted).toBeGreaterThanOrEqual(0);
  });

  it('covers all eight generators, measured rather than claimed', () => {
    const run = keystoneSweep([5, 99], 4, GATED, ['pottery']);
    // Eight names, and the count is a measurement: M4a's five (`unitActions`,
    // `unitMoveOptions`, `legalActions`, `planStartWork`, `planCancelWork`), M4b's
    // `planSetRates`, M4c's `planSetProduction` and M5's `planSetResearch`. Each was
    // *asked*, which is the property this test is about — asking is cheap and always
    // happens, so a generator that answered nothing still appears here.
    const asked = Object.keys(run.totals.askedBy).sort();
    expect(asked).toEqual([
      'legalActions',
      'planCancelWork',
      'planSetProduction',
      'planSetRates',
      'planSetResearch',
      'planStartWork',
      'unitActions',
      'unitMoveOptions',
    ]);
    for (const name of asked) {
      expect(`${name}:${String((run.totals.askedBy[name] ?? 0) > 0)}`).toBe(`${name}:true`);
    }
    // And the seven that always have something to hand back did so — measured, not claimed.
    // `planCancelWork` is excluded from *this* assertion rather than from coverage, because
    // its yield depends on a unit being mid-job, which a short random walk happens to produce
    // on these seeds but need not: its yield direction has its own test below, so nothing
    // rests on the accident. Every name that yielded is also a name that was asked, which is
    // the "no phantom generator" direction.
    const yielded = Object.keys(run.totals.yieldedBy)
      .filter((name) => name !== 'planCancelWork')
      .sort();
    expect(yielded).toEqual([
      'legalActions',
      'planSetProduction',
      'planSetRates',
      'planSetResearch',
      'planStartWork',
      'unitActions',
      'unitMoveOptions',
    ]);
    for (const name of Object.keys(run.totals.yieldedBy)) {
      expect(`${name}:${String(asked.includes(name))}`).toBe(`${name}:true`);
    }
    // …and the tech dimension was live: the sweep met gated items and every one of them
    // was refused with the gate's own tech named.
    expect(run.totals.gatedItemsSeen).toBeGreaterThan(0);
    expect(run.totals.gatedItemsAccepted).toBe(0);
    expect(run.totals.refusalsNamingTheGate).toBeGreaterThan(0);
  });

  it('planCancelWork yields exactly for a unit that is working, and the applier agrees', () => {
    // The eighth generator's yield direction, forced rather than hoped for: a worker is
    // put on a job through the applier, and then the planner must accept `CancelWork`
    // (and must not have accepted it before the job started).
    const state = gateWorld(['bronze-working', 'masonry']);
    const worker = state.units.find((unit) => unit.owner === ROME && unit.type === 'worker');
    if (worker === undefined) throw new Error('the gated world has no worker');
    expect(planCancelWork(state, ROME, worker.id).ok).toBe(false);
    const started = applyCommand(
      state,
      ROME,
      { type: 'StartWork', unitId: worker.id, kind: MINE },
      GATED,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(planCancelWork(started.value.state, ROME, worker.id).ok).toBe(true);
    expect(
      applyCommand(started.value.state, ROME, { type: 'CancelWork', unitId: worker.id }, GATED).ok,
    ).toBe(true);
  });

  it('never yields SetResearch through legalActions, and the planner is its generator', () => {
    const start = grantAll(mustStart(7), ['pottery']);
    for (const player of civIds(start)) {
      const types = [...legalActions(start, GATED, player)].map((cmd) => cmd.type);
      expect(types).not.toContain('SetResearch');
      // The planner is a real generator for the same actor: at least one tech is
      // researchable from a state that knows a non-root, and the applier agrees — which
      // is the "every tech the generator offers, the applier accepts" direction.
      const acceptable = techCatalog(GATED).filter(
        (tech) => planSetResearch(start, GATED, player, tech.id).ok,
      );
      expect(acceptable.length).toBeGreaterThan(0);
      for (const tech of acceptable) {
        expect(applyCommand(start, player, { type: 'SetResearch', tech: tech.id }, GATED).ok).toBe(
          true,
        );
      }
    }
  });

  it('refuses a tech-gated SetProduction with the typed error naming the tech — in the applier', () => {
    // The finding this review opened with, asserted in the shape the contract requires:
    // refused *before* the tech is known, accepted *after*, in BOTH the generator
    // (`cityProductionOptions`) and the applier (`applyCommand`). One field apart.
    const started = mustStart(42, GATED);
    const owner = civIds(started)[0];
    if (owner === undefined) throw new Error('the fixture world has no civilization');
    const founded = foundCity(started, owner, GATED);
    const cityId = founded.city.id;

    expect(cityProductionOptions(founded.state, GATED, cityId).map(itemKey)).not.toContain(
      itemKey(LIBRARY),
    );
    const refused = applyCommand(
      founded.state,
      owner,
      { type: 'SetProduction', cityId, item: LIBRARY },
      GATED,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('the applier accepted a tech-gated building');
    expect(refused.error).toEqual({
      kind: 'tech-required',
      cityId,
      owner,
      item: LIBRARY,
      tech: TECH('alphabet'),
    });

    // The control is the *same board* with one tech granted: offered, planned, gated
    // open, and applied.
    const taught = grantAll(founded.state, ['pottery', 'alphabet']);
    const open = {
      ...taught,
      players: taught.players.map((p) =>
        p.id === owner ? { ...p, techs: [...knownTechs(p)] } : p,
      ),
    };
    expect(cityProductionOptions(open, GATED, cityId).map(itemKey)).toContain(itemKey(LIBRARY));
    expect(planSetProduction(open, GATED, owner, cityId, LIBRARY).ok).toBe(true);
    expect(productionGate(open, GATED, owner, LIBRARY)).toEqual({ kind: 'open' });
    expect(
      applyCommand(open, owner, { type: 'SetProduction', cityId, item: LIBRARY }, GATED).ok,
    ).toBe(true);
  });

  it('refuses a tech-gated StartWork with the typed error naming the tech — in the applier', () => {
    // The worker path's half of the same finding, on the `gateWorld` fixture rather than on
    // a `newGame` board: the worker there stands on **hills** with **no mine yet**, so the
    // only thing between it and the job is the tech. (The first draft used `newGame` and
    // usually stood the worker on grassland, where the mine is refused for terrain and the
    // tech question never arises — a test that passed for the wrong reason on most seeds.)
    const owner = ROME;
    const started = gateWorld([]);
    const worker = started.units.find((unit) => unit.owner === owner && unit.type === 'worker');
    if (worker === undefined) throw new Error('the gated world has no worker');

    const plannedBefore = planStartWork(started, GATED, owner, worker.id, MINE);
    const appliedBefore = applyCommand(
      started,
      owner,
      { type: 'StartWork', unitId: worker.id, kind: MINE },
      GATED,
    );
    expect(plannedBefore.ok).toBe(false);
    expect(appliedBefore.ok).toBe(false);
    if (plannedBefore.ok || appliedBefore.ok) throw new Error('the tech gate did not refuse');
    expect(plannedBefore.error.kind).toBe('improvement-tech-required');
    expect(appliedBefore.error.kind).toBe('improvement-tech-required');
    if (appliedBefore.error.kind === 'improvement-tech-required') {
      expect(appliedBefore.error.tech).toBe(TECH('masonry'));
    }
    if (plannedBefore.error.kind === 'improvement-tech-required') {
      expect(plannedBefore.error.tech).toBe(TECH('masonry'));
      expect(plannedBefore.error.unitId).toBe(worker.id);
      expect(plannedBefore.error.improvement).toBe(MINE);
    }

    const taught = gateWorld(['bronze-working', 'masonry']);
    const workerAfter = taught.units.find((unit) => unit.owner === owner && unit.type === 'worker');
    if (workerAfter === undefined) throw new Error('the taught world has no worker');
    expect(planStartWork(taught, GATED, owner, workerAfter.id, MINE).ok).toBe(true);
    expect(
      applyCommand(taught, owner, { type: 'StartWork', unitId: workerAfter.id, kind: MINE }, GATED)
        .ok,
    ).toBe(true);
  });

  it('the unhashable-state detector has teeth (the check is not decoration)', () => {
    // The bug class M3 named, reproduced on a probe: a key holding an explicit
    // `undefined` is unhashable. `undefinedKeyIn` takes `unknown` rather than
    // `GameState`, so this probe needs no cast — the type system cannot construct the
    // broken state, which is exactly why the check has to exist at runtime.
    expect(undefinedKeyIn({ a: 1, b: undefined })).toBe('state.b holds an explicit undefined');
    expect(undefinedKeyIn({ a: { b: [1, undefined] } })).toBe('state.a.b[1] is undefined');
  });
});

/* ------------------------------------------------------------------ *
 * 2. No tech reachable from nowhere, and no cycle
 * ------------------------------------------------------------------ */

describe('2. the tech tree — reachability, cycles, eras', () => {
  it('reaches every shipped tech from the empty set, as a graph', () => {
    const reached = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const tech of techCatalog(RULESET)) {
        if (reached.has(String(tech.id))) continue;
        if (prerequisitesOf(RULESET, tech.id).every((id) => reached.has(String(id)))) {
          reached.add(String(tech.id));
          grew = true;
        }
      }
    }
    const all = techCatalog(RULESET).map((tech) => String(tech.id));
    // **The count is pinned, and from M6 so is the set.** It was 17 through M5 and is 19
    // from M6, which added `map-making` and `horseback-riding` so the M6 contract's
    // requirement — "at least one new gated unit and one gated building/improvement must
    // declare `requiresTech`, and at least one unit must declare `requiresResource`" —
    // could be met by *content* rather than by a test override. A count alone would let one
    // tech be renamed into another's place, so the ids are compared too: a row added,
    // removed or renamed has to come here and say so.
    expect([...all].sort()).toEqual([
      'alphabet',
      'banking',
      'bronze-working',
      'ceremonial-burial',
      'currency',
      'education',
      'electricity',
      'engineering',
      'feudalism',
      'horseback-riding',
      'iron-working',
      'literature',
      'map-making',
      'masonry',
      'mathematics',
      'pottery',
      'steam-power',
      'the-wheel',
      'warrior-code',
    ]);
    expect(all.length).toBe(19);
    expect([...reached].sort()).toEqual([...all].sort());
  });

  it('reaches every shipped tech through the research RULE, not just the graph', () => {
    // The property a graph walk cannot prove, because it never asks `researchProblem`:
    // a player who always researches something the *engine* says is available ends up
    // knowing the whole tree. Beakers are set directly — this test is about
    // reachability, not about prices — and the pool is a fixture, said out loud.
    let state = mustStart(11);
    const player = civIds(state)[0];
    if (player === undefined) throw new Error('the fixture world has no civilization');

    for (let guard = 0; guard < 200; guard += 1) {
      const row = playerOf(state, player);
      if (row === undefined) throw new Error('the player vanished');
      if (knownTechs(row).length === techCatalog(RULESET).length) break;

      const next = techCatalog(RULESET).find(
        (tech) => researchProblem(RULESET, row, tech.id) === undefined,
      );
      if (next === undefined) break;
      // Through the APPLIER, not the planner: `planSetResearch`'s plan carries the actor
      // and the tech, and the *write* (`withResearching`) is the applier's — so a test
      // that used the plan's `player` would never have set the field at all. (Measured
      // while writing this: that mistake made the loop complete nothing, which is how the
      // comment got here.)
      const selected = applyCommand(state, player, { type: 'SetResearch', tech: next.id }, RULESET);
      expect(selected.ok).toBe(true);
      if (!selected.ok) break;
      state = {
        ...selected.value.state,
        players: selected.value.state.players.map((p) =>
          p.id === player ? { ...p, beakers: 10_000 } : p,
        ),
      };
      state = applyResearch(state, RULESET).state;
    }

    const finalRow = playerOf(state, player);
    if (finalRow === undefined) throw new Error('the player vanished');
    expect([...knownTechs(finalRow)].map(String).sort()).toEqual(
      techCatalog(RULESET)
        .map((tech) => String(tech.id))
        .sort(),
    );
  });

  it('rejects a cycle, and NAMES it', () => {
    const cycled: Catalog = {
      ...CATALOG,
      techs: CATALOG.techs.map((tech) =>
        tech.id === TECH('pottery')
          ? { ...tech, requires: [TECH('alphabet')] }
          : tech.id === TECH('alphabet')
            ? { ...tech, requires: [TECH('pottery')] }
            : tech,
      ),
    };
    const validated = validateRuleset(cycled, 'tuned');
    expect(validated.ok).toBe(false);
    if (validated.ok) throw new Error('a cyclic tech tree validated');
    const error = validated.error.find((candidate) => candidate.kind === 'tech-cycle');
    expect(error).toBeDefined();
    if (error === undefined) throw new Error('no tech-cycle error');
    // The cycle is named in prerequisite order, with the entry point repeated: the point
    // of the member is that a reader learns *which* loop, not that one exists.
    expect([...error.cycle].map(String).sort()).toEqual(['alphabet', 'pottery', 'pottery']);
    expect(String(error.cycle[0])).toBe(String(error.cycle[error.cycle.length - 1]));
    expect(error.detail.length).toBeGreaterThan(0);
  });

  it('rejects a self-cycle, which no row-level check would catch', () => {
    const validated = validateRuleset(
      {
        ...CATALOG,
        techs: CATALOG.techs.map((tech) =>
          tech.id === TECH('masonry') ? { ...tech, requires: [TECH('masonry')] } : tech,
        ),
      },
      'tuned',
    );
    expect(validated.ok).toBe(false);
    expect(validated.ok ? [] : validated.error.map((e) => e.kind)).toContain('tech-cycle');
  });

  it('rejects an era that precedes its prerequisite’s era', () => {
    const backwards: Catalog = {
      ...CATALOG,
      techs: CATALOG.techs.map((tech) =>
        // `pottery` is ancient and `iron-working` is medieval: the inversion is the
        // prerequisite's era coming *after* the dependent's, which is the shape the
        // contract forbids. (`masonry` would not do — it is ancient too, so it is a legal
        // prerequisite and the test would prove nothing. Measured: the first version of
        // this test passed validation and failed as a test, which is the good direction.)
        tech.id === TECH('pottery') ? { ...tech, requires: [TECH('iron-working')] } : tech,
      ),
    };
    const validated = validateRuleset(backwards, 'tuned');
    expect(validated.ok).toBe(false);
    if (validated.ok) throw new Error('an era-inverted tree validated');
    expect(validated.error.map((e) => e.kind)).toContain('invalid-value');
    // …and the shipped tree passes the same check, so this is not passing because
    // validation rejects everything.
    expect(validateRuleset(CATALOG, 'tuned').ok).toBe(true);
  });

  it('shipped eras never precede a prerequisite’s era, row by row', () => {
    const rank = (era: string): number => ERAS.indexOf(era as (typeof ERAS)[number]);
    for (const tech of techCatalog(RULESET)) {
      for (const required of prerequisitesOf(RULESET, tech.id)) {
        const row = techDef(RULESET, required);
        expect(row).toBeDefined();
        if (row === undefined) continue;
        expect(rank(row.era)).toBeLessThanOrEqual(rank(tech.era));
      }
    }
  });

  it('cannot construct a validated catalog with a permanently unresearchable tech', () => {
    // A "permanently unresearchable" tech is one no player can ever complete. With every
    // row well-formed, the only way that happens is for the tech to sit in, or behind, a
    // cycle — because a finite graph in which every node has an unsatisfied prerequisite
    // must contain one. The attempts below are the pigeonhole case and the dangling case,
    // and validation refuses both: the property is structural rather than lucky.
    //
    // Attempt 1: give every root a prerequisite, so there is no root at all.
    const noRoots: Catalog = {
      ...CATALOG,
      techs: CATALOG.techs.map((tech) =>
        tech.requires.length > 0
          ? tech
          : {
              ...tech,
              requires: [tech.id === TECH('pottery') ? TECH('masonry') : TECH('pottery')],
            },
      ),
    };
    const refused = validateRuleset(noRoots, 'tuned');
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.map((e) => e.kind)).toContain('tech-cycle');

    // Attempt 2: keep the tree acyclic and complete, and strand one tech behind a
    // prerequisite that does not exist.
    const dangling: Catalog = {
      ...CATALOG,
      techs: CATALOG.techs.map((tech) =>
        tech.id === TECH('banking') ? { ...tech, requires: [TECH('no-such-tech')] } : tech,
      ),
    };
    expect(validateRuleset(dangling, 'tuned').ok).toBe(false);

    // Reported as NO FINDING, with the attempts recorded rather than asserted absent.
    expect(validateRuleset(CATALOG, 'tuned').ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Beaker conservation
 * ------------------------------------------------------------------ */

const beakersOf = (state: GameState, playerId: PlayerId): number => {
  const row = playerOf(state, playerId);
  if (row === undefined) throw new Error(`no player ${String(playerId)}`);
  return row.beakers;
};

const beakersCredited = (events: readonly GameEvent[], playerId: PlayerId): number =>
  events.reduce(
    (total, event) =>
      event.type === 'IncomeCollected' && event.playerId === playerId
        ? total + event.beakers
        : total,
    0,
  );

const beakersSpent = (events: readonly GameEvent[], playerId: PlayerId): number =>
  events.reduce(
    (total, event) =>
      event.type === 'TechResearched' && event.playerId === playerId ? total + event.cost : total,
    0,
  );

/**
 * One turn of a played run, through the applier.
 *
 * **One `EndTurn` per turn, not one per civilization.** `EndTurn` is the applier's turn
 * boundary: applying it runs the whole pipeline — work, growth, production, research, and
 * the money loop for *every* civilization — and increments `state.turn`. A loop that ended
 * every player's turn would therefore play one game turn per civilization and credit every
 * pool twice per turn. (Measured while writing this: the first draft did exactly that, and
 * its "no player holds more beakers than the run credited" check failed with 229 against
 * 193 — the *test* was double-driving the engine, and the ledger is what noticed.)
 *
 * The ledger is per civilization and it is the whole of M5's conservation claim for
 * beakers: what is banked now equals what was banked, **plus** what the money loop
 * credited, **minus** what a completion charged. Nothing else may touch the pool.
 */
const playTurn = (
  state: GameState,
  ruleset: RulesetView,
  rec: Recorder,
  where: string,
  totals: { credited: number; spent: number; completions: number; rateChanges: number },
): GameState => {
  const ender = civIds(state)[0];
  if (ender === undefined) return state;
  const before = civIds(state).map((id) => ({ id, beakers: beakersOf(state, id) }));

  const outcome = applyCommand(state, ender, { type: 'EndTurn' }, ruleset);
  if (!outcome.ok) {
    rec.check(false, `${where}: EndTurn refused for ${String(ender)}: ${errorText(outcome.error)}`);
    return state;
  }

  for (const each of before) {
    const credited = beakersCredited(outcome.value.events, each.id);
    const spent = beakersSpent(outcome.value.events, each.id);
    const after = beakersOf(outcome.value.state, each.id);
    totals.credited += credited;
    totals.spent += spent;
    rec.check(
      after === each.beakers + credited - spent,
      `${where}: ${String(each.id)} beakers went ${String(each.beakers)} -> ${String(after)} with ` +
        `${String(credited)} credited and ${String(spent)} spent`,
    );
  }
  totals.completions += outcome.value.events.filter(
    (event) => event.type === 'TechResearched',
  ).length;
  return outcome.value.state;
};

/**
 * A long played run that keeps research *moving*: each civilization researches the first
 * tech it may, and the rates are changed every few turns so the split varies and
 * completions land on turns where the credit and the charge are different sizes.
 */
const conservationRun = (
  seed: number,
  turns: number,
  ruleset: RulesetView = RULESET,
): {
  failures: readonly string[];
  credited: number;
  spent: number;
  completions: number;
  rateChanges: number;
  finalState: GameState;
} => {
  const rec = recorder();
  const totals = { credited: 0, spent: 0, completions: 0, rateChanges: 0 };
  let state = withCapitals(mustStart(seed, ruleset), ruleset);

  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of civIds(state)) {
      const row = playerOf(state, player);
      if (row === undefined) continue;
      // Keep a research target selected whenever one is available.
      if (researchingOf(row) === undefined) {
        const next = techCatalog(ruleset).find(
          (tech) => researchProblem(ruleset, row, tech.id) === undefined,
        );
        if (next !== undefined) {
          // Through the applier, for the reason the reachability test records: the
          // planner's plan names the actor and the tech, and writing the field is the
          // applier's job.
          const selected = applyCommand(
            state,
            player,
            { type: 'SetResearch', tech: next.id },
            ruleset,
          );
          if (selected.ok) state = selected.value.state;
        }
      }
      // Vary the rates, so the money loop's split is not constant across the run.
      if (turn % 5 === 0) {
        const rates = RESEARCH_RATES[(turn / 5 + Number(player)) % RESEARCH_RATES.length];
        if (rates !== undefined) {
          const planned = planSetRates(state, ruleset, player, rates);
          if (planned.ok) {
            const applied = applyCommand(state, player, { type: 'SetRates', rates }, ruleset);
            if (applied.ok) {
              state = applied.value.state;
              totals.rateChanges += 1;
            }
          }
        }
      }
    }
    state = playTurn(state, ruleset, rec, `seed ${String(seed)} turn ${String(turn)}`, totals);
  }

  return { failures: rec.problems, ...totals, finalState: state };
};

/**
 * A world that actually earns beakers: a population-3 capital on grassland with a 0/10/0
 * split. **Measured**: 4 beakers a turn, against a root tech's price of 5 — both numbers
 * are read from the engine in the ordering test below (`techCostOf`) rather than restated
 * here, and the 4 is only in this comment because a comment cannot read.
 */
const scienceWorld = (): GameState => {
  const built = createScenarioBuilder(RULESET, { mapSize: 'duel' })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .addUnit(0, asUnitTypeId('warrior'), [6, 5])
    .addUnit(1, asUnitTypeId('warrior'), [12, 12])
    .setRates(0, { tax: 0, science: 10, luxury: 0 })
    .addCity(0, [6, 5], {
      name: 'Roma',
      population: 3,
      foodBox: 0,
      shields: 0,
      workedTiles: [at(5, 6), at(6, 6), at(7, 6)],
    });
  const state = built.build();
  if (!state.ok) throw new Error(`the science world must build: ${JSON.stringify(state.error)}`);
  return state.value;
};

describe('3. beaker conservation', () => {
  it('holds to the unit across completions and rate changes, over long runs', () => {
    const run = conservationRun(42, 60);
    expect(run.failures).toEqual([]);
    // Non-vacuity: the run really contained completions and rate changes, so
    // "conserved" is not "nothing happened".
    expect(run.completions).toBeGreaterThan(0);
    expect(run.rateChanges).toBeGreaterThan(0);
    expect(run.credited).toBeGreaterThan(0);
    expect(run.spent).toBeGreaterThan(0);
    expect(run.spent).toBeLessThanOrEqual(run.credited);
  });

  it('holds on the gated ruleset too, where completions unlock content', () => {
    const run = conservationRun(1337, 40, GATED);
    expect(run.failures).toEqual([]);
    expect(run.completions).toBeGreaterThan(0);
  });

  it('leaves the pool exactly alone on the `stuck` branch', () => {
    // A hand-built state that *declares* a tech whose prerequisites it does not satisfy,
    // with more than enough beakers. The engine must not complete it and must not spend
    // anything — the pool is the player's, and a refusal to progress is not a licence to
    // edit it. This is the branch that could look like a silent half-success.
    const start = mustStart(8);
    const player = civIds(start)[0];
    if (player === undefined) throw new Error('the fixture world has no civilization');
    const tech = techCatalog(RULESET).find((row) => prerequisitesOf(RULESET, row.id).length > 0);
    if (tech === undefined) throw new Error('the catalog has no tech with prerequisites');
    const cost = techCostOf(RULESET, tech.id);
    expect(cost).toBeDefined();

    const rigged: GameState = {
      ...start,
      players: start.players.map((p) =>
        p.id === player ? { ...p, beakers: 1000, researching: tech.id } : p,
      ),
    };
    const step = researchStep(rigged, RULESET, player);
    expect(step.kind).toBe('stuck');
    const outcome = applyResearch(rigged, RULESET);
    expect(outcome.events).toEqual([]);
    expect(beakersOf(outcome.state, player)).toBe(1000);
    const row = playerOf(outcome.state, player);
    expect(row === undefined ? true : knowsTech(row, tech.id)).toBe(false);
    // …and the declared intent is left alone rather than silently repaired.
    expect(row === undefined ? undefined : researchingOf(row)).toBe(tech.id);
  });

  it('reads the pool the PREVIOUS turn’s money loop left — measured, not asserted from prose', () => {
    // The ordering the M5 contract froze: `research` is step 4 and the money loop is step 5,
    // so the research step reads the pool the *previous* turn's money loop left. The prose
    // version of that claim is unfalsifiable; this is the measurement, built so that the two
    // readings of the pipeline give **different** answers:
    //
    // one beaker short of the price when the research step runs, with a money loop that will
    // credit more than one beaker afterwards. Under the frozen order nothing completes this
    // turn and the pool ends above the price — so the completion is already earned the
    // moment the next turn begins. Under the other order (research after the money loop) the
    // tech would complete *this* turn, and every assertion below would fail.
    const player = ROME;
    const started = scienceWorld();
    const tech = techCatalog(RULESET).find((row) => prerequisitesOf(RULESET, row.id).length === 0);
    if (tech === undefined) throw new Error('the catalog has no root tech');
    const cost = techCostOf(RULESET, tech.id);
    if (cost === undefined) throw new Error('the root tech has no price');

    const selected = applyCommand(started, player, { type: 'SetResearch', tech: tech.id }, RULESET);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const rigged: GameState = {
      ...selected.value.state,
      players: selected.value.state.players.map((p) =>
        p.id === player ? { ...p, beakers: cost - 1 } : p,
      ),
    };

    const one = advanceTurn(rigged, RULESET);
    const afterOne = playerOf(one.state, player);
    if (afterOne === undefined) throw new Error('the player vanished');
    const creditedOne = beakersCredited(one.events, player);
    expect(creditedOne).toBeGreaterThan(0);
    expect(knowsTech(afterOne, tech.id)).toBe(false);
    expect(one.events.filter((event) => event.type === 'TechResearched')).toEqual([]);
    expect(afterOne.beakers).toBe(cost - 1 + creditedOne);
    // The pool is now *above* the price: the tech was earned by the money loop that ran
    // after this turn's research step, which is the whole content of "pipeline delay".
    expect(afterOne.beakers).toBeGreaterThan(cost);

    const two = advanceTurn(one.state, RULESET);
    const afterTwo = playerOf(two.state, player);
    if (afterTwo === undefined) throw new Error('the player vanished');
    expect(knowsTech(afterTwo, tech.id)).toBe(true);
    const completed = two.events.filter((event) => event.type === 'TechResearched');
    expect(completed.length).toBe(1);
    const first = completed[0];
    if (first !== undefined) {
      expect(first.playerId).toBe(player);
      expect(first.tech).toBe(tech.id);
      expect(first.cost).toBe(cost);
      // `beakers` on the event is the remainder the completion carried, which the next
      // assertion re-derives from the pools rather than trusting the event's own claim.
      expect(first.beakers).toBe(afterOne.beakers - cost);
    }
    expect(afterTwo.beakers).toBe(afterOne.beakers - cost + beakersCredited(two.events, player));
  });
});

/* ------------------------------------------------------------------ *
 * 4. Prerequisite honesty
 * ------------------------------------------------------------------ */

describe('4. a tech is never known without its prerequisites', () => {
  it('refuses SetResearch for an unmet prerequisite, naming each one', () => {
    const state = mustStart(21);
    for (const tech of techCatalog(RULESET)) {
      const missing = prerequisitesOf(RULESET, tech.id);
      if (missing.length === 0) continue;
      for (const player of civIds(state)) {
        const row = playerOf(state, player);
        if (row === undefined) continue;
        const problem = researchProblem(RULESET, row, tech.id);
        expect(problem).toBeDefined();
        const planned = planSetResearch(state, RULESET, player, tech.id);
        expect(planned.ok).toBe(false);
        if (!planned.ok) {
          expect(planned.error.kind).toBe('tech-prerequisites-unmet');
          if (planned.error.kind === 'tech-prerequisites-unmet') {
            expect(planned.error.missing).toBeDefined();
          }
        }
        const applied = applyCommand(
          state,
          player,
          { type: 'SetResearch', tech: tech.id },
          RULESET,
        );
        expect(applied.ok).toBe(false);
        if (!applied.ok) {
          expect(applied.error.kind).toBe('tech-prerequisites-unmet');
        }
        // The typed refusal names the techs that are missing, which is the actionable
        // half: "research these first".
        // `prerequisitesOf` is the catalog's order and `missingPrerequisites` is the
        // player's answer, so the comparison is over the *set*: what must agree is which
        // techs are missing, not the order two independent reads happen to emit.
        const missingRead = planned.ok
          ? []
          : missingPrerequisites(row, techDef(RULESET, tech.id) ?? tech);
        expect([...missingRead].map(String).sort()).toEqual([...missing].map(String).sort());
      }
    }
  });

  it('never completes a tech whose prerequisites are unmet, whatever the beakers', () => {
    // Every tech with prerequisites, rigged: the player knows nothing, "researches" it
    // anyway (by hand — `SetResearch` would refuse, which is the previous test), and has
    // far more beakers than it costs. Not one may complete.
    for (const tech of techCatalog(RULESET)) {
      if (prerequisitesOf(RULESET, tech.id).length === 0) continue;
      const start = mustStart(4);
      const player = civIds(start)[0];
      if (player === undefined) throw new Error('the fixture world has no civilization');
      const rigged: GameState = {
        ...start,
        players: start.players.map((p) =>
          p.id === player ? { ...p, beakers: 100_000, researching: tech.id, techs: [] } : p,
        ),
      };
      const outcome = applyResearch(rigged, RULESET);
      const row = playerOf(outcome.state, player);
      expect(row).toBeDefined();
      if (row === undefined) continue;
      expect(knowsTech(row, tech.id)).toBe(false);
      expect(knownTechs(row)).toEqual([]);
      expect(outcome.events).toEqual([]);
      expect(row.beakers).toBe(100_000);
    }
  });

  it('completes at most one tech per player per turn, and carries the remainder', () => {
    const start = mustStart(6);
    const player = civIds(start)[0];
    if (player === undefined) throw new Error('the fixture world has no civilization');
    const tech = techCatalog(RULESET).find((row) => prerequisitesOf(RULESET, row.id).length === 0);
    if (tech === undefined) throw new Error('the catalog has no root tech');
    const cost = techCostOf(RULESET, tech.id);
    if (cost === undefined) throw new Error('the root tech has no price');

    // Enough beakers for *several* techs of that price: the rule says at most one
    // completion per player per turn, so the rest is banked rather than spent.
    const rigged: GameState = {
      ...start,
      players: start.players.map((p) =>
        p.id === player ? { ...p, beakers: cost * 3 + 2, researching: tech.id } : p,
      ),
    };
    const outcome = applyResearch(rigged, RULESET);
    const row = playerOf(outcome.state, player);
    if (row === undefined) throw new Error('the player vanished');
    expect(knownTechs(row).length).toBe(1);
    expect(row.beakers).toBe(cost * 2 + 2);
    expect(outcome.events.filter((e) => e.type === 'TechResearched').length).toBe(1);
    // And the `researching` key is **absent**, never present-with-undefined: the key that
    // exists is the bug M3 named.
    expect(Object.hasOwn(row, 'researching')).toBe(false);
    expect(researchingOf(row)).toBeUndefined();
    expect(undefinedKeyIn(outcome.state)).toBeUndefined();
  });

  it('lets a tech completed this turn be the prerequisite of the next selection', () => {
    const start = mustStart(9);
    const player = civIds(start)[0];
    if (player === undefined) throw new Error('the fixture world has no civilization');
    const root = techCatalog(RULESET).find((row) => prerequisitesOf(RULESET, row.id).length === 0);
    const child = techCatalog(RULESET).find((row) =>
      prerequisitesOf(RULESET, row.id).some((id) => id === root?.id),
    );
    if (root === undefined || child === undefined)
      throw new Error('the catalog has no root/child pair');
    const cost = techCostOf(RULESET, root.id);
    if (cost === undefined) throw new Error('the root tech has no price');

    const rigged: GameState = {
      ...start,
      players: start.players.map((p) =>
        p.id === player ? { ...p, beakers: cost, researching: root.id, techs: [] } : p,
      ),
    };
    const completed = applyResearch(rigged, RULESET).state;
    const row = playerOf(completed, player);
    if (row === undefined) throw new Error('the player vanished');
    expect(knowsTech(row, root.id)).toBe(true);

    // Order matters and the honest direction is this one: the child is researchable
    // *after* the root completes, and was not before.
    expect(researchProblem(RULESET, playerOf(rigged, player) ?? row, child.id)).toBeDefined();
    expect(researchProblem(RULESET, row, child.id)).toBeUndefined();
    expect(planSetResearch(completed, RULESET, player, child.id).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Gating composition — the tech gate and the resource gate
 * ------------------------------------------------------------------ */

const DUEL = MAP_DIMENSIONS.duel;
const at = (x: number, y: number): TileIndex => tileIndex(DUEL.width, x, y);

/** The gated world: a city with a road to an iron deposit, and a worker on hills. */
const gateWorld = (granted: readonly string[], roads = true): GameState => {
  let built = createScenarioBuilder(GATED, { mapSize: 'duel' })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .setTile(7, 6, 'hills')
    // The deposit sits on hills because `iron`'s own row allows only hills and mountains:
    // the scenario builder refuses a placement `gen.ts` could never produce, which is how
    // this fixture's first draft failed rather than producing an impossible world.
    .setTile(8, 6, 'hills');
  if (roads) {
    // A road from the city's neighbour to the deposit — and **no mine** on the worker's
    // tile: with one there, every `StartWork(mine)` would be refused as `already-improved`
    // and the tech gate would never be the thing under test, the second fixture bug this
    // file found in its own first draft.
    built = built
      .addImprovement(7, 6, asImprovementId('road'))
      .addImprovement(8, 6, asImprovementId('road'));
  }
  built = built
    .addResource(8, 6, asResourceId('iron'))
    .addUnit(0, asUnitTypeId('worker'), [7, 6])
    .addUnit(1, asUnitTypeId('warrior'), [12, 12])
    .addUnit(0, asUnitTypeId('settler'), [6, 4])
    .setRates(0, { tax: 5, science: 5, luxury: 0 })
    .addCity(0, [6, 5], {
      name: 'Roma',
      population: 2,
      foodBox: 0,
      shields: 0,
      workedTiles: [at(5, 6), at(7, 6)],
    });
  for (const tech of granted) built.grantTech(asPlayerId(0), TECH(tech));
  const state = built.build();
  if (!state.ok) throw new Error(`the gated world must build: ${JSON.stringify(state.error)}`);
  return state.value;
};

const ROME = asPlayerId(0);

/**
 * A shipped-catalog world with a capital and no iron: the control for the composition
 * test, and the state item 8 uses to measure what a refusal does to a hash.
 */
const shippedWorld = (): GameState => {
  const built = createScenarioBuilder(RULESET, { mapSize: 'duel' })
    .addPlayer('Rome')
    .addPlayer('Carthage')
    .fillTerrain('grassland')
    .addUnit(0, asUnitTypeId('warrior'), [6, 5])
    .addUnit(1, asUnitTypeId('warrior'), [12, 12])
    .addCity(0, [6, 5], {
      name: 'Roma',
      population: 2,
      foodBox: 0,
      shields: 0,
      workedTiles: [at(5, 6)],
    });
  const state = built.build();
  if (!state.ok) throw new Error('the shipped world must build');
  return state.value;
};

describe('5. the two gates compose, and neither masks the other', () => {
  it('composes the two dimensions, branch by branch, and never masks one with the other', () => {
    // `swordsman` in this fixture is gated **twice**: its own row declares the iron-working
    // TECH (this fixture's addition) and it requires the `iron` RESOURCE, whose own row this
    // fixture gates on bronze-working. So one item, two dimensions, two *different* techs —
    // the composing case. Three states of knowledge, one grant apart each:
    const nothing = gateWorld([]);
    const depositTech = gateWorld(['bronze-working']);
    const itemTech = gateWorld(['iron-working']);
    const both = gateWorld(['bronze-working', 'iron-working']);
    const bothNoRoad = gateWorld(['bronze-working', 'iron-working'], false);

    /**
     * One verdict, read five ways: the gate, the menu, the planner, the applier, and the
     * applier's typed error. `expected.kind === 'open'` is the only state in which any of
     * the four may say yes, and the refusal's payload must be the gate's own verdict —
     * that row-for-row agreement is the property, not merely "it was refused".
     */
    const agree = (state: GameState, item: ProductionItem, expected: ProductionGate): void => {
      const city = cityOf(state, ROME);
      if (city === undefined) throw new Error('the gated world has no Roman city');
      const cityId = city.id;
      const gate = productionGate(state, GATED, ROME, item);
      expect(gate).toEqual(expected);
      expect(cityProductionOptions(state, GATED, cityId).map(itemKey).includes(itemKey(item))).toBe(
        expected.kind === 'open',
      );
      expect(planSetProduction(state, GATED, ROME, cityId, item).ok).toBe(expected.kind === 'open');
      const applied = applyCommand(state, ROME, { type: 'SetProduction', cityId, item }, GATED);
      expect(applied.ok).toBe(expected.kind === 'open');
      if (applied.ok) return;
      if (expected.kind === 'tech-required') {
        expect(applied.error).toEqual({
          kind: 'tech-required',
          cityId,
          owner: ROME,
          item,
          tech: expected.tech,
        });
      } else if (expected.kind === 'blocked') {
        expect(applied.error).toEqual({
          kind: 'resource-not-connected',
          cityId,
          owner: ROME,
          item,
          resource: expected.resource,
        });
      }
    };

    // **Branch 1: the item's own row.** With nothing known the gate names the tech the
    // item itself declares — and the applier's refusal is that verdict, payload included.
    agree(nothing, SWORDSMAN, { kind: 'tech-required', tech: TECH('iron-working') });

    // **Branch 2: the item declares no tech, but the resource it needs does.** `warrior` is
    // that item in this fixture: the iron requirement with no tech of its own, so the only
    // possible source of a tech is the deposit's row — and the tech named is the deposit's.
    // This is the branch `resources.ts` calls "the case a reader is most likely to miss",
    // exercised by name rather than left to reading.
    agree(nothing, WARRIOR, { kind: 'tech-required', tech: TECH('bronze-working') });

    // **The composing state, and the one place two readings of the rule differ.** The
    // item's own tech is known and the deposit's is not: the item's own gate is satisfied,
    // and the verdict is `blocked(iron)` — the RESOURCE, not the tech. That is what the
    // shipped doc says branch 2 is for ("the item declares none, but the resource it
    // requires does"), and it is measured here rather than assumed, because the first draft
    // of this test asserted the other reading (a second `tech-required` naming the deposit's
    // tech) and was wrong. The verdict is also *truthful*, read through the engine's own
    // connection rule rather than through the gate's opinion of itself:
    agree(itemTech, SWORDSMAN, { kind: 'blocked', resource: asResourceId('iron') });
    expect([...connected(itemTech, GATED, ROME)]).not.toContain(asResourceId('iron'));
    expect(unmetTechFor(itemTech, ROME, resourceDef(GATED, asResourceId('iron')))).toBe(
      TECH('bronze-working'),
    );

    // **Both branches, in the same state, on two rows one field apart.** With iron-working
    // known and the deposit's tech not, the composite swordsman is `blocked(iron)` — its own
    // gate is satisfied and the resource gate is left — while the resource-only warrior in
    // the *same* state is `tech-required(bronze-working)`, because branch 2 applies to it and
    // not to the swordsman. That pair is the sharpest statement of "the branch is documented
    // by the shape of the row": one field apart, two verdicts, both correct.
    agree(itemTech, WARRIOR, { kind: 'tech-required', tech: TECH('bronze-working') });

    // **Neither dimension masks the other.** Knowing the deposit's tech alone does not buy
    // the item (its own row still demands iron-working), and knowing the item's own tech
    // alone does not connect the deposit (`connected` above says so): each can block alone.
    agree(depositTech, SWORDSMAN, { kind: 'tech-required', tech: TECH('iron-working') });

    // **Both dimensions satisfied, and the connection is real.** Open — and connected,
    // which is the read that makes "open" the right answer rather than a formality.
    agree(both, SWORDSMAN, { kind: 'open' });
    expect([...connected(both, GATED, ROME)]).toContain(asResourceId('iron'));

    // **Both techs known, no road**: the only thing missing is the connection, and the gate
    // says exactly that. A gate that had "the tech was the reason" baked in would still name
    // a tech here and be wrong.
    agree(bothNoRoad, SWORDSMAN, { kind: 'blocked', resource: asResourceId('iron') });
    expect([...connected(bothNoRoad, GATED, ROME)]).not.toContain(asResourceId('iron'));

    // **And the two rows are genuinely two requirements**: the item's own tech and its
    // resource, read off the item's row, are different facts, and the library's gate is a
    // third row entirely (a building, no resource at all).
    expect(requiredTechOf(GATED, SWORDSMAN)).toBe(TECH('iron-working'));
    expect(requiredResourceOf(GATED, SWORDSMAN)).toBe(asResourceId('iron'));
    expect(requiredTechOf(GATED, WARRIOR)).toBeUndefined();
    expect(requiredResourceOf(GATED, WARRIOR)).toBe(asResourceId('iron'));
    agree(nothing, LIBRARY, { kind: 'tech-required', tech: TECH('alphabet') });
  });

  it('refuses the worker’s tech-gated improvement with the tech named, then accepts it', () => {
    const state = gateWorld([]);
    const worker = state.units.find((unit) => unit.owner === ROME && unit.type === 'worker');
    if (worker === undefined) throw new Error('the gated world has no worker');

    const planned = planStartWork(state, GATED, ROME, worker.id, MINE);
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.error.kind).toBe('improvement-tech-required');
      if (planned.error.kind === 'improvement-tech-required') {
        expect(planned.error.tech).toBe(TECH('masonry'));
      }
    }
    const applied = applyCommand(
      state,
      ROME,
      { type: 'StartWork', unitId: worker.id, kind: MINE },
      GATED,
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.kind).toBe('improvement-tech-required');
      if (applied.error.kind === 'improvement-tech-required') {
        expect(applied.error.tech).toBe(TECH('masonry'));
      }
    }
    // The generator agrees: the locked improvement is not offered by `unitActions`
    // (`unitActions` filters through `planStartWork`), so a player is never offered a job
    // the applier would refuse.
    const offered = unitActions(state, GATED, worker.id).map(cmdKey);
    expect(offered).not.toContain(cmdKey({ type: 'StartWork', unitId: worker.id, kind: MINE }));

    const taught = gateWorld(['bronze-working', 'masonry']);
    const workerAfter = taught.units.find((unit) => unit.owner === ROME && unit.type === 'worker');
    if (workerAfter === undefined) throw new Error('the taught world has no worker');
    expect(planStartWork(taught, GATED, ROME, workerAfter.id, MINE).ok).toBe(true);
    expect(
      applyCommand(taught, ROME, { type: 'StartWork', unitId: workerAfter.id, kind: MINE }, GATED)
        .ok,
    ).toBe(true);
  });

  it('the resource gate alone still works, on the shipped catalog', () => {
    // The M4c rule, re-checked here so that "the tech gate was wired" cannot have been
    // bought by weakening the resource gate: on the shipped catalog the swordsman —
    // a row that declares a resource and **no** tech — is refused for want of a
    // connection, with the resource named.
    //
    // M6 sharpened this case from "the shipped catalog has no tech gates" to "this row has
    // none": shipped content does declare tech gates from M6 on (the whole point of that
    // milestone's gating evidence), and the swordsman is the shipped row that isolates the
    // resource dimension, so the assertion below still fails if the resource gate is
    // weakened and cannot be satisfied by the tech gate answering instead — the refusal
    // kind and the named resource are both pinned.
    const world = shippedWorld();
    const city = cityOf(world, ROME);
    if (city === undefined) throw new Error('no Roman city');
    // The row's *own* gate is absent — read through the engine's one reader of the field
    // (`UnitDef` does not declare `requiresTech`; M5 reads it structurally).
    const swordsmanRow = unitDef(RULESET, SWORDSMAN.id);
    expect(swordsmanRow).toBeDefined();
    expect(requiresTechOf(swordsmanRow)).toBeUndefined();
    const gate = productionGate(world, RULESET, ROME, SWORDSMAN);
    expect(gate).toEqual({ kind: 'blocked', resource: asResourceId('iron') });
    const applied = applyCommand(
      world,
      ROME,
      { type: 'SetProduction', cityId: city.id, item: SWORDSMAN },
      RULESET,
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.kind).toBe('resource-not-connected');
      if (applied.error.kind === 'resource-not-connected') {
        expect(applied.error.resource).toBe(asResourceId('iron'));
      }
    }
  });

  it('a resource row’s own tech gates its own visibility, and never the tile', () => {
    // `techUnlocks` reads the four catalogs and reports what a tech unlocks.
    //
    // **M6 inverted the shipped half of this test, and the new assertion is stronger than
    // the old one.** M5 could only say "on the shipped catalog no row declares a gate, so
    // the answer is an honest empty list". M6 requires shipped content to *use* the gates,
    // so the empty list is now false by construction; what replaces it is the claim the
    // old one was standing in for — that `techUnlocks` agrees, row for row, with the gates
    // the catalog really declares. The expected answer is re-derived here from
    // `CATALOG`'s own rows (every row of every gated section that names a `requiresTech`),
    // so the test cannot be satisfied by editing both sides together, and it is checked
    // for every tech in the tree: a row whose gate names a tech that does not exist, a gate
    // `techUnlocks` forgets to report, and a reported gate no row declares all fail.
    const declared = new Map<string, string[]>();
    const note = (tech: string, entry: string): void => {
      const list = declared.get(tech);
      if (list === undefined) declared.set(tech, [entry]);
      else list.push(entry);
    };
    for (const row of CATALOG.units) {
      if (row.requiresTech !== undefined) note(String(row.requiresTech), `unit:${String(row.id)}`);
    }
    for (const row of CATALOG.buildings) {
      if (row.requiresTech !== undefined) {
        note(String(row.requiresTech), `building:${String(row.id)}`);
      }
    }
    for (const row of CATALOG.improvements) {
      if (row.requiresTech !== undefined) {
        note(String(row.requiresTech), `improvement:${String(row.id)}`);
      }
    }

    // Non-vacuity first: M6's whole claim is that shipped content exercises the gate, so a
    // catalog that declared none would fail here rather than pass by agreeing about nothing.
    expect(declared.size).toBeGreaterThan(0);
    for (const tech of techCatalog(RULESET)) {
      const reported = techUnlocks(RULESET, tech.id)
        .map((entry) => `${entry.kind}:${entry.id}`)
        .sort();
      expect(reported, `techUnlocks disagrees about ${String(tech.id)}`).toEqual(
        (declared.get(String(tech.id)) ?? []).sort(),
      );
    }

    // And the shipped gates are the M6 ones, named: the gate that is really read by play
    // rather than only reported. `ceremonial-burial` unlocks the temple, `warrior-code` the
    // archer and the spearman, `map-making` the transport, `horseback-riding` the horseman
    // (which also declares a resource requirement — one row, two gates; see
    // `m6-adversarial.test.ts` for the through-play assertions).
    const shippedUnlocks = (id: string): readonly string[] =>
      techUnlocks(RULESET, TECH(id))
        .map((entry) => `${entry.kind}:${entry.id}`)
        .sort();
    expect(shippedUnlocks('ceremonial-burial')).toEqual(['building:temple']);
    expect(shippedUnlocks('warrior-code')).toEqual(['unit:archer', 'unit:spearman']);
    expect(shippedUnlocks('map-making')).toEqual(['unit:transport']);
    expect(shippedUnlocks('horseback-riding')).toEqual(['unit:horseman']);
    expect(shippedUnlocks('pottery')).toEqual([]);

    // The GATED fixture's four rows are still reported, each named — the M5 half, unchanged.
    const unlocks = techUnlocks(GATED, TECH('bronze-working'));
    expect(unlocks.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['resource:iron']);
    expect(techUnlocks(GATED, TECH('alphabet')).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'building:library',
    ]);
    expect(techUnlocks(GATED, TECH('masonry')).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'improvement:mine',
    ]);
    expect(techUnlocks(GATED, TECH('iron-working')).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'unit:swordsman',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The played golden is not vacuous
 * ------------------------------------------------------------------ */

/**
 * The played golden's script, **re-derived here** from `packages/testing/test/golden.test.ts`
 * (the same seed, the same map, the same six steps, each choice resolved through the
 * engine). It is duplicated on purpose, and the duplication has a purpose: the assertion
 * `hashValue(replay().state) === stored hash` is what proves the replay *is* the stored
 * game's script, and only then do the coverage claims below attach to the stored entry.
 * A test that merely re-read the golden test's own code could not say that.
 */
const PLAYED_SEED = 42;
const PLAYED_TURNS = 30;
const PLAYED_FIRST_PRODUCTION_TURNS = 6;

const playedReplay = (
  ruleset: RulesetView = RULESET,
): { state: GameState; events: GameEvent[] } => {
  const events: GameEvent[] = [];
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    mapSize: 'tiny',
    civCount: 2,
    seed: PLAYED_SEED,
  };
  const created = newGame(PLAYED_SEED, settings, ruleset);
  if (!created.ok)
    throw new Error(`played replay: newGame failed — ${setupErrorText(created.error)}`);
  let state = created.value;
  const player = civIds(state)[0];
  if (player === undefined) throw new Error('played replay: no civilization');

  const step = (cmd: Command): void => {
    const outcome = applyCommand(state, player, cmd, ruleset);
    if (!outcome.ok) {
      throw new Error(`played replay refused ${JSON.stringify(cmd)}: ${errorText(outcome.error)}`);
    }
    events.push(...outcome.value.events);
    state = outcome.value.state;
  };

  const settler = state.units.find((unit) => unit.owner === player && unit.type === 'settler');
  if (settler === undefined) throw new Error('played replay: no settler');
  step({ type: 'FoundCity', unitId: settler.id });

  const worker = state.units.find((unit) => unit.owner === player && unit.type === 'worker');
  if (worker === undefined) throw new Error('played replay: no worker');
  const work = ruleset.improvements.find(
    (row) =>
      applyCommand(state, player, { type: 'StartWork', unitId: worker.id, kind: row.id }, ruleset)
        .ok,
  );
  if (work === undefined)
    throw new Error('played replay: no improvement is legal on the worker’s tile');
  step({ type: 'StartWork', unitId: worker.id, kind: work.id });

  const cheapestUnit = [...ruleset.units].sort((a, b) => a.cost - b.cost)[0];
  if (cheapestUnit === undefined) throw new Error('played replay: no units');
  const city = state.cities[0];
  if (city === undefined) throw new Error('played replay: no city');
  step({ type: 'SetProduction', cityId: city.id, item: { kind: 'unit', id: cheapestUnit.id } });

  const tech = techCatalog(ruleset).find(
    (row) => planSetResearch(state, ruleset, player, row.id).ok,
  );
  if (tech === undefined) throw new Error('played replay: nothing may be researched');
  step({ type: 'SetResearch', tech: tech.id });

  for (let turn = 0; turn < PLAYED_FIRST_PRODUCTION_TURNS; turn += 1) step({ type: 'EndTurn' });

  const cheapestBuilding = [...(ruleset.buildings ?? [])].sort((a, b) => a.cost - b.cost)[0];
  const cityAfter = state.cities[0];
  if (cheapestBuilding !== undefined && cityAfter !== undefined) {
    step({
      type: 'SetProduction',
      cityId: cityAfter.id,
      item: { kind: 'building', id: cheapestBuilding.id },
    });
  }
  for (let turn = PLAYED_FIRST_PRODUCTION_TURNS; turn < PLAYED_TURNS; turn += 1) {
    step({ type: 'EndTurn' });
  }

  return { state, events };
};

const goldenEntryHash = (name: string): string | undefined => {
  const file = loadGoldens();
  if (file === undefined) return undefined;
  return file.entries.find((entry) => entry.name === name)?.hash;
};

describe('6. the played golden is not vacuous', () => {
  it('reproduces the stored hash, so the replay IS the stored game', () => {
    const stored = goldenEntryHash('played-civs2-seed42');
    expect(stored).toBeDefined();
    if (stored === undefined) throw new Error('the golden file has no played entry');
    const replay = playedReplay();
    expect(hashValue(replay.state)).toBe(stored);
    // …and it is not a duplicate of the fresh entry it sits beside: this is the assertion
    // that makes the word "played" mean something.
    const start = newGame(
      PLAYED_SEED,
      { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed: PLAYED_SEED },
      RULESET,
    );
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(hashValue(start.value)).not.toBe(stored);
  });

  it('covers founding, growth, an improvement, both production kinds, research and the money loop', () => {
    const { state, events } = playedReplay();
    const kinds = new Set(events.map((event) => event.type));
    for (const kind of [
      'CityFounded',
      'WorkStarted',
      'WorkCompleted',
      'CityProduced',
      'TechResearched',
      'IncomeCollected',
      'UpkeepPaid',
    ]) {
      expect(`${kind}:${String(kinds.has(kind as GameEvent['type']))}`).toBe(`${kind}:true`);
    }
    // Both production kinds really happened, not merely "some production".
    const produced = events.filter((event) => event.type === 'CityProduced');
    const producedKinds = new Set(produced.map((event) => event.item.kind));
    expect([...producedKinds].sort()).toEqual(['building', 'unit']);
    // Growth: the city ends larger than it started, and the state carries the building
    // and the tech the script bought — so the hash is a hash of all of it.
    const city = state.cities[0];
    if (city === undefined) throw new Error('the replayed game has no city');
    expect(city.population).toBeGreaterThan(1);
    expect(city.buildings.length).toBeGreaterThan(0);
    const player = civIds(state)[0];
    const row = player === undefined ? undefined : playerOf(state, player);
    expect(row === undefined ? 0 : knownTechs(row).length).toBeGreaterThan(0);
    // `newGame` starts at turn 1 and the script ends 30 turns, so the final state is turn
    // 31 — stated as arithmetic on the script's own constant rather than as a magic 31.
    expect(state.turn).toBe(PLAYED_TURNS + 1);
  });

  /**
   * The mutations below are made on **views**, so the shipped content is never edited and the
   * measurement can live in the gate. The file-level version of the same proof was performed
   * once, out of band, because it edits shipped content and must be reverted: raising the
   * shipped `pottery` cost from 5 to 6 made `golden.test.ts` report
   * `played-civs2-seed42: expected f9849fa910c6cb83, actual d6d73e895b311b4b`, while all three
   * fresh entries stayed green — which is both the file-level proof that this entry gates a
   * game rule and a measurement of item 8 (b)'s claim that generation-only entries cannot see
   * a rule that generation does not read.
   */
  it('goes red when a GAME RULE moves — two kinds of mutation, measured', () => {
    const stored = goldenEntryHash('played-civs2-seed42');
    if (stored === undefined) throw new Error('the golden file has no played entry');
    expect(hashValue(playedReplay().state)).toBe(stored);

    // Mutation 1: a CONTENT cost. One tech costs one beaker more than it did.
    const dearerTechs: TechView = {
      ...RULESET,
      techs: RULESET.techs.map((row) =>
        row.id === TECH('pottery') ? { ...row, cost: row.cost + 1 } : row,
      ),
    };
    const mutated1 = (() => {
      try {
        return hashValue(playedReplay(dearerTechs).state);
      } catch {
        // A refusal is also a red golden: the script is fixed, so content that cannot
        // play it means the stored hash cannot be reproduced either.
        return 'refused';
      }
    })();
    expect(mutated1).not.toBe(stored);

    // Mutation 2: a CONTENT yield — a terrain's food, which the money loop and growth
    // both read, chosen because it is a different mechanic from research.
    const richerTerrain: TechView = {
      ...RULESET,
      terrains: RULESET.terrains.map((row, index) =>
        index === 0 ? { ...row, yields: { ...row.yields, food: row.yields.food + 1 } } : row,
      ),
    };
    const mutated2 = (() => {
      try {
        return hashValue(playedReplay(richerTerrain).state);
      } catch {
        return 'refused';
      }
    })();
    expect(mutated2).not.toBe(stored);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Determinism
 * ------------------------------------------------------------------ */

const simOptions = (seed: number, turns: number, ruleset: Ruleset = RULESET) => ({
  seed,
  settings: settingsFor(seed),
  ruleset,
  policies: [SIMPLE_POLICY, SIMPLE_POLICY],
  maxTurns: turns,
});

describe('7. determinism — same seed, same policies, same hash', () => {
  it('gives one hash in-process, with M5’s research step live', () => {
    const first = runSimulation(simOptions(42, 40));
    const second = runSimulation(simOptions(42, 40));
    expect(second.finalHash).toBe(first.finalHash);
    expect(hashValue(second.finalState)).toBe(first.finalHash);
    // Non-vacuity: the run really hashed a played state, not a fresh board.
    expect(first.turnsPlayed).toBe(40);
    expect(first.violations).toEqual([]);
    // …and the research step really ran: the played state knows techs.
    const known = first.finalState.players.flatMap((player) =>
      player.kind === 'civ' ? knownTechs(player) : [],
    );
    expect(known.length).toBeGreaterThan(0);
  });

  it('is not accidentally constant: a different seed moves the hash', () => {
    const a = runSimulation(simOptions(42, 40));
    const b = runSimulation(simOptions(43, 40));
    expect(b.finalHash).not.toBe(a.finalHash);
  });

  // Full tier: it spawns a fresh `npx tsx` process — the standing requirement lists
  // determinism-across-processes among the full tier's reasons for existing, and this is
  // the only test in the M5 review that pays for a subprocess.
  it.skipIf(!FULL_TIER)('gives the same hash in a fresh process (full tier: it spawns one)', () => {
    // Both halves of the claim are needed and only one of them is testable in-process:
    // two runs in this process could share module state and still agree.
    const here = runSimulation(simOptions(1337, 30)).finalHash;
    const program = [
      "import { DEFAULT_SETTINGS } from '@civts/core';",
      "import { CATALOG, validateRuleset } from '@civts/rules';",
      "import { SIMPLE_POLICY, runSimulation } from '@civts/sim';",
      'const validated = validateRuleset(CATALOG, "tuned");',
      'if (!validated.ok) throw new Error("catalog");',
      'const runs = [1, 2].map(() => runSimulation({',
      '  seed: 1337,',
      '  settings: { ...DEFAULT_SETTINGS, mapSize: "duel", civCount: 2, seed: 1337 },',
      '  ruleset: validated.value,',
      '  policies: [SIMPLE_POLICY, SIMPLE_POLICY],',
      '  maxTurns: 30,',
      '}).finalHash);',
      'process.stdout.write(runs.join("\\n"));',
    ].join('\n');

    const tsx = (() => {
      try {
        return createRequire(import.meta.url).resolve('tsx/cli');
      } catch (cause) {
        throw new Error(
          'the fresh-process check needs the `tsx` devDependency (resolved as "tsx/cli"): ' +
            (cause instanceof Error ? cause.message : String(cause)),
        );
      }
    })();
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawnSync(process.execPath, [tsx, '-e', program], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(child.status).toBe(0);
    const [first, second] = child.stdout.trim().split('\n');
    expect(first).toBe(here);
    expect(second).toBe(here);
  });
});

/* ------------------------------------------------------------------ *
 * 8. Are the goldens a real gate now, or only for schema and generation?
 * ------------------------------------------------------------------ */

describe('8. what the goldens actually gate, measured', () => {
  it('gates the schema: the file is well-formed, versioned and Node-pinned', () => {
    const file = loadGoldens();
    expect(file).toBeDefined();
    if (file === undefined) throw new Error('the golden file is missing');
    for (const entry of file.entries) {
      expect(entry.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.name.length).toBeGreaterThan(0);
    }
    // Five from M6: the three fresh worlds, the played world, and the played world with a
    // battle applied (`played-civs2-seed42-combat`) — the entry M6's acceptance list asks
    // for, named rather than counted so a replacement cannot pass.
    //
    // **M10 makes it six**, adding `played-civs2-seed42-victory`: the played game continued
    // to the turn limit, where the score condition ends it — "a played golden that INCLUDES
    // a victory", which is this wave's acceptance item. The count moved with the list below,
    // and the list is the assertion that matters.
    expect(file.entries.length).toBe(6);
    // The Node major is pinned, so a hash moving because the *runtime* moved is reported
    // as such rather than as a game change.
    expect(file.nodeMajor).toBe(24);
  });

  it('gates semantics too: a played entry is pinned, not only fresh worlds', () => {
    // The measurement behind "a real gate": three of the five entries are `newGame`
    // output (generation and assembly), one is a played state, and — from M6 — one is a
    // played state with a battle applied through the applier, so a change to a *rule the
    // script or the resolver exercises* moves the file. Item 6 measures the movement; this
    // states the coverage, and the whole list is named.
    const file = loadGoldens();
    if (file === undefined) throw new Error('no golden file');
    const names = file.entries.map((entry) => entry.name).sort();
    expect(names).toEqual([
      'played-civs2-seed42',
      'played-civs2-seed42-combat',
      'played-civs2-seed42-victory',
      'tiny-civs2-seed1',
      'tiny-civs2-seed1337',
      'tiny-civs2-seed42',
    ]);
    const played = file.entries.find((entry) => entry.name === 'played-civs2-seed42');
    const fresh = file.entries.find((entry) => entry.name === 'tiny-civs2-seed42');
    if (played === undefined || fresh === undefined) throw new Error('entries missing');
    expect(played.hash).not.toBe(fresh.hash);
    // …and the combat entry is a third distinct value, derived from the played one: a
    // battle that changed nothing would hash as the played world, which is exactly the
    // failure this entry exists to make impossible.
    const combat = file.entries.find((entry) => entry.name === 'played-civs2-seed42-combat');
    if (combat === undefined) throw new Error('the combat entry is missing');
    expect(combat.hash).not.toBe(played.hash);
    expect(combat.hash).not.toBe(fresh.hash);
  });

  it('does NOT gate behaviour — and here are the measurements, not an opinion', () => {
    // Reading a state hash can only tell you about state, so the honest boundary of "the
    // goldens are a real gate" is this: three measurements of what the file cannot see.
    //
    // 1. A *refusal* leaves no trace. The applier declining a command does not write
    //    anything, so a golden cannot fail because refusal behaviour changed — and refusal
    //    behaviour is exactly what the M5 gating work changed.
    const world = shippedWorld();
    const city = cityOf(world, ROME);
    if (city === undefined) throw new Error('the shipped world has no Roman city');
    const refusal = applyCommand(
      world,
      ROME,
      { type: 'SetProduction', cityId: city.id, item: SWORDSMAN },
      RULESET,
    );
    expect(refusal.ok).toBe(false);
    expect(hashValue(world)).toBe(hashValue(shippedWorld()));
    // (…and the same state hashed twice is the same hash, which is what makes the rung
    // above mean *this state in particular* rather than "hashing is broken".)

    // 2. A *rules* change the script never touches moves nothing. This fixture's four added
    //    gates are a real semantic change to the ruleset — `iron`, `swordsman`, `library` and
    //    `mine` all become tech-gated — and not one of the four stored entries moves, because
    //    the three fresh entries are `newGame` output (generation never reads `requiresTech`)
    //    and the played script's improvement, tech and production order are road / pottery /
    //    granary, none of which this fixture gates. Measured, both halves:
    for (const [seed, name] of [
      [1, 'tiny-civs2-seed1'],
      [42, 'tiny-civs2-seed42'],
      [1337, 'tiny-civs2-seed1337'],
    ] as const) {
      const stored = goldenEntryHash(name);
      expect(stored).toBeDefined();
      const fresh = newGame(
        seed,
        { ...DEFAULT_SETTINGS, mapSize: 'tiny', civCount: 2, seed },
        GATED,
      );
      expect(fresh.ok).toBe(true);
      if (fresh.ok) {
        expect(hashValue(fresh.value)).toBe(stored);
      }
    }
    const playedStored = goldenEntryHash('played-civs2-seed42');
    expect(hashValue(playedReplay(GATED).state)).toBe(playedStored);

    // 3. The file stores a name and a hash, and nothing else — no event stream, no metrics,
    //    no transcript. So "the golden is green" can never mean "the game behaved well"; it
    //    means "the state is the same state".
    const file = loadGoldens();
    if (file === undefined) throw new Error('no golden file');
    for (const entry of file.entries) {
      expect(Object.keys(entry).sort()).toEqual(['hash', 'name']);
    }
    expect(Object.keys(file).sort()).toEqual(['entries', 'nodeMajor', 'note']);
  });

  it('refuses to auto-write unless the documented opt-in variable is set', () => {
    // The harness's own rule, re-stated as a fact about the process running this test:
    // `CIVTS_WRITE_GOLDENS` is unset under the gate, so nothing here can have regenerated
    // the file — which is what makes every stored hash an assertion rather than a
    // transcript.
    expect(process.env['CIVTS_WRITE_GOLDENS']).toBeUndefined();
    const file = loadGoldens();
    expect(file).toBeDefined();
  });
});
