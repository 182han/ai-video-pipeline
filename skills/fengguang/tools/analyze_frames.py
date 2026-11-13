#!/usr/bin/env python3
"""统计视频快照（sprite）里每一帧的指标。

用法:
    python analyze_frames.py <sprite目录> [--prefix BV1xxxxxxxxx] [--json out.json]

文件名约定: <前缀>_pNN.jpg，每页是 10x10 帧网格（B 站 videoshot 约定）。
会自动跳过纯黑占位格（lum < 12）。

依赖: Pillow, numpy
"""
import sys, os, glob, json
import argparse
import numpy as np
from PIL import Image

GRID = 10
BLACK_SKIP = 12.0


def metrics(a):
    af = a.astype(np.float32)
    lum = 0.2126 * af[:, :, 0] + 0.7152 * af[:, :, 1] + 0.0722 * af[:, :, 2]
    r, g, b = af[:, :, 0], af[:, :, 1], af[:, :, 2]
    return dict(
        lum=float(lum.mean()),
        dark=float((lum < 40).mean()),
        hl=float((lum > 200).mean()),
        sat=float(((af.max(2) - af.min(2)) / (af.max(2) + 1e-6)).mean()),
        warm=float(((r > b + 15) & (r > g + 10)).mean()),
        cool=float((b > r + 15).mean()),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--prefix", default="", help="只统计指定前缀的 sprite")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    pages = sorted(glob.glob(os.path.join(args.dir, f"{args.prefix}*_p*.jpg")))
    if not pages:
        pages = sorted(glob.glob(os.path.join(args.dir, "*.jpg")))
    if not pages:
        print("no sprite pages found")
        sys.exit(1)

    rows = []
    for p in pages:
        im = Image.open(p).convert("RGB")
        w, h = im.size
        tw, th = w // GRID, h // GRID
        for gy in range(GRID):
            for gx in range(GRID):
                tile = np.asarray(im.crop((gx * tw, gy * th, (gx + 1) * tw, (gy + 1) * th)))
                m = metrics(tile)
                if m["lum"] < BLACK_SKIP:
                    continue
                rows.append(m)

    n = len(rows)
    print(f"pages: {len(pages)}  frames: {n}")
    if not n:
        return

    for k in ("lum", "dark", "hl", "sat", "warm", "cool"):
        v = np.array([r[k] for r in rows])
        print(f"{k:5s} mean={v.mean():<8.3f} median={np.median(v):.3f}")

    wd = sum(1 for r in rows if r["warm"] > r["cool"])
    print(f"warm-dominant: {wd}/{n} ({wd / n * 100:.1f}%)")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False)
        print("saved", args.json)


if __name__ == "__main__":
    main()
