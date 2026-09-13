# CivTS

A Civilization III–shaped 4X strategy game in TypeScript, built to be played and
debugged by an autonomous agent as well as by a human.

**Status: pre-alpha, at the alpha boundary.** M0–M10 have landed; the commit this
document was written against is `d4e7f72` ("M9+M10: culture, borders, governments,
happiness, victory and score"), with M11 (save/load/replay + the alpha audit) being
written in the working tree at the same time. `PLAN.md` §16 defines alpha and lists
the exit criteria A1–A7; `docs/KNOWN-ISSUES.md` lists what is deliberately not in it.

Every number quoted below was measured in one session on this machine
(2026-09-13, 18:14–18:44 UTC, an eight-core box that other workspaces were also
using — load average 3.0–13.1). Where a figure is a reading rather than a promise it
says so, with the time it was taken.

## Requirements

- **Node 24** — `.nvmrc` says `24`, `engines.node` says `>=24.0.0`. Measured here:
  `v24.20.0`. Determinism is only guaranteed for a pinned `(engine version, Node
  major)`; the golden files record the major they were made under.
- **pnpm 11** — `packageManager` pins `pnpm@11.24.0`. Measured here: `11.24.0`.
- No other services. The web app binds loopback on its own port; nothing needs the
  network.

```bash
pnpm install
```

The dependency tree is already installed in this checkout; `pnpm install` is what a
fresh clone needs. The install is non-interactive: `pnpm-workspace.yaml` declares
`allowBuilds.esbuild` so the one package that needs a postinstall step does not ask.

## Play the game

### In a browser (the way a human plays)

```bash
pnpm --filter @civts/web dev
# Vite ready in ~230 ms, then open:
#   http://127.0.0.1:4174/
```

Measured in this session: the server answered `HTTP 200` with a 901-byte
`index.html`, and Vite reported `ready in 226 ms`. **The port is 4174 and it is
this app's own port.** Port 3080 belongs to the DSH GUI used to drive the agents;
nothing here reads, proxies, restarts or rebinds it.

The page *is* the engine host: `@civts/core` and `@civts/rules` are pure TypeScript
with no Node dependencies, so the browser runs the same source the headless tests
run — there is no server-side game state and no second copy of the rules. A
production build is `pnpm --filter @civts/web build` followed by
`pnpm --filter @civts/web preview` (same host and port).

What you can do in the app: start a new game with settings (seed, map size, civ
count), pan and zoom the map, select units and give orders, open the city screen
(growth, production queue, worked tiles, culture, happiness), open the technology
tree and pick research, open the government selector, switch panels, watch the event
log, read the scoreboard, and play on until a victory/defeat screen names the
condition and the winner. Screenshots the suite produced live in
`packages/web/artifacts/` (for example `played-game.png`).

### In a terminal (the way an agent plays)

```bash
pnpm play --seed 42 --map-size tiny --civs 2 --player 0
pnpm play --seed 42 --god          # render the whole map, ignore fog
pnpm play --seed 42 --script session.txt   # run a command file, print the transcript, exit
```

The REPL draws the map from your fog of war after every command, and prints the
economy, your research and your rates in the banner. Its verbs, as the live `help`
lists them:

```
move <unitId> <x> <y>      attack <unitId> <x> <y>     fortify <unitId>
found <unitId>             cities                       city <cityId>
work <cityId> <x> <y> ...  build <cityId> <unit|building>:<id>
work <unitId> <improvementId>   cancel <unitId>
rates <tax> <science> <luxury>  research <techId>      tech
government [<governmentId>]     culture   happiness    outcome
end   units   state   save <path>   load <path>   replay <path>   help   quit
```

`save` was verified in this session: it wrote a 109,980-byte file whose payload is
`{"version":1,"engine":{"schemaVersion":9,"nodeMajor":24},"hash":…,"state":…}`. `load`
was verified to round-trip: a game saved at seed 42 / turn 3 / revision 2 was loaded
by a session started with a *different* seed (7), and the loaded state reported
`seed=42 turn=3 revision=2` with hash `dddaa974829bff21` — the hash the save carried.
`load` and `replay` are M11 and were uncommitted at HEAD `d4e7f72`, so
`docs/KNOWN-ISSUES.md` §3.3 records exactly what exists at which revision. A session
with no `save` keeps its state in memory only, and the REPL says so when you quit.

`--script <file>` runs a command file and prints a deterministic transcript, which
is what makes a play session a regression fixture (`packages/headless/test/repl.test.ts`).

### Look at a world without playing it

```bash
pnpm map --seed 42 --map-size tiny --civs 2
```

Measured: ASCII map, legend, starts (`0=Player 1@45,15  1=Player 2@49,52`) and
`state hash: 782fe5306476b5d5`. That hash is the same digest the golden files use.

## Where the tests are

| Location | What lives there |
|---|---|
| `packages/core/test/*.test.ts` | Engine units: rng, map gen, state, movement, cities, growth, production, economy, combat, tech, borders, happiness, victory, turn pipeline |
| `packages/sim/test/*.test.ts` | The simulation harness: invariants and their fire cases, policies, the AI, batch and tournament machinery |
| `packages/testing/test/*.test.ts` | Goldens, hashing, the scenario DSL, and the per-milestone adversarial suites (`m2-adversarial` … `m9-m10-adversarial`) |
| `packages/headless/test/*.test.ts` | The CLI and the REPL, including fresh-process transcript stability |
| `packages/web/test/*.test.ts` | Pure renderer and panel logic (vitest, no browser) |
| `packages/web/e2e/*.spec.ts` | The real app in headless Chromium (Playwright): map, orders, city, tech, panels, save, determinism, keystone, accessibility |

Run one file:

```bash
npx vitest run packages/core/test/turn.test.ts
```

## The commands, and which of them are slow

All wall times below are `time` output for the whole command, on the box described
at the top. They are readings from one session, not budgets.

| Command | What it is | Measured wall time |
|---|---|---|
| `pnpm verify` | The fast gate: `check:static` (typecheck + cached eslint + cached prettier, run in parallel) then `vitest run` | **64.0 s** at 18:25 UTC — see the note below: that is the *previous* serial script, and the re-drawn one could not be measured end to end |
| `pnpm verify:full` | The same, with the long tests running and the caches bypassed (`CIVTS_TEST_TIER=full`) | **491.6 s** — 8 min 12 s (18:27–18:35 UTC), against the 10-minute bound |
| `pnpm --filter @civts/web test:e2e` | Starts the real app on 127.0.0.1:4174 and drives it in headless Chromium | **249.1 s** (≈4 min); 57 passed, 4 failed at load average 9.4 — the same 4 specs passed 9/9 on a re-run (87.2 s), so it is load-sensitive, not broken (see `docs/KNOWN-ISSUES.md`) |
| `pnpm tournament:evidence` | **A3's experiment**: 20 seeds × 100 turns of self-play with the real AI, as evidence rather than as a gate | **149.8 s** (2 min 30 s) |
| `npx tsx scripts/balance-sweep.ts` | One production knob (`units.settler.cost`) over a fixed seed set | 14.0 s |
| `npx tsx scripts/tech-balance-sweep.ts` | One technology-cost multiplier over a fixed seed set | 26.6 s |
| `npx tsx scripts/combat-balance-sweep.ts --knob <id>` | One combat knob (`warrior-attack`, `grassland-defense`, `walls-bonus`, `damage-per-round`, `capture-divisor`) | ≈16 s per knob (15.9 s measured for the default) |
| `pnpm rules:provenance` | The cited/placeholder table for every rules row | ~1 s (not separately timed) |
| `pnpm map`, `pnpm play` | Generate / play | ~1 s to first frame |

**The slow ones are `verify:full` (8 min), the e2e suite (4 min) and the tournament
evidence run (2.5 min).** Everything else is seconds. `verify:full` and the e2e
suite are *not* part of `pnpm verify`; the tournament run is deliberately not a test
at all, because a per-commit gate cannot hold it (M7b's decision, recorded in
`scripts/tournament-evidence.ts`).

The fast tier's bound is **≤ 70 s** (the internal target; alpha criterion A5's own
bound is 90 s). Measured headroom at 64.0 s is therefore 6.0 s — thin, and the honest
answer is that the tier is one long test away from its target.

