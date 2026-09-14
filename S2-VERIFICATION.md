# S2 — the last residues, and an independent look at the opponent

**Verifier:** S2, an agent that wrote none of the code under test — with one disclosure that
matters, stated here rather than buried: **the A1 conformance gate in this pass
(`packages/web/e2e/s2-a1-conformance.spec.ts`) and the `isLandAt` refactor of §2 are my own work,
so §2 and §3 are self-verification, not independent verification.** Everything in §1, §2's
measurements, §3's *evidence* and §4's timings is a reading from a command this report names and
anyone can re-run; the interpretation of §3's evidence is mine and is marked as such.
**Tree:** `bb85931` ("M11 + A7 …") **plus the uncommitted working tree as R1 and R2 left it**
(`git status`: 24 tracked files modified, `P2/Q3/R2-VERIFICATION.md`, `packages/core/test/victory.test.ts`
and `scripts/probes/` untracked), **plus this pass's six edited artifacts** —
`packages/core/src/map.ts` and `packages/core/src/borders.ts` (the refactor, §2),
`packages/core/test/victory.test.ts` (the predicate's edges), `Q3-VERIFICATION.md` and
`R2-VERIFICATION.md` (the corrections, §1), and one new file,
`packages/web/e2e/s2-a1-conformance.spec.ts` (the A1 gate, §3) — and this report.
Nothing else in the tree was touched by this pass: no `packages/web/src` file, no
`docs/INTERFACES.md`, no `PLAN.md`, and no golden.
**Window:** 2026-09-14, 01:58–03:06 UTC. Box: 8 cores, **shared** — every wall figure carries the
raw load average it was taken under.
**Port 3080 / the DSH GUI:** never touched, never restarted, never proxied. `ss -ltn` at 02:39 showed
one listener on `127.0.0.1:3080` (the DSH GUI's, untouched) and **none** on 4174 after the e2e runs.
**No `git checkout --` was run, and no test was weakened, skipped or deleted.**

---

## 0. VERDICT FIRST — the A1 claim is NOT met, and that is the headline

**A1 still fails on this tree, on both of its literal clauses, and the failure is measured twice by
independent means.** `PLAN.md` §16.1 A1: *"A human can start a new game from the web UI, **choose
settings**, and play to a victory/defeat screen without touching the CLI."*

| # | A1's clause | measured now | verdict |
|---|---|---|---|
| 1 | human starts a new game from the web UI | a game exists on load; it cannot be *started* differently | **PARTIAL** |
| 2 | **chooses settings** | **no control exists** — 20 buttons on a clean page, none of them setup | **FAIL** |
| 3 | plays to a victory/defeat screen | yes: `VICTORY — Player 1 won by the engine's "score" condition, on turn 200` | PASS |
| 4 | **against an opponent** (the clause the auditor added) | **the rival seat is byte-identical at turn 1 and turn 200** | **FAIL** |

The two FAILs are the two blockers this assignment names, and **S1 has not landed anything**: at
02:20 UTC `packages/web/src`'s newest file was `main.ts` at 14:37:05 the previous day,
`packages/web/src` contains **no import of any policy** (`grep -rn "policy" packages/web/src` → 1
hit, a comment in `panels/save.ts`), and `git status` shows no `packages/web/src` file modified by
this wave. So §3 below reports what independent verification is possible **now**, and every item
that needs S1's work is reported as **NOT VERIFIABLE — the artifact does not exist**, with the
gate that will decide it named.

**The single most useful thing this pass produced for that gate** is
`packages/web/e2e/s2-a1-conformance.spec.ts`: five tests and six assertions, written against the
frozen seam and the engine's own `Settings`. Switched on (`CIVTS_A1_GATE=1`) it is **RED on this
tree — 4 failed, 1 passed, 19.9 s wall, load 2.08 → 2.19** — and it goes green only when the
opponent plays and a setup surface exists. By default it reports **5 skipped**, so the alpha gate
(`pnpm test:e2e`, 63 tests) stays green and Playwright's own output names what it did not run.
Run it alone:

```
cd packages/web && CIVTS_A1_GATE=1 npx playwright test --config playwright.config.ts s2-a1-conformance
```

| # | Question | Verdict |
|---|---|---|
| 1 | Q3's false "not observable in AI play" claim is corrected in place, with the measurement | **DONE, re-measured** — §1 (8/8 games, 16/16 borders, 713/1,793 = 39.8 % water) |
| 2 | the duplicated land predicate is one statement, and no behaviour changed | **DONE** — §2 |
| 3a | the opponent really thinks | **NOT MET — S1 absent**: the rival does not move at all (§3a) |
| 3b | the AI cannot touch the world's RNG, in the browser | **NOT VERIFIABLE** — no AI in the browser (§3b) |
| 3c | browser-vs-headless hash equality with the AI running | **PARTIAL** — the human-only reference is verified green in three places; the AI half is **NOT VERIFIABLE**, no AI runs (§3c) |
| 3d | setup is real, and an invalid value is refused by the engine | **NOT MET — S1 absent**: no setup control exists (§3d) |
| 3e | the AI-off control changes behaviour; the AI-on test is non-vacuous under mutation | **NOT MET — S1 absent**, and the switch has no spelling in `Settings` today (§3e) |
| 3f | determinism across two browser contexts, with the AI, matching headless | **NOT VERIFIABLE** (§3f) |
| 3g | a real game to an end against a live opponent | **FAIL** — played to an end, against a rival that never moved (§3g) |
| 3h | A5 with raw `time`; e2e not collected by vitest | **PASS with a named risk** — fast 57.9 s cold / 35.1 s warm; full **8 m 38 s**, and the full tier is one file (§4) |

**Findings, worst first.** Every one is measured; there is no fabricated finding, and the places
where this pass found nothing say so.

- **S2-F1 (blocker, A1).** No opponent in the browser. Re-measured two ways (§3a, §3g).
- **S2-F2 (blocker, A1).** No game-setup surface. 20 buttons, none of them setup (§3d).
- **S2-F3 (new, small, and in the way of S1's work).** **"The opponent is off" has no spelling in
  the engine's `Settings`.** The `ai` section exists and both its fields (`aggression`,
  `expandFast`) are **read by nothing** — `grep -rn "settings.ai" packages --include=*.ts` matches
  only tests and the app's pass-through. So an AI-off control cannot be expressed as a game setting
  today; §3e names the one-field shape the conformance gate asks for (`ai.opponent: 'policy' | 'off'`)
  and the mutation that proves the opponent test non-vacuous.
- **S2-F4 (A5, named risk — not a defect yet).** The full tier measured **517.7 s** against its
  600 s bound (13.7 % headroom) **twice**, on a box at load 1.85–6.33, and **one file is 461.6 s of
  it** (`packages/testing/test/m2-adversarial.test.ts`, measured solo at load 1.35). R2 recorded
  431.9 s for the same command on this tree; the gap is the m2 adversarial keystone sweep's own
  growth and it is now the whole critical path. §4 has the per-file table.
- **Regenerated-or-unexplained:** the two correction appendices to `Q3-VERIFICATION.md` and
  `R2-VERIFICATION.md` are new prose in files whose authors are gone; they are marked in place and
  nothing in either report was deleted (§1).

---

## 1. Q3's FALSIFIED CLAIM, CORRECTED IN PLACE

**What the false sentence was.** `Q3-VERIFICATION.md` §0's F5 entry and §B4 both stated that the
domination numerator's land-versus-water divergence was **"not observable in AI play — 16 games
(duel and tiny, seeds 1–8, the real AI in one seat), 97 cities in the final states, 0 water tiles
inside any border"**. R1 measured the opposite on this tree, and this pass reproduced R1's
measurement exactly.

**The measurement, re-run for this correction** (the repository's own instrument, unmodified):

```
$ npx tsx scripts/probes/land-numerator-probe.ts
 02:59:13 ... load average: 1.16, 1.02, 1.19     (start)
  totals: 8 of 8 games and 16 borders hold at least one water tile;
          713 water tiles across 1793 owned tiles (1080 land). 8 of 8 games ended.
  land halves the all-tiles and land-only readings disagree on, over these 8 AI-played games: 0

real    2m32.450s   EXIT 0
```

**8 of 8 games, 16 of 16 borders, 713 of 1,793 owned tiles = 39.8 % water.** The probe's own §1
shows why a clean sample of 16 borders was never plausible on this map: one radius-3 coastal claim
is **20 land + 25 water**, and a `tiny` map here is 38 % land.

**What was corrected, in place and visibly** (nothing deleted; every correction is in the report's
own voice and marked `S2`):

| file | site | correction |
|---|---|---|
| `Q3-VERIFICATION.md` | §0, F5 entry | the "Not observed in AI play" clause replaced by the measured figures and marked as this report's own error |
| `Q3-VERIFICATION.md` | §B4, the F5 paragraph | the false sentence quoted **verbatim and marked FALSE**, followed by the probe's output and a new paragraph: **what the correction changes about the ruling that followed** |
| `Q3-VERIFICATION.md` | end, "would not claim" | the "no AI-played game reaches that difference" clause withdrawn, with the distinction the measurement actually forces |
| `Q3-VERIFICATION.md` | new final section | "S2 — THE ONE CLAIM IN THIS REPORT THAT WAS FALSIFIED, CORRECTED IN PLACE": what was wrong, where it was corrected, what it does **not** change, and why it is recorded rather than quietly fixed |
| `R2-VERIFICATION.md` | §0's B2 row and §B2's heading | narrowed from "changed **nothing observable**" to "**no outcome** moved", because R2's own §B2(4) is the counter-example (the seed-47 fixture's greatest satisfied threshold moves 3 % → 2 %) — see `R2-VERIFICATION.md` §C (S2-F1) |
| `R2-VERIFICATION.md` | new §C | the narrowed claim, this pass's completion of R2-F3, and R2-F1's README measurement re-confirmed on today's tree |

**The ruling was justified on the measured basis, not the false one — and the correction makes the
case stronger.** R1's land-only numerator (`borders.ts`' `ownedLandTiles`, wired at
`victory.ts:268`) rests on (a) the AMENDMENT at `docs/INTERFACES.md:2103–2128` ruling the map's land
the correct denominator, so numerator and denominator must be the same *kind* of quantity, and
(b) the target being a moving denominator a player can lower by claiming less. Neither depends on
water being rare; with ~40 % of every border water, an all-tiles numerator counts a player's bays
toward a share of the world's **land** on every board in play. What the 8-game sample does show is
that the *verdict* did not move at the shipped 60 % threshold (probe §3: `0` disagreements), so the
filter is a correctness fix to a quantity, not an outcome-changer — which is what
`R2-VERIFICATION.md` §B2 measured, and what the narrowed wording now says.

Verification of the edit: `npx prettier --check Q3-VERIFICATION.md R2-VERIFICATION.md` → **"All
matched files use Prettier code style!"**.

---

## 2. THE DUPLICATED LAND PREDICATE — one statement now, and no behaviour changed

**What it was.** `packages/core/src/borders.ts` carried a private `isLandAt(state, ruleset, index)`
whose own doc comment said "`landTileCount`'s rule", duplicating the predicate inlined in
`map.ts`' `landTileCount` — whose comment says it exists to be "the ONE statement of what ground
counts as land". Reproduced from the tree (S2's own reading, and R2's R2-F3):

```
packages/core/src/map.ts:473   export const landTileCount = (map, ruleset) => {           // the inlined rule
packages/core/src/borders.ts:427  const isLandAt = (state, ruleset, index) => {          // the copy
```

**What changed.**

```ts
// packages/core/src/map.ts — the ONE predicate, exported
export const isLandAt = (map: GameMap, ruleset: RulesetView, index: number): boolean => {
  const terrain = terrainAtIndex(map, index);
  if (terrain === undefined) return false;
  const def = ruleset.terrains.find((row) => row.id === terrain);
  return def !== undefined && !isWaterRole(def.role);
};

export const landTileCount = (map: GameMap, ruleset: RulesetView): number => {
  let total = 0;
  for (let index = 0; index < map.terrain.length; index += 1) {
    if (isLandAt(map, ruleset, index)) total += 1;
  }
  return total;
};
```

`borders.ts`' copy is **deleted**; `ownedLandTiles` calls the exported predicate
(`borders.ts:71` imports it, `:459` uses it), and `isWaterRole` is no longer imported there. The two
signatures differ in one argument — the copy took a `GameState` and read `state.map.terrain[index]`,
the shared predicate takes the `GameMap` and reads through `terrainAtIndex` — and those are the same
read: `terrainAtIndex(map, i) === map.terrain[i]`, and both then resolve the row through the same
`ruleset.terrains.find`. Out-of-range indices answer `false` in both, `undefined` terrain answers
`false` in both, and a role of `ocean`/`coast` answers `false` in both.

**Proof that no behaviour changed.**

| evidence | reading |
|---|---|
| the six golden hashes, stored | `tiny-civs2-seed1 781d15e49cf79357`, `tiny-civs2-seed42 782fe5306476b5d5`, `tiny-civs2-seed1337 717543ac9b22ed91`, `played-civs2-seed42 ba1c98cb81d62c08`, `played-civs2-seed42-combat cfb35436b3d9bfcd`, `played-civs2-seed42-victory 2294bc55f0ef3f3e` — **all six unmoved**, `packages/testing/goldens/state.json` **not modified by this pass** (`git status` clean for it, sha256 `3abcf82a…`) |
| the golden gate | `npx vitest run packages/testing/test/golden.test.ts` → **17 passed**, including "stores exactly the hashes this build produces" |
| the whole fast gate | `pnpm verify` → **EXIT 0**, `65 files passed`, `2118 passed | 56 skipped (2174)` |
| the whole full gate | `pnpm verify:full` → **EXIT 0**, `65 files passed`, `2172 passed | 2 skipped (2174)` — twice |
| the predicate's edges, pinned | `packages/core/test/victory.test.ts`' `isLandAt — the one land predicate, at its edges`: both water roles false, mountains (impassable **land**) true, a tile past the map's terrain false, an undescribed terrain id false in both readers, and `landTileCount` equal to the predicate applied to every tile the map has |

The refactor's *semantics* are unchanged by construction, and the goldens are the independent check:
they hash four played states that include cities, borders and ownership, which is exactly what
`ownedLandTiles` is read for.

**One honest note about the new tests.** They pin the predicate's edges and its agreement with
`landTileCount`; they would **not** have caught the duplication itself (a copy that agrees
behaviourally cannot be caught by a behavioural test). What catches the duplication is the type
system plus this report: there is one function, it is exported, and the copy is gone. That is stated
because "the test proves there is one predicate" would be false.

---

## 3. INDEPENDENT VERIFICATION OF S1 — every item, and its state

**The precondition, measured.** S1 has produced nothing on this tree (§0). So for every item below,
the honest report is either "not met, with the measurement that shows it" or "not verifiable, and
here is the gate that will decide it". No item is claimed as passing on the strength of S1's
absence.

### (a) THE OPPONENT REALLY THINKS — **NOT MET**

Measured on this tree, twice, by two different drivers.

**(i) S2's own probe** (a clean load, the app's own `Found city` control, 199 clicks of the app's
own `End turn` control, state read through the frozen seam):

