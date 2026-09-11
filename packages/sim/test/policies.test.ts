/**
 * Evidence for the two shipped policies — the AI seam.
 * See docs/INTERFACES.md, "STANDING REQUIREMENT — simulation-first" ("the AI is a
 * replaceable `Policy`, never hard-wired into the engine").
 *
 * What is checked here is everything that makes a policy *safe to plug in*, and
 * nothing about whether it plays well — it is a placeholder, and a test that measured
 * its strength would be a balance claim this file is not entitled to make:
 *
 * 1. **A policy is a pure function of its context.** The shipped policies do not mutate
 *    the state, give the same commands twice for the same state, and read nothing
 *    ambient (two different policy RNG streams give identical commands — they do not
 *    consume their stream at all, which is why the world's stream cannot be perturbed
 *    by them).
 * 2. **A policy proposes only what the engine accepts.** That is the seam's keystone
 *    property, the twin of "the UI cannot offer a move that fails": over a driven game
 *    every command either policy returns is applied by `applyCommand`, in order, with
 *    no refusal — and it is non-vacuous, because the driver counts the commands.
 * 3. **The seam is real.** The policy commands; the engine owns `EndTurn` and the turn
 *    pipeline. `SIMPLE_POLICY` never proposes an `EndTurn`, and `DO_NOTHING_POLICY`
 *    proposes nothing at all — the baseline is the absence of a policy, not a policy
 *    that plays badly.
 * 4. **The tuning seam works.** `simplePolicy({ targetCities })` changes the game,
 *    which is what "Tunable" has to mean for the AI half of the standing requirement.
 * 5. **Play is independent of the catalog's ROW ORDER** (the adversarial pass's
 *    FINDING C). A catalog's row positions are not part of what it says, so the same
 *    seed must play the same game with the rows reversed and with them shuffled:
 *    asserted at the level of the policy's commands (on identical states) *and* at
 *    the level of whole runs. One section is left: `resources`, where the generator
 *    draws its placement from the map RNG once per row in row order, so the world is a
 *    function of that order — deliberately, and detectably, because the ruleset hash
 *    covers row order. That single remaining section is pinned by measurement, named in
 *    the complement assertion, and reported rather than compensated for here.
 */

import {
  DEFAULT_SETTINGS,
  IMPROVEMENT_KINDS,
  applyCommand,
  asImprovementId,
  asPlayerId,
  civPlayers,
  improvementDef,
  newGame,
  nextBelow,
  nextUint32,
  resolveHutEntry,
  unitActions,
  unitById,
  unitDef,
  type Command,
  type GameError,
  type GameEvent,
  type GameState,
  type HutEntryOutcome,
  type ImprovementId,
  type PlayerId,
  type Settings,
  type UnitId,
} from '@civts/core';
import { CATALOG, validateRuleset, type Catalog, type Ruleset } from '@civts/rules';
import { canonicalize, hashValue } from '@civts/testing';
import { describe, expect, it } from 'vitest';

import {
  DO_NOTHING_POLICY,
  SIMPLE_POLICY,
  policyRngFor,
  runSimulation,
  simplePolicy,
  type Policy,
  type PolicyContext,
  type SimulationResult,
} from '@civts/sim';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The real, validated content the CLI runs on. */
const RULESET: Ruleset = (() => {
  const validated = validateRuleset(CATALOG, 'tuned');
  if (!validated.ok) {
    throw new Error(
      `the shipped catalog does not validate: ${validated.error.map((issue) => issue.kind).join(', ')}`,
    );
  }
  return validated.value;
})();

const settingsFor = (seed: number): Settings => ({
  ...DEFAULT_SETTINGS,
  seed,
  mapSize: 'duel',
  civCount: 2,
});

const freshState = (seed: number): GameState => {
  const created = newGame(seed, settingsFor(seed), RULESET);
  if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);
  return created.value;
};

/** The context the runner would hand a policy for this state and player. */
const ctxFor = (
  state: GameState,
  playerId: PlayerId,
  seed: number,
  ruleset: Ruleset = RULESET,
): PolicyContext => ({
  state,
  playerId,
  ruleset,
  rng: policyRngFor(seed, playerId, state.turn),
});

/** One refusal the driver saw: the command, and the engine's reason for it. */
interface Refusal {
  readonly command: Command;
  readonly error: GameError;
}

interface Driven {
  readonly state: GameState;
  readonly commands: readonly Command[];
  readonly events: readonly GameEvent[];
  readonly refusals: readonly Refusal[];
}

/**
 * Play `turns` turns by polling `policy` for every civilization — civilizations only,
 * in player-id order, exactly as `runner.ts` does — and apply every command through
 * `applyCommand`.
 *
 * This is a deliberately separate driver from the runner: the claim here is about a
 * *policy*, and it is checked by watching what the engine does with its proposals, one
 * command at a time. A refusal is recorded rather than thrown so that a test can assert
 * there were none, and the commands themselves are kept so a test can count what the
 * policy actually proposed.
 */
