# KNOWN ISSUES — what is deferred, and every limit this project recorded

Alpha is a *stopping point*, not a finished game: `PLAN.md` §16.1 defines alpha as
the whole core loop present, integrated and playable by a human from the browser, and
§16.3 lists what is deliberately **not** alpha-blocking. This document carries that
list plus every honest limit recorded during the work — including the ones recorded
*by this documentation pass*, which are marked as such with the date and the command
that produced them.

Written against commit `d4e7f72` (M0–M10 landed) with M11 landing in the working tree
at the same time. Where a limit is a measurement, the measurement is named; where
something could not be measured, it says so instead of guessing.

---

## 1. Not in alpha (`PLAN.md` §16.3)

Deferred to beta or later, and deliberately **not half-implemented** — no stub rows,
no dead flags, no placeholder screens:

| deferred | state in this tree |
|---|---|
| Balance tuning beyond playability | numbers are playable and measured (`docs/BALANCE.md`); no tuning pass has been done |
| Corruption | not modelled at all |
| City **culture flips** | borders and per-city culture exist; a city changing hands by culture does not |
| Full diplomacy (alliances, treaties, trade) beyond war/peace | no diplomacy system; units may cross foreign territory and the rule site says so rather than pretending the omission is a design choice |
| Espionage | not modelled |
| Isometric renderer and sprites | the renderer is Canvas 2D top-down; PixiJS/isometric was deferred at M0 |
| Audio | none |
| Animation polish | none (frames are drawn, not animated) |
| Mod packs | none |
| Difficulty handicaps | `difficulty: "regent"` exists in settings and changes nothing |
| Auto-explore / auto-improve | none |
| Multiplayer | none |

## 2. Deferred inside the engine's own contracts

- **Space race is unimplemented.** There is no `VictoryConditionId` for it and no
  catalog row; the M9+M10 contract requires it be *named* as deferred rather than
  silently absent, which it is (in the catalog notes and `docs/GDD.md` §5).
- **A government change has no anarchy transition.** `SetGovernment` takes effect
  immediately; a real revolution's anarchy is not modelled, and the catalog row says so.
- **Luxury resources had no effect until M9**; they now content citizens. See §6 for
  three prose sites that still say otherwise.
- **`techs` is the one catalog section `applyOverrides` cannot patch.** The
  `RulesetPatch` surface covers buildings, capture, combat, culture, governments,
  improvements, resources, score, terrains, units and victory — and reports `techs` as
  unpatchable rather than silently dropping it. A tech-cost sweep therefore has to
  scale the catalog directly (which `scripts/tech-balance-sweep.ts` does, and prints).
- **No stacking limit** beyond "no stacking on an enemy".
- **The multi-growth path is unreachable with the shipped catalog** (recorded at M3):
  terrain food never exceeds the 2 a citizen eats, so the only possible surplus is a
  city centre's floor. A mutation probe that turns growth's `while` into an `if`
  passes every test in the repository that plays real games. It becomes live the moment
  a 3+ food terrain is sourced.
- **A bankruptcy-driven building loss emits no event**, so it is a silent state
  change the REPL can only show after the fact. A `BuildingLost` event is still owed.

---

## 3. Defects measured in this session (2026-09-13) — open, or closed with its evidence

These were found by running shipped commands, not by reading code. They are recorded
here because a documentation pass that reports only the flattering facts is worse than
no documentation. Each entry says which it is: **open** with the measurement that still
reproduces, or **closed** with the command that shows the fix working. A closed entry is
kept rather than deleted, because the defect is what the next reader needs to recognise
if it comes back.

### 3.1 A real invariant violation, reachable from shipped content

```bash
npx tsx packages/headless/src/cli.ts sim --seeds 3 --map-size duel --civs 2 --turns 60 \
  --policy simple --override units.warrior.attack=3 --json
# exit 1
# violations: captured-city-consistent — seed 3, turn 27:
#   city 0 (City 1) holds "pyramids" after a capture, and the city it was taken from did not hold it
```

Reproduced **twice**, independently: once through the CLI above and once through the
default run of `npx tsx scripts/combat-balance-sweep.ts`, which reports **4
violations** and exits 1, cutting 3 of its 15 runs short at `units.warrior.attack` 3,
4 and 5, all on seed 3.

