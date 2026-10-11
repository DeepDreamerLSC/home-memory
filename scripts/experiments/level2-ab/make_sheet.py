# -*- coding: utf-8 -*-
"""为评审拼对比图:每物品一行 5 格(源/A入/B入/A出/B出),等高 560,格间白线+顶部标签。"""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = "/tmp/level2-ab"
OUT = os.path.join(BASE, "review")
H = 560
LABEL_H = 46
FONT = None
for p in ("/System/Library/Fonts/PingFang.ttc",
          "/System/Library/Fonts/Hiragino Sans GB.ttc",
          "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"):
    if os.path.exists(p):
        FONT = ImageFont.truetype(p, 30)
        break

names = ["手机", "游戏手柄", "猕猴桃", "美工刀", "麦克风", "鼠标"]
cols = [("源图(原始)", f"{BASE}/src/{{n}}.jpg"),
        ("A 输入(裁剪)", f"{BASE}/A-{{n}}.png"),
        ("B 输入(抠图)", f"{BASE}/B-{{n}}.png"),
        ("A 产物(卡通)", f"{BASE}/out/A-{{n}}.cartoon.png"),
        ("B 产物(卡通)", f"{BASE}/out/B-{{n}}.cartoon.png")]

for n in names:
    tiles = []
    for label, path_tmpl in cols:
        im = Image.open(path_tmpl.format(n=n)).convert("RGB")
        w = round(im.width * H / im.height)
        tiles.append((label, im.resize((w, H), Image.LANCZOS)))
    gap = 6
    total_w = sum(t.width for _, t in tiles) + gap * (len(tiles) - 1)
    sheet = Image.new("RGB", (total_w, H + LABEL_H), (240, 240, 240))
    d = ImageDraw.Draw(sheet)
    x = 0
    for label, t in tiles:
        sheet.paste(t, (x, LABEL_H))
        d.text((x + 8, 6), label, fill=(20, 20, 20), font=FONT)
        x += t.width + gap
    dst = os.path.join(OUT, f"sheet-{n}.png")
    sheet.save(dst, "PNG")
    print(dst, sheet.size)