const drive = (seed: number, policy: Policy, turns: number): Driven => {
  const commands: Command[] = [];
  const events: GameEvent[] = [];
  const refusals: Refusal[] = [];
  let state = freshState(seed);

  for (let turn = 0; turn < turns; turn += 1) {
    for (const player of civPlayers(state)) {
      for (const command of policy.chooseCommands(ctxFor(state, player.id, seed))) {
        commands.push(command);
        const outcome = applyCommand(state, player.id, command, RULESET);
        if (!outcome.ok) {
          refusals.push({ command, error: outcome.error });
          continue;
        }
        state = outcome.value.state;
        events.push(...outcome.value.events);
      }
    }
    const ended = applyCommand(state, asPlayerId(0), { type: 'EndTurn' }, RULESET);
    if (!ended.ok) throw new Error(`EndTurn was refused: ${ended.error.kind}`);
    events.push(...ended.value.events);
    state = ended.value.state;
  }

  return { state, commands, events, refusals };
};

const countCommands = (commands: readonly Command[], type: Command['type']): number =>
  commands.filter((command) => command.type === type).length;

const countEvents = (events: readonly GameEvent[], type: GameEvent['type']): number =>
  events.filter((event) => event.type === type).length;

type StartWorkCommand = Extract<Command, { readonly type: 'StartWork' }>;

const isStartWorkCommand = (command: Command): command is StartWorkCommand =>
  command.type === 'StartWork';

/** Compare two ids by UTF-16 code unit: the tie-break `policies.ts` documents. */
const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ *
 * A policy is a pure function of its context
 * ------------------------------------------------------------------ */

describe('the shipped policies are pure, deterministic functions', () => {
  it('gives the same commands twice for the same context', () => {
    const state = freshState(41);
    const fresh = ctxFor(state, asPlayerId(0), 41);
    expect(SIMPLE_POLICY.chooseCommands(fresh)).toEqual(SIMPLE_POLICY.chooseCommands(fresh));

    // Mid-game, where cities, units and improvements all differ from a fresh state.
    const middle = drive(41, SIMPLE_POLICY, 12);
    for (const player of civPlayers(middle.state)) {
      const ctx = ctxFor(middle.state, player.id, 41);
      expect(SIMPLE_POLICY.chooseCommands(ctx)).toEqual(SIMPLE_POLICY.chooseCommands(ctx));
    }
  });

  it('does not mutate the state it is handed', () => {
    const before = drive(42, SIMPLE_POLICY, 8).state;
    const hashBefore = hashValue(before);
    const unitCount = before.units.length;
    const cityCount = before.cities.length;

    SIMPLE_POLICY.chooseCommands(ctxFor(before, asPlayerId(0), 42));
    DO_NOTHING_POLICY.chooseCommands(ctxFor(before, asPlayerId(0), 42));

    expect(hashValue(before)).toBe(hashBefore);
    expect(before.units).toHaveLength(unitCount);
    expect(before.cities).toHaveLength(cityCount);
  });

  it('does not consume the policy RNG stream, so the world cannot be perturbed by it', () => {
    const state = freshState(43);
    const withFirstStream = ctxFor(state, asPlayerId(0), 43);
    const withSecondStream: PolicyContext = {
      ...withFirstStream,
      rng: policyRngFor(43, asPlayerId(1), 99),
    };

    // The shipped policies are deterministic without randomness: with a different
    // stream in hand they still return the same commands, which means nothing they do
    // depends on a draw — and a policy that drew would be drawing from its *own* stream
    // (`runner.test.ts` proves the world's trajectory is identical either way).
    expect(SIMPLE_POLICY.chooseCommands(withFirstStream)).toEqual(
      SIMPLE_POLICY.chooseCommands(withSecondStream),
    );
    expect(withFirstStream.rng).not.toEqual(withSecondStream.rng);
  });
});

/* ------------------------------------------------------------------ *
 * A policy proposes only what the engine accepts
 * ------------------------------------------------------------------ */