```
seed 1, settings {mapSize: tiny, civCount: 2, seed: 1, difficulty: regent, ...}
human seat 0, rival seat 1
start rival:  cities 0, units 2, unitTiles "2@1973m2,3@1912m2", treasury 10, techs 0, ownedTiles 0
end   rival:  cities 0, units 2, unitTiles "2@1973m2,3@1912m2", treasury 10, techs 0, ownedTiles 0
end   human:  cities 1, units 1,                treasury 1068, techs 0, ownedTiles 5
end hash 7929363e1f5c9055, turn 200, "VICTORY — Player 1 won by the engine's \"score\" condition, on turn 200."
```

The rival's cities, units, unit tiles, treasury, techs and owned tiles are **identical at turn 1 and
turn 200**. The human founded one city and banked 1,068 gold.

**(ii) The repository's own A1 audit spec** (`alpha-audit-a1.spec.ts`, run by this pass: `1 passed
(14.4 s)`, load 0.73) carries the same reading in its own annotations — `A1 rival seat` records the
rival's fingerprint at start and at end. It passes because it **reports** the rival's activity as an
annotation rather than asserting it; the conformance gate this pass added asserts it, and is red.

**Is it the SAME policy the tournaments run, imported rather than re-written?** **Not applicable
yet — and unfalsifiable today**: `grep -rn "policy\|Policy" packages/web/src` matches one comment
(`panels/save.ts:204`) and nothing else, so the app imports **no** policy at all. `@civts/sim` *is*
already a declared dependency of `packages/web` (`package.json`: `"@civts/sim": "workspace:*"`), so
the import is available the moment S1 writes it; the conformance gate's §(a) test checks the
behavioural half (the rival issues commands the engine **accepted** — read off the seam's own
dispatch log, `entry.result === 'ok'`), and the "same policy, not a second implementation" half is
checkable by reading the import list, which this pass did.

### (b) THE AI CANNOT TOUCH THE WORLD'S RNG — **NOT VERIFIABLE**

No AI runs in the browser, so the property is not measurable there. The gate is written and
specific: `s2-a1-conformance.spec.ts`' §(a,b) test reads `state().rng` (the authoritative world
stream) in two games on the **same seed** with the **same human script** — one with the opponent
live, one with it off — and asserts the two streams are equal at the same turn. That is the M5
property in its browser form: a policy may draw from `policyRngFor(seed, playerId, turn)` and never
from `state.rng`. The headless half of the property is already pinned by the suite
(`packages/sim/test/ai.test.ts`' "takes its own stream and never reads the world RNG while deciding",
full tier), and by `runner.ts`' own §"The policy RNG stream".

### (c) THE UI STILL ADDS NO RULES (with the AI running) — **PARTIAL: reference verified, AI half NOT VERIFIABLE**

The gate is specific (§(c,f) of `s2-a1-conformance.spec.ts`): the same seed, map size and script run
in **two browser contexts** and **through the engine headlessly**, and all three hashes must agree.
It is written to be **sensitive to a running AI**: the browser's game must equal *this* script's
headless game, so a policy that plays any seat when `End turn` is dispatched changes the hash. It
also asserts its own reference — `headlessRivalMoved === false` and the rival's seat unchanged in
the browser — so it cannot pass by accidentally measuring the AI.

**That reference half is green on this tree** (gate run `✓ 2 … 2.4s`), and the same property is green
independently in two existing specs (`determinism.spec.ts` "a scripted game through the UI hashes
exactly like the same script through the engine"; `m8-adversarial.spec.ts:1182` "determinism: one
seed and one script hash the same in two browser contexts and in the headless engine"). **The half
that A1 needs — the same equality with a policy running — is not verifiable, because no policy
runs.** Every one of those green numbers was measured with the opponent switched off, so none of
them says anything about what happens when the AI plays inside the page. What is *verified* here is
the baseline the AI half will be measured against, and that baseline is now sensitive to the very
failure it will be asked to detect.

### (d) SETUP IS REAL — **NOT MET**

Measured: a clean load's control surface, by role and accessible name, with `localStorage` cleared
before the first navigation (`alpha-audit-a1.spec.ts`), and again by this pass's conformance gate:

```
20 buttons: End turn | Set rates | Set government | Settler 0 | Worker 1 | Found city |
            Move to 10,8 | Move to 11,8 | Move to 12,8 | Move to 10,9 | Move to 12,9 |
            Move to 10,10 | Move to 11,10 | Move to 12,10 | Fortify | Technology |
            Save game | Load game | Debug | Fortify
