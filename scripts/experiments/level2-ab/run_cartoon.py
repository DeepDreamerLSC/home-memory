#!/usr/bin/env python3
"""Level 2 A/B 卡通化实验:对 /tmp/level2-ab/{A,B}-<名>.png 共 12 张跑 Qwen-Image-Edit。

架构裁定(issue #3 Generation Runtime Contract 之下的子实验):
  A 组输入 = 原图适当裁剪(未抠图)
  B 组输入 = 同一裁剪 → AI 抠图
两组使用完全相同的 prompt / seed / 管线参数,仅输入图不同。

复用 spike v0(chore/experiment-frameworks:scripts/experiments/cartoon-spike/run_spike.py)的:
  - 模型加载:QwenImageEditPlusPipeline.from_pretrained(MODEL_DIR, bfloat16).to("mps")
  - 管线参数:30 步 / 1024×1024 / true_cfg_scale 4.0 / negative_prompt / mps Generator seed=42
差异(按本轮任务书):
  - 输入改为本实验 A/B 图;prompt 统一为一条身份保真强化版(spike v0 方案A基础上强化);
  - negative 中「文字」改为「乱码文字」——本轮 prompt 要求保留原物文字标签作为识别特征,
    同时追加「凭空添加的元素」与任务书的「禁止添加原物没有的元素」对齐;其余沿用。
行为:
  - 逐张 append 事件到 /tmp/level2-ab/gen-log.jsonl;单张失败记录后继续;
  - 已存在且可打开的输出跳过(断点续跑);软超时 2.4h,到点不再起新任务;
  - 结束写 /tmp/level2-ab/timings.md。
"""

from __future__ import annotations

import json
import os
import time
import traceback
from pathlib import Path

import torch
from PIL import Image
from diffusers import QwenImageEditPlusPipeline

BASE = Path("/tmp/level2-ab")
OUT = BASE / "out"
LOG = BASE / "gen-log.jsonl"
MODEL_DIR = Path.home() / "Desktop/work/models/Qwen-Image-Edit-2511"

# ---- 管线参数:与 spike v0 完全一致 ----
MAX_SIDE = 1024
STEPS = 30
TRUE_CFG = 4.0
SEED = 42

# ---- prompt:spike v0 方案A基础上强化身份保真(本轮任务书指定) ----
PROMPT_TMPL = (
    "把这张图片里的{name}画成奶油白色(#FAF8F2)纯色背景、墨黑色(#191919)粗实圆润线条、"
    "明黄色(#FFE15A)少量点缀的极简简笔画贴纸风卡通形象,构图居中,大量留白。"
    "必须完整保留它区别于其他同类物品的全部识别特征:整体形状轮廓、原有配色及各色块位置、"
    "按键、接口、纹理等显著细节,以及物体上原有的文字标签和标识一律按原样保留画出,不要省略或改动;"
    "不要把它画成泛化的通用形象,禁止添加原物上不存在的任何元素。"
)
# spike v0 negative:「照片,写实,3D渲染,渐变色,杂乱背景,多余的颜色,文字,水印」
# 本轮改动:「文字」→「乱码文字」(要保留原物文字标签),追加「凭空添加的元素」。
NEGATIVE = "照片,写实,3D渲染,渐变色,杂乱背景,多余的颜色,乱码文字,水印,凭空添加的元素"

SOFT_DEADLINE_SEC = 2.4 * 3600  # 到点不再开始新的一张;总收尾由外部 2.5h 把控

T0 = time.time()


def log(event: dict) -> None:
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **event}
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps(event, ensure_ascii=False), flush=True)


def load_sized(path: Path) -> Image.Image:
    """与 spike v0 相同:长边缩到 1024(本实验输入已是 1024×1024,直接 RGB)。"""
    img = Image.open(path).convert("RGB")
    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return img


def output_ok(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        Image.open(path).verify()
        return True
    except Exception:
        return False


def main() -> None:
    OUT.mkdir(exist_ok=True)
    names = sorted(
        p.stem[2:] for p in BASE.glob("A-*.png")
        if (BASE / f"B-{p.stem[2:]}.png").exists()
    )
    if not names:
        log({"event": "script_error", "error": "BASE 下未找到成对的 A-*.png / B-*.png"})
        raise SystemExit(1)

    tasks = [(g, n) for n in names for g in ("A", "B")]  # 按物品交错 A/B
    todo = [
        (g, n) for g, n in tasks
        if not output_ok(OUT / f"{g}-{n}.cartoon.png")
    ]
    log({"event": "script_start", "pid": os.getpid(),
         "pairs": names, "tasks_total": len(tasks), "todo": len(todo)})

    if not todo:
        log({"event": "all_done", "ok": 0, "fail": 0, "skip": len(tasks), "wall_sec": round(time.time() - T0)})
        return

    log({"event": "model_load_start", "model_dir": str(MODEL_DIR)})
    t = time.time()
    pipe = QwenImageEditPlusPipeline.from_pretrained(str(MODEL_DIR), torch_dtype=torch.bfloat16)
    pipe = pipe.to("mps")
    log({"event": "model_loaded", "load_sec": round(time.time() - t)})

    ok = fail = skip = 0
    for g, n in tasks:
        src = BASE / f"{g}-{n}.png"
        dst = OUT / f"{g}-{n}.cartoon.png"
        if output_ok(dst):
            skip += 1
            log({"event": "item_skip", "group": g, "name": n, "output": str(dst)})
            continue
        if time.time() - T0 > SOFT_DEADLINE_SEC:
            log({"event": "item_abort_deadline", "group": g, "name": n})
            fail += 1
            continue
        log({"event": "item_start", "group": g, "name": n, "input": str(src), "output": str(dst)})
        t1 = time.time()
        try:
            img = load_sized(src)
            gen = torch.Generator("mps").manual_seed(SEED)
            with torch.inference_mode():
                result = pipe(
                    prompt=PROMPT_TMPL.format(name=n),
                    image=img,
                    negative_prompt=NEGATIVE,
                    true_cfg_scale=TRUE_CFG,
                    num_inference_steps=STEPS,
                    height=MAX_SIDE,
                    width=MAX_SIDE,
                    generator=gen,
                ).images[0]
            result.save(dst)
            wall = round(time.time() - t1)
            ok += 1
            log({"event": "item_done", "group": g, "name": n, "wall_sec": wall,
                 "bytes": dst.stat().st_size, "seed": SEED, "steps": STEPS, "true_cfg": TRUE_CFG})
        except Exception as e:  # 单张失败记录后继续
            fail += 1
            log({"event": "item_fail", "group": g, "name": n,
                 "wall_sec": round(time.time() - t1), "error": repr(e)})
            traceback.print_exc()

    total_wall = round(time.time() - T0)
    log({"event": "all_done", "ok": ok, "fail": fail, "skip": skip, "wall_sec": total_wall})

    # timings.md
    rows = ["| 变体 | 照片 | 墙钟秒 |", "| --- | --- | --- |"]
    for line in LOG.read_text(encoding="utf-8").splitlines():
        ev = json.loads(line)
        if ev.get("event") == "item_done":
            rows.append(f"| {ev['group']} | {ev['name']} | {ev['wall_sec']} |")
    done_secs = [json.loads(l)["wall_sec"] for l in LOG.read_text(encoding="utf-8").splitlines()
                 if (e := json.loads(l)).get("event") == "item_done"]
    if done_secs:
        rows.append(f"| 合计 | {len(done_secs)} 张 | {sum(done_secs)} |")
    (BASE / "timings.md").write_text("\n".join(rows) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
