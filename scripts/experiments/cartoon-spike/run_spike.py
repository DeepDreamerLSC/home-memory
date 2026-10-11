#!/usr/bin/env python3
"""Cartoonization Spike v0(按 Issue #3 架构评审授权,2026-10-10)

真实物品照片 → 品牌风格卡通形象,验证「物品身份保持 + 风格一致性」。
仅离线实验,不接产品代码。

用法:
  1. 把 6 张真实物品照片放进 inputs/,文件名即物品名(如「充电器.jpg」「钥匙.png」)
  2. 确保已生成 style-ref/style-sample.png(见 README)
  3. 用试点环境运行:/tmp/qwen-img-venv/bin/python scripts/experiments/cartoon-spike/run_spike.py

产物(全部在 outputs/,可追溯):
  A-<物品>.png / B-<物品>.png  方案A=固定prompt / 方案B=风格参考图
  manifest.json                每张的原图、方案、参数、耗时、种子
  review.md                    原图/A/B 对照表 + 盲评列(人工填写)
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import torch
from PIL import Image
from diffusers import QwenImageEditPlusPipeline

HERE = Path(__file__).resolve().parent
MODEL_DIR = Path.home() / "Desktop/work/models/Qwen-Image-Edit-2511"
INPUTS = HERE / "inputs"
STYLE_REF = HERE / "style-ref" / "style-sample.png"
OUTPUTS = HERE / "outputs"

MAX_SIDE = 1024
STEPS = 30
TRUE_CFG = 4.0
SEED = 42

# 品牌风格描述(A/B 共用的锚定文字;B 组另有图例锚定)
STYLE_WORDS = (
    "极简扁平简笔画卡通风格:墨黑色(#191919)粗实圆润线条,"
    "奶油白色(#FAF8F2)纯色背景,明黄色(#FFE15A)少量点缀,"
    "漫画感,大量留白,构图居中"
)
NEGATIVE = "照片,写实,3D渲染,渐变色,杂乱背景,多余的颜色,文字,水印"
IDENTITY_WORDS = "保留它区别于其他同类物品的关键特征(形状轮廓、颜色、显著细节),不要把它画成泛化的通用形象"


def load_sized(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB")
    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return img


def main() -> None:
    photos = sorted([p for p in INPUTS.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}])
    if not photos:
        raise SystemExit("inputs/ 里没有照片(支持 jpg/png),文件名即物品名,如「充电器.jpg」")
    if not STYLE_REF.exists():
        raise SystemExit("缺少 style-ref/style-sample.png,先按 README 生成风格样例")
    OUTPUTS.mkdir(exist_ok=True)

    style_sample = load_sized(STYLE_REF)
    manifest: list[dict] = []

    print(f"加载模型:{MODEL_DIR}", flush=True)
    t0 = time.time()
    pipe = QwenImageEditPlusPipeline.from_pretrained(str(MODEL_DIR), torch_dtype=torch.bfloat16)
    pipe = pipe.to("mps")
    print(f"模型加载 {time.time()-t0:.0f}s;共 {len(photos)} 件物品 × 2 方案", flush=True)

    for i, photo in enumerate(photos, 1):
        name = photo.stem
        img = load_sized(photo)
        plans = [
            (
                "A",
                {
                    "image": img,
                    "prompt": f"把这张照片里的{name}画成{STYLE_WORDS}的卡通形象。{IDENTITY_WORDS}。",
                },
            ),
            (
                "B",
                {
                    "image": [img, style_sample],
                    "prompt": (
                        f"第一张是真实照片,第二张是目标画风样例。"
                        f"用第二张的画风把第一张照片里的{name}画成卡通形象。{IDENTITY_WORDS}。"
                    ),
                },
            ),
        ]
        for plan_id, kwargs in plans:
            gen = torch.Generator("mps").manual_seed(SEED)
            t1 = time.time()
            with torch.inference_mode():
                out = pipe(
                    negative_prompt=NEGATIVE,
                    true_cfg_scale=TRUE_CFG,
                    num_inference_steps=STEPS,
                    height=MAX_SIDE,
                    width=MAX_SIDE,
                    generator=gen,
                    **kwargs,
                ).images[0]
            elapsed = round(time.time() - t1)
            out_path = OUTPUTS / f"{plan_id}-{name}.png"
            out.save(out_path)
            manifest.append(
                {
                    "物品": name,
                    "方案": plan_id,
                    "原图": str(photo.relative_to(HERE)),
                    "输出": str(out_path.relative_to(HERE)),
                    "种子": SEED,
                    "步数": STEPS,
                    "true_cfg": TRUE_CFG,
                    "分辨率": MAX_SIDE,
                    "耗时秒": elapsed,
                },
            )
            (OUTPUTS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
            print(f"[{i}/{len(photos)}] {plan_id}-{name} 完成({elapsed}s)", flush=True)

    rows = []
    for m in manifest:
        if m["方案"] != "A":
            continue
        name = m["物品"]
        rows.append(
            f"| {name} | 原图 inputs/{name}.* | A(固定prompt) | B(风格参考图) | 身份保持:__ 风格一致:__ |"
        )
    review = [
        "# Cartoonization Spike v0 结果对照(人工盲评表)",
        "",
        "> 每行一件物品:遮住方案标签先盲评「身份保持」(还能认出是原图那件吗/会不会认成别的同类),",
        "> 再评「品牌风格一致」(墨黑线条+奶油白底+明黄点缀)。门槛:≥5/6 身份可辨认、无严重错件、≥5/6 风格符合。",
        "",
        "| 物品 | 原图 | 方案A | 方案B | 盲评(身份/风格) |",
        "| --- | --- | --- | --- | --- |",
        *rows,
        "",
        "参数与耗时见 manifest.json(种子固定,可复现)。",
    ]
    (OUTPUTS / "review.md").write_text("\n".join(review), encoding="utf-8")
    print(f"全部完成:{OUTPUTS}/review.md", flush=True)


if __name__ == "__main__":
    main()