setup-like controls (name matches /new game|settings|setup|scenario/i): NONE
```

The game is `DEFAULT_SETTINGS` + `seed: 1` (`main.ts`: `DEFAULT_SEED = 1`), so the seed, the map
size and the civ count are whatever the app happens to construct. The *only* way to choose them
today is `window.__CIVTS__.seed(seed, options)` — the test seam, which is not a surface a human can
use, and which is why the conformance gate uses `seed()` as the **oracle** (a chosen setting must
produce the engine's own `newGame`, hash for hash) rather than as the delivery mechanism.

**Does the engine refuse an invalid value?** Yes, and it already did before this pass — read from
the tree rather than argued: `parseSettings` is a `v.strictObject` over `mapSize` (picklist),
`civCount` (`integer, min 2, max 16`), `seed` (`integer`) and `difficulty` (picklist), and it is what
`main.ts`' `reseed` calls (`main.ts:583`: `parseSettings({...state.settings, ...options, seed})`,
returning early when it fails). This pass measured the parser's refusal directly through the gate's
§(d) test: an unknown map size, `civCount: 1`, `civCount: 99` and a fractional seed are each
refused by the **engine's own** parser — `parsed.ok === false` for all four, state hash unchanged,
settings unchanged — and `dispatch({type:'NotACommand'})` comes back `'refused'`. So the *engine*
half of (d) is verified; the *surface* half does not exist.

### (e) THE AI-OFF CONTROL, AND NON-VACUITY BY MUTATION — **NOT MET (the switch has no spelling)**

Two halves, and only one of them can be done today.

**(i) Non-vacuity of the AI-on test by mutation.** The mutation the assignment names — *disable the
AI scheduling and confirm the opponent test goes RED* — **cannot be applied, because there is no
scheduling to disable**: the app contains no call to any policy. The honest statement is that the
opponent test is red **already**, for a stronger reason than the mutation would give: the rival does
not move at all. Recorded as **not run, with the reason**, rather than reported as a pass. The
mutation to run the moment S1 lands is: remove the AI's turn hook from the app's turn advance and
confirm `s2-a1-conformance.spec.ts` §(a,b) and §(e) go red; the gate's §(e) test is written to be the
one that notices (`off.cities === 0` and `on ≠ off`).

**(ii) The AI-off control is expressible in the engine's settings — S2-F3.** A control that
switches the opponent off must be a value the game is hashed with, because `state.settings` is part
of `GameState` and the M8 contract forbids the UI from holding a rule of its own. Today the `ai`
section's two fields are `aggression` (`0..1`) and `expandFast` (boolean), and **neither is read by
anything**: `grep -rn "settings.ai" packages --include=*.ts` matches only `settings.test.ts`,
`adversarial.test.ts` and the app's own pass-through — no policy, no engine module. A number that
nothing reads cannot mean "off", and a panel variable would be a rule outside the state. The gate
therefore asks for exactly one new field, `ai.opponent: 'policy' | 'off'`, and asserts it two ways:
the engine must **accept** the seed with it set (a refused seed proves the field does not exist) and
must keep it (an inert field is stripped by `strictObject`, and an inert switch "reports as off
whatever the app does" — the exact false-pass this project has paid for repeatedly).

### (f) DETERMINISM ACROSS TWO CONTEXTS, AND AGAINST HEADLESS — **NOT VERIFIABLE**

Gate written, not runnable (§3c). What *is* verified today, without an opponent: the existing
browser-vs-headless equality is green in **two** places — `determinism.spec.ts` (a scripted game
through the UI hashes like the same script through the engine) and `m8-adversarial.spec.ts`
("one seed and one script hash the same in two browser contexts and in the headless engine") — and
both are green in the full e2e run reported in §4. Neither has an AI in it.

### (g) A REAL GAME TO AN END — **FAIL: played to an end, against nobody**

Measured by this pass's conformance gate §(g), on a clean browser session, clicking only the app's
own controls:

```
turns=200 clicks=199 outcomeScreen=true
VICTORY — Player 1 won by the engine's "score" condition, on turn 200.
human: cities 0→1, units 2→1, ownedTiles 0→5, treasury 10→1068
rival: cities 0→0, units 2→2, ownedTiles 0→0, treasury 10→10   ← identical, byte for byte
hash 7929363e1f5c9055
```

**The condition, the turn and the winner, as the engine reports them:** `score`, turn 200, winner
`Player 1` (the human, player 0). The scoreboard shows **both seats at 0** at the end (the snapshot
in §3's companion screenshot: `Treasury 1068 gold`, `Science 566 beakers`, `1 citizen(s)`), which is
the mechanical explanation of the whole finding: nobody scored, the horizon arrived, and the score
condition names the lowest player id on a tie (a rule pinned by `tournament.test.ts`' "credits a
score tie to the lowest player id"). **A human winning by score against a rival that never acted is
a victory screen about a board, not about a game.**

Read as the A1 claim: **PART 3 of A1 is met in form** (there is a victory/defeat screen, reachable
by clicking, with no CLI), and **A1 as a whole is not met**, because the game that was played had no
opponent.

### (h) A5 WITH RAW `time`, AND THE E2E SUITE

**A5's two bounds, measured with `time` on the command a person runs.** Raw readings, with the load
average each was taken under; §4 lists every figure in one place.

| command | wall | load at start → end | bound | headroom | verdict |
|---|---|---|---|---|---|
| `rm -rf .cache && time pnpm verify` (cold) | **0m57.949s** | 1.69 → 7.21 | ≤ 70 s | **12.1 s (17.2 %)** | PASS, EXIT 0 |
| `time pnpm verify` (warm) | **0m35.091s** | 4.51 → 7.39 | ≤ 70 s | **34.9 s (49.9 %)** | PASS, EXIT 0 |
| `time pnpm verify` (final tree, warm) | **0m37.472s** | 1.76 → 2.32 | ≤ 70 s | **32.5 s (46.5 %)** | PASS, EXIT 0 |
| `time pnpm verify:full` #1 | **8m37.463s** (517.5 s) | 6.33 → 2.33 | ≤ 600 s | **82.5 s (13.8 %)** | PASS, EXIT 0 |
| `time pnpm verify:full` #2 | **8m38.032s** (518.0 s) | 1.85 → 2.15 | ≤ 600 s | **82.0 s (13.7 %)** | PASS, EXIT 0 |
| `time npx vitest run packages/testing/test/m2-adversarial.test.ts` (`CIVTS_TEST_TIER=full`) | **7m42.864s** (461.6 s) | 1.35 | — | — | PASS, 29 tests |

**The load the full e2e suite was run under, and its counts.**

```
$ cd packages/web && time npx playwright test --config playwright.config.ts
 02:59:51 ... load average: 2.41, 2.26, 2.74      (start)
  5 skipped
  63 passed (3.9m)
