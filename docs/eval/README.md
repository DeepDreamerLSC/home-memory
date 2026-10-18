# AI Eval 评测资产索引(#83)

本目录是 #83「AI 能力评测」的交付汇总。四件套按产生顺序排列,后一件以前一件为依据;读的顺序也照此。

## 四件套

| # | 件 | 路径 | 一句话 |
| --- | --- | --- | --- |
| 1 | 覆盖与缺口矩阵(E0-A) | `docs/eval/coverage-matrix.md` | 三任务(提取 / 位置拆分 / 语音编辑)逐能力点盘「守住 / 部分 / 缺口」与责任层;§4 历史合同 vs 现行目标差异;§5 缺口排序 |
| 2 | 冻结样例集 v1(E0-B) | `tests/fixtures/eval/README.md`(+ `dev/` 30、`val/` 23、`legacy-contract/` 6) | 字段规范、essentials 判定语义、dev/val 纪律、归因分层约定、缺口→val 样例映射、隐私纪律 |
| 3 | 基线报告 **B1**(E0-C/D) | `docs/eval/2026-10-18-dev-local.md` · `docs/eval/2026-10-18-val-local.md`(各有同名 `.json`) | 本地 A3B 新冻结基线:dev 90%(27/30)、val 78%(18/23);逐例双判、失败清单含人工判据、修复贡献统计 |
| 4 | E1 点火方案 | `docs/eval/e1-plan.md` | 模型范围、调用预算、素材权限、验收标准(建议)、禁项、执行步骤、基线编号规则、授权边界 |

配套:runner `scripts/eval/run.js`(用法见文件头注释与 `--help`);旧 v1 合同的 live 证据 `docs/samples-evidence.md`(2026-10-09,仅历史参考,不可外推)。

## 复跑

```sh
# 需本地推理 token:env LOCAL_LLM_TOKEN 或 ~/Desktop/work/hm-llm-infra/.token(绝不入库、绝不打印)
node scripts/eval/run.js --set val --out docs/eval/<日期>-val-local.md
node scripts/eval/run.js --set dev --out docs/eval/<日期>-dev-local.md
node scripts/eval/run.js --set dev --out /tmp/smoke.md --limit 3     # smoke,不是基线
```

`--set` 永不含 legacy-contract;DeepSeek 降级在评测中 stub 禁用(对照模式待 E1 扩展,需 key 授权)。

## 三铁律(#83 评审;所有件都遵守)

1. 历史合同样例(legacy-contract,s05 类 `needs_split`)与现行「一句话多件」目标分开标注,不混判、不进分数;
2. 归因分层——每例同时记录「模型原始输出」与「生产链终态(含修补)」,位置拆分要能看出是模型拆对还是确定性修补救的;
3. 没有可重放的历史证据不得宣称修复前后提升——E0 只立新冻结基线 B1;B1 起的比较规则见 `e1-plan.md` §4.3/§7。

## 纪律摘要

- val 封存:只在正式评测跑;**绝不**为了让实现通过而改 val;金标错 → 新版本号;
- 任何 prompt / 修补 / 评测器 / 样例改动 → 全量重跑 → 新基线编号;旧报告永不改写;
- 报告 / 日志只落样例 id、判定、字段路径、差异码、expect(合成资产)、engine、耗时、版本——绝不落 prompt 原文、输入原文、模型输出原文、位置/物品实际内容;密钥绝不入库。

## 变更记录

- 2026-10-18:四件套齐(矩阵 → 样例集 v1 → 基线 B1 → E1 方案),分支 `feat/issue83-eval-e0`。