The 64.0 s reading is from the **previous** serial script
(`typecheck && lint && format:check && test`) at 18:25 UTC, before M11's new files
existed. The script was re-drawn at 18:30 into a parallel, cache-backed
`check:static` plus `test`, with `check:static:full` and `lint:full`/`format:check:full`
kept for an honest uncached pass. Its components measured at 18:48:

| step | wall |
|---|---|
| `pnpm typecheck` | 8.2 s |
| `pnpm lint` (cached) | 4.2 s |
| `pnpm lint:full` (uncached) | 31.0 s |
| `pnpm format:check` (cached) | 3.1 s |
| `pnpm test` | 24.5 s — 64 files, 2095 passed, 56 skipped of 2151 (18:52 UTC) |

The three static steps run in parallel inside `check:static` rather than one after
another, and the cache is where most of the win is (31.0 s → 4.2 s for eslint alone).
**The composed `pnpm verify` was not measured green**, because at 18:50–18:52 it
stopped inside `check:static` — 8 of M11's own files were unformatted, one of its new
e2e specs had an eslint error, and its `repl.test.ts` did not typecheck — while that
wave was still landing. The test step itself was green on every attempt. The M11 wave
owns that change and its numbers: re-measure rather than assuming any figure above.

## Rules provenance

Fidelity is tracked, not asserted:

```bash
pnpm rules:provenance
# ruleset provenance — 0/60 cited (0%), 60 placeholder
```

**Every one of the 60 rules rows is currently `placeholder`: unsourced, chosen to be
playable, and explicitly not claimed to be Civ 3.** Nothing is `cited`. Setting
`fidelity: "cited-only"` makes the engine refuse to start while any active row is a
placeholder, so "is this Civ 3-accurate?" is a mechanical check rather than a claim —
and today that check is expected to fail.

Known trap this exists to prevent: a widely-linked "city growth mechanics" thread
that yields `20 + 2·pop` is **Civ IV**, not Civ III. Cite the game as well as the
number. `docs/GDD.md` carries the full provenance table.

## Determinism

Same seed + same commands ⇒ same state, on a pinned `(engine version, Node major)`.
No ambient randomness or time reaches the engine: the RNG state lives inside
`GameState`, simulation maths is integer-only, and `Math.random`, `Date.now`,
`performance.now` and the transcendentals are lint-banned inside
`packages/core/src` and `packages/sim/src`. The goldens
(`packages/testing/goldens/state.json`, 6 entries, `nodeMajor: 24`) fail loudly on a
mismatch and are **never** rewritten by a test run; a hash may only move by an
intentional regeneration with a `rehash: <reason>` line in the commit message.

## Layout

```
packages/
  core/       pure deterministic engine — zero runtime dependencies
  rules/      typed content + provenance for every row
  sim/        simulation harness: invariants, policies, the AI, tournaments
  testing/    invariants harness, hashing, scenario DSL, goldens
  headless/   CLI: map, play (REPL), sim, tournament, provenance
  web/        the browser app (Vite + Canvas 2D) and its Playwright suite
scripts/      the evidence scripts: balance sweeps, tournaments, behaviour probe
docs/         INTERFACES.md (frozen contracts), GDD, ENGINE, BALANCE, KNOWN-ISSUES, TASKS
PLAN.md       the plan of record, including §16 (what alpha means)
```

## Documentation map

- `docs/GDD.md` — the game as built, with the provenance table.
- `docs/ENGINE.md` — architecture, determinism, the turn pipeline, the invariant
  registry, the gate tiers, the golden policy, and the lesson ledger.
- `docs/BALANCE.md` — every measured sweep, including the ones that showed no effect.
- `docs/KNOWN-ISSUES.md` — the deferred list and every honest limit.
- `docs/TASKS.md` — the milestone ledger M0–M11 and the findings behind it.
- `docs/INTERFACES.md` — the frozen per-milestone contracts (do not edit).
