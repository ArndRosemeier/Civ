# GDD — the game as built, and where every number came from

This is the design document for what the engine *actually does*, not what it aspires
to. The authoritative contracts are in `INTERFACES.md`; the plan of record is
`PLAN.md`. Where this document and the code disagree, the code is right and this
document is a bug.

Written against commit `d4e7f72` (M0–M10 landed; M11 in the working tree).

---

## 1. Provenance: the honest headline

**Every rules row in the shipped catalog is `placeholder`. Nothing is `cited`.**

```
$ pnpm rules:provenance
ruleset provenance — 0/60 cited (0%), 60 placeholder

terrains — 6 rows, 0 cited, 6 placeholder
units — 10 rows, 0 cited, 10 placeholder
buildings — 8 rows, 0 cited, 8 placeholder
improvements — 3 rows, 0 cited, 3 placeholder
resources — 6 rows, 0 cited, 6 placeholder
techs — 19 rows, 0 cited, 19 placeholder
combat — 1 row, 0 cited, 1 placeholder
capture — 1 row, 0 cited, 1 placeholder
governments — 3 rows, 0 cited, 3 placeholder
culture — 1 row, 0 cited, 1 placeholder
score — 1 row, 0 cited, 1 placeholder
victory — 1 row, 0 cited, 1 placeholder

cited-only mode is expected to FAIL until rows are traced to sources.
```

That command is the whole provenance table: it prints one section per catalog
section, the counts above it, and every row's own `provenance` note. The numbers are
Civ-3-**shaped** — a 4X with terrain yields, a settler that founds cities, a tech
tree with eras, wonders that are globally unique — but **they are our own numbers,
chosen to be playable and measured against nothing**. No row claims to match Civ 3,
and several notes say where Civ 3 is known to differ:

- the **Pyramids** give culture here; in Civ 3 they do not,
- the **library** gives culture here; in Civ 3 it does not,
- the **unhappy ladder** is 7/12/18 citizens, deliberately re-runged from 3/6/10
  after it was measured to make a three-citizen city permanently unable to build
  the temple that would cure it,
- Civ 3's **domination** needs a share of land *and* population together, its
  **cultural** victory counts culture per city, and its **turn limit** depends on
  map size and difficulty; none of that is reproduced.

The mechanical consequence: `fidelity: "cited-only"` makes the engine **refuse to
start**. That refusal is the intended behaviour today.

### The trap this exists to prevent

A commonly linked CivFanatics thread titled *"city growth mechanics"* resolves to
`20 + 2·pop`. That formula is **Civ IV, not Civ III**. Always verify *which game* a
number belongs to, not just the number.

---

## 2. The core loop

`newGame(seed, settings, ruleset)` generates a map, places one civilization per
`settings.civCount` plus one barbarian player, gives every civilization a **settler
and a worker**, marks the tiles around each start explored, and sets `turn = 1`,
`revision = 0`, `SCHEMA_VERSION = 9`.

Measured for `seed 42, tiny (60×60), 2 civs` (see §7 for the command):

- players: `Player 1` (civ), `Player 2` (civ), `Barbarians` (kind `barbarian`),
- each civilization: `treasury 10`, `rates {tax 6, science 4, luxury 0}`,
  `government despotism`,
- starting units in id order: `settler, worker, settler, worker`,
- map: `28` huts, `30` resource tiles, `0` improvements.

From there a player explores, settles, works tiles, builds, researches, fights and
runs an economy until a **victory condition** ends the game.

---

## 3. The turn pipeline — a contractual order

`advanceTurn(state, ruleset)` in `packages/core/src/turn.ts` is the **single
definition of what "a turn" means**. Every step runs in this order, and the order is
part of the frozen contract:

1. **work progress** — every unit with a job, in unit-id order; completing at zero
   turns-left adds the improvement.
2. **growth** — every city, in city-id order.
3. **production** — every city, in city-id order.
4. **culture** — every city, in city-id order (M9).
5. **research** — every civilization, in player-id order (M5).
6. **the money loop** — every civilization, in player-id order: income, upkeep,
   treasury, bankruptcy (M4b).