Scope, measured rather than assumed: the same registry runs **zero** violations over
66,395 checks in A3's 20-game tournament with the shipping AI (`pnpm
tournament:evidence`), and the fast and full gates are green about it. So this is not
a general engine failure — it is a board state the registry refuses, reachable with
the placeholder policy on a duel map at raised attack values, and **it is not
diagnosed** here (this pass owns documentation only). It is the reason
`docs/BALANCE.md` §3 says its table is not evidence.

### 3.2 Three prose sites contradict the engine about luxuries

Measured with `grep` (line numbers as of 18:47 UTC; these files were being edited by
the M11 wave at the time, so search for the sentence rather than trusting a number):

- `packages/headless/src/cli.ts:175` — "Luxuries are shown too and still do nothing:
  happiness is M9."
- `packages/headless/src/repl.ts:68-70` and `packages/headless/src/repl.ts:2816-2817`
  — "Luxuries still do nothing (happiness is M9)."

M9 has landed. The live banner the same code prints is correct ("luxuries CONTENT
CITIZENS: every 2 banked content one…"), so a reader gets contradictory sentences
from one program. The `--help` text is simply stale. It is the M7e failure class
again: prose that was true when written, in files this pass does not own.

### 3.3 `save` exists; `load`/`replay` were still landing

At commit `d4e7f72` the REPL's verb list ends at `save <path>` and there is no
`packages/core/src/serialize.ts`. During this session (18:30–18:50 UTC) the M11 files
appeared uncommitted in the working tree — `core/src/serialize.ts`, `core/src/replay.ts`,
their tests, and `load`/`replay` verbs in `repl.ts` and in the live REPL banner.

Both halves were exercised at 18:52 against that working tree:

- `save` wrote a 109,980-byte payload of the shape
  `{"version":1,"engine":{"schemaVersion":9,"nodeMajor":24},"hash":…,"state":…}`;
- `load` round-tripped: a state saved at seed 42 / turn 3 / revision 2 was loaded by a
  session started with seed 7, and the loaded state reported `seed=42 turn=3
  revision=2` with hash `dddaa974829bff21`, the hash the save carried.

So: **save/load works in the working tree and does not exist at HEAD.** Anyone
building from `d4e7f72` alone gets `save` and no way to read it back. The repository's
own rule — one serializer, in `packages/core/src/serialize.ts`, never
`JSON.stringify` at a call site — is exactly what that wave is closing.

### 3.4 The e2e suite is load-sensitive

Measured three times in one session, on the same box:

| run | load average at start | result | wall |
|---|---|---|---|
| full Playwright suite | 9.37 | **57 passed, 4 failed** | 249.1 s |
| those same 4 specs re-run alone | 13.13 | **9 passed, 0 failed** | 87.2 s |
| full suite again (the alpha audit's run) | 2.3–3.5 | **63 passed, 0 failed, 0 flaky, 0 retries** | 3.9 min |

The four failures were all "the app never reported `ready === true`" inside the
15 s readiness budget — a cold Vite dev server plus a busy box, not a code path the
re-run exercises differently. The suite count also moved from 57 to 63 as specs
landed, so the two readings are not the same test list; what is comparable is the
*failure mode*, and it is load, not code.

It is reported rather than explained away, and it is a real hazard:
**nobody should promise a green UI suite on a busy box.** The whole-suite figure is
only reproducible on a quiet one; a verdict that flips on machine noise is not a
criterion, which is why the e2e suite is not part of `pnpm verify` or `pnpm verify:full`.

### 3.5 The fast tier's headroom is thin

`pnpm verify` measured **64.0 s** wall at 18:25 UTC against an internal target of
**≤ 70 s** — **6.0 s**, or 8.6 %, of headroom — and alpha criterion A5's own bound is
90 s. Roughly half that wall time was static analysis, not tests: the M9+M10 wave
measured 78.3 s on the same box with about 47 s of it eslint and prettier. The M11
wave re-drew the scripts into a parallel, cache-backed `check:static` (with
`check:static:full` for an honest uncached pass) precisely because of this. Its
components measured at 18:48–18:52 on the in-flight tree: typecheck **8.2 s**, cached
eslint **4.2 s** (uncached `lint:full` **31.0 s**), cached prettier **3.1 s**, tests
**24.5 s** over 64 files / 2095 passed / 56 skipped of 2151. The **composed**
`pnpm verify` never went green in that window: it stopped inside `check:static` on
M11's own files (8 unformatted, 1 eslint error in a new e2e spec, 1 typecheck error in
`packages/headless/test/repl.test.ts`), all of them still landing. The **test step was
green on every attempt** — 61 files at 18:25, 63 at 18:48, 64 at 18:52.

So the honest statement is: the parts are fast, the composed command was not measured
with M11's files, and 64.0 s is a reading of the **previous** script that must not be
quoted as the current gate.

The gap that note left is now closed by measurement rather than by assumption. The
verifier measured the composed command **green** on the landed tree — **31.414 s** warm
(load 2.11 → 4.89) and **56.153 s** cold (`.cache` deleted first, load 2.87 → 6.16),
both EXIT 0 — and this pass re-measured it green as well: **32 s** raw wall for
`pnpm verify`, EXIT 0, `64 files / 2112 passed / 56 skipped of 2168`, taken at load
**5.78 → 7.95**, i.e. on a box that was *busy* rather than quiet. The cold figure is the
honest one for a fresh checkout and it is the tighter of the two: **56.2 s against the
70 s target leaves 13.8 s (20 %)**. The tier is inside its bound even at load ≈ 8, and
the bound is not generous; a checkout that has never run the gate should be read as
~56 s, not ~32 s.


### 3.6 The mutation check cannot run inside the shared suite

`pnpm mutation:check` deliberately breaks two source files on disk
(`packages/core/src/borders.ts`, `packages/core/src/cities.ts`), runs a child vitest
against them and restores them. Measured during M9+M10: with the file parallelism on,
**seven unrelated tests failed** in that ~3 s window, every one of them a
fresh-process hash comparison that had picked up the mutation. So it is gated on
`CIVTS_MUTATION_CHECK=1` and run in its own invocation with `--no-file-parallelism`,
and both tiers print it as **skipped** by name.

**It was not run in this session** — it mutates source files on disk for ~3 seconds,
and other agents were working in the same tree at the time. Unmeasured, not assumed
green.

### 3.7 Two of the four victory conditions have never ended an AI-played game

This is the project's largest honest gap, and it is a **shortfall, not a dead rule**.
Measured with the shipped catalog, the real AI (`smart`) in both seats, 20 seeds on
`tiny`, seats rotated:

| condition | ever ended a real AI-played game? | evidence |
|---|---|---|
| `cultural` | **yes, in self-play — it is the AI's whole game** | 13 of 20 at 150 turns, 18 of 20 at 200 turns |
| `score` | **yes, in self-play**, at the catalog's own horizon | 2 of 20 at 200 turns (seeds 3 and 7) |
| `conquest` | **only with the AI in ONE seat** — never in self-play | **0 of 100** self-play games; 6 of 6 against the do-nothing control |
| `domination` | **never, anywhere** | **0 of 100** AI-played games |

```bash
# 13 of 20 end at 150 turns, every one by `cultural`; 0 violations, 0 planner failures
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 150 --json

