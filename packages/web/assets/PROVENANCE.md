# Art provenance — the 16 sprites, where they came from, and what is still open

This file exists because every other piece of content in this repository carries its
origin, and the artwork did not. Rules rows declare `cited` or `placeholder` and
`pnpm rules:provenance` counts them; the sixteen PNGs had no equivalent record at all,
so "where did these come from?" had no answer inside the repository.

## Origin

**All sixteen assets were freshly generated with Grok 4.6 image generation (xAI) for
this project.** They are not cropped, traced, collaged or otherwise derived from any
existing artwork, and they are not licensed stock. They were produced for CivTS and
have not appeared anywhere else.

Stated by the project owner, not inferred: the PNGs carry no metadata — no text
chunks, no generator stamp — so the repository cannot corroborate this on its own.
Read the line above as a declaration by the person who made them, which is what every
provenance statement in this project is:

```
$ python3 -c "from PIL import Image; print(Image.open('packages/web/assets/tiles/tile-grassland.png').info)"
{}
```

That empty dictionary is the reason this file is prose rather than a field the
tooling can check.

## What is in the set, and why each one exists

The set is complete against the shipped catalog — checked against the engine, not
against the filenames:

| | Engine | Assets | |
|---|---|---|---|
| Terrains | 6 | 6 | `grassland`, `plains`, `hills`, `mountains`, `ocean`, `coast` |
| Units | 10 | 10 | `settler`, `worker`, `scout`, `warrior`, `galley`, `archer`, `spearman`, `horseman`, `swordsman`, `transport` |

Neither list has an orphan on either side: every catalog row has a sprite and every
sprite has a catalog row. `packages/web/src/tiles.ts` and `packages/web/src/units.ts`
name them in one place each.

- **Tiles** are 256×256 RGB, in `assets/tiles/`.
- **Units** are 128×128 RGBA with real transparency — measured, not assumed: the
  corner pixel is `(0, 0, 0, 0)` and between 53 % and 78 % of each sprite's pixels are
  transparent, so nothing renders as an opaque box on the map.

## How they were processed

The two scripts in the asset folders are the *transformation*, and they are committed
so the step is reproducible rather than a thing that happened once on somebody's
laptop. Neither script generates anything; neither is needed to build or run the game.

- `assets/tiles/process_tiles.py` — resizes to 256 px with LANCZOS, unsharp-masks,
  nudges contrast 5 %, pulls the midtone 8 % toward a documented palette colour, then
  writes that palette colour into the centre pixel (`lock_centre`).
- `assets/units/process_units.py` — chroma-keys the background away by sampling the
  corners, then resizes to 128 px.

**`lock_centre` does not set the colour contract**, and this is worth knowing before anyone
trusts it: it locks the centre pixel of the *source* file, but the tests that check the
contract sample the *painted canvas* after the texture has been scaled into the tile rect,
where that single pixel is blended away. The two were reconciled by measuring the art:
`TERRAIN_COLOURS` in `src/render.ts` is now the **mean of what each terrain paints**, derived
by `e2e/terrain-palette-probe.spec.ts`, and the `PALETTE` dict in `process_tiles.py` is only
the grading target the script pulls toward while processing. The two are deliberately not the
same list, and the one that is the contract is the one in `render.ts`. See
`docs/KNOWN-ISSUES.md` §3.12 for the measurements.

The comment in `process_tiles.py` says the same thing at the point of use, so nobody re-grades
a tile expecting the script's palette to be the contract.

## What is still open

**The repository has no `LICENSE` file.** That is a decision about the project as a
whole and not something this pass can settle: it is the project owner's choice what
terms the code and these images are offered under. The origin above is recorded so
that the choice can be made with the facts in hand.

Nothing else about the art is unresolved: the set is complete, the names match the
catalog exactly, the transparency is real, the palette the renderer documents is now the
colour the art actually paints (measured, not asserted — §3.12 of `docs/KNOWN-ISSUES.md`),
and a missing or unreadable file fails loudly on the page rather than leaving a blank canvas
(see `reportStartFailure` in `packages/web/src/main.ts`).
