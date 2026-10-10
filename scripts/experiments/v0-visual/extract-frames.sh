#!/usr/bin/env bash
#
# Issue #3 V0 实验脚本:从短视频按「固定间隔 + 场景切换」抽取关键帧。
#
# 隐私红线(issue #3):抽帧产物属于临时文件——最短必要保留,实验结束用 --clean 删除;
# 产物仅本地保存,不上传、不进公开仓库/Issue。脚本本身不做任何网络操作。
#
# 用法:
#   ./extract-frames.sh <input-video> <output-dir> [选项]
#   ./extract-frames.sh --clean <output-dir>
#
# 选项(均可用环境变量 INTERVAL/SCENE/MAX/QUALITY/SCALE 覆盖默认值):
#   --interval N   固定间隔抽帧,每 N 秒一帧(默认 2;若会超出 --max 预算,自动放大)
#   --scene T      场景切换阈值 0–1,越小越敏感(默认 0.3)
#   --max N        总帧数预算(默认 8;issue #3 示例预算 3–8)
#   --quality Q    输出 JPEG 质量,ffmpeg -q:v 取值 2–31,越小质量越高(默认 2)
#   --scale N      长边上限像素,等比缩放且不放大;0=不缩放(默认 2048;
#                  依据调研报告 §七:满足智谱 ≤6000×6000 与 ≤5M/张,Qwen 侧 token 自动封顶)
#   --clean DIR    删除整个输出目录后退出
#
# 产物命名:输出目录下 interval_NNN.jpg(固定间隔)与 scene_NNN.jpg(场景切换)。
# 模糊帧、明显重复帧的人工剔除是实验流程的一部分(issue 合同),脚本不自动删帧。

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

die() { echo "[$SCRIPT_NAME] 错误:$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖:$1(请先安装 ffmpeg)。"; }

INTERVAL="${INTERVAL:-2}"
SCENE="${SCENE:-0.3}"
MAX="${MAX:-8}"
QUALITY="${QUALITY:-2}"
SCALE="${SCALE:-2048}"

CLEAN_MODE=0
VIDEO=""
OUTDIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --clean)
      [ $# -ge 2 ] || die "--clean 需要一个目录参数"
      OUTDIR="$2"; shift 2
      CLEAN_MODE=1
      ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --scene)    SCENE="$2"; shift 2 ;;
    --max)      MAX="$2"; shift 2 ;;
    --quality)  QUALITY="$2"; shift 2 ;;
    --scale)    SCALE="$2"; shift 2 ;;
    -h|--help)  usage ;;
    --*)        die "未知选项:$1(见 --help)" ;;
    *)
      if [ -z "$VIDEO" ]; then VIDEO="$1"; elif [ -z "$OUTDIR" ]; then OUTDIR="$1"; else die "多余参数:$1"; fi
      shift
      ;;
  esac
done

if [ "$CLEAN_MODE" -eq 1 ]; then
  if [ -n "$VIDEO" ]; then die "--clean 不能与其他参数混用"; fi
  [ -n "$OUTDIR" ] || die "--clean 需要一个目录参数"
  if [ -d "$OUTDIR" ]; then
    rm -rf "$OUTDIR"
    echo "[$SCRIPT_NAME] 已删除临时帧目录:$OUTDIR(隐私红线:临时文件最短保留)"
  else
    echo "[$SCRIPT_NAME] 目录不存在,无需清理:$OUTDIR"
  fi
  exit 0
fi

[ -n "$VIDEO" ] && [ -n "$OUTDIR" ] || usage
[ -f "$VIDEO" ] || die "输入视频不存在:$VIDEO"

INTERVAL="$(awk -v v="$INTERVAL" 'BEGIN{ if (v<=0) print ""; else printf "%.3f", v }')" || die "--interval 必须为正数"
[ -n "$INTERVAL" ] || die "--interval 必须为正数"
awk -v s="$SCENE" 'BEGIN{ exit !(s>0 && s<1) }' || die "--scene 取值应为 0–1 之间"
awk -v m="$MAX" 'BEGIN{ exit !(m>=1) }' || die "--max 至少为 1"
awk -v q="$QUALITY" 'BEGIN{ exit !(q>=2 && q<=31) }' || die "--quality 取值应为 2–31"
case "$SCALE" in ''|*[!0-9]*) die "--scale 必须为非负整数(0=不缩放)" ;; esac