# 20 of 20 end at 200 turns: cultural 18, score 2
npx tsx scripts/tournament-evidence.ts --seeds 1..20 --turns 200 --json

# conquest, AI vs a do-nothing control: 6 of 6, at turns 35-42
npx tsx scripts/probes/outcome-aggregate-probe.ts
```

The 100 self-play games are P1's three horizons (20 each: 100, 150, 200 turns) plus
two further 20-game runs by the verifier P2; `conquest` and `domination` are **0** in
every one of them. `domination` is demonstrated only on **hand-built boards with
patched thresholds** — a city added by hand with `dominationLandPct: 1,
dominationPopPct: 50` — in `packages/testing/test/m9-m10-adversarial.test.ts:590–681`
and `:1314–1338`. It is boundary-tested at each of its two thresholds there, so the
rule holds; what has never happened is a *policy* playing its way to it. At the
shipped magnitudes (60% of the **map's** land, 40% of the world's citizens) the AI
neither takes nor grows that far inside 200 turns.

The `conquest` demonstration is weaker than its row makes it look: the do-nothing
control never founds a second city, so "the AI conquers" there means "the AI takes an
undefended capital", not "two AIs fight a war".

**A3's own wording** — *"at least one victory condition demonstrated ending a real
game"* — is **met**, by `cultural` and `score`. The M9+M10 acceptance line that asks
*each* condition to be "demonstrated ENDING A REAL GAME" is **not** met for `conquest`
or `domination`, and **"the victory system works" / "every victory condition works in
practice" would be an overstatement.** `docs/GDD.md` §5.1 and `docs/BALANCE.md` §8
carry the same table with their censuses.

### 3.8 The `checks` denominator was derived and the deciding turn was never checked — **fixed in this wave**

This was the verifier's **F2**, and it was two defects wearing one number.

*The defect, as measured.* Both `civts sim` and `civts tournament` reported
`invariants.checks` as `Σ turnsPlayed × invariantCount` (two derivations in
`packages/headless/src/sim-cli.ts`, at lines 1640 and 3037 as the file stood before the
repair), while the runner checked the game-over condition **before** it ran the invariant
registry and `break`ed on the turn that ended the game (`packages/sim/src/runner.ts`, the
game-over break at line 736 and the registry at line 746, again as the file stood before
the repair). So the **turn the game was decided on was handed to no predicate at all**,
and the reported figure was larger than the number of checks really run:

| run (before the fix) | reported `checks` | really run | over-reported |
|---|---|---|---|
| 20 seeds × 150 turns | 86,975 | 86,520 | 455 (0.52 %) |
| 20 seeds × 200 turns | 93,730 | 93,030 | 700 (0.75 %) |

Measured, not argued, by a probe that installs a one-invariant registry recording every
turn it is really given:

```bash
npx tsx scripts/probes/invariant-check-count-probe.ts
# before the fix:  turnsPlayed 35, checks really run 34, skipped 1
# after the fix:   turnsPlayed 35, checks really run 35, skipped 0
```

Two consequences, both stated rather than only the flattering one. (1) The **verdict was
unaffected**: 0 violations is 0 violations, and the reported count was the *larger* of
the two, so nothing was hidden by it. (2) The **coverage claim was overstated**, and the
gap was not academic — the skipped turn is the one on which a capture or a completion
happens, and `captured-city-consistent` (the invariant that really does fire on this
engine, §3.1) is a capture invariant. Had that capture also been the decisive one, the
run would have reported no violation at all. The suite could not catch it either:
`packages/headless/test/sim-cli.test.ts` **pinned the derived identity**
`checks === count × turnsPlayed` on a fixture whose runs do not end (line 500 as it stood
before the repair; the pin belongs to the defect and was rewritten with it).

*The repair, and how it is verified.* The runner now counts checks **where they happen**
— the registry it is handed is the caller's own entries with each `check` wrapped in a
counter, and `SimulationResult.invariantChecks` (required, never `undefined`) carries the
total — and it runs the registry **before** the game-over break, so the deciding turn is
checked like any other and no turn is double-checked or skipped. A violation still
outranks an ending when both land on the same turn, because a broken state is an engine
defect and has to be reported as one.

Re-measured after the repair, on this tree:

```bash
npx tsx scripts/probes/invariant-check-count-probe.ts     # skipped 0, on both arms
npx tsx packages/headless/src/cli.ts sim --seeds 1..2 --turns 200 --policy none \
  --map-size duel --json                                  # 199 turns → invariantChecks 6965 = 199 × 35
