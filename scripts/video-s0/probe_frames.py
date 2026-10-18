#!/usr/bin/env python3
"""#85 S0 最小离线探针:抽帧→时间戳→清晰度→近重复过滤(合成素材,不连产品库,不调模型)。
用法:python3 probe_frames.py --workdir /tmp/video-s0 [--video]
  --video:先把合成帧编成 mp4,再走「视频解码→ffprobe 时间戳→管线」全链;
  缺省直接跑帧管线(视频解码段标 SKIP)。退出码 0=自检全过。"""
import argparse, json, os, subprocess, sys
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
    # 3 张模糊版(应被清晰度过滤)与 2 张近重复(轻微平移,应被去重)
    for j, src in enumerate([2, 6, 9]):
        Image.open(f"{d}/f{src:02d}.png").filter(ImageFilter.GaussianBlur(6)).save(f"{d}/blur{j}.png")
    for j, src in enumerate([4, 7]):
        im = Image.open(f"{d}/f{src:02d}.png"); im.paste(im.crop((0,0,600,480)), (12, 0)); im.save(f"{d}/dup{j}.png")

def to_video(d, mp4):
    r = subprocess.run(["ffmpeg","-y","-framerate","2","-pattern_type","glob","-i",f"{d}/f*.png",
                        "-c:v","libx264","-pix_fmt","yuv420p",mp4], capture_output=True, text=True)
    if r.returncode != 0: print("FFMPEG_ENCODE_FAIL:", r.stderr[-300:]); sys.exit(3)

def decode(d, mp4, out):
    os.makedirs(out, exist_ok=True)
    r = subprocess.run(["ffmpeg","-y","-i",mp4,f"{out}/d%03d.png"], capture_output=True, text=True)
    if r.returncode != 0: print("FFMPEG_DECODE_FAIL:", r.stderr[-300:]); sys.exit(3)
    p = subprocess.run(["ffprobe","-select_streams","v","-show_entries","frame=pts_time",
                        "-of","json",mp4], capture_output=True, text=True)
    if p.returncode != 0: print("FFPROBE_FAIL"); sys.exit(3)
    return [float(f["pts_time"]) for f in json.loads(p.stdout)["frames"]]

def gray(a): return np.dot(a[..., :3], [0.299, 0.587, 0.114])

def sharpness(img):
    g = np.asarray(img.convert("L"), dtype=np.float32)
    lap = np.abs(4*g[1:-1,1:-1] - g[:-2,1:-1] - g[2:,1:-1] - g[1:-1,:-2] - g[1:-1,2:])
    return float(lap.var())

def ahash(img):
    g = np.asarray(img.convert("L").resize((8,8)), dtype=np.float32)
    bits = (g > g.mean()).flatten()
    return sum(int(b) << i for i, b in enumerate(bits))

def ham(a, b): return bin(a ^ b).count("1")

def run(workdir, video_mode):
    src = f"{workdir}/frames"; out = f"{workdir}/decoded"
    make_frames(src)
    files = sorted(os.listdir(src)); files = [f for f in files if f.endswith(".png")]
    ts = [None]*len(files); decoded = False
    if video_mode:
        mp4 = f"{workdir}/synth.mp4"; to_video(src, mp4)
        times = decode(src, mp4, out)
        dfiles = sorted(os.listdir(out)); dfiles = [f for f in dfiles if f.endswith(".png")]
        # 解码帧只含 f*(合成源),按顺序对齐 pts;blur/dup 未入视频
        vfiles = [f for f in files if f.startswith("f")]
        assert len(dfiles) == len(vfiles) == len(times), f"帧数不一致 {len(dfiles)}/{len(vfiles)}/{len(times)}"
        for f, t in zip(vfiles, times): ts[files.index(f)] = t
        decoded = True
    rows = []
    for i, f in enumerate(files):
        im = Image.open(f"{src}/{f}")
        rows.append({"file": f, "pts_time": ts[i], "sharpness": round(sharpness(im), 1), "hash": ahash(im)})
    SHARP_MIN = 120.0; DUP_H = 6
    kept = []
    for r in sorted(rows, key=lambda x: -x["sharpness"]):
        if r["sharpness"] < SHARP_MIN: r["drop"] = "blurry"; continue
        if any(ham(r["hash"], k["hash"]) <= DUP_H for k in kept): r["drop"] = "near_dup"; continue
        kept.append(r)
    for r in rows:
        if "drop" not in r: r["drop"] = "rank_cut"
    kept = sorted(kept, key=lambda x: (x["pts_time"] if x["pts_time"] is not None else -1))
    checks = {
        "kept_in_3_8": 3 <= len(kept) <= 8,
        "no_blur_kept": all("blur" not in k["file"] for k in kept),
        "no_dup_pair_kept": all(ham(a["hash"], b["hash"]) > DUP_H for ai, a in enumerate(kept) for b in kept[ai+1:]),
        "ts_monotonic": (all(kept[i]["pts_time"] < kept[i+1]["pts_time"] for i in range(len(kept)-1))
                         if video_mode and len(kept) > 1 else True),
        "ts_present_when_video": (all(k["pts_time"] is not None for k in kept) if video_mode else True),
    }
    manifest = {"video_mode": video_mode, "decoded": decoded, "sharp_min": SHARP_MIN, "dup_hamming": DUP_H,
                "total_frames": len(rows), "kept": len(kept),
                "frames": [{k: r[k] for k in ("file","pts_time","sharpness","drop") if k in r} for r in rows]}
    json.dump(manifest, open(f"{workdir}/manifest.json","w"), ensure_ascii=False, indent=1)
    print(json.dumps({"checks": checks, "summary": {k: manifest[k] for k in ("video_mode","decoded","total_frames","kept")}}, ensure_ascii=False))
    return 0 if all(checks.values()) else 4

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--workdir", required=True)
    ap.add_argument("--video", action="store_true"); a = ap.parse_args()
    sys.exit(run(a.workdir, a.video))
