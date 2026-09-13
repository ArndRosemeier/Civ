/**
 * Governments — what a civilization's form of rule changes about its numbers.
 * See docs/INTERFACES.md M9 ("Governments"), PLAN.md §5.3 (determinism) and §5.4
 * (data layout).
 *
 * ## Why this module exists
 *
 * The contract adds a `governments` catalog section, a **required**
 * `PlayerState.government`, a `SetGovernment` command that is "planner-and-player
 * legal" and validated against the catalog, and then names the effects:
 *
 * > Effects, all read from the spec and applied in one place: rate caps clamp
 * > `SetRates` legality, `freeUnitsPerCity` and `unitSupportCost` change the money
 * > loop's unit upkeep.
 *
 * "Read from the spec and applied in one place" is the whole design of this file.
 * A government's *shape* is declared here once, every reader goes through a function
 * here, and no system may keep its own copy of a government's number:
 *
 * - `rateCapsOf` — asked by `economy.ts`' `ratesProblem`, which is already the one
 *   statement of the rate rule and the function both `planSetRates` and the UI's
 *   slider question run through. A cap is therefore a *conjunct* of the existing
 *   rule rather than a second rule beside it.
 * - `freeUnitsPerCity` / `unitSupportCost` — asked by `economy.ts`' `unitSupport`,
 *   where M4b wrote `FREE_UNITS_PER_CITY` and `UNIT_SUPPORT_COST` as module
 *   constants. Those constants are **gone** in M9: their M4b doc comments already
 *   said "Civ 3's real support model is government-dependent … which this engine
 *   does not model at all", and this wave is what makes the engine model it. Keeping
 *   the constants would be the M6b defect a second time — a magnitude in the catalog
 *   *and* a magnitude in logic, free to disagree.
 * - `governmentHappiness` — asked by `happiness.ts`, the government's own modifier
 *   on how many of a city's citizens are unhappy.
 *
 * ## Totality: what a ruleset that declares no governments means
 *
 * `RulesetView` does not declare `governments` (it is the engine's *structural*
 * view, exactly as it does not declare `combat`, `capture` or `culture`), so this
 * module reads the section through `unknown` — the arrangement `combatRulesOf` and
 * `captureRulesOf` already use — and answers with a **degenerate** rule when it is
 * absent: `NO_GOVERNMENT`, one government with no caps at all, the M4b allowances as
 * its numbers, and no happiness modifier.
 *
 * That fallback deliberately reproduces M4b's numbers rather than inventing small
 * ones, and the difference from `NO_CAPTURE_RULES`/`NO_BORDER_RULES` is worth stating
 * because it looks inconsistent: those two fall back to a rule that is *unlike* the
 * shipped one specifically so that an absent section changes behaviour. Here the
 * absent section must **not** change behaviour, because before M9 there was no
 * section and the engine already supported units at 2-per-city + 4 — every M2–M8
 * structural view in the tree (and every hand-built fixture in the test suites) is a
 * game with no governments, and making those views suddenly charge 5 gold a unit
 * would be M9 rewriting eight milestones of fixtures to no purpose. The *shipped
 * catalog* requires the section (`validateRuleset`), every real game therefore
 * carries declared governments, and the degenerate rule is reachable only from a
 * structural view — which is the same place `NO_COMBAT_RULES` and `NO_CAPTURE_RULES`
 * are reachable from, one reading later.
 *
 * ## Determinism
 *
 * Nothing here reads the RNG, a clock or the environment; every function is a pure
 * read of a ruleset (and, for the modifiers, of a `GovernmentId`). Every rate cap is
 * a whole number between 0 and `RATE_TOTAL` by validation, and `clampRate` is the
 * one floor, so no rate can leave the range the split is defined over.
 */

import { asGovernmentId, asTechId, type GovernmentId, type PlayerId, type TechId } from './ids.js';
import type { GameState, PlayerState, Rates } from './state.js';