```

So the A3 figures (`86,975` and `93,730` at 150 and 200 turns) are **unchanged in value
and now true** rather than derived, and the coverage claim they carry is the one the
runner actually made. This is the repair's own acceptance evidence, and it is a
different thing from "the number looked right".

The lesson is the one this project keeps re-learning: **a denominator computed from the
loop's arithmetic is a claim about the loop, and a claim about a loop goes stale the
moment the loop has an early exit.** It is now counted where it happens.

### 3.9 The draw arm of the outcome report had no coverage — **closed in this wave**

**The finding (P2's mutation B′).** The verifier mutated the `winner === null` branch of
`gameOutcomeReport` (`packages/headless/src/sim-cli.ts`, line 2926 at the revision it
tested — search for the branch rather than trusting the number) to name the wrong
condition, and **the whole `sim-cli` suite stayed green**. No shipped condition reaches a
draw in a tournament, so the mutation was vacuous rather than the assertions being absent;
but the honest reading was that the draw path was **not covered**, and that a mutation
applied there proved nothing. The draw is a real outcome the frozen `GameOutcome` shape
exists for (`winner: null`, a score tie), so it was a coverage hole rather than a dead
branch.

**What closed it.** `packages/headless/test/sim-cli.test.ts` now has a fixture that
really reaches the arm — `'reports a drawn ending, and the counted checks rather than a
product'` — and asserts, on a drawn run, `kind === 'draw'`, `condition === 'score'`,
`turn === scoreHorizon(...)`, that the `winner` key is **absent** (not present-and-
undefined, which `canonicalize` refuses) and that the rendered text prints the draw
label. The `condition` and `kind` assertions are exactly what P2's mutation B′ flips, so
the mutation is no longer vacuous; the test's own comment names the mutation and the
report section it came from.

*Not independently re-run here:* this pass read the fixture and its assertions rather
than re-applying the mutation to another workstream's file. The claim is therefore "the
arm is now reached and its condition is asserted", which is what makes the mutation
visible — not "the mutation was re-executed and turned red".

### 3.10 The seat question: no effect supported at n = 20

Both seats run the **same policy** with the seats rotated, so a per-seat win total is a
measurement of the *position* and mixes no strategy. Counted from the per-game records
of the runs in §3.7:

| sample | endings | seat 1 wins | seat 0 wins | one-sided binomial p (fair coin) |
|---|---|---|---|---|
| 150 turns, 20 seeds | 13 | 10 | 3 | 4.61 % |
| 200 turns, 20 seeds | 20 | 12 | 8 | 25.17 % |
| 200 turns, the 15 games **not** on a plains start | 15 | 8 | 7 | **50.0 %** |
| 200 turns, the 5 plains-start games only | 5 | **5** | 0 | 3.13 % |
| the three horizons pooled — nested, double-counted | 38 | 27 | 11 | 0.69 % — *do not read this row* |

**No seat effect is supported at n = 20.** The auditor's "seat 1 won 5 of 5" was the
whole 100-turn sample, and 5 of 5 is p ≈ 3.1 % — the p-value of a coincidence — and it
is **not** a pure start-terrain artefact, because seeds 18 and 19 are grassland starts
that seat 1 also won. At the largest sample seat 1 wins 12 of 20 (60 %, p = 25 %).
The residue that is left lives in the **starting position**, which is measurably
asymmetric:

```bash
npx tsx scripts/probes/starting-position-probe.ts
# seat 0: grassland in all 20 seeds.
# seat 1: plains in exactly 5 — seeds 3, 8, 12, 16, 20 — in every configuration,
#         because map generation is deterministic.
```

Seat 1 won all 5 of those plains-start games at 200 turns and lost the other 15 by
**8–7** — dead even. P2's conclusion is the one recorded here: a plains-only effect,
5 of 5 twice over in two independent runs, is a **map-generation** finding (a systematic
start asymmetry worth its own look), not a seat effect, and it is not alpha-blocking.
To be convincing at this sample size a one-sided result would need **≥ 15 of 20**
(p = 2.07 %; 14 of 20 is 5.77 % and does not clear 5 %), at a horizon chosen before
looking, with the excess still present in the 15 non-plains-start games. No
wrong-player crediting was found: the winner every game reports is the seat the engine's
`gameOutcomeOf` names, checked against an independent read of the board.

The pooled row is printed only to show the trap: pooling *nested* horizons counts the
same game twice and manufactures a "significant" result. (Its p-value is **0.69 %**, not
the 0.9 % an earlier draft of `docs/BALANCE.md` printed — see §3.11.)

### 3.11 Figures that did not reproduce, and readings that move

Recorded here rather than quietly corrected, because a figure a reader cannot reproduce
is exactly the class of defect this document exists to catch.

- `docs/BALANCE.md:331` printed the pooled double-counted row's p-value as **0.9 %**. The
  counts in that same row (27 seat-1 wins of 38 endings) give
  `P(X ≥ 27 | n = 38, p = ½) = 0.69 %`; no neighbouring count gives 0.9 %. Fixed in this
  pass, and the arithmetic is quoted there so it can be re-checked. The other five
  p-values in that table (3.1 %, 4.6 %, 25.2 %, 50.0 %, 2.07 %, 5.77 %) were recomputed
  and reproduce exactly.
- The README's **64.0 s** fast-gate reading and the note that the composed `pnpm verify`
  "was not measured green" were true when written and are no longer the current gate;
  both are now superseded by a measured green run (§3.5), with the raw time and the load
  average beside it.
- The tournament wall times are **load-sensitive** and move run to run: the 150-turn
  configuration took 171.7 s, 173 s and 172.4 s across three runs, and the 200-turn one
  187.8 s, 188 s and 192.8 s — the same deterministic games, the same counts, the same
  final hashes. The millisecond figures are readings of the box, not properties of the
  engine, which is why every one of them is quoted with a load average.