real    3m51.872s   EXIT 0
 03:03:42 ... load average: 2.57, 2.52, 2.75      (end)
```

**63 passed, 0 failed, 5 skipped, 3 m 51.9 s wall, load 2.41 → 2.57 — a quiet box, one worker, no
retries.** (Run twice: the earlier reading before the conformance gate existed was the same 63
passed in 3 m 48.7 s at load 1.50.) Three things about that number are worth stating rather than
letting it pass as a green tier: (1) it is **63 tests plus 5 skips**, and the 5 are this pass's A1
conformance gate reporting itself by name rather than being silently uncollected — running it is one
environment variable, and §0 has that command; (2) **every one of the 63 was measured with the
opponent switched off**, which is precisely why the A1 claim could look green for three passes;
(3) it is the alpha gate, so it stays green while the work it cannot see is not done — which is the
whole reason the fifth skip line matters.

**e2e is still not collected by vitest.**

```
$ npx vitest list --filesOnly | wc -l                      → 65
$ npx vitest list --filesOnly | grep -c "web/e2e"          → 0
```

**The full tier's 2 skips are named, and the fast tier's 56 are named in its own output** — the fast
run prints `Skipped in this tier — 56 tests … packages/headless/test/repl.test.ts (1) … 13 files in
all`, and the full run prints exactly 2 (`m9-m10-adversarial.test.ts` §9's two
`CIVTS_MUTATION_CHECK=1` tests). So `full ⊇ fast` is checkable by eye, as designed.

---

## 4. THE A5 RISK, NAMED: THE FULL TIER IS ONE FILE

The full tier fits its bound **twice at 13.7 % headroom**, and this pass reports the composition
because the number is not spread across the tier — it is one file:

| file (full tier) | span |
|---|---|
| `packages/testing/test/m2-adversarial.test.ts` | **461,626 ms** (solo: 461,626 ms at load 1.35) |
| `packages/testing/test/m4b-adversarial.test.ts` | 110,042 / 114,922 ms |
| `packages/sim/test/ai.test.ts` | 95,536 / 97,031 ms |
| `packages/sim/test/invariants.test.ts` | 94,501 / 96,993 ms |
| `packages/testing/test/m3-adversarial.test.ts` | ~86,740 ms |
| `packages/sim/test/invariant-precision.test.ts` | ~81,985 ms |
| `packages/testing/test/m9-m10-adversarial.test.ts` | ~67,543 ms |
| rest (58 files) | ≤ 67 s each |

The tier's wall (517.7 s) is therefore `m2-adversarial` (461.6 s) **plus** the static step and the
other files' tails. R2 recorded **431.9 s** for the same command on this tree (§B6) and this pass
measures **517.5/518.0 s** twice at comparable load — an 86–100 s gap that is not attributable to
this pass's changes (its core edits are behaviour-preserving and hash-neutral, and the goldens are
unmoved). Reported as a **measurement with a named risk, not a defect**: A5's full bound still holds
with 82 s of headroom, and the headroom is now proportional to one file's growth rather than to the
tier's. A file that grows 20 % takes the tier over its bound.

---

## 5. WHAT THIS REPORT WOULD NOT CLAIM

- It does not claim A1 is met. It is not: §0, §3(a,d,g).
- It does not claim §3 is **independent** verification. S1 produced nothing, so §3 reports
  non-existence plus a red gate; and the gate is this pass's own work, which is a conflict of
  interest this report states at the top rather than hides.
- It does not claim the AI-off control works, or that the mutation was run. The mutation has nothing
  to disable, and the switch has no spelling in `Settings` today (§3e, S2-F3).
- It does not claim the `isLandAt` tests would catch a *behaviourally identical* duplicate; they
  catch the predicate's edges, and the duplication is closed by the export, not by a test (§2).
- It does not claim the 63-test e2e run is evidence about A1's opponent clause; it is evidence about
  everything else in A4/M8, measured with the opponent off (§3h).
- It does not claim the full tier's headroom is comfortable. 82 s against 600 s, with one file
  holding 461.6 s of it, is the weakest number in this report (§4).

---

## COMMANDS — every reading above, in one block

```bash
cd /home/box/Harness/CivGlm

