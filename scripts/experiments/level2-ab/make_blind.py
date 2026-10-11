# -*- coding: utf-8 -*-
"""盲评集:12 张产物随机重命名为 01-12.png 复制到 /tmp/level2-ab/blind/;
映射表写 /tmp/level2-ab/blind-key.md(评完再看)。固定 seed 可复现。"""
import glob, os, random, shutil

BASE = "/tmp/level2-ab"
BLIND = os.path.join(BASE, "blind")
KEY = os.path.join(BASE, "blind-key.md")
SRC = sorted(glob.glob(os.path.join(BASE, "out", "*.cartoon.png")))
assert len(SRC) == 12, SRC

os.makedirs(BLIND, exist_ok=True)
files = [os.path.basename(p) for p in SRC]
rng = random.Random(20261011)
rng.shuffle(files)

lines = ["# Level2 A/B 盲评映射表(评完再看)", "",
         "| 盲评编号 | 变体 | 物品 | 原文件 |", "| --- | --- | --- | --- |"]
for i, name in enumerate(files, 1):
    variant, item = name.split("-", 1)[0], name.split("-", 1)[1].split(".")[0]
    dst = os.path.join(BLIND, f"{i:02d}.png")
    shutil.copy2(os.path.join(BASE, "out", name), dst)
    lines.append(f"| {i:02d} | {variant} | {item} | out/{name} |")
with open(KEY, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

print("blind files:")
for p in sorted(glob.glob(os.path.join(BLIND, "*.png"))):
    print(" ", p, os.path.getsize(p))
