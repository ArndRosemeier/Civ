# UI OVERHAUL — a map-centric interface

**STATUS: PROPOSAL. Nothing here is frozen, implemented, or committed.** This document exists to
be argued with before it costs anything. When a phase lands, its contract moves into
`docs/INTERFACES.md` as an amendment with a migration owner (the F6 rule).

The goal, in the owner's words: *"a map centric game with the UI disappearing into the background,
only ever surfacing when it's needed"* — and specifically, unit movement should happen **on the
map**, because a list of `Move to 3,4` buttons is not how anyone moves a unit.

---

## 1. What is actually wrong today, with evidence

Three structural facts, all measured, none of them a matter of taste:

1. **A panel column is reserved whether or not anything is open.**
   `styles.css:145` gives the panels root `flex: 1 1 380px; min-width: 340px`. The shell
   (`main.ts`, `buildShell`) is a flex column whose `main` is a row of *map column* + *panels
   root*. So roughly a third of the window is permanent panel real estate. The interface cannot
   recede while that box exists: there is nowhere for it to recede *to*.

2. **Movement is offered as one button per adjacent tile.** `unitpanel.ts` renders the engine's
   list — `unitActions(state, ruleset, unitId)` — as buttons, and `actionLabel` names each
   `MoveUnit` as `` `Move to ${tileLabel(state, command.to)}` ``. Correcting my own first guess:
   `unitMoveOptions` (`actions.ts:182-197`) is a filtered scan of the **8 neighbours**, and
   `planMove` refuses a non-adjacent destination outright ("Path movement is not part of M2; chain
   single steps instead", `commands.ts:1464-1473`). So it is at most **nine** buttons — eight
   moves, plus one per adjacent enemy — not the dozens I assumed before reading the engine. Nine
   buttons each spelling out a coordinate the player is already looking at is still nine too many.
   But `MoveUnit` being a **single adjacent step** and not a path turns out to matter far more
   than the button count, and it is the largest single consequence for this plan (§4.4).

3. **The map can already do it.** `main.ts:881-889` (the canvas `click` handler) looks the clicked
   tile up in `unitActions` and dispatches the matching command if it finds one. Click-to-move and
   click-to-attack **already work**. The buttons are not the mechanism; they are a second
   projection of a list the map already reads. Reconnaissance confirms only **2 of the 12 commands
   are map-reachable today** — `MoveUnit` and `AttackUnit` — and they are the only two whose
   payload names a map tile.

4. **A refused click says nothing.** `main.ts:677-684` applies the command, and on failure returns
   `{outcome:'refused', events:[]}` — **discarding the engine's fully typed `GameError`**. A
   comment at `main.ts:820-840` claims "the refusal is the player's feedback", but no message is
   rendered anywhere. In a panel-driven UI that is survivable, because the panel only ever offers
   what the engine accepts. In a map-centric UI it is fatal: the player clicks a tile that looks
   reachable, and *nothing happens, ever*. This must be fixed as part of the overhaul, not after
   it.

So the movement buttons are **redundant**, not merely unfashionable. That is the single most
important finding in this document, because it means the change is mostly *deletion* — and it
means the risk is not behavioural but contractual (see §4.1).

---

## 2. THE SCHEMA

The schema comes first because the visuals are downstream of it. It has four parts. Parts A and B
are descriptive — they record what the engine already gives us. Part C is where the actual design
decisions live. Part D is the behaviour rule.

### 2.A — Context: what the player has selected

```ts
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'unit'; readonly unitId: UnitId }
  | { readonly kind: 'city'; readonly cityId: CityId }
  | { readonly kind: 'tile'; readonly tile: TileIndex }; // inspection only, issues nothing
```

Exactly one selection at a time. **Selection is navigation, never a command** — it dispatches
nothing, which is why it stays legal after the game has ended. `main.ts` already reasons this way
in its game-over guards, and the schema makes it a stated rule rather than a local decision.

### 2.B — Command enumeration: it is per CONTEXT, and the first draft of this section was wrong

`packages/core/src/actions.ts` distinguishes commands it hands the UI a **list** of from commands
whose space is a search space — "a choice board", which a generator that yielded it "would be
advertising as if it were the player's whole move set" (`actions.ts:26-93`).

This section originally presented that as a **6 / 6 split per command**, as a single fact about each
command. **That was wrong**, and the plan of record is corrected here rather than quietly edited:
"is it enumerated?" has no answer without asking **"for what?"**, because the engine has three
different functions answering for three different things.

| context | the engine's function | what it answers for |
|---|---|---|
| `unit` | `unitActions` (`:246`) | one selected unit |
| `city` | `cityProductionOptions` (`:323`) | one selected city |
| `player` | `legalActions` (`:395`) | the player's whole turn — the union of every unit's list, **plus one `EndTurn` last** |

The disagreement that exposed it: `SetProduction` **is** enumerated — by the *city* query, whose
items the seam wraps into one command each. Calling it globally `queried` contradicted
`e2e/keystone.spec.ts:83`, which had always treated it as enumerated for a city, while that spec's
own comment listed it among the queried ones. Both readings were live and neither was checkable.

| # | command | enumerated in | needs a map tile? |
|---|---|---|---|
| 1 | `MoveUnit` | `unit`, `player` | **yes** (`to`) |
| 2 | `AttackUnit` | `unit`, `player` | **yes** (`target`) |
| 3 | `FoundCity` | `unit`, `player` | no — the unit's own tile |
| 4 | `StartWork` | `unit`, `player` | no — the unit's own tile |
| 5 | `CancelWork` | `unit`, `player` | no |
| 6 | `EndTurn` | `player` **only** | no |
| 7 | `SetProduction` | `city` **only** | no |
| 8 | `FortifyUnit` | **no list anywhere** (`planFortifyUnit`) | no |
| 9 | `SetWorkedTiles` | **no list anywhere** | no |
| 10 | `SetResearch` | **no list anywhere** | no |
| 11 | `SetRates` | **no list anywhere** | no |
| 12 | `SetGovernment` | **no list anywhere** | no |

Two facts here were **measured against the engine, not reasoned about**, and both corrected a draft
of mine. `legalActions` yields the unit commands too, so `FoundCity` is enumerated for the player and
not only for a unit; and `EndTurn` is the one command that belongs to the player context alone, which
is why `unitActions` deliberately omits it — a unit's actions are its own (`actions.ts:127-137`).

Five commands are in no list in any context. Seven are. Twelve in total, so nothing is unclassified.

Two rows are what the whole redesign turns on: **the only two commands that name a map tile are
the two the map can issue by being clicked.** Everything else is either about the thing you have
selected, or a choice board.

### 2.C — Surfaces: the mapping from command to presentation

Every command gets exactly one surface. This table is the schema's centre and it is **total over
the `Command` union** — a new command member must be a compile error here (the same
`assertNever` discipline `actionLabel` already uses), not a silently unlabelled control.

```ts
export type Surface = 'map' | 'cluster' | 'workspace' | 'ambient';
```

| surface | meaning | members |
|---|---|---|
| `map` | **the control is a map tile.** Nothing is rendered; the tile is the affordance, shown by a highlight. | `MoveUnit`, `AttackUnit` |
| `cluster` | a small, transient control anchored to the selection. Exists only while something is selected. | `FoundCity`, `StartWork`, `CancelWork`, `FortifyUnit` |
| `workspace` | a panel you *enter* and *leave*. Real estate and reading time. | `SetProduction`, `SetWorkedTiles`, `SetResearch`, `SetRates`, `SetGovernment` |
| `ambient` | always on screen, as small as legibility allows. | `EndTurn` |

The mapping is 2 / 4 / 5 / 1. Note what it says: **only one command in twelve belongs in a
permanent part of the screen.** That is the quantitative answer to "should the UI recede" — it can,
because almost nothing has to stay.

### 2.D — Gesture resolution: what a click means

This is the part that makes deleting the movement buttons *safe*, and it is the part today's
behaviour gets subtly wrong.

Today the click handler resolves a collision by priority: a tile holding your own city **opens the
city** even when a selected unit could move onto it (`main.ts:866-873`). That is a reasonable
priority for a UI that also has buttons — the comment says so outright, "the unit's own action
group lists it as a `Move to x,y` control, which is where the keystone sweep's reachability
direction finds it". **Delete the buttons and that move becomes unreachable**, and the keystone
sweep fails. This is the one real trap in the whole overhaul, and it is why the schema has to be
settled before anything is deleted.

The resolution is to stop asking one surface to mean two things, and give navigation its own
spatial target:

| click | meaning |
|---|---|
| a **tile** while a unit is selected, and the engine offers a command naming that tile | **issue it.** The offered order always wins. |
| a **tile** while a unit is selected, no offered command names it | **inspect** it (selection becomes `tile`). Nothing is dispatched. |
| a **city banner / label** (a DOM label drawn over the city, not the tile) | **open the city screen.** |
| a **unit flag / label** | **select that unit** (or, if several share the tile, the next one in id order). |
| a **tile** with nothing selected | select the unit there, or open the city there, or inspect. |

The rule in one sentence: **tiles issue orders; labels navigate.** That is the whole trick. It
removes the collision instead of arbitrating it, it matches how the genre actually feels (the city
name plate is what you click to enter a city), and — critically — it makes *every* engine-offered
spatial command reachable by clicking the tile it names, which is exactly what the keystone sweep
requires.

It also handles stacking, which is real: `commands.ts:35` records that "Civ 3 stacks, and M2 sets
no stacking limit", so moving onto a tile that already holds your own units is legal. Under the
precedence rule above that move is issued by the tile click, and *selecting* the unit already
there is done by its flag. Both actions stay reachable, and neither gesture is overloaded.

### 2.E — Behaviour: when chrome exists

Five rules. They are deliberately few, because a rule that needs a paragraph is a rule that will
be broken by the next feature.

1. **Nothing selected ⇒ nothing but the map, the ambient HUD, and labels.** The default screen has
   no cluster and no reserved column.
2. **Selecting surfaces exactly one cluster** — the `cluster`-surface commands for that selection,
   and nothing else.
3. **Chrome is transient.** Escape, deselecting, or completing an order dismisses it. No cluster
   survives a turn boundary.
4. **A workspace opens only when asked, or when the engine requires a decision** — a city with no
   production is the one case where the game must interrupt. Otherwise the decision is announced
   and waits.
5. **Information is not chrome.** Tile yields, movement cost and combat odds surface on **hover**,
   where the pointer already is. A readout in a panel is a readout the player has to stop playing
   to read.

---

## 3. THE IDEAS

Grounded in the schema, ordered roughly by value per unit of risk.

**1. Delete the reserved panel column.** The structural fix; everything else is cosmetic until
this happens. Panels become overlays that own the screen while open and nothing while closed.

**2. Move by clicking the map; delete the movement buttons.** Behaviour already exists. The work
is: change the precedence (§2.D), teach the keystone sweep that a map click is a reachable control,
and delete `Move to …` from the label switch. Attack gets the same treatment.

**3. City and unit labels as the navigation targets.** Small DOM labels over the canvas — city name
+ size + production progress; a unit flag when a stack is selected. Clicking a label navigates;
clicking the tile orders. This is what makes rule §2.D work, and it doubles as the at-a-glance
readout that replaces three panels.

**4. The cluster.** A slim transient strip (or an anchored popover) with only the `cluster`
commands: *Found city*, *Start work ▸*, *Cancel work*, *Fortify*. Appears on selection, gone
otherwise. This is where "surfaces when needed" becomes literal.

**5. The next-unit flow.** Space = the next unit with moves left; Enter = end turn. After an order,
if the unit has movement left, advance; if not, offer the next. This is the single largest
playability win available and it costs almost nothing — the engine already knows which units can
still act. It is also what makes deleting the unit panel *comfortable* rather than merely possible.

**6. A notification rail.** "Production needed in Kyoto" as a clickable chip that opens exactly
that city's workspace. Instead of a panel listing everything, the UI says one thing at a time and
waits.

**7. Hover as the readout.** Hovering a tile shows terrain, yields and movement cost. Hovering an
enemy shows combat odds — from the engine's own combat function, never recomputed (the keystone
rule applies to readouts too: the UI may not compute outcomes).

