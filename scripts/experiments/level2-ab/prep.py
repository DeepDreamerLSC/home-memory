# -*- coding: utf-8 -*-
"""Level2 A/B 对照输入预处理(仓库零写入,全部产物落 /tmp/level2-ab/)。

对每张源图:
1. rembg isnet-general-use 推理得 RGBA(alpha 蒙版与原图同尺寸)。
2. 蒙版前景阈值 alpha>128(沿用 /tmp/level1-probe/analyze_masks.py:17 的先例)
   取包围盒,每边向外扩该维度 bbox 尺寸的 10%,clamp 到图像边界 —— 作为统一裁剪框。
3. A 套:同框裁剪 RGB → 等比缩放(LANCZOS)至 1024 内 → 白底 1024 方图居中 → PNG。
4. B 套:同一框裁剪 RGBA(含 isnet alpha)→ 同一等比缩放 → 以 alpha 为蒙版贴到
   1024 白底 RGB → PNG。
   A/B 的唯一差异 = 是否抠背景(裁剪框、缩放、白底规格完全相同)。
坐标全部记录到 crop-boxes.json。
"""
import os, sys, json, glob, time

os.environ["U2NET_HOME"] = os.path.expanduser("~/.rembg/models")

import numpy as np
from PIL import Image
from rembg import new_session, remove

SRC = "/tmp/level2-ab/src"
OUT = "/tmp/level2-ab"
MASK_DIR = os.path.join(OUT, "masks")
os.makedirs(MASK_DIR, exist_ok=True)

SIDE = 1024
EXPAND = 0.10  # bbox 每边外扩该维度尺寸的 10%


def fit_square(img, side=SIDE):
    """等比缩放至 side 内,返回(缩放图, 在 side 方图上的粘贴位置)。"""
    w, h = img.size
    scale = min(side / w, side / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = img.resize((nw, nh), Image.LANCZOS)
    pos = ((side - nw) // 2, (side - nh) // 2)
    return resized, pos


records = {}
files = sorted(glob.glob(os.path.join(SRC, "*.jpg")))
if len(files) != 6:
    print("UNEXPECTED file count:", len(files), file=sys.stderr)
    sys.exit(1)

session = new_session("isnet-general-use")

for f in files:
    name = os.path.splitext(os.path.basename(f))[0]
    t0 = time.perf_counter()
    im = Image.open(f)
    im.load()
    W, H = im.size

    # isnet 推理:输出与原图同尺寸 RGBA
    cut = remove(im.convert("RGB"), session=session)  # RGBA
    a = np.array(cut)[:, :, 3]
    fg = a > 128
    ys, xs = np.nonzero(fg)
    if len(xs) == 0:
        records[name] = {"error": "empty mask"}
        continue
    minx, maxx = int(xs.min()), int(xs.max())
    miny, maxy = int(ys.min()), int(ys.max())
    bw, bh = maxx - minx + 1, maxy - miny + 1
    # 每边外扩 10%(x 方向扩 0.1*bw,y 方向扩 0.1*bh),clamp 到图内
    x0 = max(0, int(minx - EXPAND * bw))
    x1 = min(W - 1, int(maxx + EXPAND * bw))
    y0 = max(0, int(miny - EXPAND * bh))
    y1 = min(H - 1, int(maxy + EXPAND * bh))
    box = (x0, y0, x1, y1)  # PIL crop: 左上右下(含 x1/y1)

    # --- A 套:裁剪 + 缩放 + 白底方图 ---
    crop_a = im.convert("RGB").crop(box)
    ra, pos = fit_square(crop_a)
    canvas_a = Image.new("RGB", (SIDE, SIDE), (255, 255, 255))
    canvas_a.paste(ra, pos)
    canvas_a.save(os.path.join(OUT, f"A-{name}.png"), "PNG")

    # --- B 套:同框裁剪(含 alpha)→ 缩放 → alpha 蒙版贴白底 ---
    crop_b = cut.crop(box)  # RGBA
    rb, pos_b = fit_square(crop_b)
    canvas_b = Image.new("RGB", (SIDE, SIDE), (255, 255, 255))
    canvas_b.paste(rb, pos_b, mask=rb)  # 以 alpha 为蒙版
    canvas_b.save(os.path.join(OUT, f"B-{name}.png"), "PNG")

    # 蒙版存档(审查用)
    Image.fromarray(a).save(os.path.join(MASK_DIR, f"{name}.png"))

    records[name] = {
        "src_size": [W, H],
        "mask_bbox_alpha_gt_128": [minx, miny, maxx, maxy],
        "bbox_w_h": [bw, bh],
        "crop_box_expanded_10pct_clamped": [x0, y0, x1, y1],
        "fg_ratio": round(float(fg.mean()), 4),
        "crop_size": [x1 - x0 + 1, y1 - y0 + 1],
        "sec": round(time.perf_counter() - t0, 1),
    }
    print(f"done {name}: bbox={records[name]['mask_bbox_alpha_gt_128']} "
          f"box={records[name]['crop_box_expanded_10pct_clamped']} "
          f"fg={records[name]['fg_ratio']}", flush=True)

with open(os.path.join(OUT, "crop-boxes.json"), "w", encoding="utf-8") as fp:
    json.dump(records, fp, ensure_ascii=False, indent=1)
print("ALL_DONE")
