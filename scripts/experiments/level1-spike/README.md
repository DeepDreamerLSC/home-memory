# Level 1 Visual Spike(受限研究,issue #3 / Generation Runtime Contract)

> 授权口径(2026-10-11 架构裁定):比较普通裁剪、轻量抠图、必要时云端 API(桌面比对,不实调付费接口);
> 先验证**质量、时延、成本**,不进入产品主链路。本目录只是离线实验,零部署、零付费、不改生产代码。

## 冻结样本集(目标 30 张,八场景)

| 场景 | 目标张数 | 说明 |
| --- | --- | --- |
| S1 单一主体·干净背景 | 4 | 基线最好情形 |
| S2 杂乱桌面/抽屉 | 5 | 真实主场景,背景干扰 |
| S3 透明/反光物品 | 4 | 玻璃/金属,抠图高危 |
| S4 细长物(充电线/数据线) | 3 | 已知最差情形(cartoon spike 复现过) |
| S5 多个相似物品同框 | 4 | 误合并/误裁风险 |
| S6 带文字/标签物品 | 4 | 身份特征保留检验 |
| S7 前景遮挡 | 3 | 部分遮挡下主体完整率 |
| S8 多物体同框 | 3 | 主体定位准确性 |

**当前状态:interim 集 = 6 张(S1 为主),来自 cartoon-spike 的既有照片;30 张冻结集待用户提供**(隐私:用户自拍照,gitignore 不入库)。样本不足时一切指标标注「探索性」,不得当生产 SLA。

## 三条管线(run_level1.py)

| 管线 | 技术 | 定位 |
| --- | --- | --- |
| P0 普通裁剪 | PIL 等比缩放 + 白底方图 512px | 零 AI 下界对照(架构问题 1) |
| P1a 轻量抠图 | rembg u2netp(170MB 档以下,CPU 友好) | 时延优先候选 |
| P1b 质量抠图 | rembg isnet-general-use | 质量优先候选 |

每张产物:alpha 抠图 → 包围盒裁剪 → 白底合成 512px(与 P0 同规格,可比)。

## 指标口径

1. **主体完整率**:抠图蒙版是否吃掉主体部位(逐张人工/辅评,金标=人)
2. **身份可辨率**:处理后能否认出原物品(盲评,同 cartoon-spike 口径)
3. **无关泄漏**:合成图是否引入原照片背景残留/伪影
4. **时延**:冷启动(模型加载)与热稳态(逐张)分开;单机 M5 Max,仅量级参考
5. **内存**:进程峰值 RSS 粗口径
6. **成本**:P0/P1 本地零边际成本;云端 API 成本按调研报告桌面推算,不实调

产出:`outputs/manifest.json`(逐张时延/参数)+ `outputs/P0-*.png / P1a-*.png / P1b-*.png` + `outputs/review.md`(盲评表,人工列留空)。

## 运行

```bash
/tmp/level1-venv/bin/python3 scripts/experiments/level1-spike/run_level1.py   # 需先 pip install rembg pillow onnxruntime(探针环境已有)
```

## 红线

inputs/ outputs/ 已 gitignore;真实家庭影像绝不上传仓库/issue;本实验不修改 miniprogram/ 与 cloudfunctions/。