**8. Workspaces as places.** The city screen and tech tree become full-bleed views you enter and
leave with Escape, rather than a 380px column that never goes away. Same roles, same accessible
names, new geometry.

**9. The event log as a ticker.** Collapsed to the last line or two, expanding on demand.

**10. Keyboard-first bindings.** A small documented set — next unit, end turn, fortify, found
city, open city, zoom, Escape — surfaced in one discoverable place. Worth knowing that this is the
one idea here that **breaks nothing**, because no keyboard or focus contract exists today (§5,
Phase 4).

**11. Say no out loud.** Make a refused order visible: the engine already computes a typed
`GameError` and the app discards it (§1.4). A map-centric UI *needs* this more than a panel UI does
— a click that does nothing is indistinguishable from a frozen game. Proposed: the schema owns the
refusal rendering, and the five hand-rolled per-panel verdicts
(`ratesVerdict`, `governmentVerdict`, `WorkedTileOption.legal`, `techRows(...).selectable`) collapse
into it.

**12. One labeller, not two.** `actionLabel` (`unitpanel.ts:173`) and `abilityLabel` (`main.ts:233`)
are two independent exhaustive switches over the same union. The schema should own the single one —
which is also what makes the `map` surface possible, since a map affordance still needs a label for
its tooltip and its accessible name.

**13. Hover the map to ask the engine.** The offered-action list carries no cost and no preview
(§4.4b), so "this tile costs 2, you have 1" and "these are your odds" must be built from `planMove`
and a folded `applyCommand` on a copy — the same reads the AI makes. Legitimate, because they ask
the engine rather than deciding, but it is a second query path and it must be built once, not
per-surface.

---

## 4. WHAT MUST NOT BREAK

### 4.1 The keystone invariant, in both directions — and the three places it is wired to buttons

