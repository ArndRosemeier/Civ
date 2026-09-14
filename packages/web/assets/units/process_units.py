"""Chroma-key unit backgrounds (sampled from corners) and resize to 128px."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SIZE = 128

UNIT_IDS = (
    "settler",
    "worker",
    "scout",
    "warrior",
    "galley",
    "archer",
    "spearman",
    "horseman",
    "swordsman",
    "transport",
)


def dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b, strict=True)))


def process(name: str) -> None:
    path = ROOT / f"unit-{name}.png"
    source = Image.open(path).convert("RGBA")
    width, height = source.size
    samples = [
        source.getpixel((2, 2))[:3],
        source.getpixel((width - 3, 2))[:3],
        source.getpixel((2, height - 3))[:3],
        source.getpixel((width - 3, height - 3))[:3],
        source.getpixel((width // 2, 2))[:3],
        source.getpixel((2, height // 2))[:3],
    ]
    key = tuple(sum(c[i] for c in samples) // len(samples) for i in range(3))
    pixels = source.load()
    assert pixels is not None
    for y in range(height):
        for x in range(width):
            r, g, b, _a = pixels[x, y]
            if dist((r, g, b), key) <= 45 or (
                dist((r, g, b), key) <= 70 and r > 140 and b > 80 and g < 100
            ):
                pixels[x, y] = (0, 0, 0, 0)
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if dist((r, g, b), key) <= 90 and r > 120 and g < 120 and b > 60:
                edge = False
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < width and 0 <= ny < height and pixels[nx, ny][3] == 0:
                            edge = True
                if edge or dist((r, g, b), key) <= 55:
                    pixels[x, y] = (0, 0, 0, 0)
    bbox = source.getbbox()
    if bbox is None:
        raise RuntimeError(f"{name}: empty after chroma key")
    source = source.crop(bbox)
    w, h = source.size
    side = max(w, h)
    pad = max(2, side // 25)
    side = side + pad * 2
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(source, ((side - w) // 2, (side - h) // 2), source)
    final = square.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    final.save(path, optimize=True)
    opaque = sum(1 for px in final.getdata() if px[3] > 32)
    print(f"{name}: key={key} opaque={opaque} bytes={path.stat().st_size}")


def main() -> None:
    for name in UNIT_IDS:
        process(name)


if __name__ == "__main__":
    main()
