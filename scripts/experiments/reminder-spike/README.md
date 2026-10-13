# reminder-spike:一句话提取原型离线实验(issue #36 D1b)

> 授权口径(issue #36):**docs-only 研究件**。零 API key、零网络、零第三方依赖(纯 Python 标准库),不改 `miniprogram/` 与 `cloudfunctions/` 生产代码,不建任何生产集合。照 `scripts/experiments/level1-spike/` 先例,实验资产与结论留在本目录。

## 文件

| 文件 | 说明 |
| --- | --- |
| `prompt-draft.txt` | 提取原型 prompt 草案(设计规格见 docs/experiments/issue36-reminder-validation/D1b-extraction-prototype.md) |
| `corpus.jsonl` | 冻结语料 34 句 + 逐句金标(基准日 2026-10-13) |
| `mock-responses.jsonl` | 固定 mock 响应(含 6 处人为注入偏差,证明检出能力) |
| `run_mock.py` | 离线评测:解析 → 纪律校验(R1–R8)→ 金标比对 → 报告 |
| `outputs/report.json` / `outputs/report.md` | 最近一次运行结果(自动生成,可复现) |

## 冻结留档(2026-10-13)

| 文件 | sha256 |
| --- | --- |
| corpus.jsonl | `b5069b54a77b94bd457d55d0927a5248b82751189818c411abf4e71857a6eeb4` |
| mock-responses.jsonl | `f045468a6aa5f8f96ea07fff419361012a99cf9dd88cd0190c97a55bd711ab92` |
| prompt-draft.txt | `b9f31a3da6dd2738f061376d08a9cd46436b7a4d8f39ef453659d66054e7d9a7` |

## 运行

```bash
python3 scripts/experiments/reminder-spike/run_mock.py
# 期望输出:注入 6 检出 6;干净句意外问题 0;结论 PASS;退出码 0
```

## 红线

- mock 结果**不代表任何真实模型表现**,只证明评测框架(schema 校验 + 金标比对)可跑;
- 真实 LLM 跑批为 TODO,须经独立实验授权(不在 issue #36 本批);
- 语料为研究员编写的高仿真实口语样本,**不是用户真实录音**,不得当作用户行为证据引用。