/**
 * **The government magnitudes a ruleset declares** — the engine's structural view
 * of `@civts/rules`' `GovernmentSpec`, minus `provenance` (a field the engine never
 * reads), exactly as `CaptureDef` mirrors `CaptureSpec`.
 *
 * Five fields, each with one reader (see the module note):
 *
 * - `rateCaps` — the highest each of the three sliders may be set to under this
 *   government. `RATE_TOTAL` is the hard ceiling the total rule already imposes, so
 *   a cap of `RATE_TOTAL` means "uncapped" and is how a row says so.
 * - `freeUnitsPerCity` — units each city supports for free, the per-city term of
 *   M4b's allowance formula.
 * - `unitSupportCost` — gold per turn for each unit over the allowance.
 * - `happinessModifier` — added to a city's **unhappy** count: a repressive
 *   government makes more citizens unhappy (`+1`), a liberal one fewer (`-1`).
 *   Signed on purpose, for the reason `BuildingEffect`'s `city-happiness` is.
 *
 * What is deliberately **not** here is the M9 anarchy transition. The contract
 * defers it: "Government changes take effect immediately; the anarchy transition is
 * DEFERRED and noted at the rule site". This is that rule site. A real
 * revolution — some turns of no production or no income while the new order
 * settles — is a *timed* rule, and this engine's turn pipeline has no place to
 * carry "this player is in anarchy until turn N" without a new per-player field and
 * a new pipeline step. Adding one silently would be inventing a mechanic the
 * contract says is out of scope; `SetGovernment` therefore takes effect on the turn
 * it is issued, and `commands.ts`' `SetGovernment` doc says so where a player would
 * read it.
 */
export interface GovernmentDef {
  readonly id: GovernmentId;
  readonly name: string;
  /** The highest each slider may reach under this government; `>= 0`, `<= RATE_TOTAL`. */
  readonly rateCaps: Rates;
  /** Units supported for free per city owned (integer `>= 0`). */
  readonly freeUnitsPerCity: number;
  /** Gold per turn for each unit beyond the free allowance (integer `>= 0`). */
  readonly unitSupportCost: number;
  /** Added to a city's unhappy count (signed integer). */
  readonly happinessModifier: number;
  /**
   * The tech a player must know before it may adopt this government, or **absent** for
   * one available from the start.
   *
   * Absent rather than `undefined`, for the reason every optional key in this codebase
   * is (`exactOptionalPropertyTypes`, and a present-but-`undefined` key cannot survive
   * canonical JSON) — though this field is not hashed: a government row is content, and
   * content is hashed as a whole through `hashValue(validateRuleset(CATALOG))`, not field
   * by field.
   *
   * The contract allows this gate — "validated against the catalog, refused with a typed
   * error for an unknown id or (if you add a prerequisite) an unmet tech" — and the
   * shipped catalog uses it, so the three shipped governments are reachable in an order
   * rather than all at once. Despotism is the one with no gate, which is what makes the
   * M9 government rule reachable in the first turns of a real game instead of only late:
   * a player can move from despotism to monarchy only after Monarchy, but it can always
   * move back.
   */
  readonly requiresTech?: TechId;
}

/**
 * The tech `id`'s row requires, or `undefined` when it requires none or this ruleset
 * does not describe it.
 *
 * Read through the parsed catalog rather than out of the raw section a second time, so
 * a caller asking "what does this government need?" and a caller asking "may this player
 * adopt it?" are reading one parse of one row. `commands.ts`' `planSetGovernment` is the
 * only caller, and it pairs this with `tech.ts`' `unmetTechRequirement` rather than
 * testing `player.techs` itself.
 */
export const governmentTechRequirement = (
  ruleset: unknown,
  id: GovernmentId,
): TechId | undefined => {
  const row = governmentDef(ruleset, id);
  return row === undefined ? undefined : row.requiresTech;
};

