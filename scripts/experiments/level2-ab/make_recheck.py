# -*- coding: utf-8 -*-
"""复核拼图:左=B输入(美工刀,抠图后),右=B输入(麦克风,抠图后),放大看部件与边缘。"""
from PIL import Image, ImageDraw, ImageFont
import os
BASE = "/tmp/level2-ab"; OUT = os.path.join(BASE, "review")
H = 700; LABEL_H = 46
FONT = ImageFont.truetype("/System/Library/Fonts/PingFang.ttc", 30) \
    if os.path.exists("/System/Library/Fonts/PingFang.ttc") else None
items = [("美工刀 B 输入(AI 抠图后,检查推钮/分段结构)", f"{BASE}/B-美工刀.png"),
         ("麦克风 B 输入(AI 抠图后,检查头部边缘残留)", f"{BASE}/B-麦克风.png")]
tiles = []
for label, p in items:
    im = Image.open(p).convert("RGB")
    w = round(im.width * H / im.height)
    tiles.append((label, im.resize((w, H), Image.LANCZOS)))
gap = 6
tw = sum(t.width for _, t in tiles) + gap
sheet = Image.new("RGB", (tw, H + LABEL_H), (240, 240, 240))
d = ImageDraw.Draw(sheet)
x = 0
for label, t in tiles:
    sheet.paste(t, (x, LABEL_H))
    d.text((x + 8, 6), label, fill=(20, 20, 20), font=FONT)
    x += t.width + gap
sheet.save(f"{OUT}/recheck-Binputs.png", "PNG")
print("ok", sheet.size)