7. **the barbarian step** — in unit-id order; engine behaviour, not a policy (M6).
8. **refill** — every unit's movement.
9. **ownership recomputed** from the cities (M9).
10. **`turn += 1`**.

Why the order matters, in the code's own words (each of these is observable and
pinned by a test):

- **Work runs first**: an improvement finished this turn must contribute to *this*
  turn's yields.
- **Growth runs before production**: a city that grows has one more citizen — and
  one more worked tile — before its shields are counted.
- **Research runs before the money loop**: research spends the pool the *previous*
  turn's money loop banked, so no beaker is credited and spent in the same step.
- **The money loop runs after production**, so a unit produced this turn is paid for
  from the turn it appears, and **before the refill**, so a unit disbanded by
  bankruptcy gets no movement back.
- **The barbarian step runs after the money loop** — a city a barbarian takes still
  pays its former owner for that turn — and **before the refill**, because an attack
  spends all remaining movement.
- **A finished game returns unchanged** and refuses further commands: the victory
  screen is not a game that keeps playing behind it.

`EndTurn` calls this pipeline; nothing else spells the order out.

---

## 4. Systems, and the numbers each one uses

Every value below was read out of the shipped catalog this session; §7 has the
commands. Rows are `placeholder` per §1.

### 4.1 Terrain (6 rows)

| terrain | role | move cost | defence bonus | food/shield/commerce | passable |
|---|---|---|---|---|---|
| grassland | grassland | 1 | +10% | 2/1/1 | yes |
| plains | plains | 1 | +10% | 1/2/1 | yes |
| hills | hills | 2 | +50% | 0/2/0 | yes |
| mountains | mountains | 3 | +100% | 0/0/0 | no |
| ocean | ocean | 1 | 0% | 1/0/0 | no (needs a sea unit) |
| coast | coast | 1 | 0% | 1/0/2 | no (needs a sea unit) |

Generation is integer-hash value noise with a **quantile** sea level (not a magic
constant), so the ocean fraction is stable and the arrangement is seed-dependent.

### 4.2 Map sizes (6 rows)

| size | width × height | maximum civilizations |
|---|---|---|
| duel | 40 × 40 | 2 |
| tiny | 60 × 60 | 4 |
| small | 80 × 80 | 6 |
| standard | 100 × 100 | 8 |
| large | 140 × 140 | 12 |
| huge | 180 × 180 | 16 |

Golden state hashes depend on these dimensions: changing one is an intentional rehash.

### 4.3 Units (10 rows)

| unit | role | attack/defence/move | cost | domain | requires tech | requires resource |
|---|---|---|---|---|---|---|
| settler | settler | 0/0/2 | 3 | land | — | — |
| worker | worker | 0/0/2 | 2 | land | — | — |
| scout | scout | 0/1/3 | 1 | land | — | — |
| warrior | military | 1/2/1 | 1 | land | — | — |
| galley | military | 0/2/3 | 2 | sea | — | — |
| archer | military | 3/0/1 | 2 | land | warrior-code | — |
| spearman | military | 1/3/1 | 2 | land | warrior-code | — |
| horseman | military | 3/1/2 | 3 | land | horseback-riding | horses |
| swordsman | military | 2/2/1 | 3 | land | — | iron |
| transport | military | 0/1/2 | 3 | sea | map-making | — |

A unit at 0 hit points is **removed**, never stored at 0. Attacking consumes **all**
remaining movement, win or lose.

### 4.4 Buildings (8 rows) and the one wonder

| building | cost | maintenance | wonder | culture/turn | happiness | effects |
|---|---|---|---|---|---|---|
| granary | 10 | 0 | no | 0 | 0 | growth-food 1 |
| barracks | 12 | 1 | no | 0 | 0 | shield +25% |
| walls | 15 | 1 | no | 0 | 0 | shield +25% |
| temple | 15 | 1 | no | 1 | 1 | commerce +25% |
| library | 20 | 1 | no | 1 | 0 | beakers +50% |
| marketplace | 12 | 1 | no | 0 | 0 | commerce +50% |
| factory | 25 | 3 | no | 0 | 0 | shields +50% |
| pyramids | 30 | 2 | **yes** | 2 | 1 | growth-food 1 |