# §1 — the measurement that falsifies Q3's claim
npx tsx scripts/probes/land-numerator-probe.ts          # 2m32.5s, load 1.16 → 1.02, EXIT 0

# §2 — the refactor and its proof
npx vitest run packages/core/test/victory.test.ts       # 4 passed
npx vitest run packages/testing/test/golden.test.ts     # 17 passed, six hashes unmoved
npx tsx /tmp/goldens-print.ts                           # the six stored hashes
pnpm verify                                             # EXIT 0, 2118 passed | 56 skipped

# §3 — the A1 gate, red on this tree
cd packages/web && npx playwright test --config playwright.config.ts s2-a1-conformance
                                                        # 5 skipped by default (the alpha gate stays green)
cd packages/web && CIVTS_A1_GATE=1 npx playwright test --config playwright.config.ts s2-a1-conformance
                                                        # 4 failed, 1 passed, 19.9s, load 2.08 → 2.19
npx playwright test --config playwright.config.ts alpha-audit-a1
                                                        # 1 passed, 14.4s, load 0.73
grep -rn "policy\|Policy" packages/web/src              # one comment; no policy is imported

# §3d — the setup surface, read from the page
#   (20 buttons, none setup-like; the list is in the gate's own failure message)
npx tsx packages/headless/src/cli.ts map --seed 7 --map-size duel --civs 2