### 3.12 Textured tiles broke a contract they claimed to keep — **resolved: the palette adopted the art**

The sprite commit (`2376dd5`) added sixteen generated PNGs and painted the map with
them. All sixteen are correct and complete against the catalog
(`packages/web/assets/PROVENANCE.md`), but three end-to-end tests fail on this tree,
and the commit's own central claim is measurably false:

> "Keeps owner badges, selection outlines, and the documented terrain centre colours
> so the existing render contracts still hold."

**It does not keep the documented terrain centre colours.** `lock_centre()` in
`assets/tiles/process_tiles.py` writes the palette colour into the exact centre pixel
of the *source* PNG, but the e2e samples the *painted canvas* after the texture has
been scaled into the tile rect — where one pixel is a blend of its neighbours and the
locked value is gone. Measured, not inferred:

```
grassland  painted rgb(84, 143, 52)  documented #4a9d4a  differs by 28
coast      painted rgb(76, 207, 210) documented #3aa0c8  differs by 51
```

`map.spec.ts:167` allows a difference of 24 and `m8-adversarial.spec.ts:1410`
compares against the palette outright, so both fail. The lock is applied at the wrong
layer: it is a property of the file, and the tests are a property of the pixels.

**`map.spec.ts:273` fails for an unrelated reason.** `ZOOM_DEFAULT_INDEX` went `2 → 3`
in the same commit, so the test's *opening* `zoomTo(page, 1, 1)` now lands on the
maximum level (128 px per tile) and the later zoom has nowhere left to go:
`128 == 128`. This is deterministic, not load flake — it reproduces on an idle box.

**Both were decisions about which art is canonical, and both were put to the project owner,
who chose to adopt the art.** What that meant in practice:

*The palette was re-derived from the pixels, not re-guessed.*
`e2e/terrain-palette-probe.spec.ts` (`CIVTS_PALETTE_PROBE=1`) samples painted tile centres
through the app's own seam and prints the mean, the spread and the pairwise separation. Its
first version found only two terrains, because a seeded start explores a patch of about 6x6
tiles; sweeping seeds fixed that, and the mountains needed naming explicitly — a script over
the engine found that only 39 of the first 2500 `tiny` seeds put a mountain inside a starting
visibility radius. Over 79 seeds:

```
coast      n= 277  mean=rgb(71,202,208)  #47cad0  worst-offset=23  max-pairwise=44
grassland  n=1677  mean=rgb(90,145,56)   #5a9138  worst-offset=36  max-pairwise=48
hills      n= 281  mean=rgb(125,107,71)  #7d6b47  worst-offset=23  max-pairwise=37
mountains  n=  78  mean=rgb(125,126,127) #7d7e7f  worst-offset=15  max-pairwise=27
ocean      n=  70  mean=rgb(41,87,141)   #29578d  worst-offset=29  max-pairwise=44
plains     n= 145  mean=rgb(193,153,60)  #c1993c  worst-offset=10  max-pairwise=18
```

Those means are now `TERRAIN_COLOURS` in `render.ts`, and the two tolerances the commit had
outgrown (24 and 8) are one shared constant each, both measured rather than chosen:
`TERRAIN_CENTRE_TOLERANCE` = 44 (covers the widest 36 with margin) and
`TERRAIN_SAME_KIND_TOLERANCE` = 56 (covers the widest 48, and stays under the closest
separation between two terrains, hills/mountains at 75).

**This table took three attempts, and its own numbers are what caught the first two.**

1. The probe exited as soon as all six terrains had appeared, which for this seed list happened
   before the seeds collected *for their mountains* were ever reached — so mountains rested on
   **3 tiles**. The weakest number was weak because of an early `break`, not because mountains
   are rare. Removing it took mountains to 56 and **moved hills and mountains**.
2. `MOUNTAIN_SEEDS` then held **30 of the 39** seeds it claimed to hold. The list had been copied
   out of a script that printed `slice(0, 30)` while the prose said "that list" — the evidence was
   narrower than its own description, which is the failure mode this document exists to catch.
   A verifier found it by enumerating the seeds against the engine instead of reading the list.
   Completing it took mountains to 78 and **moved hills, mountains and ocean**.

The palette has therefore moved three times, by one point in each affected channel, and the
tests passed through all three — because `TERRAIN_CENTRE_TOLERANCE` is 44 and a point is nothing
beside it. `render.ts` now says so at the point of use, so that nobody chases the last digit:
what has to be right is the evidence, not the rounding. The lessons are the two this project
keeps re-learning — a number produced by a loop with an early exit describes the loop (§3.8),
and a claim is only as wide as the thing it actually enumerates. `lock_centre` is left in
`process_tiles.py` and is now documented as *not* the thing that sets the contract — it locks
a file's centre pixel, and the contract is about the canvas.

*Because the tolerance widened, an assertion was added — and an independent verifier then showed
it does not do what its comment claimed.* `map.spec.ts` also requires each sample to be **nearer
its own terrain's documented colour than any other terrain's**. The claim was that this catches a
wrong-terrain mapping "that the tolerance alone would hide". It does not: the global minimum of
`separation − spread of the painted terrain` is 52, which is above the 44 tolerance, so a
mispainted tile is always caught by the tolerance line first and never reaches this one. What it
actually catches is a **documentation collision** — two terrains documented too close to tell
apart — which the absolute bound cannot see, since it compares a sample with one colour at a
time. Setting `hills` to grassland's colour fails this line and only this line; swapping two
terrains' textures fails the tolerance line. Both checks are worth having; the comment now says
which is which instead of claiming the stronger one.