Multipliers are integer percentages applied with a **single floor** after summing
(flooring twice gives a different number). A wonder is globally unique and is never
destroyed by capture; it can only be lost through a bankruptcy disband, after which
it becomes buildable again. Seven of the eight declare maintenance > 0, which is what
makes a treasury shortfall reachable from shipped content.

### 4.5 Improvements (3 rows)

| improvement | kind | worker turns | yield delta | allowed terrain |
|---|---|---|---|---|
| road | road | 2 | +0/+0/+1 | grassland, plains, hills, mountains |
| mine | mine | 3 | +0/+1/+0 | hills, mountains |
| irrigation | irrigation | 2 | +1/+0/+0 | grassland, plains |

Improvements live on `GameState` (a sparse `(tile, kind)` list), not on the map, and
apply only to **worked** tiles; the city centre is unaffected. A tile may hold
several. Civ 3 restricts irrigation by water access and roads cut movement cost;
neither is modelled here.

### 4.6 Resources (6 rows)

| resource | kind | yields | allowed terrain |
|---|---|---|---|
| iron | strategic | 0/0/0 | hills, mountains |
| horses | strategic | 0/0/0 | grassland, plains |
| gems | luxury | 0/0/0 | hills, mountains |
| wines | luxury | 0/0/0 | grassland, plains |
| wheat | bonus | +1/0/0 | grassland, plains |
| fish | bonus | +1/0/0 | coast |

Strategic resources gate production: a unit whose row names one may only be built by
a city whose owner has that resource **connected** by a road path (deterministic
8-way BFS, one implementation, asked from everywhere). Bonus resources are terrain —
not gated, no road needed. Luxury resources content citizens (§4.8). A tile carries
**at most one** resource (the generator enforces it); a tile may carry **several**
improvements (a road *and* a mine is normal).

### 4.7 Technology (19 rows, four eras)

| tech | era | cost | requires |
|---|---|---|---|
| pottery | ancient | 5 | — |
| bronze-working | ancient | 6 | — |
| ceremonial-burial | ancient | 6 | — |
| alphabet | ancient | 7 | pottery |
| warrior-code | ancient | 5 | bronze-working |
| the-wheel | ancient | 8 | pottery |
| masonry | ancient | 9 | bronze-working |
| map-making | ancient | 8 | pottery |
| iron-working | medieval | 14 | bronze-working + masonry |
| mathematics | medieval | 16 | alphabet + masonry |
| currency | medieval | 13 | the-wheel + alphabet |
| literature | medieval | 15 | alphabet + ceremonial-burial |
| horseback-riding | medieval | 13 | the-wheel + warrior-code |
| feudalism | medieval | 18 | warrior-code + iron-working |
| engineering | industrial | 26 | mathematics + iron-working |
| banking | industrial | 24 | currency + feudalism |
| education | industrial | 28 | literature + mathematics |
| steam-power | modern | 40 | engineering + banking |
| electricity | modern | 45 | steam-power + education |

Prerequisite cycles are rejected at validation, and era ordering is checked. Civ 3
has roughly forty technologies across four ages; this is a 19-row tree chosen to
reach every gate with a real decision.

### 4.8 Governments, happiness and disorder (3 rows)

| government | rate caps (tax/science/luxury) | free units per city | unit support cost | happiness |
|---|---|---|---|---|
| despotism | 8 / 8 / 2 | 2 | 1 | 0 |
| monarchy | 8 / 6 / 4 | 4 | 1 | 0 |
| republic | 6 / 8 / 6 | 1 | 2 | 1 |

Rates must be non-negative integers **summing to exactly `RATE_TOTAL = 10`**; the
default is 6/4/0, and the integer remainder of the commerce split goes to **gold**
(deterministic and stated, not "whatever the arithmetic did"). Rate caps come from
the government and are enforced in one place.

Unhappiness comes from city size on this ladder:

| population ≥ | unhappy citizens |
|---|---|
| 1 | 0 |
| 7 | 1 |
| 12 | 2 |
| 18 | 4 |

reduced by buildings with `happiness`, by a government's own modifier, and by luxury
resources connected. Every 2 banked luxuries content one citizen, and each connected
luxury resource contents 1 more.