/**
 * **The government a ruleset that declares none is played under** — see the module
 * note for why this one reproduces M4b's numbers where `NO_BORDER_RULES` and
 * `NO_CAPTURE_RULES` deliberately do not.
 *
 * `id` is the empty string, which no catalog row can carry (`validateRuleset`
 * refuses an empty id), so a state played under this rule can never be mistaken for
 * one played under a real government — and `governmentDef` below always resolves it,
 * which is what makes "every player has a government the engine can read" total.
 */
export const NO_GOVERNMENT: GovernmentDef = {
  id: asGovernmentId(''),
  name: 'No government',
  // No caps: the M4b rate rule (three integers >= 0 summing to RATE_TOTAL) is the
  // only constraint, because before M9 it was.
  rateCaps: { tax: 10, science: 10, luxury: 10 },
  // M4b's two constants, moved here unchanged. `economy.ts` no longer declares them.
  freeUnitsPerCity: 2,
  unitSupportCost: 1,
  happinessModifier: 0,
};

/** Is this value a plain object (not an array, not `null`)? */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole number at least `min`, or `undefined` for anything this engine cannot read. */
const wholeAtLeast = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;

/** One rate cap, read totally: `fallback` for anything that is not a whole count. */
const capOf = (value: unknown, fallback: number): number => wholeAtLeast(value, 0) ?? fallback;

/**
 * One government row, read **structurally** out of an untyped section entry, or
 * `undefined` when the entry is not a row this engine can use.
 *
 * A row needs an `id` (a string that is not empty) and nothing else: every other
 * field falls back to the degenerate rule's value, so a row that declares only an id
 * is a legal, honest government that says nothing about rates, upkeep or happiness.
 * That is the same totality `captureRulesOf` takes of a section that declares only
 * some of its fields, and it is what keeps a JSON catalog or a foreign ruleset from
 * throwing in the middle of a turn.
 */
const governmentRow = (value: unknown): GovernmentDef | undefined => {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  if (typeof id !== 'string' || id === '') return undefined;

  const caps = isRecord(value['rateCaps']) ? value['rateCaps'] : undefined;
  const fallback = NO_GOVERNMENT.rateCaps;

  return {
    id: asGovernmentId(id),
    name: typeof value['name'] === 'string' ? value['name'] : id,
    rateCaps: {
      tax: capOf(caps?.['tax'], fallback.tax),
      science: capOf(caps?.['science'], fallback.science),
      luxury: capOf(caps?.['luxury'], fallback.luxury),
    },
    freeUnitsPerCity: wholeAtLeast(value['freeUnitsPerCity'], 0) ?? NO_GOVERNMENT.freeUnitsPerCity,
    unitSupportCost: wholeAtLeast(value['unitSupportCost'], 0) ?? NO_GOVERNMENT.unitSupportCost,
    // Signed: any whole number, including a negative one.
    happinessModifier:
      typeof value['happinessModifier'] === 'number' && Number.isInteger(value['happinessModifier'])
        ? value['happinessModifier']
        : NO_GOVERNMENT.happinessModifier,
    // Absent when the row declares none: see `GovernmentDef.requiresTech`. Written
    // only when there is a usable id, so the key is never present-and-undefined.
    ...(typeof value['requiresTech'] === 'string' && value['requiresTech'] !== ''
      ? { requiresTech: asTechId(value['requiresTech']) }
      : {}),
  };
};

/**
 * **The government catalog a ruleset declares**, in catalog order — the one read of
 * the section.
 *
 * Empty for a view that declares no governments at all, and empty for a section that
 * is present but not an array. Rows this engine cannot read are dropped rather than
 * kept as `undefined`, so every element of the result is a government a caller can
 * use.
 *
 * **Catalog order is preserved and is not a rule.** Which government is *default* is
 * decided once, by `defaultGovernmentOf`, precisely because "the first row" is the
 * kind of iteration-order dependence M5's review found in the AI's behavior.
 */