`INTERFACES.md:1844-1850` is binding: *"every control the UI offers must be accepted by the engine,
and every action the engine accepts for a unit or city must be reachable from the UI"*. Reconnaissance
found the reachability half is **already partly map-driven**, which is good news, and that it is
wired to buttons in **three** further places, which is the real risk. All three must move in the
same commit as the deletion.

**(a) The keystone sweep itself — mostly ready.** `keystone.spec.ts:193-202` clicks every control in
the `Actions for unit N` group, then `:211-225` falls back to `clickTileOrder` for whatever is
still missing; and `clickTileOrder` (`helpers.ts:1456`) already tries the **map click first**. So
the reachability direction survives deletion almost as-is — the button fallback comes out and the
map click becomes the only route for `map`-surface commands.

**(b) `driveScript` has no map path, and it throws.** This is the sharpest one. `driveScript`
(`helpers.ts:1633-1698`) replays a headless command script into the browser by looking up an exact
accessible name per command, and for `MoveUnit` that name is `^Move to <x>,<y>$`
(`helpers.ts:1650-1660`); with no matching control it throws *"the UI drive has no control for
{...}"* (`:1682-1684`). Its consumer `orders.spec.ts:407` — the A4 **attack** proof — replays a
scene that necessarily contains `MoveUnit` march steps and asserts `stateHash()` equality after
**every** step. Delete the buttons and this fails with a message that reads like a missing control
rather than a redesign. The fix is a real one: teach `driveScript` a map path
(`bringTileToCentre` + `clickTileOrder`, both of which exist), and note that `clickTile` **throws**
unless the tile's centre is on-canvas (`helpers.ts:810-816`), so the drive loop must pan per step.
That adds a flake surface to an already expensive test. `evidence.spec.ts:101` is unaffected — its
script is `FoundCity`, `SetProduction`, `EndTurn` only.

**(c) The offered-direction sweep loses evidence and cannot be compensated.** `keystone.spec.ts:111`
proves "the UI offers nothing the engine refuses" by enumerating controls in the action group;
deleting the move controls shrinks what that sweep sees. The page-wide sweep at
`m8-adversarial.spec.ts:334` **only ever clicks buttons, never tiles** (`:444-462`), so it cannot
take over. And that sweep's coverage is already DOM-order dependent — `:427-438` records that
docking the panels changed which controls it visited. **A redesign that reorders the tree silently
moves that boundary again.** The plan must therefore add an explicit offered-direction check for
map affordances: if the UI highlights a tile as movable-to, that tile must be engine-offered.

### 4.2 The accessibility contract is semantic, and already anticipates this

`INTERFACES.md:1873-1876` freezes a table of role + accessible-name pairs and states the reason:
*"Tests target by ROLE and ACCESSIBLE NAME, never by CSS class or DOM position, so the two can be
built in parallel and the tests survive a restyle."* **A restyle is explicitly the thing this
contract was designed to survive.** The 17 names stay; their geometry, prominence and lifetime are
ours to change. That is the licence for this overhaul.

Two caveats, both real:
- `M9+M10` (`INTERFACES.md:2079-2081`) rules that the frozen M8 table may **not** be extended in
  place; new controls "state the new names beside the new panels and keep them unique".
- Making an element exist *only while its context applies* is a change in lifetime, not in name.
  That is permitted by the letter of the contract — but any test that looks for it at load time
  will need updating. Measured coupling: 81 `getByRole('button')` uses, 18 `dialog`, and only
  **4** references to `Move to` anywhere in the suite. The coupling is to *behaviour*, not to
  chrome, exactly as the contract intended.

### 4.3 The rest

- **Canvas for the map, DOM for panels** (`INTERFACES.md:1903`). Unchanged.
- **Hit-testing converts a page coordinate to a tile "through the SAME function the renderer
  uses"** (`INTERFACES.md:1908`). Unchanged, and the new labels must not invent a second mapping.
- **Determinism**: *"The UI introduces no randomness, no clock into the simulation, and no floating
  point"* (`INTERFACES.md:1922`). Unchanged.
- **A4 coverage** (`INTERFACES.md:1911-1916`) — each item keeps at least one named e2e assertion.
- **No engine change is required.** `unitActions` already enumerates per-tile moves and per-enemy
  attacks. If a phase seems to need a new command, that is a signal the phase is wrong.

---

### 4.4 What the engine does not give the UI — and what it costs the plan

This section exists because reconnaissance found that **the overhaul is not purely a UI change**.
Four gaps, in order of consequence. Under the keystone rule, each of the bottom three would need a
new engine command *and* its own `plan*` evaluator — never a control that computes for itself.