# §4 — A5, with raw time
rm -rf .cache && time pnpm verify                       # 57.949s cold
time pnpm verify                                        # 35.091s warm
time pnpm verify:full                                   # 517.5s and 518.0s, twice
CIVTS_TEST_TIER=full time npx vitest run packages/testing/test/m2-adversarial.test.ts
                                                        # 461.6s, one file
cd packages/web && time npx playwright test --config playwright.config.ts
                                                        # 63 passed (3.8m), 3m48.7s, load 1.50
npx vitest list --filesOnly | wc -l                     # 65 files, 0 e2e
npx vitest list --filesOnly | grep -c "web/e2e"          # 0
```

**Hashes of this pass's artifacts, taken 2026-09-14 03:07 UTC (nothing under `Q3`, `R2`, the two core
sources, the test file or the gate was edited after this reading; only this report's prose was).**
The list covers every artifact
this pass touched **except this report itself**: a document cannot contain its own sha256 without
the value invalidating the moment it is written, and a report that printed a hash it knew was stale
would be the exact species of dishonesty the rest of this file is about. A reader who wants it runs
`sha256sum S2-VERIFICATION.md` — which is the same rule Q3 and R2 got wrong in the other direction,
by asserting a figure they had not re-measured. The last line is the tree's final static state.

```
610220bc27b6a5c0e56445829833e8689ceb9c50ad3104c9b7000e2b447f8208  Q3-VERIFICATION.md
2dd446be5561f9cadcdbcb6c8f4c10b94c1fd82c1aad9ea9869e6af58a91ed4a  R2-VERIFICATION.md
71aac997c5d8c449c93d25ed945e1bb11c47f8155780b27866d74994aa89a2ef  packages/core/test/victory.test.ts
82dab8e27bd5d2541525ca60ec58b8b96776e49a7787db56e30d734c16cb1f99  packages/web/e2e/s2-a1-conformance.spec.ts
03de81f35dac939efb255ab79d8703381e489ddf433f126ea899d821c2034291  packages/core/src/map.ts
4909fe3b3b45616e265c51b16792d7c49ea571569f0dd9b4c8f0905eaf6b884d  packages/core/src/borders.ts
```

Final static state of the tree this report describes: `pnpm check:static` → **EXIT 0** (typecheck,
lint and format, all three). `docs/INTERFACES.md` and `PLAN.md` were **not edited by this pass** —
`docs/INTERFACES.md` does appear modified in `git status`, and that modification is R1's (the
overruled-domination strikethrough plus the AMENDMENT, `git diff docs/INTERFACES.md` → +34/−2), which
was already on the tree when this pass began and is deliberately left alone.
