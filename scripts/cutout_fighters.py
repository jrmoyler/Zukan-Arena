#!/usr/bin/env python3
"""Offline art pipeline for Zukan Arena fighter cutouts.

Segments every portrait in art/portraits with the IS-Net
general-use salient-object model (via rembg), removes stray text and
ornaments, trims, and writes:

  public/characters/cutout/zukan-XXX.webp   transparent, trimmed sprite
  src/game/data/cutouts.json                layout metadata (size, foot anchor, palette)

Usage:
  pip install "rembg[cpu]"
  python3 scripts/cutout_fighters.py            # all 68 fighters
  python3 scripts/cutout_fighters.py 7 53       # selected indices

The output is committed so the game never segments at runtime.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "art/portraits"
OUTPUT = ROOT / "public/characters/cutout"
META = ROOT / "src/game/data/cutouts.json"
TARGET_HEIGHT = 640

# Pre-crop boxes (fractions: left, top, right, bottom) for portraits whose frame
# contains more than one subject or large typographic panels.
PRE_CROP: dict[int, tuple[float, float, float, float]] = {
    7: (0.0, 0.0, 0.47, 0.70),     # Prism Chorus: a six-member swarm from the roster sheet
    50: (0.0, 0.30, 0.70, 1.0),    # Luminor: ignore lore cards on the right
    53: (0.0, 0.18, 1.0, 0.62),    # Viridian Skyrake: skip card header and stat panel
}


# Fighters whose identity is a group of creatures; every sizeable subject is kept.
SWARMS = {7}


def keep_main_subject(alpha: np.ndarray, swarm: bool = False) -> np.ndarray:
    solid = alpha > 0.35
    labels, count = ndimage.label(solid)
    if count <= 1:
        return alpha
    sizes = ndimage.sum(solid, labels, range(1, count + 1))
    largest = int(np.argmax(sizes)) + 1
    main = labels == largest
    # Keep sizeable satellites that sit near the main body (floating crystals, orbs).
    grown = ndimage.binary_dilation(main, iterations=max(6, int(alpha.shape[0] * 0.04)))
    keep = main.copy()
    for index, size in enumerate(sizes, start=1):
        if index == largest:
            continue
        component = labels == index
        if swarm and size >= sizes[largest - 1] * 0.25:
            keep |= component
        elif size >= sizes[largest - 1] * 0.01 and (component & grown).any():
            keep |= component
    keep = ndimage.binary_dilation(keep, iterations=2)
    return np.where(keep, alpha, 0.0)


def palette_of(rgb: np.ndarray, alpha: np.ndarray) -> list[str]:
    mask = alpha > 0.8
    pixels = rgb[mask].astype(np.int32)
    if len(pixels) == 0:
        return ["#888888"]
    sat = pixels.max(axis=1) - pixels.min(axis=1)
    lum = pixels @ np.array([299, 587, 114]) // 1000
    vivid = pixels[(sat > 28) & (lum > 40) & (lum < 236)]
    if len(vivid) < 50:
        vivid = pixels
    keys = (vivid >> 5)
    flat = keys[:, 0] * 64 + keys[:, 1] * 8 + keys[:, 2]
    counts = np.bincount(flat, minlength=512)
    out = []
    for key in np.argsort(counts)[::-1][:3]:
        if counts[key] == 0:
            break
        r, g, b = (key // 64) * 32 + 16, ((key // 8) % 8) * 32 + 16, (key % 8) * 32 + 16
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def process(index: int, session) -> dict:
    fighter_id = f"zukan-{index:03d}"
    image = Image.open(SOURCE / f"{fighter_id}.webp").convert("RGB")
    if index in PRE_CROP:
        l, t, r, b = PRE_CROP[index]
        w, h = image.size
        image = image.crop((int(l * w), int(t * h), int(r * w), int(b * h)))
    # Upscale tiny sources before segmentation so the matte keeps fine edges.
    if image.height < 600:
        factor = 600 / image.height
        image = image.resize((round(image.width * factor), 600), Image.LANCZOS)

    cut = remove(image, session=session, post_process_mask=False)
    rgba = np.asarray(cut).astype(np.float32) / 255.0
    alpha = keep_main_subject(rgba[..., 3], index in SWARMS)
    rgb = np.asarray(image).astype(np.float32)

    ys, xs = np.nonzero(alpha > 0.5)
    top, bottom = ys.min(), ys.max()
    left, right = xs.min(), xs.max()
    pad = int(max(bottom - top, right - left) * 0.025)
    top, left = max(0, top - pad), max(0, left - pad)
    bottom, right = min(alpha.shape[0] - 1, bottom + pad), min(alpha.shape[1] - 1, right + pad)

    band = max(2, int((ys.max() - ys.min()) * 0.06))
    foot_rows = alpha[ys.max() - band: ys.max() + 1] > 0.5
    foot_cols = np.nonzero(foot_rows.any(axis=0))[0]
    foot_x = foot_cols.mean() if len(foot_cols) else (left + right) / 2

    out = np.dstack([rgb, alpha * 255.0]).clip(0, 255).astype(np.uint8)
    crop = Image.fromarray(out, "RGBA").crop((left, top, right + 1, bottom + 1))
    crop_h = crop.height
    scale = TARGET_HEIGHT / crop_h
    crop = crop.resize((max(1, round(crop.width * scale)), TARGET_HEIGHT), Image.LANCZOS)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    crop.save(OUTPUT / f"{fighter_id}.webp", "WEBP", quality=88, method=6, alpha_quality=95)

    meta = {
        "w": crop.width,
        "h": crop.height,
        "footX": round(float((foot_x - left) / (right - left + 1)), 4),
        "footY": round(float((ys.max() - top) / (bottom - top + 1)), 4),
        "palette": palette_of(rgb, alpha),
    }
    print(f"{fighter_id} {crop.width}x{crop.height} foot=({meta['footX']},{meta['footY']}) {meta['palette']}")
    return meta


def main() -> None:
    indices = [int(arg) for arg in sys.argv[1:]] or list(range(1, 69))
    session = new_session("isnet-general-use")
    meta = json.loads(META.read_text()) if META.exists() else {}
    for index in indices:
        meta[f"zukan-{index:03d}"] = process(index, session)
    META.write_text(json.dumps(dict(sorted(meta.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