**(a) There is no path. `MoveUnit` is one adjacent step.** This is the big one, and it reframes the
owner's request. `unitMoveOptions` (`actions.ts:182-197`) is `neighbors8` filtered by `planMove`;
a non-adjacent destination is refused as `invalid-argument` naming the distance. **There is no
multi-tile reachability query anywhere in the engine.** The only route search in the repository is
the AI's own breadth-first search in `packages/sim/src/ai/smart.ts:1720-1785`, which needed a fake
probe state to work at all ("this unit standing on `tile` and every other friendly unit lifted off
the board"), is cached on the `GameState` object, and is **not exported**.

So "click a far tile and the unit walks there" — the thing that actually makes a map-centric
interface feel map-centric — has no engine answer today. The choices, and they are the owner's:
- **(i) Adjacent-only.** Click a neighbour; a journey is one click per turn. Cheap, honest, and it
  is what the map already does. But it means the map-centric UI cannot express the single most
  natural map gesture in the genre.
- **(ii) A UI-side pathfinder** that holds the intent ("this unit is heading for tile X") and
  dispatches one step per turn. The path is not a game rule — it is a plan — so this does not
  obviously violate the keystone. But it must not compute legality or cost itself: each step must
  still be an engine-offered `MoveUnit`, and the intent must survive `EndTurn` without entering the
  simulation state (or it stops being deterministic).
- **(iii) A `GoTo` command in the engine** with a planner that owns the route. Cleanest for the
  keystone and for replay/determinism, most expensive, and it is a genuine rules-bearing addition —
  a route is a multi-turn commitment the engine would have to hold.

I recommend **(ii) as an interim, (iii) if the game is to be played seriously**, and I would not
let this block Phases 0-3, which are all adjacent-only anyway.

**(b) There is no offered-action descriptor.** An offered action *is* the bare `Command`
(`actions.ts:246-291`). There is **no label, no `disabled` flag, no `reason`, and no `cost`** in
the engine — "offered" *is* "enabled", and absence from the list is the only signal. Labels already
exist twice on the UI side (`actionLabel` in `unitpanel.ts:173-204`, `abilityLabel` in
`main.ts:233-252`) — two independent labellers is one too many, and the schema (§2.C) should own
the single one.

The cost is real for a map-centric UI: to show "this tile costs 2, you have 1" the UI must call
`planMove` itself. That is allowed — it is asking the engine, not deciding — but it must be a
*read*, never a reimplementation. `MovePlan` already carries `cost` and `movementLeft`
(`commands.ts:1365-1371`); the generator simply discards the plan when it builds the command list
(`actions.ts:273-277`).

**(c) Refusal reasons never reach the player** — §1.4 above. The engine computes a fully typed
`GameError` (`commands.ts:530-891`) and the app throws it away at `main.ts:677-684`. Note how the
panels cope today: five separate places rebuild the "why" by calling a `plan*` evaluator and
formatting the error themselves (`ratesVerdict`, `governmentVerdict`, `WorkedTileOption.legal`,
`techRows(...).selectable`). That is five copies of the same idea, and the schema should replace
them with one.

**(d) Smaller gaps, recorded so they are not discovered later:** no attack preview (odds require
folding the command through `applyCommand` on a copy, which is what the AI does at
`smart.ts:2035-2050`); no city-level action list (`actionsFor` with a city yields production
options only); no way to edit the city **queue** (`SetProduction` replaces the head only, and
`commands.ts:3245-3249` says so outright); and none of the rest of the Civ-3 order vocabulary —
wait/skip, sentry, sleep, disband, pillage, rename, transport load/unload, ranged missions. A
Civ-shaped map-centric UI will want most of those, and **each one is an engine command plus an
evaluator, not a UI control.**



### 4.5 The panel-geometry rule — the one assertion a map-centric UI collides with head-on

`docs/KNOWN-ISSUES.md:523-526` states the layout rule the current design is built on: *"an open
panel covers neither the map nor the action buttons"*, and `panel-usability.spec.ts:248-253`
enforces it literally: `elementFromPoint(centre of canvas) === 'CANVAS'`. Two panels open at once
must both be fully visible, and the `Close` button of each must sit inside a 1280×900 window
(`:140-161,167`).

**A map-centric UI's whole premise — chrome over the map — is exactly what that assertion
forbids.** It is *changeable*: it is a geometry assertion, not a keystone. But it is backed by a
measured, reverted experiment — a `position: fixed` centred dialog "turned three green tests red",
and the header comment at `panel-usability.spec.ts:8-19` records why. So relaxing it needs the same
kind of measurement, not an argument. The honest reading: the current rule exists because panels
used to *intercept the pointer and the wheel*. A transient overlay that is pointer-transparent
outside its own controls, and that dismisses on Escape, does not have that problem — but that is a
claim to be demonstrated, not asserted. **This is the assertion to design against first, because it
is the one that decides whether "floating chrome" is even available to us.**



### 4.6 The layout constraints — and the one that "map-centric" collides with hardest

From the panel-by-panel inventory. These are the facts that decide what Phase 1 can actually do.

**(a) The map canvas is a fixed 720×540 box on purpose, and it is not "the space left over".**
`flex: 0 0 auto` on the map region (`styles.css:110`) plus a literal CSS width/height
(`main.ts:399-400`), because — quoting the source — "the camera clamp, the render rectangle and the
click hit-test must all invert one number" (`main.ts:110-115`). Every e2e click point is computed
from that box (`helpers.ts:1128-1195`, which first scrolls the canvas to the centre of the viewport).
**So "let the map fill the window" is not a CSS change; it changes the surface the entire hit-test
suite is built on.** This is the second-biggest decision in the document after goto (§4.4a), and it
is the one most likely to be underestimated.

**(b) The panel column already overflows at the suite's own 1280×900.** The scoreboard is cut by the
window edge in the shipped clean-load screenshot and Save/Debug sit below the fold, reachable only
by the column's scrollbar (`docs/KNOWN-ISSUES.md:521-538`). The budget: header ≈36 px, map 542 px,
gaps 24 px, leaving ≈260-282 px of dock, against a ≈510 px panel column. **The redesign is not
solving a self-inflicted problem here — it is fixing an existing one.**

**(c) No second element may carry a name the panels already own.** `main.ts:27-33` states the rule:
"two elements with one accessible name make a role-and-name locator ambiguous", and Playwright
matches accessible names by **substring** (`panels/index.ts:316-341`). Consequence for the design: a
map overlay may not add its own `Units`, `End turn`, `Treasury` or `Science` — which is a real
constraint on "put the HUD over the map", since the obvious thing to do is exactly that. The overlay
must *reuse* the panel's element (the shell already moves dialogs rather than duplicating them,
`main.ts:601-620`) or name its controls something new and unique.

**(d) Small ones that will bite anyway.** `styles.css:144` uses
`main > section[aria-label='Panels']` as a CSS selector — the only aria-label in the codebase used
as a style hook; the panel column must stay a direct `<section>` child of `<main>`. The chrome
filter `UI_CHROME = /close|cancel|done|dismiss|^×$|^x$/i` (`helpers.ts:1518`) decides which buttons
the page-wide sweep skips, so **any new non-dispatching button** (an icon toggle, a collapse
chevron) must be added to it or the sweep counts it as an order that failed to dispatch.
`contain: inline-size` on the dock (`styles.css:134-142`) is load-bearing: without it the map column
once measured **3114 px** and pushed the panel column off a 1280 px window.

**(e) There is no focus infrastructure to lose.** No `keydown`, no `tabindex`, no `.focus()`, no
focus trap, no a11y lint anywhere in the package. The map is a `role=application` region with no
focusable child, which the inventory calls "the sharpest gap" — pan, zoom, select and order are
pointer-only. So Phase 4 adds a contract rather than changing one, and until then a keyboard user
cannot touch the map at all.

**(f) Housekeeping the schema should absorb.** The 9-line `el()` DOM helper is **copy-pasted into
nine files** with no shared DOM module. The schema owns the single labeller (§3, idea 12); it should
own the single element helper too, for the same reason.


## 5. PHASES

**The phase plan now has a dependency line running through it**, because §4.4 shows the overhaul is
not purely presentational. Phases 0-3, 5 and 6 are **UI-only and can start now**. Only the goto
question (id (a)) and the extended order vocabulary (id (d)) need engine work, and neither blocks
the others.


**Phase 0 — the schema as a typed artifact, and the sweeps taught to read it.** Write §2.B/§2.C as
`packages/web/src/ui/schema.ts`: a `Record<Command['type'], Surface>` that the compiler forces to
be total. Then three test-side changes, all **before** anything visible moves:
  - extend the keystone sweep so a `map`-surface command is proven reachable by a *tile click*, and
    every other surface by a control;
  - teach `driveScript` (`helpers.ts:1633`) a map path, so it stops depending on
    `^Move to <x>,<y>$` (§4.1b). This is the single highest-value item in Phase 0 — it is the
    difference between Phase 2 being a deletion and being an outage;
  - add the offered-direction check for map affordances that the page-wide sweep cannot provide
    (§4.1c).

**No visible change.** This is first because it converts every later claim into a mechanical check,
and because §4.1's three wiring points are disarmed here rather than mid-deletion.

**Phase 1 — settle the geometry question, then delete the reserved column.** Before any overlay is
designed, answer §4.5: measure whether a pointer-transparent, Escape-dismissible overlay covers the
map centre or swallows the wheel, with the same kind of measurement that produced the current rule.
Then make panels overlays and the HUD minimal; the screen becomes the map. Low risk to the keystone,
and the largest visible change.

**Phase 2 — map movement.** Precedence change (§2.D), city and unit labels as the navigation
targets, delete the movement buttons, and the three sweeps updated in the same commit. Also fix the
silent refusal (§1.4) — in a map-centric UI, a click that does nothing and says nothing is a bug
the player cannot distinguish from the game freezing.