describe('the simple policy plays through the engine', () => {
  it('proposes only commands the applier accepts, over a 20-turn game', () => {
    const driven = drive(44, SIMPLE_POLICY, 20);

    // The keystone property: a policy cannot waste a decision on a command the engine
    // would refuse, because it asks the engine's own planner before proposing one.
    expect(driven.refusals).toEqual([]);
    // ...and it is not vacuous: the policy really did command.
    expect(driven.commands.length).toBeGreaterThan(20);
  });

  it('founds a city with its settler on the first turn', () => {
    const created = freshState(45);
    const commands = SIMPLE_POLICY.chooseCommands(ctxFor(created, asPlayerId(0), 45));

    const found = commands.filter((command) => command.type === 'FoundCity');
    expect(found).toHaveLength(1);
  });

  it('founds, moves, sets production and improves the ground over 20 turns', () => {
    const driven = drive(46, SIMPLE_POLICY, 20);

    expect(countCommands(driven.commands, 'FoundCity')).toBeGreaterThanOrEqual(2);
    expect(countCommands(driven.commands, 'MoveUnit')).toBeGreaterThan(0);
    expect(countCommands(driven.commands, 'SetProduction')).toBeGreaterThan(0);
    expect(countCommands(driven.commands, 'StartWork')).toBeGreaterThan(0);
    expect(countEvents(driven.events, 'CityFounded')).toBeGreaterThanOrEqual(2);
    expect(countEvents(driven.events, 'WorkCompleted')).toBeGreaterThan(0);
    expect(driven.state.improvements.length).toBeGreaterThan(0);
    expect(driven.state.cities.length).toBeGreaterThan(1);
  });

  it('never proposes an EndTurn: the turn boundary is the engine’s, not the AI’s', () => {
    const driven = drive(47, SIMPLE_POLICY, 10);
    expect(countCommands(driven.commands, 'EndTurn')).toBe(0);
  });

  it('leaves a unit that is working where it is, because a step would cancel the job', () => {
    const created = freshState(48);
    const worker = created.units.find(
      (unit) => unitDef(RULESET, unit.type)?.role === 'worker' && unit.owner === asPlayerId(0),
    );
    if (worker === undefined) throw new Error('the fixture has no worker');
    const workerId: UnitId = worker.id;

    const started = SIMPLE_POLICY.chooseCommands(ctxFor(created, asPlayerId(0), 48)).find(
      (command) => command.type === 'StartWork',
    );
    if (started === undefined) throw new Error('the policy did not start a job for the worker');
    const working = applyCommand(created, asPlayerId(0), started, RULESET);
    if (!working.ok) throw new Error(`StartWork was refused: ${working.error.kind}`);
    expect(unitById(working.value.state, workerId)?.work).toBeDefined();

    const next = SIMPLE_POLICY.chooseCommands(ctxFor(working.value.state, asPlayerId(0), 48));
    expect(next.some((command) => command.type === 'CancelWork')).toBe(false);
    expect(next.some((command) => command.type === 'MoveUnit' && command.unitId === workerId)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The baseline
 * ------------------------------------------------------------------ */

describe('the do-nothing baseline decides nothing', () => {
  it('returns no commands for any state', () => {
    const fresh = freshState(49);
    expect(DO_NOTHING_POLICY.chooseCommands(ctxFor(fresh, asPlayerId(0), 49))).toEqual([]);

    const middle = drive(49, SIMPLE_POLICY, 6).state;
    for (const player of civPlayers(middle)) {
      expect(DO_NOTHING_POLICY.chooseCommands(ctxFor(middle, player.id, 49))).toEqual([]);
    }
  });

  it('leaves the world to the engine: no command events at all', () => {
    const driven = drive(50, DO_NOTHING_POLICY, 5);

    expect(driven.commands).toEqual([]);
    // The pipeline still ran every turn — growth, production and the money loop are the
    // engine's, not the AI's.
    expect(countEvents(driven.events, 'IncomeCollected')).toBeGreaterThan(0);
    expect(driven.state.turn).toBe(6);
    expect(driven.state.cities).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The tuning seam
 * ------------------------------------------------------------------ */

describe('the simple policy is tunable', () => {
  it('settles fewer cities when its target is lower', () => {
    const one = drive(51, simplePolicy({ targetCities: 1 }), 15).state;
    const four = drive(51, simplePolicy({ targetCities: 4 }), 15).state;

    expect(one.cities.length).toBeGreaterThan(0);
    expect(four.cities.length).toBeGreaterThan(one.cities.length);
  });

  it('keeps its defaults when a patch names nothing', () => {
    const patched = simplePolicy({ targetCities: 1 });
    const driveOne = drive(52, patched, 1);
    const driveDefault = drive(52, SIMPLE_POLICY, 1);

    // A patch that says nothing about a field must not blank it out.
    expect(driveOne.refusals).toEqual([]);
    expect(driveDefault.refusals).toEqual([]);
    expect(simplePolicy().name).toBe(SIMPLE_POLICY.name);
  });
});

/* ------------------------------------------------------------------ *
 * FINDING C — the catalog's ROW ORDER is not an input to the AI
 * ------------------------------------------------------------------ *
 *
 * The adversarial pass found that a catalog's row *positions* were an input to a
 * run: reversing `CATALOG.units` made this policy field galleys instead of
 * warriors, and reversing `improvements` (or `resources`) moved the run hash.
 * `policies.ts`' `cheapest` documented "a reordered catalog must not silently
 * change a simulation's outcome" and achieved it; its sibling `firstOfRole` and the
 * `StartWork` choice taken off `unitActions` did not, and both are now decisions
 * from the candidates' own content — price and `(kind, id)` for a production item,
 * kind rank and id for a worker's job.
 *
 * What is asserted here, in the order the claim weakens:
 *
 * 1. the permutations really are reorderings of the shipped rows (a non-vacuous
 *    probe);
 * 2. **on one state, the policy returns the identical command list under every one
 *    of them** — the sharp form of "the AI plays the same game", since nothing
 *    downstream can then differ for a reason the policy owns;
 * 3. **whole runs**, 12 turns of the shipped content, are identical in hash, in
 *    every metrics row and in the final state under every row order of `terrains`,
 *    `buildings`, `improvements` and `units`;
 * 4. and the one section that still moves a run is pinned, by measurement, to an
 *    ENGINE rule that reads row order — `gen.ts`' resource placement, which draws from
 *    the map RNG once per resource row **in row order** — and is reproduced from a
 *    state with no policy involved at all. It is reported rather than compensated for
 *    here: a policy that worked around it would be hiding an engine dependence behind
 *    an AI quirk. It is also safe by construction rather than by luck, since the ruleset
 *    hash covers row order (`gen.ts`' placement site, `core/test/gen.test.ts`), and the
 *    second engine reader this list used to name — `hut.ts`' `rewardUnitDef`, formerly
 *    "the first `military` land unit in the catalog" — is now a canonical pick, so the
 *    row-order probe for `units` asserts identity rather than a residual difference.
 */

/** The five row sections a catalog is made of. */
type RowSection = 'terrains' | 'units' | 'buildings' | 'improvements' | 'resources';

const ROW_SECTIONS: readonly RowSection[] = [
  'terrains',
  'units',
  'buildings',
  'improvements',
  'resources',
];

/** How a section's rows were reordered. */
type RowOrderMode = 'reversed' | 'shuffled';

/** `rows[index]`, or a thrown error — `noUncheckedIndexedAccess` without a `!`. */
const mustRow = <T>(rows: readonly T[], index: number): T => {
  const row = rows[index];
  if (row === undefined) throw new Error(`the fixture has no row ${String(index)}`);
  return row;
};

/**
 * A fixed permutation of `rows`: the partial Fisher–Yates shuffle with its swap index
 * taken from a constant arithmetic sequence.
 *
 * A *fixed* permutation rather than a drawn one, for two reasons: `Math.random` is
 * banned in this package (a policy that drew from the ambient stream would not be a
 * pure function of its context), and a fixed shuffle is the stronger probe — it is
 * the same permutation on every machine, so a failure is reproducible rather than a
 * once-in-n-runs flake. That this stride really does reorder every shipped section is
 * asserted below rather than assumed.
 */
const shuffledRows = <T>(rows: readonly T[], stride: number): readonly T[] => {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * stride + 1) % (i + 1);
    const held = mustRow(out, i);
    out[i] = mustRow(out, j);
    out[j] = held;
  }
  return out;
};

const reordered = <T>(rows: readonly T[], mode: RowOrderMode, stride: number): readonly T[] =>
  mode === 'reversed' ? [...rows].reverse() : shuffledRows(rows, stride);

/**
 * The shipped catalog with one section's rows in a different order.
 *
 * Written out per section rather than through a computed key: a spread of a
 * computed `RowSection` would need a cast to get back into `Catalog`, and a cast is
 * exactly where a section renamed in `@civts/rules` would go unnoticed.
 */
const catalogInOrder = (section: RowSection, mode: RowOrderMode): Catalog => {
  const stride = 3;
  if (section === 'terrains')
    return { ...CATALOG, terrains: reordered(CATALOG.terrains, mode, stride) };
  if (section === 'units') return { ...CATALOG, units: reordered(CATALOG.units, mode, stride) };
  if (section === 'buildings') {
    return { ...CATALOG, buildings: reordered(CATALOG.buildings, mode, stride) };
  }
  if (section === 'improvements') {
    return { ...CATALOG, improvements: reordered(CATALOG.improvements, mode, stride) };
  }
  return { ...CATALOG, resources: reordered(CATALOG.resources, mode, stride) };
};

const validatedRuleset = (catalog: Catalog, what: string): Ruleset => {
  const outcome = validateRuleset(catalog, 'tuned');
  if (!outcome.ok) {
    throw new Error(
      `the ${what} catalog does not validate: ${outcome.error
        .map((issue) => issue.kind)
        .join(', ')}`,
    );
  }
  return outcome.value;
};

/** The row ids of one section, in the order the rows are stored. */
const rowIds = (rows: readonly { readonly id: unknown }[]): readonly string[] =>
  rows.map((row) => String(row.id));

const sectionIds = (ruleset: Ruleset, section: RowSection): readonly string[] => {
  if (section === 'terrains') return rowIds(ruleset.terrains);
  if (section === 'units') return rowIds(ruleset.units);
  if (section === 'buildings') return rowIds(ruleset.buildings);
  if (section === 'improvements') return rowIds(ruleset.improvements);
  return rowIds(ruleset.resources);
};

interface RowOrder {
  readonly label: string;
  readonly section: RowSection;
  readonly ruleset: Ruleset;
}

/** Every row order this file probes: each section reversed, and each shuffled. */
const ROW_ORDERS: readonly RowOrder[] = ROW_SECTIONS.flatMap((section) =>
  (['reversed', 'shuffled'] as const).map((mode) => ({
    label: `${section}×${mode}`,
    section,
    ruleset: validatedRuleset(catalogInOrder(section, mode), `${section} (${mode})`),
  })),
);

/**
 * The row orders a whole 12-turn run is identical under — measured below, and the
 * reason each is neutral:
 *
 * - `terrains` — every reader looks a row up by id (`terrainAtIndex` →
 *   `ruleset.terrains.find`), and `generateWorld` reads roles through a map, so
 *   position is never consulted;
 * - `buildings` — `cityProductionOptions` lists them in row order, but this policy
 *   now chooses by price and `(kind, id)`, and the applier looks rows up by id;
 * - `improvements` — the same, and this is the section whose reversal moved the run
 *   before the fix: `unitActions` lists one `StartWork` per catalog kind in row
 *   order, and this policy took the first;
 * - `units` — the two readers were the policy's production choice (now `cheapestOfRole`,
 *   content-keyed) and the ENGINE's goody-hut reward, which is now the cheapest
 *   `military` land row with the id as tie-break rather than the first one, so a hut pays
 *   the same unit whatever order the rows hold.
 *
 * `resources` alone is deliberately absent, and the test after this one pins *why*: the
 * generator draws its placement from the map RNG once per resource row in row order, so
 * the WORLD is a function of that order — deliberately, and safely, because the ruleset
 * hash covers row order and a replay against the wrong ordering is therefore detected
 * (see `gen.ts`' placement site and `core/test/gen.test.ts`).
 */
const RUN_NEUTRAL_ORDERS: readonly string[] = [
  'terrains×reversed',
  'terrains×shuffled',
  'buildings×reversed',
  'buildings×shuffled',
  'improvements×reversed',
  'improvements×shuffled',
  'units×reversed',
  'units×shuffled',
];

/**
 * The three neutral sections shuffled **at once**, by a different stride from the
 * single-section probes above — the strongest form of the probe a run can be asked
 * for, since a policy that read positions could be insensitive to one section's order
 * and still move when several move together.
 */
const COMBINED_ORDER_LABEL = 'terrains+buildings+improvements×shuffled';

const COMBINED_ORDER: Ruleset = validatedRuleset(
  {
    ...CATALOG,
    terrains: reordered(CATALOG.terrains, 'shuffled', 5),
    buildings: reordered(CATALOG.buildings, 'shuffled', 5),
    improvements: reordered(CATALOG.improvements, 'shuffled', 5),
  },
  'three sections at once',
);

const runFor = (seed: number, ruleset: Ruleset, turns: number): SimulationResult =>
  runSimulation({
    seed,
    settings: settingsFor(seed),
    ruleset,
    policies: [SIMPLE_POLICY, SIMPLE_POLICY],
    maxTurns: turns,
  });

describe('FINDING C — the catalog’s ROW ORDER is not an input to the AI', () => {
  it('reorders what it claims to reorder — same rows, different positions', () => {
    expect(ROW_ORDERS).toHaveLength(ROW_SECTIONS.length * 2);

    for (const order of ROW_ORDERS) {
      const before = sectionIds(RULESET, order.section);
      const after = sectionIds(order.ruleset, order.section);

      // The probe moved something — the rows are in a different order...
      expect(after, order.label).not.toEqual(before);
      // ...and it moved nothing else: sorted, the two are the same rows, so a
      // difference the tests below measure is a difference of ORDER, never of content.
      expect([...after].sort(), order.label).toEqual([...before].sort());
      expect(before.length, order.label).toBeGreaterThan(1);
    }

    // The combined order, section by section: three arrays really were reordered.
    for (const section of ['terrains', 'buildings', 'improvements'] as const) {
      const before = sectionIds(RULESET, section);
      const after = sectionIds(COMBINED_ORDER, section);
      expect(after, `${COMBINED_ORDER_LABEL}, ${section}`).not.toEqual(before);
      expect([...after].sort(), `${COMBINED_ORDER_LABEL}, ${section}`).toEqual([...before].sort());
    }
  });

  it('gives IDENTICAL commands on one state, however the rows are ordered', () => {
    // A fresh state (a settler that founds, a worker that starts a job, a city that is
    // set to build) and two mid-game states (cities with queues, goods, several units
    // per role) — so the two choices FINDING C named are both exercised and not merely
    // present in the file.
    const cases: readonly {
      readonly label: string;
      readonly state: GameState;
      readonly seed: number;
    }[] = [
      { label: 'fresh state, seed 41', state: freshState(41), seed: 41 },
      { label: 'turn 10, seed 41', state: drive(41, SIMPLE_POLICY, 10).state, seed: 41 },
      { label: 'turn 14, seed 46', state: drive(46, SIMPLE_POLICY, 14).state, seed: 46 },
    ];

    const sawCommands = new Set<Command['type']>();
    let comparisons = 0;

    for (const probe of cases) {
      for (const player of civPlayers(probe.state)) {
        const baseline = SIMPLE_POLICY.chooseCommands(
          ctxFor(probe.state, player.id, probe.seed, RULESET),
        );
        for (const command of baseline) sawCommands.add(command.type);
        comparisons += 1;

        for (const order of ROW_ORDERS) {
          const commands = SIMPLE_POLICY.chooseCommands(
            ctxFor(probe.state, player.id, probe.seed, order.ruleset),
          );
          expect(canonicalize(commands), `${order.label} on the ${probe.label}`).toBe(
            canonicalize(baseline),
          );
        }
      }
    }

    // Non-vacuity, three ways: the loop really compared (2 civilizations × 3 states ×
    // 10 row orders); the commands it compared were not all empty; and every kind of
    // decision this policy makes was among them, so a permutation of the *catalog*
    // could have changed one. `SetProduction` and `StartWork` are the two FINDING C
    // named as inheriting content order.
    expect(comparisons).toBe(6);
    expect(sawCommands.size).toBeGreaterThan(0);
    expect([...sawCommands].sort()).toEqual([
      'FoundCity',
      'MoveUnit',
      'SetProduction',
      'SetWorkedTiles',
      'StartWork',
    ]);
  });

  it('ranks a worker’s job by the KIND its row builds, not by how its id is spelled', () => {
    // `StartWork` names a row by its **id**, while the ranking is over the row's
    // **kind** (`IMPROVEMENT_KINDS`), and the shipped catalog is exactly the case where
    // those two are the same word — so a ranking that read the id against the kind
    // vocabulary would look right there and be wrong for any other content. This
    // fixture separates them: the ids are prefixed so that their order is the REVERSE
    // of the kind order ('3-road', '2-mine', '1-irrigation'), so a ranking that read
    // ids would pick the irrigation row while a ranking that reads kinds picks the road.
    const ORDER: readonly string[] = IMPROVEMENT_KINDS;
    const renamed = validatedRuleset(
      {
        ...CATALOG,
        improvements: CATALOG.improvements.map((row) => ({
          ...row,
          id: asImprovementId(
            `${String(ORDER.length - ORDER.indexOf(row.kind))}-${String(row.id)}`,
          ),
        })),
      },
      'renamed-improvements',
    );

    const state = freshState(48);
    const worker = state.units.find(
      (unit) => unitDef(renamed, unit.type)?.role === 'worker' && unit.owner === asPlayerId(0),
    );
    if (worker === undefined) throw new Error('the fixture has no worker');

    const offered = unitActions(state, renamed, worker.id).filter(isStartWorkCommand);
    // Something to choose between, or the ranking is not exercised at all.
    expect(offered.length).toBeGreaterThan(1);

    const kindRankOf = (id: ImprovementId): number => {
      const kind = improvementDef(renamed, id)?.kind;
      return kind === undefined ? -1 : ORDER.indexOf(kind);
    };
    const byKind = [...offered].sort(
      (a, b) => kindRankOf(a.kind) - kindRankOf(b.kind) || compareId(a.kind, b.kind),
    );
    const byId = [...offered].sort((a, b) => compareId(a.kind, b.kind));

    const chosen = SIMPLE_POLICY.chooseCommands(ctxFor(state, asPlayerId(0), 48, renamed)).find(
      isStartWorkCommand,
    );

    // The policy took the job whose row's kind ranks first...
    expect(String(chosen?.kind)).toBe(String(mustRow(byKind, 0).kind));
    // ...and the two candidate orders really disagree here, so the assertion above is
    // about which rule was used and not about a fixture where both agree.
    expect(String(mustRow(byId, 0).kind)).not.toBe(String(mustRow(byKind, 0).kind));
  });

  it(
    'PLAYS THE SAME GAME — one hash, one metrics sequence — under the neutral row orders',
    { timeout: 120_000 },
    () => {
      // Three seeds, all of them real games (see the non-vacuity block): a claim about
      // one seed is a claim about one map, and the sections being permuted are read on
      // every map.
      const seeds = [1, 5, 41];
      const turns = 12;
      const neutral = [
        ...ROW_ORDERS.filter((candidate) => RUN_NEUTRAL_ORDERS.includes(candidate.label)),
        { label: COMBINED_ORDER_LABEL, ruleset: COMBINED_ORDER },
      ];
      let compared = 0;

      for (const seed of seeds) {
        const baseline = runFor(seed, RULESET, turns);
        const baselineMetrics = canonicalize(baseline.metrics);

        // Non-vacuity first: the run being compared really played. On every seed and
        // window below the policy founds cities, walks units, sets production and puts
        // workers on jobs, so `improvements` — the section whose reversal used to move
        // this run — is a section a decision was actually taken from.
        expect(baseline.finalState.cities.length, `seed ${String(seed)}`).toBeGreaterThan(1);
        expect(baseline.finalState.improvements.length, `seed ${String(seed)}`).toBeGreaterThan(0);
        expect(baseline.finalState.units.length, `seed ${String(seed)}`).toBeGreaterThan(5);
        expect(baseline.metrics.length, `seed ${String(seed)}`).toBeGreaterThan(20);
        expect(baseline.violations, `seed ${String(seed)}`).toEqual([]);

        for (const order of neutral) {
          const where = `${order.label} on seed ${String(seed)}`;
          const played = runFor(seed, order.ruleset, turns);
          compared += 1;

          expect(played.finalHash, where).toBe(baseline.finalHash);
          expect(canonicalize(played.metrics), where).toBe(baselineMetrics);
          // The state itself, not only its hash: every field of every city, unit, tile
          // and player pool. A hash agreement with a different state would be a
          // collision, and "identical metrics" would still leave the game unproven.
          expect(canonicalize(played.finalState), where).toBe(canonicalize(baseline.finalState));
          expect(played.turnsPlayed, where).toBe(baseline.turnsPlayed);
          expect(played.stoppedBecause, where).toBe(baseline.stoppedBecause);
          expect(played.violations, where).toEqual(baseline.violations);
        }
      }

      // The comparisons really happened: 3 seeds × 9 row orders of an order the engine
      // is neutral to (eight single-section permutations and the three-section shuffle).
      expect(compared).toBe(seeds.length * neutral.length);
      expect(neutral.map((candidate) => candidate.label)).toContain(COMBINED_ORDER_LABEL);

      // And the complement — the orders NOT asserted identical above — is exactly the one
      // section the generator reads by row position, by name, so a *new* order dependence
      // introduced later (a fresh `find`, a positional `[0]`) fails this assertion instead
      // of passing unnoticed among the exceptions. `units` was in this list when the hut
      // reward was "the first military land row"; the canonical pick moved it to the
      // neutral half above, which is the assertion getting stronger rather than the list
      // being trimmed.
      expect(
        ROW_ORDERS.filter((candidate) => !RUN_NEUTRAL_ORDERS.includes(candidate.label)).map(
          (candidate) => candidate.label,
        ),
      ).toEqual(['resources×reversed', 'resources×shuffled']);
    },
  );

  it('FINDING C (engine, hut.ts): a hut hands out the same unit whatever row it holds', () => {
    // No policy is involved anywhere in this test: the state is hand-built from a real
    // one, the RNG is chosen so the hut's single draw selects its `unit` reward, and
    // `resolveHutEntry` is called directly — it is `commands.ts` that calls it inside
    // `MoveUnit`. This test used to pin the OPPOSITE fact — that `hut.ts`' `rewardUnitDef`
    // was `unitCatalog(ruleset).find(role === 'military' && domain === 'land')`, "the
    // first military land unit in catalog order", so reversing `CATALOG.units` handed out
    // the swordsman instead of the warrior. The rule is now canonical — the **cheapest**
    // military land row, ties broken by id — so the same state and the same draw give the
    // same unit under both orders, which is the stronger statement this test now makes.
    const seed = 1;
    const created = newGame(seed, settingsFor(seed), RULESET);
    if (!created.ok) throw new Error(`newGame(${String(seed)}) failed: ${created.error.kind}`);
    const fresh = created.value;

    const hut = mustRow(fresh.map.huts, 0);
    const mover = mustRow(fresh.units, 0);

    // A world RNG state whose next hut draw is the `unit` reward (`HUT_REWARD_KINDS[0]`;
    // `nextBelow` is the draw `resolveHutEntry` itself takes). Searched by advancing a
    // local cursor — a pure function of the state, no ambient randomness — and the
    // branch is asserted below rather than assumed.
    let cursor = fresh.rng;
    let chosen: typeof fresh.rng | undefined;
    for (let step = 0; step < 64 && chosen === undefined; step += 1) {
      if (nextBelow(cursor, 3)[0] === 0) chosen = cursor;
      else cursor = nextUint32(cursor)[1];
    }
    if (chosen === undefined) throw new Error('no RNG state in range draws the hut unit reward');

    const standing: GameState = {
      ...fresh,
      rng: chosen,
      units: fresh.units.map((unit) => (unit.id === mover.id ? { ...unit, tile: hut } : unit)),
    };

    const reversedSets: Ruleset = validatedRuleset(
      catalogInOrder('units', 'reversed'),
      'units (reversed)',
    );
    const withFirstRow = resolveHutEntry(standing, RULESET, mover.id);
    const withLastRow = resolveHutEntry(standing, reversedSets, mover.id);
    if (withFirstRow === undefined || withLastRow === undefined) {
      throw new Error('the fixture did not enter a hut');
    }

    /** The units the entry added, by type — the reward, read off the state. */
    const spawned = (outcome: HutEntryOutcome): readonly string[] =>
      outcome.state.units
        .filter((unit) => !standing.units.some((candidate) => candidate.id === unit.id))
        .map((unit) => String(unit.type));

    // The branch is the one this test claims to exercise, in both orders.
    expect(canonicalize(withFirstRow.events)).toContain('"reward":"unit"');
    expect(canonicalize(withLastRow.events)).toContain('"reward":"unit"');

    // The measured fact, after the fix: the SAME state, the SAME draw, the SAME unit —
    // because the answer is a function of the rows' content (price, then id) and not of
    // their position. Non-vacuity: the reversed catalog really does put a different row
    // first, so the old positional rule would have handed out the swordsman here, and the
    // two orders really are two different rulesets (their hashes differ).
    expect(spawned(withFirstRow)).toEqual(['warrior']);
    expect(spawned(withLastRow)).toEqual(['warrior']);
    const firstMilitaryLand = (ruleset: Ruleset): string | undefined => {
      const row = ruleset.units.find(
        (candidate) => candidate.role === 'military' && candidate.domain === 'land',
      );
      return row === undefined ? undefined : String(row.id);
    };
    expect(firstMilitaryLand(RULESET)).toBe('warrior');
    expect(firstMilitaryLand(reversedSets)).toBe('swordsman');
    expect(hashValue(reversedSets)).not.toBe(hashValue(RULESET));

    // ...and nothing else about the outcome moved: the hut was consumed, the RNG
    // advanced identically, and the two outcomes are the same state.
    expect(canonicalize(withLastRow.state.map)).toBe(canonicalize(withFirstRow.state.map));
    expect(canonicalize(withLastRow.state.rng)).toBe(canonicalize(withFirstRow.state.rng));
    expect(withLastRow.state.units.map((unit) => String(unit.id))).toEqual(
      withFirstRow.state.units.map((unit) => String(unit.id)),
    );
    expect(canonicalize(withLastRow.state)).toBe(canonicalize(withFirstRow.state));
    expect(canonicalize(withLastRow.events)).toBe(canonicalize(withFirstRow.events));
  });

  it('FINDING C (engine, gen.ts): the WORLD is a function of the resources row order', () => {
    // The second engine dependence, and the starker one: it needs no policy at all.
    // `generateWorld` places resources row by row, drawing from the **map RNG** once
    // per copy *in row order* (`perRow` copies per row, each draw removing a tile from
    // that row's pool), so permuting `CATALOG.resources` permutes the draws: a
    // different world is generated from the same seed, before any decision is taken.
    //
    // The baseline policy is the one that commands nothing, so what is measured here
    // cannot be a policy's doing.
    const seed = 1;
    const turns = 6;
    const idle = (ruleset: Ruleset): SimulationResult =>
      runSimulation({
        seed,
        settings: settingsFor(seed),
        ruleset,
        policies: [DO_NOTHING_POLICY, DO_NOTHING_POLICY],
        maxTurns: turns,
      });

    const baseline = idle(RULESET);
    const reversedSets = validatedRuleset(
      catalogInOrder('resources', 'reversed'),
      'resources (reversed)',
    );
    const flipped = idle(reversedSets);

    // Non-vacuity: the world really holds resources, so "the resources differ" is a
    // statement about placement and not about an empty list.
    expect(baseline.finalState.map.resources.length).toBeGreaterThan(0);
    // Terrain and huts are placed *before* resources in the generator and never
    // consult the ruleset's row order, so they are identical...
    expect(canonicalize(flipped.finalState.map.terrain)).toBe(
      canonicalize(baseline.finalState.map.terrain),
    );
    expect(canonicalize(flipped.finalState.map.huts)).toBe(
      canonicalize(baseline.finalState.map.huts),
    );
    // ...while the resources are not, and neither is the run: the world itself moved,
    // with no policy in the loop.
    expect(canonicalize(flipped.finalState.map.resources)).not.toBe(
      canonicalize(baseline.finalState.map.resources),
    );
    expect(flipped.finalHash).not.toBe(baseline.finalHash);
    expect(baseline.finalState.cities).toEqual([]); // the baseline decided nothing at all
  });

  it('FINDING C (engine): a reversed units row order no longer moves the run at all', () => {
    // The last trace of FINDING C, measured so its absence is evidence rather than a hope.
    // With the rows of `units` reversed the whole 12-turn game used to differ in exactly
    // one way — the TYPE of the units the huts handed out (the engine rule pinned above,
    // which took the first military land row) — while everything else was identical, and
    // the old symptom, an AI fielding an armada of galleys, was already gone. The hut
    // reward is now canonical, so the whole run is byte-identical: same units, same ids,
    // same types, same cities, same tiles, same RNG, same hash. The assertion got
    // STRONGER with the fix, not weaker: it no longer needs a type-blind comparison to say
    // that row order is inert here.
    const seed = 1;
    const turns = 12;
    const reversedSets = validatedRuleset(catalogInOrder('units', 'reversed'), 'units (reversed)');
    const baseline = runFor(seed, RULESET, turns);
    const flipped = runFor(seed, reversedSets, turns);

    // Non-vacuity, without which the equality below would be a claim about two runs that
    // never differed: the reversal really reorders the section, the two rulesets really
    // are different rulesets, and the run really holds units for the huts to have paid
    // for (asserted before the comparison, so it is not read off the equality).
    expect(sectionIds(reversedSets, 'units')).not.toEqual(sectionIds(RULESET, 'units'));
    expect([...sectionIds(reversedSets, 'units')].sort()).toEqual(
      [...sectionIds(RULESET, 'units')].sort(),
    );
    expect(hashValue(reversedSets)).not.toBe(hashValue(RULESET));
    expect(baseline.finalState.units.length).toBeGreaterThan(1);

    expect(flipped.finalHash).toBe(baseline.finalHash);
    expect(canonicalize(flipped.finalState)).toBe(canonicalize(baseline.finalState));
    expect(canonicalize(flipped.metrics)).toBe(canonicalize(baseline.metrics));
    expect(flipped.turnsPlayed).toBe(baseline.turnsPlayed);
    expect(flipped.stoppedBecause).toBe(baseline.stoppedBecause);
    expect(flipped.violations).toEqual(baseline.violations);
    const types = (result: SimulationResult): readonly string[] =>
      result.finalState.units.map((unit) => String(unit.type));
    expect(types(flipped)).toEqual(types(baseline));
    expect(types(baseline)).not.toContain('galley');
  });
});
