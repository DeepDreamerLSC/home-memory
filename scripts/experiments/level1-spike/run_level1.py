#!/usr/bin/env python3
"""Level 1 Visual Spike:三管线对比运行器(P0 普通裁剪 / P1a u2netp / P1b isnet)。

产物全部写入 outputs/(gitignored):manifest.json 记录逐张时延与冷启动;
每张图产出 P0-/P1a-/P1b- 三版 512px 白底合成图供盲评。
仅离线实验,零网络(模型如已缓存)、零部署、不改生产代码。
"""

import json
import os
import resource
import time

import PIL.Image
import PIL.ImageOps

from rembg import remove, new_session

HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS = os.path.join(HERE, "inputs")
OUTPUTS = os.path.join(HERE, "outputs")
SIZE = 512

# 排除探针期间的分析脚本产物,只吃 jpg/png 样本
EXTS = (".jpg", ".jpeg", ".png")


def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def compose_on_white(img, bg):
    """任意模式图 → RGBA 贴白底 → RGB,再等比缩放 + 白底方图 SIZE。"""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    canvas = PIL.Image.new("RGBA", img.size, (255, 255, 255, 255))
    canvas.alpha_composite(img)
    img = canvas.convert("RGB")
    img = PIL.ImageOps.exif_transpose(img)
    img.thumbnail((SIZE, SIZE), PIL.Image.LANCZOS)
    square = PIL.Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    square.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))
    return square


def crop_to_alpha(rgba):
    """alpha 包围盒裁剪(抠图管线用):透明边裁掉,只留主体区域。"""
    bbox = rgba.getbbox()
    if bbox is None:
        return rgba
    return rgba.crop(bbox)


def p0_plain(path, out_path):
    t0 = time.perf_counter()
    img = PIL.Image.open(path)
    img = PIL.ImageOps.exif_transpose(img)
    img.thumbnail((SIZE, SIZE), PIL.Image.LANCZOS)
    square = PIL.Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    square.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))
    ms = (time.perf_counter() - t0) * 1000
    square.save(out_path)
    return ms


def make_rembg_pipeline(model_name):
    """返回 (run, cold_ms):首次调用含模型加载(冷启动),其后为热稳态。"""
    state = {"session": None, "cold_ms": None}

    def run(path, out_path):
        t0 = time.perf_counter()
        if state["session"] is None:
            t_load = time.perf_counter()
            state["session"] = new_session(model_name)
            state["cold_ms"] = (time.perf_counter() - t_load) * 1000
        img = PIL.Image.open(path)
        img = PIL.ImageOps.exif_transpose(img)
        cut = remove(img, session=state["session"])
        cut = crop_to_alpha(cut)
        result = compose_on_white(cut, SIZE)
        ms = (time.perf_counter() - t0) * 1000
        result.save(out_path)
        return ms

    return run, state


def main():
    os.makedirs(OUTPUTS, exist_ok=True)
    names = sorted(
        n for n in os.listdir(INPUTS) if n.lower().endswith(EXTS) and not n.startswith(".")
    )
    if not names:
        raise SystemExit("inputs/ 为空:先放入样本照片(gitignored)")

    manifest = {"size": SIZE, "sample_count": len(names), "pipelines": {}, "images": {}}

    p1a_run, p1a_state = make_rembg_pipeline("u2netp")
    p1b_run, p1b_state = make_rembg_pipeline("isnet-general-use")

    for name in names:
        stem = os.path.splitext(name)[0]
        path = os.path.join(INPUTS, name)
        rec = {}

        rec["p0_ms"] = round(
            p0_plain(path, os.path.join(OUTPUTS, "P0-%s.png" % stem)), 1
        )
        rec["p1a_u2netp_ms"] = round(
            p1a_run(path, os.path.join(OUTPUTS, "P1a-%s.png" % stem)), 1
        )
        rec["p1b_isnet_ms"] = round(
            p1b_run(path, os.path.join(OUTPUTS, "P1b-%s.png" % stem)), 1
        )
        manifest["images"][name] = rec
        print("%-12s P0=%7.1fms  P1a=%7.1fms  P1b=%7.1fms" % (
            name, rec["p0_ms"], rec["p1a_u2netp_ms"], rec["p1b_isnet_ms"]))

    manifest["pipelines"] = {
        "p0_plain": {"tech": "PIL 等比缩放+白底方图", "cold_ms": 0},
        "p1a_u2netp": {"tech": "rembg u2netp", "cold_load_ms": round(p1a_state["cold_ms"] or 0, 1)},
        "p1b_isnet": {"tech": "rembg isnet-general-use", "cold_load_ms": round(p1b_state["cold_ms"] or 0, 1)},
        "peak_rss_mb_note": "RSS 见 stdout(粗口径)",
    }
    manifest["machine_note"] = "Apple M5 Max 单机,探索性数据,不得当生产 SLA"
    with open(os.path.join(OUTPUTS, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("peak RSS: %.0f MB" % peak_rss_mb())
    print("manifest → outputs/manifest.json")


if __name__ == "__main__":
    main()
