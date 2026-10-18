#!/usr/bin/env python3
"""#85 S0 最小离线探针 v2(评审 B1 修复:解码帧必须进筛选管线)。
抽帧→ffprobe 时间戳→清晰度→近重复过滤;合成素材;不连产品库,不调模型。
用法:python3 probe_frames.py --workdir /tmp/video-s0 [--video]
  --video:全部合成帧(含模糊/近重复)编入 mp4→解码→**对解码帧**做筛选;
  缺省直接对目录帧做筛选(无视频段)。退出码 0=自检全过。"""
import argparse, json, os, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

def make_frames(d, n=12):
    os.makedirs(d, exist_ok=True)
    for i in range(n):
        img = Image.new("RGB", (640, 480), (250-i*8, 246, 240))
        dr = ImageDraw.Draw(img)
        dr.rectangle([40+i*10, 60, 240+i*10, 300], fill=(30+i*15, 120, 200))
        dr.ellipse([300, 120+i*12, 480, 300+i*12], fill=(240, 160, 40))
        dr.text((30, 20), f"S0-SYNTH frame {i:02d}", fill=(20, 20, 20))
        img.save(f"{d}/f{i:02d}.png")
    for j, src in enumerate([2, 6, 9]):
        Image.open(f"{d}/f{src:02d}.png").filter(ImageFilter.GaussianBlur(6)).save(f"{d}/blur{j}.png")
    for j, src in enumerate([4, 7]):
        im = Image.open(f"{d}/f{src:02d}.png"); im.paste(im.crop((0,0,600,480)), (12, 0)); im.save(f"{d}/dup{j}.png")

def make_stress_frames(d, n=14):
    """压力场景(评审三轮:cap 必须被真触发):n 张强差异清晰帧,逼出 KEEP_MAX 截断。"""
    os.makedirs(d, exist_ok=True)
    for i in range(n):
        img = Image.new("RGB", (640, 480), ((40*i) % 255, (90*i) % 255, (160*i) % 255))
        dr = ImageDraw.Draw(img)
        w = 80 + i * 35
        dr.rectangle([20, 60, min(w, 620), 420], fill=((200+13*i) % 255, 60, 60))
        if i % 2 == 0:
            dr.ellipse([max(620-w, 20), 120, 620, 400], fill=(250, 200, 30))
        else:
            dr.polygon([(320, 60), (600, 420), (60, 420)], outline=(255, 255, 255), width=8)
        dr.text((250, 180), str(i), fill=(0, 0, 0), font_size=160)
        img.save(f"{d}/f{i:02d}.png")

def to_video(d, mp4):
    r = subprocess.run(["ffmpeg","-y","-framerate","2","-pattern_type","glob","-i",f"{d}/*.png",
                        "-c:v","libx264","-pix_fmt","yuv420p",mp4], capture_output=True, text=True)
    if r.returncode != 0: print("FFMPEG_ENCODE_FAIL:", r.stderr[-300:]); sys.exit(3)

def decode(mp4, out):
    os.makedirs(out, exist_ok=True)
    r = subprocess.run(["ffmpeg","-y","-i",mp4,f"{out}/d%03d.png"], capture_output=True, text=True)
    if r.returncode != 0: print("FFMPEG_DECODE_FAIL:", r.stderr[-300:]); sys.exit(3)
    p = subprocess.run(["ffprobe","-select_streams","v","-show_entries","frame=pts_time",
                        "-of","json",mp4], capture_output=True, text=True)
    if p.returncode != 0: print("FFPROBE_FAIL"); sys.exit(3)
    times = [float(f["pts_time"]) for f in json.loads(p.stdout)["frames"]]
    dfiles = sorted(f for f in os.listdir(out) if f.endswith(".png"))
    assert len(dfiles) == len(times), f"解码帧数 {len(dfiles)} ≠ pts 数 {len(times)}"
    return dfiles, times

def sharpness(img):
    g = np.asarray(img.convert("L"), dtype=np.float32)
    lap = np.abs(4*g[1:-1,1:-1] - g[:-2,1:-1] - g[2:,1:-1] - g[1:-1,:-2] - g[1:-1,2:])
    return float(lap.var())

def ahash(img):
    g = np.asarray(img.convert("L").resize((8,8)), dtype=np.float32)
    bits = (g > g.mean()).flatten()
    return sum(int(b) << i for i, b in enumerate(bits))

def ham(a, b): return bin(a ^ b).count("1")

