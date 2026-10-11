#!/usr/bin/env python3
"""生成 B 组的风格参考图(一次性):纯底图模式画一件简笔画物品作为画风锚点。

样例本身不做身份保持测试(它只提供画风,这正是评审认可的纯底图能力范围)。
"""

import time
from pathlib import Path

import torch
from PIL import Image
from diffusers import QwenImageEditPlusPipeline

HERE = Path(__file__).resolve().parent
MODEL_DIR = Path.home() / "Desktop/work/models/Qwen-Image-Edit-2511"
OUT = HERE / "style-ref" / "style-sample.png"

PROMPT = (
    "在这张纯色底图上绘制一件物品的卡通形象:一只带手柄的马克杯,杯身有一道明黄色横条纹。"
    "墨黑色(#191919)粗实圆润线条勾勒轮廓,保持背景原有的奶油白色(#FAF8F2),"
    "明黄色(#FFE15A)仅用于条纹。极简扁平简笔画,漫画感,大量留白,构图居中,不要出现任何文字。"
)

base = Image.new("RGB", (1024, 1024), "#FAF8F2")

t0 = time.time()
pipe = QwenImageEditPlusPipeline.from_pretrained(str(MODEL_DIR), torch_dtype=torch.bfloat16)
pipe = pipe.to("mps")
print(f"模型加载 {time.time()-t0:.0f}s", flush=True)

t1 = time.time()
with torch.inference_mode():
    image = pipe(
        image=base,
        prompt=PROMPT,
        negative_prompt="照片,写实,3D渲染,渐变色,多余的颜色,文字,水印",
        true_cfg_scale=4.0,
        num_inference_steps=30,
        generator=torch.Generator("mps").manual_seed(7),
    ).images[0]

OUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUT)
print(f"风格样例完成({time.time()-t1:.0f}s):{OUT}", flush=True)
