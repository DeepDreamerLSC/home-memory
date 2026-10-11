# Level 2 卡通化 A/B 对照实验(2026-10-11)

问题:卡通化之前是否需要 AI 抠图?(issue #3 Generation Runtime Contract 下的子实验)

- **A 组**:原图适当裁剪(蒙版包围盒外扩 10%)→ 白底 1024 方图 → Qwen-Image-Edit
- **B 组**:同一裁剪框 + isnet alpha 抠图 → 白底 1024 → 同一模型
- 唯一变量:是否去背景。同 prompt、同 seed(42)、同管线(30 步/1024/true_cfg 4.0/bfloat16/MPS)

**结论(人工盲评终裁后):下一阶段默认路线「裁剪优先、抠图可选」,不宣称 A 统计上优于 B(6 件/单评审/单 seed)。** VLM 辅评阶段曾判 B-needed(背景污染 A 4/6 vs B 0/6)——该观察未被盲评推翻,被推翻的是「B 应为默认」;人工盲评整体偏好 A 4 胜:B 2 胜。完整评审与终裁见 `report.md`(§2/§7,已同步发布 issue #3)与 `sheets/` 六张五格对照拼图。**注意:本轮 A 的裁剪框本身借用了 ISNet 蒙版 bbox(A 仍依赖分割,只是未抠除背景),实验未比较「纯非 AI 裁剪」基线——这是下一轮实验的重点。**

## 文件

| 文件 | 说明 |
| --- | --- |
| `prep.py` | 预处理:rembg isnet 蒙版 → 统一裁剪框 → A/B 两套输入(5.1s/6张) |
| `run_cartoon.py` | 12 张生图:复用 cartoon-spike 的加载与参数,断点续跑,逐张计时 |
| `make_sheet.py` / `make_blind.py` / `make_recheck.py` | 五格拼图 / 盲评集(seed 固定可复现) / 分歧复核图 |
| `crop-boxes.json` | 逐张蒙版 bbox、外扩后裁剪框、前景占比、预处理耗时 |
| `timings.md` / `gen-log.jsonl`(在运行目录) | 逐张墙钟耗时与事件日志 |
| `sheets/` | 六张五格对照拼图(源图|A输入|B输入|A产物|B产物) |

## 复现说明(如实边界)

- 运行目录为 `/tmp/level2-ab/`(脚本内路径硬编码,未参数化);源图 6 张来自 cartoon-spike inputs,未入库;
- 环境:`/tmp/level1-venv`(rembg+onnxruntime,isnet-general-use 模型缓存 `~/.rembg/models/`)与 `/tmp/qwen-img-venv`(diffusers+torch,Qwen-Image-Edit-2511 本地权重)——两者均为本机一次性环境,README 不承诺开箱复现;
- 单机 M5 Max、单模型、单 seed、每物品每路线 1 次生成:结论为探索性;
- 复现顺序:`prep.py` → `run_cartoon.py` → `make_sheet.py` / `make_blind.py`;参数与 seed 均固定在脚本内。

## 真实影像授权说明

`sheets/` 含用户提供的真实物品照片(源图列)。本仓库为公开仓库,该批影像于 2026-10-11 经用户明确授权上传;公开 Git 历史中的图像无法通过日后删除文件彻底撤回,此点已在授权时知悉。除此之外,实验原始照片与全部中间产物仍遵循不入库红线。