*A worse hole, found the same way.* The pixel test seeded once, and at `SEED` (4242) the starting
patch holds only coast, grassland and ocean. **Swapping the hills and mountains textures — the
closest pair in the palette, 75 apart, and the one most worth checking — left both
`map.spec.ts` and `m8-adversarial.spec.ts` green.** The test now sweeps `PALETTE_SEEDS` (4242,
70, 75), a cover found by enumerating the engine over seeds 1..120 rather than by guessing, and
it asserts that the sampled terrains equal the palette's keys — so the coverage cannot quietly
shrink again. Verified by mutation: the hills/mountains swap now fails with
`tile 733 is hills and sampled rgb(120, 121, 122), but the app documents #7d6b47 for it`
(70 > 44). `m8-adversarial.spec.ts` still samples a single frame, so its coverage remains limited
to whatever terrains that frame holds; that is recorded rather than presented as complete.

*The zoom test zooms out instead of in.* The app keeps its `2x` opening
(`ZOOM_DEFAULT_INDEX` stays 3, so textured tiles read clearly); the test's own opening
`zoomTo` had already climbed to the innermost level, so the assertion was measuring the
ceiling of the zoom range rather than the projection changing.

**Verified by breaking it, not by watching it go green.** Swapping the grassland and hills
textures in `src/tiles.ts` turns `map.spec.ts` red with
`tile 2008 is grassland and sampled rgb(130, 111, 76), but the app documents #5a9138 for it`
— so the widened tolerance still sees a wrong terrain — and `src/tiles.ts` reverted
byte-identical. The zoom assertion is **not** independently falsifiable: collapsing every zoom
ratio to the same value makes `zoomSign` throw first, so that requirement is enforced by the
helper and the assertion restates it. That is said in the code beside the assertion rather
than left implied.

Two further tests that the same commit broke — `determinism.spec.ts:156` and
`panels.spec.ts:64`, both failing with "the M8 test seam is missing" — were **races,
not contract changes**, and are fixed. `start()` became `async` and now decodes the
sprites before publishing `window.__CIVTS__`, so a spec that reloads and seeds
immediately was racing the decode; `seedApp` now waits for the seam the way `openApp`
always did. The same commit also shipped with the fast gate red (`render.ts` was not
prettier-clean) and turned a failed boot into a blank page — `void start()` with no
`catch` — which now reports on the page instead. Suite state: **58 passed / 5 failed
before, 60 passed / 3 failed after the first pass, 63 passed / 0 failed once the art was
adopted.**

---

### 3.13 Every unit of every player was drawn through the fog — **closed, with the mutations that prove it** (2026-09-14)

Found by reading `main.ts` and confirmed by measurement, not by a failing test — the suite had no
test that could see it, which is why it survived to this pass. Recorded in the plan as
`docs/UI-OVERHAUL.md` §7.8.

**The defect.** `unitMarkers` was `state.units.map(…)` — every unit of every player, with a comment
claiming "this file does not decide what is visible". True of that function, and false of the app:
nothing downstream decided either. `render.ts` filters markers by **viewport** only
(`if (!onScreen(rect.x, rect.y, viewport)) continue`), and fog is applied to *terrain* alone (an
unexplored tile is filled flat `FOG_COLOUR`), so the frame painted an unexplored tile as unknown and
then painted the enemy standing on it.

**The measurement.** At game start on a `small` map with 4 civilizations (seeds 1, 7, 75, 4242),
**all 6 foreign units stood on never-explored ground, and all 6 were drawn.** Reading the canvas
rather than the map at a hidden unit's tile centre gave `rgb(82, 67, 47)` — a unit sprite — where
the fog colour is `#31394a`; the same tile carried **81** pixels of that unit's owner colour (the
marker's badge) inside ground the player had never seen. The same numbers appear in the mutation
output below, which is what makes the test evidence rather than decoration.

**The rule, which is now written where the markers are built** (`packages/web/src/main.ts:199`,
`:224`). `fog.ts` exports two different notions and they must not be conflated:

- **units → `visibleTiles`** (current sight, derived from the viewing player's own units). A marker
  is a claim about what the player can see *this instant*, so a rival that walks out of range stops
  being drawn.
- **cities → `isExplored`** (memory). You keep a city you have seen on the map after it leaves your
  sight, which is the genre convention and what this codebase already does one layer down — the
  border tint is drawn only on an explored tile. **This half is an owner-level decision, taken for
  consistency rather than derived from the leak**, and it is stated here so it can be overridden:
  swap it to `visibleTiles` and cities will vanish when they leave sight.

The renderer stays a pure function of `(state, camera, viewport, markers)`; the app asks the engine
which markers to hand it.

**What the test now proves** (`packages/web/e2e/map.spec.ts:619`, "fog: a rival the player cannot see
is not painted, one it can see is, and one that walks out of sight stops being painted"). It plays a
`duel` / 2-civ game to turn 23 (seed 12), reads the **app's own state through its own save path** so
that the engine's `visibleTiles` and `isExplored` can be asked about the browser's game rather than
about a copy of the rule, and asserts four things, each with its premise asserted too so that none
can quietly vanish:

1. a rival on never-explored ground: the tile centre is exactly `FOG_COLOUR` **and** no pixel of the
   tile is that unit's owner colour;
2. **the control** — a rival in the player's sight *is* painted (> 0 pixels of its owner's colour);
   without this, a build that painted no units at all would pass (1);
3. founding the settler's city (one player action, consuming the sight that unit contributed) takes
   a rival out of sight while its tile stays **explored** — and its marker is gone while the tile
   is still painted as remembered terrain. This is the assertion that distinguishes the two rules;
4. cities, both directions: the player's own city marker is painted, and a rival city on
   never-explored ground is not.

The instrument is `countTilePixels` (`packages/web/e2e/helpers.ts:1008`), which counts pixels of a
tile's own rectangle that are exactly a colour. A centre sample cannot make claim (2): "the centre is
not fog" is also true of an app that paints no units at all.

**Falsified three ways, each RED, `main.ts` restored byte-identical**
(`sha256 6adf302069fe1e5e2a6448e34632688ae60a6a381aadd7f12d8483b7b240cd12`, checked with
`sha256sum -c` after each):

| mutation | result | first failure |
|---|---|---|
| unit filter forced always-true (the pre-fix behaviour) | RED | `rival worker (tile 1166) stands on ground the player has NEVER explored, … its centre reads rgb(82, 67, 47) instead of #31394a` |
| unit filter `isExplored` instead of `visibleTiles` | RED | `rival galley (tile 578) left the player's sight but its tile is still EXPLORED, and it is still painted: 81 of the tile's pixels are its owner's colour (#2f6fd1)`, expected 0, received 81 |
| city filter forced always-true | RED | `a rival city (tile 1366) stands on ground the player has never explored and its marker is painted: 318 of its tile's pixels are the city colour #f2e6c8` |

The second row is the one worth keeping: a build that swapped current sight for memory would pass
every other test in the repository and fails only here.

**The related leak that is NOT fixed (engine side, recorded rather than touched).** The shipped AI
policy reads fogged world data when it chooses where to walk: `exploreRanker`
(`packages/sim/src/policies.ts:~375`) ranks a candidate step by `hutAt(state, tile)` — the existence
of a goody hut on the *destination* tile — and by `yieldsAt` on that tile, with no `isExplored`
guard, so a rival scout can prefer an unseen hut to an unseen empty tile. (`revealCount` beside it
*is* guarded: it asks `isExplored`.) `inContact` reads enemy units and cities on the eight adjacent
tiles only, which are inside a unit's own sight radius, so it is not a leak in practice. This is a
reading, not a measurement, and it is left alone deliberately: the policy is the measurement
instrument every balance number in this repository was taken against, and changing what it can see
would invalidate them.

**Also recorded:** `FOE_COLOUR` (`render.ts:133`) is exported and used by nothing — markers take the
*owner's own* colour from the state, for the player's units and everyone else's alike. The comment on
`unitMarkers` used to claim foreign units were drawn "in a single warning colour", which was never
true; the claim is gone.

---

## 4. UI limits

### 4.1 A side screen is 380 px wide now, and the strip scrolls on a short window

**What changed, and why the old text was rewritten.** Until Phase 3 of the UI overhaul the
panels were **docked under the map**, in the map column, capped at 40 % of its height. Two
problems came with that, and the second one was measured: the column had two claimants, so
opening a panel shrank the map — at 900×1000 the map region fell from 915 px to 546 px when the
debug panel opened — which moves the box the camera clamps against and the click hit-test
inverts *while the player is looking at the same view*. (Putting the dock back under the map as a
mutation check in Phase 3 reproduced it at 1280×900: the canvas fell from 813×813 to 330×330 while
the debug panel was open, which is what the new assertion reports.) The dialogs
are now docked at the foot of the sidebar, where they share the strip with the panels (the stack
keeps 40 %, the dock may take 60 %), so the map column has one claimant and the map's box is
byte-identical with and without a panel open. `panel-usability.spec.ts` asserts that equality
directly, and the map-covering rule it has asserted since M8 is unchanged: a `position: fixed`
centred dialog was implemented, measured, found to intercept the pointer and the wheel, and
reverted with the evidence recorded.

**The honest cost, and it is a cost.** A docked panel is now **380 px wide** (the strip's width,
which is §7.7.5's still-open question) instead of as wide as the map column. The city screen is
the panel that feels it: twenty-one worked-tile labels at 380 px wrap onto many rows, so at a
900 px-tall window a player scrolls *within* the panel to see them all — `dialog { max-height:
100%; overflow: auto }` bounds it by the dock and the dock by the strip. Widening the sidebar is
the lever, and that is the owner's decision to make, not this phase's.

**What the suite asserts now, and what it still does not.** Geometric, and stronger than before:
the panel's box and its Close control are inside the window; the panel's box does not overlap the
unit's orders popup and the point at the centre of an orders control belongs to that control; the
middle of the map still belongs to the canvas; and the sidebar at 1280×900 — with a full event
log, a founded city and a live opponent — holds every panel and every scoreboard row and cell
without scrolling in either direction (`panel-usability.spec.ts`, "X1 sidebar"). It does **not**
assert that no scrolling is ever needed anywhere:

- **On a short window.** At 1600×700 the panels measure 765 px against a 617 px strip, so the
  stack scrolls: 249 px of it shows and 765 px of panels are in it, and the panel at the fold is
  cut by the stack's edge like any scrolled list. What the `flex: 0 0 auto` rule in `styles.css`
  prevents is the *other* resolution — the flex algorithm squeezing a panel's own box (measured:
  the scoreboard panel shrank 106 px → 10 px) — not this.
- **With a dialog open.** The dock may take 60 % of the strip and divides it among the open
  dialogs; measured with three open at 1280×900, they were 163 px, 189 px and 117 px tall holding
  973 px, 1031 px and 582 px of content. Each scrolls inside itself and each keeps its Close
  control visible (every dialog puts it directly under its heading), which is why the placement
  test still passes — but a player looking at the city screen in that state sees about a sixth of
  it.
- **Neither of those scrollbars is reliably visible.** Measured at 1600×700 while the stack
  overflowed: `offsetWidth === clientWidth === 380`, i.e. no classic scrollbar is being laid out,
  so Chromium paints an overlay scrollbar that appears only while scrolling. A vision review of
  screenshots taken for this phase read the result as *"the sidebar has stacked panels extending
  below the window without a visible scrollbar"* and *"the CITY 1 panel is cut off by the bottom
  edge"* — both true of the pixels, and both a scroll away from being wrong. Nothing is lost, and
  the honest way to say it is: below the fold the strip looks clipped rather than scrollable.

### 4.2 The map pixel test is not evidence about the terrain palette

`packages/web/e2e/map.spec.ts` samples the **centre of tiles that are visible,
explored and clear** (up to two per terrain id), and asserts that each sample matches
the colour the app itself documents for that terrain, that the same terrain samples
the same colour twice, and that two sampled terrains differ. That is real evidence
that pixels are painted **per terrain** for the terrains on screen at that camera,
seed and viewport — and it is **not** evidence that every terrain in the palette has
the right colour, because a terrain that is not on screen is never sampled. M8's own
mutation record matches this: forcing one colour for every terrain turned exactly two
terrain tests red, and no more.

Do not read "the map pixel test is green" as "the terrain colours are all correct".

### 4.3 Other UI limits

- The interactive-TTY branch of the REPL cannot be exercised in this environment
  (no TTY); pipes, EOF and `--script` are covered. A human should run `pnpm play`
  once in a real terminal.
- Screenshots are captured for a human reviewer (`packages/web/artifacts/`); they are
  advisory evidence for legibility, never the gate for correctness.

---

## 5. Verification and determinism limits

- **Cross-Node-version determinism is untested by construction.** Identical hashes
  are guaranteed only for a pinned `(engine version, Node major)`; the golden file
  records `nodeMajor: 24` and fails loudly on a mismatch. Measured here: Node
  `v24.20.0`.
- **`Math` aliasing is not lint-enforceable** (`const M = Math; M.random()`, or
  `globalThis.Math.random()`). The `Date` half of the aliasing gap is closed. For the
  remaining spellings the determinism claim rests on review plus the golden gate, not
  on lint, and that is recorded in the eslint config comment.
- **`canonicalize` blind spots**, documented and pinned by adversarial tests: `-0 ≡ 0`,
  typed arrays equal their plain-array equivalents, non-enumerable properties are
  dropped, and a lone surrogate encodes identically to U+FFFD.
- **The goldens gate less than they look like they do.** A golden state is `newGame`
  at turn 0, so no city exists and no growth/production/economy mechanic runs on it;
  breaking compound flooring or wonder uniqueness each turned the suite red while
  `golden.test.ts` stayed green. Played, combat-bearing and victory-bearing goldens
  were added in M5/M6/M9+M10 to close the measured gap.
- **A core test imports from `@civts/testing`** (`packages/core/test/settings.test.ts`),
  inverting the dependency direction for that one test file. `core/src` itself is
  unaffected and the build graph is still acyclic.
- **`Math`-admitting floats in configuration**: `settings.ai.aggression` is a float
  and is hashed. ECMA-262 fully specifies number→string and IEEE-754 arithmetic, so
  configuration floats are deterministic; the rule is stated as "integer-only
  *simulation* math; transcendentals banned" rather than the stronger claim.

---

## 6. Process lessons recorded rather than repeated

The full ledger is `docs/ENGINE.md` §7. The ones that are still live hazards rather
than history:

- **`M9+M10` orchestration.** The schema owner died on a provider transport error
  having written **zero files**, and a second agent died the same way. Three
  downstream agents each independently reported BLOCKED with no files written — the
  correct call, because every file they owned was expressed in terms of a schema that
  did not exist, and inventing it would have recreated the dual-source bug. The
  integration owner then built the milestone. **The failure was the sequencing: agents
  were launched on the assumption that phase one had landed, with no guard that
  checked.** It is this project's own rule — a claim that nothing verifies is a claim
  that drifts — applied to orchestration. Any future wave needs a **guard that reads
  the predecessor's output** before the successor starts, not an assumption that it
  succeeded.
- **Never `git checkout --` a file an agent is editing** (M7d destroyed uncommitted
  work that way).
- **A contract amendment names a migration owner for every existing consumer before
  agents launch** (M2's F6 rule: escalating correctly is not the same as having an
  owner).
- **An abort guard keys on who owns the blocker, not on a `blocked` status** (M3).
- **Report the command's wall time, never an inner stopwatch** (M7's A5 failure:
  65.9 s inside vitest against a bound on `pnpm verify`, which actually took 104 s).

---

## 7. Documentation debt

- `docs/TASKS.md` is a ledger of what landed and what it cost; the per-milestone
  findings tables are kept there because they are the raw material of the lesson
  ledger, not because every entry is still open.
- `docs/GDD.md` restates catalog numbers so the design is readable in one place. If
  a number there disagrees with `packages/rules`, **the catalog is right** — the GDD
  §7 lists the commands that print it.
- `docs/INTERFACES.md` and `PLAN.md` are frozen or plan-of-record documents and are
  not edited by this pass.
