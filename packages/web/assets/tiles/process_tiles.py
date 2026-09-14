"""Gently resize terrain tiles — keep painterly detail, lock centre sample colour."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent
SIZE = 256

# NOT the render contract. This dict is the middletone this script grades each tile toward
# while processing. The colour the app *documents* for a terrain is `TERRAIN_COLOURS` in
# `packages/web/src/render.ts`, and it is the MEAN of what the terrain paints on the canvas,
# measured by `packages/web/e2e/terrain-palette-probe.spec.ts` — a different list, on purpose,
# because a painted tile centre is a blend rather than a single pixel. Changing a value here
# does not change what the tests expect; it changes the art, which then changes the expectation
# only once the probe is re-run. See `docs/KNOWN-ISSUES.md` 3.12.
PALETTE: dict[str, tuple[int, int, int]] = {
    "grassland": (0x4A, 0x9D, 0x4A),
    "plains": (0xB8, 0xA2, 0x4A),
    "hills": (0x8A, 0x7A, 0x52),
    "mountains": (0x8C, 0x8C, 0x94),
    "ocean": (0x1D, 0x4F, 0x8A),
    "coast": (0x3A, 0xA0, 0xC8),
}


def colour_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b, strict=True)))


def soft_grade(im: Image.Image, target: tuple[int, int, int], strength: float) -> Image.Image:
    """Mild pull toward the documented midtone without crushing detail."""
    out = Image.new("RGB", im.size)
    src = im.load()
    dst = out.load()
    assert src is not None and dst is not None
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = src[x, y]
            dst[x, y] = (
                int(r * (1 - strength) + target[0] * strength),
                int(g * (1 - strength) + target[1] * strength),
                int(b * (1 - strength) + target[2] * strength),
            )
    return out


def lock_centre(im: Image.Image, target: tuple[int, int, int]) -> Image.Image:
    """Exact centre pixel for e2e; tiny soft rim so smoothing still samples near the palette."""
    result = im.copy()
    px = result.load()
    assert px is not None
    cx = im.width // 2
    cy = im.height // 2
    for y in range(cy - 2, cy + 3):
        for x in range(cx - 2, cx + 3):
            d = math.hypot(x - cx, y - cy)
            if d > 2.2:
                continue
            t = 1.0 if d < 0.5 else 0.55
            r, g, b = px[x, y]
            px[x, y] = (
                int(r * (1 - t) + target[0] * t),
                int(g * (1 - t) + target[1] * t),
                int(b * (1 - t) + target[2] * t),
            )
    px[cx, cy] = target
    return result


def process(name: str, target: tuple[int, int, int]) -> None:
    path = ROOT / f"tile-{name}.png"
    source = Image.open(path).convert("RGB")
    resized = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    resized = resized.filter(ImageFilter.UnsharpMask(radius=0.8, percent=80, threshold=3))
    resized = ImageEnhance.Contrast(resized).enhance(1.05)
    resized = soft_grade(resized, target, 0.08)
    final = lock_centre(resized, target)
    final.save(path, optimize=True)
    centre = final.getpixel((SIZE // 2, SIZE // 2))
    assert isinstance(centre, tuple)
    print(
        f"{name}: centre={centre} target={target} "
        f"dist={colour_distance(centre[:3], target):.1f} bytes={path.stat().st_size}"
    )


def main() -> None:
    for name, target in PALETTE.items():
        process(name, target)


if __name__ == "__main__":
    main()