**Phase 3 — the cluster.** The `cluster`-surface commands (`FoundCity`, `StartWork`, `CancelWork`,
`FortifyUnit`), transient, dismissed by Escape, dismissed by completing an order.

**Phase 4 — next-unit flow and keyboard bindings.** Note that **no keyboard or focus contract exists
anywhere in `packages/web/src` today** (no `keydown`, no `tabindex`, no `focus()`), so this phase
*adds* a contract rather than changing one — which is the rare luxury in this document, and the
reason it is worth doing properly with a documented binding table.

**Phase 5 — workspaces and the notification rail.** City screen, tech tree, rates, government. This
is where the structure-pinned tests concentrate (`city.spec.ts`'s checkbox role and parsed
aria-label, `tech.spec.ts`'s row label format and `data-state`, `m9-m10-ui.spec.ts`'s `dt`/`dd`), so
each needs its own small migration rather than a sweep.

**Phase 6 — the hover layer.** Yields, movement cost, combat odds, all read from engine functions,
never recomputed.

**Not in these phases, and deliberately:** goto/path movement (§4.4a) and the missing order
vocabulary (§4.4d, wait/sentry/disband/pillage). Both are engine work, both are large, and neither
blocks anything above. They deserve their own decision and their own document.

Every phase keeps `pnpm verify` green and the alpha gate passing. Phases 0 and 2 are the only ones
that can break the keystone, and Phase 0 is what makes Phase 2 safe.

---

## 6. OPEN QUESTIONS FOR THE OWNER

1. **How far to recede?** Zero permanent chrome, or keep a slim always-on top strip (turn, gold,
   End turn)? The schema permits either; the second is more forgiving to a new player. Note the
   frozen contract requires `Turn`, `Year`, `Treasury`, `Science`, `Luxury` and `End turn` to exist
   as `status`/`button` at all times, so "zero chrome" means "visually minimal", never "absent".
2. **Next-unit auto-advance — yes or no?** Biggest playability change in the list, and the most
   likely to annoy someone who wants to micromanage.
3. **Tiles order, labels navigate (§2.D): agree?** It is what lets the movement buttons go. The
   alternative — keeping a button for the ambiguous cases — keeps a control panel alive for a
   minority of clicks.
4. **The goto question (§4.4a) — adjacent-only, UI-side path intent, or an engine `GoTo`?** This is
   the biggest single decision in the document. Adjacent-only is cheap and honest but means the map
   can never express "walk there"; an engine `GoTo` is the real thing but is a rules-bearing
   addition with a determinism story to write.
5. **Do we relax the panel-geometry rule (§4.5)?** It forbids exactly the overlay chrome a
   map-centric UI implies, and it was measured into place. Relaxing it means re-measuring, not
   arguing.
6. **Right-click / long-press for the cluster?** Genre-standard, but it is a hidden gesture unless
   documented — and there is no keyboard or gesture contract today to extend.
7. **May the event log, scoreboard and debug panel default to hidden?** They are A4 coverage items
   and the debug panel is used by tests; hiding them by default is the most aggressive reading of
   "surface only when needed".
8. **Do we write an amendment to `INTERFACES.md` for M12 (the UI overhaul), or keep this document
   as the plan and amend only when a phase lands?** Precedent (F6) says an amendment must name a
   migration owner for every existing consumer. My recommendation: keep this as the plan, and write
   the M12 amendment in Phase 0 — because Phase 0 is where the sweeps change, and that is exactly
   the kind of change the amendment exists to record.

---

# 7. THE OWNER'S DESIGN, EVALUATED

The owner's proposal, recorded verbatim before evaluating it so the evaluation has something to be
wrong about:

> "For commands i would imagine something like a popup near the mouse whenever an action is
> available and move as a standard action. Which means: I click on a unit and immediately see
> actions that unit can do, right next to the unit. I can click one of those actions and its done.
> If the user then clicks on an enemy unit instead, this automatically resolves into an attack. If
> the user clicks on an empty tile, this resolves into a goto action. The goal is to make everything
> maximally intuitive and simple. I think the map should be a square, covering the left side of the
> screen and the leftover sidebar hosts everything that is not a direct unit action."

## 7.1 Verdict: yes — and it is better than §1-§6, in one specific way

The sidebar is not a contradiction of "the UI recedes". It is a **re-partition of the panel column
that already exists**, and that makes it dramatically cheaper and safer than the demolition I
proposed:

- The frozen accessibility contract requires **thirteen** elements to exist at all times (`Turn`,
  `Year`, `Treasury`, `Science`, `Luxury`, `Events`, `Scoreboard`, `Cities`, `Units`, `Save game`,
  `Load game`, `Debug`, `State hash`). A sidebar is their natural home, so the contract is satisfied
  by *moving nothing*.
- It dodges the duplicate-name trap completely (§4.6c). My "chrome over the map" version would have
  had to re-create `End turn` and `Treasury` on the map, which `main.ts:27-33` forbids.
- **The panel column already IS a sidebar.** So Phase 1 stops being "delete a third of the screen"
  and becomes "restyle the sidebar, and move the *unit* controls out of it into the popup". The
  only structural change is the map becoming square and fluid.

The owner's instinct — unit actions belong next to the unit, everything else belongs in a sidebar —
is a cleaner cut than the one I drew, because it is a cut along *what the player is attending to*,
not along *what is transient*.

## 7.2 The click contract, restated precisely

| click, with a unit selected | result |
|---|---|
| an **enemy** on an adjacent tile | `AttackUnit` — already the engine's own offer |
| an **enemy** beyond reach | *undecided* — goto-then-attack, or a refusal that says why (see 7.4) |
| an **empty tile** | **goto** to it |
| a tile holding **your own unit** | *undecided* — see 7.3 |
| a tile holding **your own city** | *undecided* — today this opens the city (main.ts:869-875) |
| nothing selected | select the unit there, open the city there, or inspect |

The first and third rows already work. Rows 2, 4 and 5 are the ones with no answer yet, and they
are the whole difficulty: **the owner's rules are complete for unoccupied and hostile ground, and
silent on friendly ground.**

## 7.3 The proposal for friendly tiles: the popup is the disambiguator

A tile holding your own unit or city is genuinely two things at once — and unlike a button, a click
cannot be given a priority without silently deleting the other meaning.

**MEASURED, AND IT SPLITS THE CLAIM IN TWO — this section previously said "your own unit or city" and
that was half wrong.** `main.ts` resolves a click in code order, and the order is: own city →
`openCity` (`:94`), **then** the selected unit's own action list (`:105`), then own unit → select
(`:116`), then a bare `MoveUnit` that the engine refuses (`:133`).

| friendly tile | what a click does today | consequence |
|---|---|---|
| holds **your own unit** | the unit's own `MoveUnit` action is found **first**, so it is dispatched | **the map already works.** No collision, no button needed |
| holds **your own city** | `openCity` is checked **first**, so the city screen opens | **a `MoveUnit` onto your own city is unreachable by click**, held up only by a movement button (§4.1) |