def run(workdir, video_mode, stress=False):
    # 场景隔离(终审整理):清掉本脚本已知产物,复用目录不带入上一场景的帧
    os.makedirs(workdir, exist_ok=True)
    for stale in ["frames", "decoded", "synth.mp4", "manifest.json"]:
        target = f"{workdir}/{stale}"
        if os.path.isdir(target):
            import shutil; shutil.rmtree(target)
        elif os.path.exists(target):
            os.remove(target)
    src = f"{workdir}/frames"; out = f"{workdir}/decoded"
    (make_stress_frames if stress else make_frames)(src)
    src_files = sorted(f for f in os.listdir(src) if f.endswith(".png"))
    if video_mode:
        # B1:全部帧(含 blur/dup)入视频,筛选对象=解码帧
        mp4 = f"{workdir}/synth.mp4"; to_video(src, mp4)
        dfiles, times = decode(mp4, out)
        judged = [{"file": f, "path": f"{out}/{f}", "pts_time": t,
                   "src_name": src_files[i] if i < len(src_files) else "?",
                   "src_label": (re.match(r"^[a-z]+", src_files[i]).group(0) if i < len(src_files) and re.match(r"^[a-z]+", src_files[i]) else "?")}
                  for i, (f, t) in enumerate(zip(dfiles, times))]
        judged_dir = out
    else:
        judged = [{"file": f, "path": f"{src}/{f}", "pts_time": None,
                   "src_name": f,
                   "src_label": (re.match(r"^[a-z]+", f).group(0) if re.match(r"^[a-z]+", f) else "?")} for f in src_files]
        judged_dir = src
    SHARP_MIN = 120.0; DUP_H = 6; KEEP_MAX = 8
    for r in judged:
        im = Image.open(r["path"])
        r["sharpness"] = round(sharpness(im), 1); r["hash"] = ahash(im)
    DUP_GROUND_TRUTH = [("f04.png", "dup0.png"), ("f07.png", "dup1.png")]  # 构造期真值(独立于 aHash)
    ranked = sorted(judged, key=lambda x: -x["sharpness"])
    kept = []
    for r in ranked:
        if r["sharpness"] < SHARP_MIN: r["drop"] = "blurry"; continue
        if any(ham(r["hash"], k["hash"]) <= DUP_H for k in kept): r["drop"] = "near_dup"; continue
        kept.append(r)
    if len(kept) > KEEP_MAX:  # 上限真截断(评审:不能只检查不限制)
        for r in kept[KEEP_MAX:]: r["drop"] = "cap_cut"
        kept = kept[:KEEP_MAX]
    kept_ids = {id(r) for r in kept}
    for r in judged:
        if id(r) not in kept_ids and "drop" not in r: r["drop"] = "rank_cut"
    for r in kept: r["kept"] = True
    kept = sorted(kept, key=lambda x: x["pts_time"] if x["pts_time"] is not None else -1)
    kept_names = {k["src_name"] for k in kept}
    by_name = {r["src_name"]: r for r in judged}
    checks = {
        "judged_input_is_decoded": (judged_dir == out) if video_mode else True,
        "kept_in_3_8": 3 <= len(kept) <= 8,
        "cap_enforced_by_construction": len(kept) <= KEEP_MAX,
        "no_blur_kept": all(k["src_label"] != "blur" for k in kept),
        "blur_each_dropped_blurry": stress or all(
            by_name.get(b, {}).get("drop") == "blurry" for b in ["blur0.png", "blur1.png", "blur2.png"]),
        "dup_pairs_actually_eliminated": stress or all(
            (by_name.get(a, {}).get("drop") == "near_dup") or (by_name.get(b, {}).get("drop") == "near_dup")
            for a, b in DUP_GROUND_TRUTH),
        "stress_cap_cut_fired": (not stress) or (len(kept) == KEEP_MAX and any(
            r.get("drop") == "cap_cut" for r in judged)),
        "kept_marker_consistent": all(r.get("kept") is True and "drop" not in r for r in kept)
                                  and all(("drop" in r) or r.get("kept") is True for r in judged),
        "ts_monotonic": (all(kept[i]["pts_time"] < kept[i+1]["pts_time"] for i in range(len(kept)-1))
                         if video_mode and len(kept) > 1 else True),
        "ts_present_when_video": (all(k["pts_time"] is not None for k in kept) if video_mode else True),
    }
    manifest = {"video_mode": video_mode, "judged_dir": judged_dir, "sharp_min": SHARP_MIN, "dup_hamming": DUP_H,
                "total_frames": len(judged), "kept": len(kept), "keep_max": KEEP_MAX, "stress": stress,
                "frames": [{k: r.get(k) for k in ("file","pts_time","sharpness","src_name","src_label","kept","drop")} for r in judged]}
    json.dump(manifest, open(f"{workdir}/manifest.json","w"), ensure_ascii=False, indent=1)
    print(json.dumps({"checks": checks, "summary": {k: manifest[k] for k in ("video_mode","judged_dir","total_frames","kept")}}, ensure_ascii=False))
    return 0 if all(checks.values()) else 4

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--workdir", required=True)
    ap.add_argument("--video", action="store_true"); ap.add_argument("--stress", action="store_true")
    a = ap.parse_args(); sys.exit(run(a.workdir, a.video, a.stress))