need ffmpeg
need ffprobe

DURATION="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO")" \
  || die "无法读取视频时长(ffprobe)"
DURATION_SEC="${DURATION%%.*}"
[ -n "$DURATION_SEC" ] || die "无法解析视频时长:$DURATION"

# 若默认间隔会超出帧预算,自动放大间隔,保证固定间隔一路 ≤ MAX 帧。
EFFECTIVE_INTERVAL="$INTERVAL"
EXPECT_FRAMES="$(awk -v d="$DURATION_SEC" -v i="$INTERVAL" 'BEGIN{ printf "%d", d/i + 1 }')"
if [ "$EXPECT_FRAMES" -gt "$MAX" ]; then
  EFFECTIVE_INTERVAL="$(awk -v d="$DURATION_SEC" -v m="$MAX" 'BEGIN{ printf "%.3f", (d/m + 0.4) }')"
  echo "[$SCRIPT_NAME] 提示:间隔 ${INTERVAL}s 会抽出约 ${EXPECT_FRAMES} 帧,超出预算 ${MAX};已自动放大为 ${EFFECTIVE_INTERVAL}s。"
fi

mkdir -p "$OUTDIR"

# 长边 ≤SCALE 的等比缩放(不放大);横竖拍都约束长边。0 = 不缩放。
# 末尾 format=yuvj420p:强制全量程 YUV 供 mjpeg 编码,避免部分输入触发
# 「Non full-range YUV is non-standard」编码器报错(竖拍 yuv420p 输入实测复现)。
if [ "$SCALE" -gt 0 ]; then
  SCALE_VF="scale='if(gte(iw,ih),min(${SCALE},iw),-2)':'if(gte(iw,ih),-2,min(${SCALE},ih))',format=yuvj420p,"
else
  SCALE_VF="format=yuvj420p,"
fi

echo "[$SCRIPT_NAME] 视频:$VIDEO(约 ${DURATION_SEC}s)"
echo "[$SCRIPT_NAME] 参数:间隔=${EFFECTIVE_INTERVAL}s 场景阈值=${SCENE} 预算=${MAX} 帧 JPEG质量(-q:v)=${QUALITY} 长边上限=${SCALE:-不限制}"

echo "[$SCRIPT_NAME] [1/2] 固定间隔抽帧 → interval_*.jpg"
ffmpeg -hide_banner -loglevel error -i "$VIDEO" \
  -vf "${SCALE_VF}fps=1/${EFFECTIVE_INTERVAL}" -q:v "$QUALITY" \
  "$OUTDIR/interval_%03d.jpg"

echo "[$SCRIPT_NAME] [2/2] 场景切换抽帧 → scene_*.jpg"
ffmpeg -hide_banner -loglevel error -i "$VIDEO" \
  -vf "${SCALE_VF}select='gt(scene,${SCENE})'" -fps_mode vfr -q:v "$QUALITY" \
  "$OUTDIR/scene_%03d.jpg" 2>/dev/null || \
ffmpeg -hide_banner -loglevel error -i "$VIDEO" \
  -vf "${SCALE_VF}select='gt(scene,${SCENE})'" -vsync vfr -q:v "$QUALITY" \
  "$OUTDIR/scene_%03d.jpg"

INTERVAL_COUNT="$(find "$OUTDIR" -name 'interval_*.jpg' | wc -l | tr -d ' ')"
SCENE_COUNT="$(find "$OUTDIR" -name 'scene_*.jpg' | wc -l | tr -d ' ')"
TOTAL=$((INTERVAL_COUNT + SCENE_COUNT))

echo "[$SCRIPT_NAME] 完成:固定间隔 ${INTERVAL_COUNT} 帧 + 场景切换 ${SCENE_COUNT} 帧,共 ${TOTAL} 帧 → $OUTDIR"

if [ "$TOTAL" -gt "$MAX" ]; then
  echo "[$SCRIPT_NAME] 提示:总数超出预算 ${MAX}。人工只保留 ${MAX} 张内最能代表区域的帧(剔除模糊与明显重复,计入 C 方案耗时)。"
fi

echo "[$SCRIPT_NAME] 下一步:人工剔帧后,按 prompts/multi-frame.md 以多图同请求发给模型(多图上限见调研报告对照表)。"
echo "[$SCRIPT_NAME] 用完清理:./extract-frames.sh --clean $OUTDIR"
