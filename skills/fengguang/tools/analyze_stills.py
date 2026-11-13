#!/usr/bin/env python3
"""统计静帧的画面带指标。

用法:
    python analyze_stills.py <图片目录> [输出json路径]

画面带定位: 行内方差 > 14 的最长连续段（排除手机黑边与 UI）。
输出: 每张图的 lum / dark / hl / sat / warm / cool 与汇总。
依赖: Pillow, numpy
"""
import sys, os, glob, json
import numpy as np
from PIL import Image

ROW_STD_THRESHOLD = 14.0
MIN_BAND_PX = 30


def metrics(arr):
    a = arr.astype(np.float32)
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    return dict(
        lum=float(lum.mean()),
        dark_ratio=float((lum < 40).mean()),
        highlight_ratio=float((lum > 200).mean()),
        sat=float(((a.max(2) - a.min(2)) / (a.max(2) + 1e-6)).mean()),
        warm=float(((r > b + 15) & (r > g + 10)).mean()),
        cool=float((b > r + 15).mean()),
    )


def find_band(arr):
    row_std = arr.std(axis=(1, 2))
    idx = np.where(row_std > ROW_STD_THRESHOLD)[0]
    if len(idx) < MIN_BAND_PX:
        return None
    breaks = np.where(np.diff(idx) > 3)[0]
    segs = np.split(idx, breaks + 1)
    seg = max(segs, key=len)
    if len(seg) < MIN_BAND_PX:
        return None
    return int(seg[0]), int(seg[-1])


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    src = sys.argv[1]
    out_json = sys.argv[2] if len(sys.argv) > 2 else None

    files = sorted(p for p in glob.glob(os.path.join(src, "*"))
                   if os.path.splitext(p)[1].lower() in (".jpg", ".jpeg", ".png", ".webp"))
    rows, skipped = [], []

    for f in files:
        try:
            im = Image.open(f).convert("RGB")
        except Exception as e:
            skipped.append((os.path.basename(f), str(e)))
            continue
        a = np.asarray(im).astype(np.float32)
        band = find_band(a)
        if not band:
            skipped.append((os.path.basename(f), "no band"))
            continue
        y0, y1 = band
        crop = a[y0 + 1:y1, :, :]
        m = metrics(crop)
        m["name"] = os.path.basename(f)
        m["ar"] = round(crop.shape[1] / crop.shape[0], 2)
        rows.append(m)

    n = len(rows)
    print(f"analyzed: {n}  skipped: {len(skipped)}")
    for s in skipped[:8]:
        print("  skip", s)

    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
        print("saved", out_json)

    if not n:
        return

    ars = {}
    for r in rows:
        ars[r["ar"]] = ars.get(r["ar"], 0) + 1
    print("\naspect ratio:", sorted(ars.items(), key=lambda x: -x[1])[:5])

    for k in ("lum", "dark_ratio", "highlight_ratio", "sat", "warm", "cool"):
        v = np.array([r[k] for r in rows])
        print(f"{k:16s} mean={v.mean():.3f}  median={np.median(v):.3f}")

    wd = sum(1 for r in rows if r["warm"] > r["cool"])
    print(f"warm-dominant: {wd}/{n} ({wd / n * 100:.1f}%)")


if __name__ == "__main__":
    main()