Both halves are now evidence rather than argument. The unit half is proved by the strict keystone
test: on `SEED = 31337` the settler starts on tile 628 with its worker on tile 567, which **is** one
of its eight neighbours, so the settler really is offered a move onto a friend-occupied tile — and
that test clicks such tiles and passes. The city half was measured directly against the engine: on
seeds 1, 7, 31337 and 4242, founding with the settler leaves the worker **offered a move onto its own
city's tile** (on 31337, tile 628), while `openCity` is what a click on that tile actually does.

So the popup's job is **narrower than this section first claimed**: it is not needed to make friendly
*units* clickable — they already are — but it is needed for friendly *cities*, and it is needed for
the *general* case where a tile is legitimately more than one thing (a stack, or a destination that
is also a landmark).

The popup solves it, using the mechanism the owner already asked for: **when a click is ambiguous,
the popup opens with the explicit choices** — *Goto here* / *Select Warrior 4* / *Open Kyoto* —
each of which is an engine-offered action or plain navigation. Unambiguous clicks stay one-click.
That keeps the 95 % case maximally simple (the owner's goal) while making the remaining cases
*expressible* rather than *prioritised away*, which is what the keystone invariant requires.

## 7.4 Goto: the fork is "does the simulation remember the destination?"

Confirmed by reconnaissance: **`MoveUnit` is a single adjacent step and the engine has no route
query at all** (§4.4a). So goto is new work, and there are three shapes:

- **(a) A pathfinder in `packages/web/src`, intent in UI memory.** *Recommend against.* The
  rule-scanner (`m8-adversarial.spec.ts:918`) flags every line in `packages/web/src` that holds a
  rule word **and** arithmetic, and a route search is exactly that shape. It would also be a
  **second** pathfinder: the AI already wrote one (`smart.ts:1720-1785`), complete with a fake probe
  state, *because the engine has no route query*.
- **(b) A route query in the engine, intent in UI memory.** Pathfinding lands where the AI can share
  it; no state change; **the six goldens are untouched**. Cost, and it is real: the UI becomes the
  thing that issues the between-turn steps, so "the UI added no rules" weakens from *provable* to
  *argued* — a pending goto produces dispatches a headless script would not contain, which is
  precisely what `determinism.spec.ts:83` compares.
- **(c) A `GoTo` command with the destination stored in the unit.** The only shape where the UI adds
  genuinely nothing: the script is `[GoTo, EndTurn, EndTurn, …]` and replays headlessly to the same
  hash, and a goto survives save/load because it is *state*. Cost: a state-shape change, so **all
  six goldens regenerate**, a new pipeline step, and an F6 migration owner — plus the AI can now set
  a goto, which is a balance decision as much as a UI one.

**Recommendation: (b) now, (c) when goto earns it.** (b) is enough for a human to play, and it does
not spend the goldens on a first pass. But the owner should know that (b)'s price is paid in the
determinism proof, not in the UI — and that (c) is the version that is *architecturally* right.

## 7.5 The square map: right call, most expensive change

The canvas is a deliberately fixed 720×540 box because "the camera clamp, the render rectangle and
the click hit-test must all invert one number" (§4.6a). A square, fluid map is the structural
enabler for everything else — but it is the change that touches the most, and it should be its own
phase with its own measurement rather than a CSS tweak.

## 7.6 Revised phases

The owner's design reorders these. Phase 0 is unchanged and still first — it is what makes the
button deletion safe.

0. **Schema + `driveScript` map path.** Invisible. Unchanged from §5.
1. **The map becomes square and fluid.** New priority, because it is the enabler. — **landed**, see §9.
2. **The click contract, and the popup.** Merge the shell's `Abilities for unit <id>` group and the
   panel's `Actions for unit <id>` group into **one** popup with the frozen name — today they are
   two independent lists, which is also two independent labellers (§3, idea 12).
3. **Sidebar re-partition.** Unit controls leave; everything else stays and stops overflowing.
4. **Goto.** Engine route query first, then the intent decision of §7.4.
5. **Next-unit flow and keyboard.** Still additive: no keyboard contract exists today.
6. **Hover layer.** Tile yields, movement cost, combat odds.

## 7.7 Open questions this raises

1. **Goto: (b) now and (c) later, or (c) directly?** The price of (c) is the six goldens.
2. **Popup-as-disambiguator for friendly tiles (§7.3) — agree?**
3. **A distant enemy: goto-then-attack, or a refusal that says "not adjacent"?** Goto-then-attack is
   the genre answer and the more useful one, but it is more machinery.
4. **Goto into the fog.** Legality never consults fog (`actions.ts:138-145`), so the engine will
   happily route through unexplored tiles. What happens to a goto when scouting invalidates its
   path — cancel with a message, or recompute?
5. **How wide is the sidebar, and may the map take the rest?** This is the one number that decides
   how "map-centric" the result actually feels.

## 7.8 A DEFECT FOUND WHILE CHECKING THIS: the app draws every unit through the fog

Recording this here because the owner's inspection idea ("display what the user can know about that
enemy") depends on a correct notion of *what the player can know*, and the app currently has none.

**The defect.** `unitMarkers` (`main.ts:181-188`) is `state.units.map(...)` — every unit of every
player — and the unit draw loop in `render.ts:469-485` filters only by **viewport**
(`if (!onScreen(...)) continue`), never by fog. Fog is applied to *terrain* only
(`render.ts:406`: an unexplored tile is painted flat `FOG_COLOUR`). So an unexplored tile is painted
as unknown… **and then the enemy standing on it is drawn on top.** The module comment is candid
about the split — "this file does not decide what is visible" — but nothing downstream decides
either.

**The evidence.** Units at game start, `small` map, 4 civs, counted with the engine's own
`visibleTiles` and `isExplored` (`packages/core/src/fog.ts`):

```
seed    1  total units   8  foreign  6  NOT currently visible  6  never-explored ground  6
seed    7  total units   8  foreign  6  NOT currently visible  6  never-explored ground  6
seed   75  total units   8  foreign  6  NOT currently visible  6  never-explored ground  6
seed 4242  total units   8  foreign  6  NOT currently visible  6  never-explored ground  6
```

**All six foreign units, on every seed tried, stand on ground the player has never explored — and
the app draws all six.** From turn one, the fog hides the map but not the enemy army.

**FIXED, and the fix carries two things the owner should look at.**

*Decision taken (overridable).* `fog.ts` exports two notions and they must not be conflated:
**units → `visibleTiles`** (current sight), because a marker is a claim about what the player can see
*this instant*; **cities → `isExplored`** (memory), because keeping a city you have seen after it
leaves your sight is the genre convention and what this codebase already does one layer down, where
the border tint is drawn only on explored ground. The city half is a **consistency choice, not
something derived from the leak** — swap it to `visibleTiles` and cities will vanish when they leave
sight. Recorded as an owner decision precisely so it can be overridden.

*Found and deliberately NOT fixed — engine side.* The shipped AI policy reads fogged world data when
choosing where to walk: `exploreRanker` (`packages/sim/src/policies.ts:~375`) ranks a step by
`hutAt` on the destination tile with no `isExplored` guard, so a rival scout can prefer an unseen hut
to an unseen empty tile. (`revealCount` beside it *is* guarded.) The neighbouring `inContact` reads
only the eight adjacent tiles, which are inside a unit's own sight radius, so it is not a leak in
practice. It is left alone for a strong reason: **that policy is the measurement instrument every
balance number in this repository was taken against**, so changing what it can see would invalidate
them. It is also a *reading, not a measurement*, and is recorded as such. **This is an open item for
the owner**, not a finished matter.

**Why it was not caught.** No test asserts that a unit outside the player's vision stays unpainted.
The pixel tests go the other way: `tileIsClear` (`helpers.ts:1278`) *excludes* tiles with markers,
so the suite treats a drawn marker as a fixture of the world rather than as something that could be
present when it should not be. A test that cannot fail is decoration, and here the decoration hid a
leak.

**The rule the fix needs — and the two notions of "known" must not be conflated.**
`fog.ts` exports both, and they answer different questions:
- `isExplored` — memory: has this player *ever* seen this tile. Correct for **terrain and borders**,
  which is what the M9/M10 contract already does.
- `visibleTiles` — current sight: what this player can see *right now*, derived from its own units.
  Correct for **units**, because an enemy that has walked out of range must stop being drawn.

So: units and their markers use `visibleTiles`; terrain and borders keep `isExplored`. Cities are
genuinely ambiguous — a city you have explored but cannot currently see is remembered in every game
of the genre — and that is a decision, not an oversight, so it should be made deliberately.

**Consequence for the plan.** This is a **gameplay defect independent of any layout work**, it is
small and testable, and the inspector (§7.3) would otherwise be built on top of it — an "inspect
this enemy" panel that reads `state.units` would formalise the leak rather than fix it. **It should
be fixed first, as its own change with its own test**, and that test is the one the suite is
currently missing: *a unit the player cannot see is neither painted nor inspectable.*

The inspector must then read visibility from the **same function the renderer uses**, in the same
spirit as the contract's one-projection rule (`INTERFACES.md:1908`) — a second notion of "can be
seen" is a fog leak waiting to happen, which is exactly how this one happened.

---

# 8. DECISIONS TAKEN

Recorded so that later phases do not re-litigate them.

| # | decision | date |
|---|---|---|
| 1 | **Ambiguous click ⇒ the popup disambiguates.** Friendly ground is cleared with explicit choices, not by a precedence rule (§7.3). | owner |
| 2 | **A distant enemy does nothing.** Instead the click shows what the player can legitimately know about that unit (§7.2). This removes goto-then-attack from the design entirely. | owner |
| 3 | **Goto shape (b):** a route query in the engine, the destination held as UI intent. Not (a), a pathfinder in the web package. (c) — a stored `GoTo` in the unit — is deferred until goto earns the golden regeneration (§7.4). | owner |
| 4 | **An invalidated goto is cancelled**, with a message, rather than silently recomputed. Invalidations are the fog case in particular: legality never consults fog (`actions.ts:138-145`), so a route may cross ground the player cannot see. | owner |
| 5 | **The fog leak is fixed before the map work** (§7.8), as its own change with its own test. | owner |

Consequences to carry forward:

- Decision 2 means the click contract has exactly three outcomes — **order, inspect, or popup to
  disambiguate** — and no compound action. It simplifies Phase 4 substantially.
- Decision 4 means the UI must be able to *notice* an invalidation, which requires the route query of
  decision 3 to be re-askable cheaply, and requires somewhere to say "the route is gone" (§3, idea
  11 — the same channel that makes a refused order visible).
- Decision 3 leaves `determinism.spec.ts:83` as the open debt: with intent in UI memory, a pending
  goto emits dispatches a headless script would not contain. **The plan must therefore keep gotos out
  of the determinism fixtures, and say so in the code**, rather than let the proof quietly weaken.

---

# 9. PROGRESS

## Phase 0 — in progress

**Done: the schema, and it is load-bearing rather than decorative.**

- `packages/web/src/ui/schema.ts` — the total `Command['type'] → Placement` table, plus
  `tileNamedBy`, `isMapCommand`, `surfaceOf`, `enumeratedIn`, `isEnumerated`, `enumerationContextsOf`
  and `surfaceCounts`. A new command member does not compile until it is classified, and
  `tileNamedBy`'s switch has no `default`, so the same member stops the build twice.
- `packages/web/test/ui/schema.test.ts` — seven tests, built on a `Record<Command['type'], Command>`
  sample table so a new member cannot be silently untested. It re-derives the headline claim
  (`{map: 2, cluster: 4, workspace: 5, ambient: 1}`) rather than restating it, and it is the bridge
  that stops the table and the extractor drifting apart.
- `main.ts` no longer carries its own `commandTile`; the canvas click handler asks the schema. Two
  definitions of "which tile does this command point at" is the same defect class the contract bans
  for the projection.

**Mutation-checked, because a test that cannot fail is decoration.** Two breakages, both RED, file
restored byte-identical (`c2fe8c5c…`):

| mutation | what went red |
|---|---|
| the extractor stops agreeing with the table (`AttackUnit` returns `undefined`) | `AttackUnit is a map command but names no tile: expected undefined to be type of 'number'`, and the swap-detector `expected undefined to be 9` |
| the table calls a map command a workspace (`MoveUnit → workspace`) | four tests, including `MoveUnit is not a map command but names tile 7` and `MoveUnit should carry a tile field` |

**Corrected: the enumeration column is per context, and the engine — not reasoning — forced the
change.** The first version of the test asserted six and six from a single global field. A count
cannot tell a right labelling from a wrong one, so the test was rewritten to ask the engine's three
functions directly; doing that showed the *field itself* was wrong. "Is it enumerated?" has no answer
without asking "for what?", and §2.B carries the corrected table.

Two of the engine's answers contradicted my draft and are now recorded as measured facts:
`legalActions` yields the **unit** commands as well, so `FoundCity` is enumerated for the player and
not only for a unit; and `EndTurn` belongs to the **player** context alone, which is exactly why
`unitActions` omits it.

**Mutation-checked, two breakages, both RED**, restored byte-identical (`7191f83b…`):

| mutation | what went red |
|---|---|
| collapse the contexts (`EndTurn → unit`) | `expected ['MoveUnit','AttackUnit',…(4)] to deeply equal […(3)]` and `the engine enumerates EndTurn for the player, but the schema does not` |
| the disagreement this rewrite settled (`SetProduction → []`) | `expected [] to deeply equal ['SetProduction']` |

**Not done yet — the test-side seams**, which are the half that makes Phase 2 safe. Designed, not
written, because they touch files the fog-leak change is editing:

- **A map path in `driveScript` (`helpers.ts:1633`).** Its `MoveUnit` case clicks a button named
  `^Move to <x>,<y>$` and it has **no `AttackUnit` case at all** — an attack script throws on
  `default`. The replacement is `clickTileOrder`, which already prefers the map click. **The
  subtlety that will bite if it is missed:** `clickTileOrder` takes a *camera*, and the required
  `bringTileToCentre` call **drags the map**, so the camera must be **re-read after the pan**. A
  stale camera clicks the wrong tile — and then `clickTileOrder`'s own fallback reports the order as
  unreachable, which is a misleading failure for a real bug. Order: select the unit, pan, re-read the
  camera, then click.
- **The keystone sweep strengthened** so a `map`-surface command is proven reachable *by tile click*
  rather than by either route — which is the assertion that makes deleting the buttons safe rather
  than merely survivable. It should also stop hand-maintaining `ENUMERATED_UNIT_COMMANDS` /
  `ENUMERATED_CITY_COMMANDS` (`keystone.spec.ts:71-82`) and derive the expectation from the schema,
  so the sweep and the UI cannot disagree about what is obliged to be reachable.

**Both seams are now written, and neither has been run.** They are typecheck- and lint-clean, but
they exercise a browser and the fog-leak change holds port 4174 — two Playwright runs at once is how
the earlier flakes happened, so they wait for a clear window.

**The second seam has already paid for itself, before it has even been reported.** It was written to
falsify §7.3's premise, and checking that premise against the engine split it in two: friendly
**unit** tiles are already clickable (the unit's own action is found before the tile's unit is
selected), while friendly **city** tiles are not (`openCity` is checked first). §7.3 carried
"your own unit or city" as one claim and it was half wrong. See §7.3 for the measurement.

It is also **not vacuous**, which I checked rather than assumed: on `SEED = 31337` the settler and its
worker begin adjacent, so the friend-occupied case is genuinely among the offered moves the test
clicks.

**And that check is now a test rather than a memory.** `packages/web/test/ui/map-orders.test.ts` pins
the two engine facts this whole argument depends on, because an e2e test cannot tell "the feature
works" from "the situation never arose":

- on every seed the sweep uses, a friendly unit **can** move onto a friend-occupied tile — so if the
  engine's starting placement ever changed such that no units began adjacent, this test fails and
  says the map-only test has become vacuous;
- after founding, a friendly unit **is** offered a move onto its own city's tile — the premise of
  §7.3's city half, and the reason the popup still has a job.

Both were mutation-checked by blinding the instrument to the very thing it looks for; both went RED
with a message naming the consequence. Restored byte-identical (`a710bc90…`).

The second seam doubles as the **falsifier for §7.3's premise**, which until now was an argument:
§7.3 asserts that a friendly tile is genuinely two things at once and that a `MoveUnit` onto a tile
holding your own unit or city is *unreachable by a click today, held up only by a movement button*.
That is a claim about behaviour, and the new test is the first thing in the suite that can settle it
— it clicks the destination and nothing else, so if any offered map order cannot be issued that way,
it fails and names the tiles. **Its result is therefore evidence about §7.3, not merely a regression
check**, and §7.3 should be read as unconfirmed until it reports.

## The fog leak (scope item 1) — landed, `3c99193`

Landed and independently verified. The rule, the measurement and the three mutations are in §7.8;
see also `docs/KNOWN-ISSUES.md` §3.13, which records the city half as a consistency choice rather
than something the leak forced, and the `exploreRanker` finding as a reading that was deliberately
not acted on.

## Phase 0 — landed, `6708c3a`

The schema, the enum-per-context correction, and the two test-side seams are all in. §7.3's premise
was settled by the new map-only sweep, and one half of it was wrong — see §7.3, which is now
corrected in place: friendly **unit** tiles were already clickable, friendly **city** tiles are not.

## Phase 1 — the square, fluid map — landed

**What changed.** The canvas was a fixed 720×540, and the argument for fixing it was sound — the
viewport the camera is clamped against, the rectangle the renderer walks, and the box the hit-test
inverts must be one number. That argument is kept; only its owner changed. The layout now decides
the size (a square that takes the room the sidebar leaves), `measureCanvas` reads it, and
`viewport()` hands the same number to all three consumers. `localPoint` lost its scale factor
outright: with nothing stretching the canvas, a client point minus the box origin is already in the
coordinate space the tiles were projected into.

**Measured, at three window sizes** (region is the map region's border box; "content" is what is
left after its 1px border and 8/10px padding):

| viewport | region | content box | canvas | largest square that fits |
| --- | --- | --- | --- | --- |
| 1280×900 | 852×815 | 830×797 | **797×797** | 797 |
| 900×1000 | 472×915 | 450×897 | **450×450** | 450 |
| 1600×700 | 1172×615 | 1150×597 | **597×597** | 597 |

Square at every size, and exactly the largest square available rather than merely *a* square. The
sidebar became a fixed 380px strip (`flex: 0 1 380px`) so the map takes what remains, and the dock
gave up its claim on the column's height (`flex: 0 1 auto; max-height: 40%`) so the map has first
claim on it. No JavaScript sizes the canvas: `container-type: size` plus
`width: min(100%, 100cqh)` expresses "the largest square that fits" in one declaration.

**A defect in the first version of this phase, found by its own test.** The resize handler skipped
its work when `measureCanvas` reported the size unchanged — and that is wrong, because `draw` calls
`measureCanvas` too. Any repaint between the layout change and the observer callback (the pointer
events of a drag are enough) consumed the change first, so the handler saw "nothing changed",
returned early, and the camera was **never** re-clamped. It appeared intermittently: a later resize
with no intervening repaint clamped correctly. Measured before the fix — at 900×1000 the camera sat
at 52.97, widening to 1600×700 made 50.67 the legal limit, and the camera stayed at 52.97 for as
long as it was watched. The fix is to clamp unconditionally, which `clampCamera`'s idempotence
makes free. **This is the failure the fixed 720×540 box used to make impossible, and it is exactly
why the phase needed its own measurement rather than a stylesheet edit.**

**The test** (`map.spec.ts`, "the map is a fluid square…") asserts four things at three window
sizes: that the canvas is square; that it fills its region's content box; that a pointer at its
centre resolves to the tile the projection says is under that point; and — the control, since a
hardcoded square passes the first two — that the size actually moved between windows. It then
settles the camera question that the third assertion provably cannot: a pointer test compares the
app against the app's *own* camera, so a camera showing ground past the map's edge inverts
consistently and every click still lands where the wrong view drew. That is checked by driving the
view hard into the map's corner at a narrow window and then widening it, which makes the held
camera illegal; the assertion is that the app's camera is one `clampCamera` would produce.

Mutation-checked three ways, each RED with a message naming the failure, each restored
byte-identical: removing the re-clamp ("the widening resize left the camera un-clamped…"), freezing
the canvas to a 450px square ("the map never filled its region at 1280x900"), and restoring a stale
scale factor in the hit-test ("the app never named a tile under the centre of the canvas").

**Not done in this phase, and not claimed.** The dock still sits under the map — Phase 3 is what
re-partitions it, and the 40% cap is a holding position rather than a design. A narrow, tall window
(900×1000) leaves the square limited by width and a good deal of unused height beneath it; that dead
space closes when the dock's contents move to the sidebar. The sidebar's 380px is the current
number, not an answer to §7.7.5, which is still open for the owner. And no keyboard or focus
contract exists yet — that is Phase 5 and was not touched here.