export const governmentCatalog = (ruleset: unknown): readonly GovernmentDef[] => {
  const section = isRecord(ruleset) ? ruleset['governments'] : undefined;
  if (!Array.isArray(section)) return [];

  const rows: GovernmentDef[] = [];
  for (const entry of section) {
    const row = governmentRow(entry);
    if (row !== undefined) rows.push(row);
  }
  return rows;
};

/**
 * The government named `id`, or `undefined` when this ruleset does not describe it.
 *
 * The degenerate government is *not* matched here: its id is the empty string, which
 * no command can name (a `GovernmentId` is a non-empty string by validation and by
 * the command layer's own check), so `undefined` from this function means exactly
 * "this ruleset has no such government" — which is what `SetGovernment` refuses on.
 */
export const governmentDef = (ruleset: unknown, id: GovernmentId): GovernmentDef | undefined =>
  governmentCatalog(ruleset).find((row) => row.id === id);

/**
 * **The government every player starts under**, for `newGame`.
 *
 * The first row of the catalog, which is the only choice that is a function of the
 * content alone: the shipped catalog puts despotism first, and `rules.test.ts` pins
 * that with a named assertion so a reordering of the section is a test failure rather
 * than a silent change of every game's opening government.
 *
 * `NO_GOVERNMENT` for a view that declares none, so `newGame` is total over
 * structural views: a game still starts and still has a government the engine can
 * read. A real game always takes the first declared row, because `validateRuleset`
 * refuses a catalog whose `governments` section is empty.
 */
export const defaultGovernmentOf = (ruleset: unknown): GovernmentDef =>
  governmentCatalog(ruleset)[0] ?? NO_GOVERNMENT;

/**
 * The government **a state's player is actually under** — the read every effect
 * uses, and the one that makes "a state cannot name a government the ruleset does
 * not describe" harmless.
 *
 * A player whose `government` names a row this ruleset does not have falls back to
 * `defaultGovernmentOf` rather than to nothing: a save loaded under a different
 * ruleset is a real case (the CLI takes a `ruleset` setting), and the honest answer
 * for "what are your rates capped at?" is the game's own starting government rather
 * than an exception inside a legality check. `@civts/sim`'s
 * `government-is-in-catalog` invariant is what *reports* such a state; this read
 * stays total so that reporting it does not require surviving a crash.
 */
export const governmentOf = (ruleset: unknown, player: PlayerState): GovernmentDef =>
  governmentDef(ruleset, player.government) ?? defaultGovernmentOf(ruleset);

/** The government of the player with this id, or `undefined` for an unknown player. */
export const playerGovernment = (
  state: GameState,
  ruleset: unknown,
  playerId: PlayerId,
): GovernmentDef | undefined => {
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player === undefined ? undefined : governmentOf(ruleset, player);
};

/**
 * **The rate caps in force for a player** — the one read, asked by `economy.ts`'
 * `ratesProblem`.
 *
 * `rates` is the triple *being asked about* rather than the player's current one,
 * because the question is "may this player set these rates?", and the answer must
 * not depend on what its sliders happen to say now. That is why the parameter is a
 * `PlayerState` (whose `government` decides) plus a triple, rather than a state
 * read that would silently check the old values.
 */
export const rateCapsOf = (ruleset: unknown, player: PlayerState): Rates =>
  governmentOf(ruleset, player).rateCaps;

/**
 * How many units each of this player's cities supports for free — the money loop's
 * per-city term, read from the spec (see the module note for why M4b's constant is
 * gone).
 */
export const freeUnitsPerCity = (ruleset: unknown, player: PlayerState): number =>
  governmentOf(ruleset, player).freeUnitsPerCity;

/** Gold per unit beyond the allowance — the money loop's per-unit term, read from the spec. */
export const unitSupportCost = (ruleset: unknown, player: PlayerState): number =>
  governmentOf(ruleset, player).unitSupportCost;

/** This player's government's own contribution to a city's unhappy count. */
export const governmentHappiness = (ruleset: unknown, player: PlayerState): number =>
  governmentOf(ruleset, player).happinessModifier;