**Civil disorder is real**: if a city's unhappy citizens outnumber its happy ones it
produces **no shields, no beakers and no gold** that turn and accumulates no growth
food — it touches production, the money loop and growth, each asking the one verdict.

### 4.9 Combat

| magnitude | value |
|---|---|
| fortify bonus | +25% |
| city defence bonus | +50% |
| walls bonus | +50% |
| veteran attack bonus | +25% |
| maximum experience | 3 |
| roll bound | 100 |
| damage per round | 1 |
| minimum win chance | 1% |
| maximum win chance | 99% |
| capture population divisor | 2 |

Modifiers are summed as percentages and floored **once**; the defender wins ties and
that rule is named in the code rather than left implicit. A captured city loses
population (`max(1, floor(population / divisor))`), loses every non-wonder building
in maintenance-descending order, and keeps its wonders. Barbarians are engine
behaviour — a numbered step of the pipeline that walks toward the nearest
civilization city and attacks when adjacent, using the same combat path.

Civ 3's combat (firepower, per-unit hit points, terrain and veteran rules) is a
different model; this engine does not reproduce it.

### 4.10 Culture and borders

Cities accumulate culture (a temple finished this turn counts this turn). The
player's total is **derived** by summing their cities, never stored. A city's claimed
radius grows with its own culture:

| city culture ≥ | claimed radius |
|---|---|
| 0 | 1 |
| 10 | 2 |
| 100 | 3 |

A tile inside two cities' ranges belongs to the higher culture; ties go to the
**lower city id**, never to iteration order. A city may not be founded on another
player's tile and a foreign tile may not be worked. Units **may** cross foreign
territory — there is no war-declaration system at alpha, and the rule site says so.
Ownership is recomputed from culture every turn rather than accumulated.

### 4.11 Growth, and the food box

A city's food box needs `5 × population + 5` food to grow: population 1 → 10, 2 → 15,
3 → 20, … 8 → 45. Surplus carries over (observably — it is not reset). A deficit
draws the box down; if it would go below zero the city loses a citizen (never below
1) and the box restarts at 0. A `growth-food` building reduces the target, floored at
a minimum of 1 so a city can always eventually grow.

The city radius is the classic 21 tiles (`max(|dx|,|dy|) ≤ 2` minus the four
corners). The centre is always worked and free; each citizen works one tile inside
the radius; no two cities may work the same tile. Minimum city distance is 2.

### 4.12 Vision and exploration

Visibility radius is **2** tiles, derived on demand from unit and city positions and
never stored; only the "explored" layer persists, and a unit moving extends it.
Entering a goody hut consumes it and draws a reward from the state RNG (a free unit,
a barbarian band nearby, or nothing).

---

## 5. Victory and score

Four conditions, catalog-driven, evaluated at **one point** in the turn loop. The
first that holds decides the game; `GameOutcome` is a **derived** read
(`{kind, condition, winner, turn}`), never a stored flag that can disagree with the
board. A finished game refuses further commands with a typed error.

| condition | rule | threshold (placeholder) |
|---|---|---|
| conquest | you are the last civilization holding a city | — |
| domination | you own enough of the claimed land **or** of the world population | 60% land, 40% population |
| cultural | your total culture reaches the threshold | 1,500 culture |
| score | at the catalog's own horizon, the highest score wins | turn 200 |

Bare civs never win, never score and never count toward another player's conquest.
The score horizon (`scoreVictoryTurn = 200`) is **content**, deliberately separate
from a simulation's `maxTurns`: a run that stops before the horizon reports
"max-turns" with no winner rather than crowning one, because the experiment ended
before the game did.

Score is one integer from five catalog weights, read by the engine and the UI from
the same function:

| term | weight |
|---|---|
| per citizen | 2 |
| per city | 3 |
| per technology | 4 |
| per culture point | 1 |
| per wonder | 8 |

**Space race is not implemented.** It is named as deferred here and in the catalog
rather than silently absent: there is no `VictoryConditionId` for it and no row.

---

## 6. Deferred, deliberately

Alpha is the whole core loop, playable and machine-checked; the following are
explicitly **not** alpha-blocking (`PLAN.md` §16.3) and none of them is
half-implemented:

balance tuning beyond playability; corruption; city culture-**flips** (culture
changing a city's owner — borders and per-city culture exist, flips do not); full
diplomacy (alliances, treaties, trade) beyond war and peace; espionage; isometric
renderer and sprites; audio; animation polish; mod packs; difficulty handicaps;
auto-explore / auto-improve; multiplayer. Plus, from the engine's own contracts:
space race and the anarchy transition of a government change.

`docs/KNOWN-ISSUES.md` carries the same list with the honest limits recorded during
the work.

---

## 7. How to reproduce every number in this document

```bash
# §1 — the provenance table and its counts
pnpm rules:provenance

# §2 — the starting position (players, treasury, rates, government, starting units)
npx tsx -e 'import {DEFAULT_SETTINGS,newGame} from "@civts/core";
import {CATALOG,validateRuleset} from "@civts/rules";
const r=validateRuleset(CATALOG); if(!r.ok) process.exit(1);
const g=newGame(42,DEFAULT_SETTINGS,r.value); if(!g.ok) process.exit(1);
console.log(g.value.players.map(p=>[p.id,p.name,p.kind,p.treasury,JSON.stringify(p.rates),p.government].join(" ")).join("\n"));
console.log("units", g.value.units.map(u=>u.type).join(","));
console.log("huts", g.value.map.huts.length, "resources", g.value.map.resources.length, "improvements", g.value.improvements.length);
console.log("schemaVersion", g.value.schemaVersion);'

# §4 — every catalog table (terrain, units, buildings, improvements, resources,
#       governments) in one pass
npx tsx -e 'import {CATALOG as C} from "@civts/rules";
const y=(v)=>`${v.food}/${v.shields}/${v.commerce}`;
for(const t of C.terrains) console.log("TF",t.id,t.moveCost,t.defenseBonusPct,y(t.yields),t.impassable);
for(const u of C.units) console.log("UN",u.id,u.attack,u.defense,u.movement,u.cost,u.domain,u.requiresTech??"-",u.requiresResource??"-");
for(const b of C.buildings) console.log("BL",b.id,b.cost,b.maintenance,b.wonder===true,b.culturePerTurn,b.happiness??0,JSON.stringify(b.effects));
for(const i of C.improvements) console.log("IM",i.id,i.turns,y(i.yields),i.allowedRoles.join(","));
for(const r of C.resources) console.log("RE",r.id,r.kind,y(r.yields),r.allowedRoles.join(","));
for(const g of C.governments) console.log("GV",g.id,JSON.stringify(g.rateCaps),g.freeUnitsPerCity,g.unitSupportCost,g.happiness??0);
for(const t of C.techs) console.log("TE",t.id,t.era,t.cost,t.requires.join("+")||"-");
console.log("VICTORY",JSON.stringify(C.victory)); console.log("SCORE",JSON.stringify(C.score));
console.log("COMBAT",JSON.stringify(C.combat));   console.log("CAPTURE",JSON.stringify(C.capture));
console.log("CULTURE",JSON.stringify(C.culture));'

# §4.2 and §4.11 — map sizes, the rate total, vision, the food box
npx tsx -e 'import {MAP_SIZES,MAP_DIMENSIONS,RATE_TOTAL,VISIBILITY_RADIUS,MIN_CITY_DISTANCE,foodBoxSize} from "@civts/core";
for(const s of MAP_SIZES) console.log(s, MAP_DIMENSIONS[s].width+"x"+MAP_DIMENSIONS[s].height, MAP_DIMENSIONS[s].maxCivs);
console.log("RATE_TOTAL",RATE_TOTAL,"VISION",VISIBILITY_RADIUS,"MIN_CITY_DISTANCE",MIN_CITY_DISTANCE);
console.log([1,2,3,4,5,6,7,8].map(p=>p+"->"+foodBoxSize(p)).join(" "));'

# §3 — the pipeline order, as the code states it
sed -n '1,40p' packages/core/src/turn.ts
```

The per-system behaviour (exact costs, exact growth turns, exact thresholds) is
asserted by the suites in `packages/core/test`, `packages/testing/test` and
`packages/sim/test`, and `docs/BALANCE.md` records what the balance harness measured
when those numbers were moved.
