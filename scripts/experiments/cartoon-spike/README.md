# Cartoonization Spike v0

按 [Issue #3 架构评审授权](https://github.com/DeepDreamerLSC/home-memory/issues/3#issuecomment-6097156587)(2026-10-10)执行。
**仅离线实验,不接产品代码,不建队列/适配器/LoRA。**

## 要验证的问题(评审原话)

> 能否让 10 件不同的真实物品拥有统一、可爱的品牌画风,同时用户仍能轻易分辨每一件原本是什么。

即:**物品身份保持 + 品牌风格一致**,二者同时成立。美术质量好但身份丢失(所有充电器长得一样)= 失败。

## 实验设计

| 项 | 值 |
| --- | --- |
| 样本 | **6 件真实物品照片**(用户提供,日常物品,建议外观有区分度:充电器/钥匙/药膏/剪刀/充电宝/水杯类) |
| 方案 A | 固定风格 prompt + 固定种子(风格只靠文字锚定) |
| 方案 B | 风格参考图(图1=物品照片,图2=画风样例;Edit-Plus 多图官方能力) |
| 生成 | 每件 A/B 各 1 张 = **12 张**;1024px、30 步、true_cfg 4.0、seed 42 |
| 预处理 | **无**(评审裁定:背景移除不设必经,本组数据即"不抠图"基线,抠图对照留后续) |
| 评价 | VLM 辅助 + **人工盲评为主**(review.md 表格);门槛:≥5/6 身份可辨认、无严重错件、≥5/6 风格符合 |

## 环境

试点环境可直接复用(diffusers 0.41 + torch 2.14 + **torchvision**,MPS):

```bash
uv venv /tmp/qwen-img-venv --python 3.11
uv pip install --python /tmp/qwen-img-venv/bin/python \
  diffusers transformers accelerate torch torchvision pillow protobuf sentencepiece
```

模型用本地权重 `~/Desktop/work/models/Qwen-Image-Edit-2511`(零下载)。
注意:该 diffusers 版本 Edit-Plus 管线不支持纯文生图,image 必传。

## 运行

1. 风格样例(一次性,已生成则跳过):`make-style-sample.py` 产出 `style-ref/style-sample.png`
2. 放 6 张照片进 `inputs/`,**文件名=物品名**(如 `充电器.jpg`)
3. 跑:`/tmp/qwen-img-venv/bin/python run_spike.py`(本机约 6.5 分钟/张,12 张串行约 80 分钟)
4. 填 `outputs/review.md` 盲评表;参数、耗时、种子全在 `outputs/manifest.json`

## 红线(与 Issue #3 一致)

- 不入正式数据库、不改小程序代码;实验图片不上传公开仓库
- 云端 API(qwen-image-edit-plus 等)与本地 2511 **不视为同一版本**,性能与一致性需单独实测;云端商用许可需单独审云服务条款,不从 Apache 2.0 推导
- 本实验不构成产品化授权
