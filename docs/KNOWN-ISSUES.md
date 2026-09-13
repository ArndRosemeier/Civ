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

## 3. Open defects measured in this session (2026-09-13)

These were found by running shipped commands, not by reading code. They are recorded
here because a documentation pass that reports only the flattering facts is worse than
no documentation.

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

Measured twice in one session:

| run | load average at start | result | wall |
|---|---|---|---|
| full Playwright suite | 9.37 | **57 passed, 4 failed** | 249.1 s |
| those same 4 specs re-run alone | 13.13 | **9 passed, 0 failed** | 87.2 s |

The four failures were all "the app never reported `ready === true`" inside the
15 s readiness budget — a cold Vite dev server plus a busy box, not a code path the
re-run exercises differently. It is reported rather than explained away, and it is a
real hazard for anyone using this suite as a gate: a verdict that flips on machine
noise is not a criterion.

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

---

## 4. UI limits

### 4.1 The city screen scrolls inside its own panel at 900 px

The panels are **docked under the map**, not floating over it, and the layout rule is
that an open panel covers neither the map nor the action buttons (a `position: fixed`
centred dialog was implemented, measured, found to intercept the pointer and the wheel
— it turned three green tests red — and reverted with the evidence recorded).

The consequence is honest and visible: the dock bounds the panel
(`dialog { max-height: 100%; … overflow: auto }`, `styles.css:241` and `:247`) and the
panel column scrolls inside itself
(`main > section[aria-label='Panels'] { overflow-y: auto }`, `styles.css:148`). At a **900 px-tall window** the city screen's content is taller
than the dock, so a player scrolls *within* the panel. What the suite asserts
(`packages/web/e2e/panel-usability.spec.ts`, measured passing in this session's
re-run) is **geometric**: the panel's box is inside the window and the points that
matter — the middle of the map, an action button in the panel column — still belong to
the game rather than to a panel. It does not assert that no scrolling is ever needed,
and a future panel that needs more room than the dock has will scroll rather than
fail.

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
