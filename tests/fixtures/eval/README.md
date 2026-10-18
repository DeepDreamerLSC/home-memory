# AI Eval 冻结样例集(#83 E0-B)

- 版本:**v1**(2026-10-18,分支 `feat/issue83-eval-e0`)。任何样例/期望的改动都必须开新版本号(v2、v3…),旧版本结果不与新版本混算;版本变更在本文件末尾登记。
- 上游依据:`docs/eval/coverage-matrix.md`(E0-A 覆盖与缺口矩阵)。本目录只立**新冻结基线**——没有可重放的历史证据,不宣称任何「修复前后提升」(铁律③)。
- 消费方:E1 点火时**原位扩展** `tests/samples-live.js` 驱动本目录(不新建框架)。当前该脚本只跑 v1 单件入口(矩阵 §0),尚未接本目录——本 commit 仅落评测资产,不接线。

## 1. 目录与规模

| 目录 | 规模 | 用途 |
| --- | --- | --- |
| `dev/` | 30 例(extract 15 / locsplit 7 / editparse 8) | **可看可调**:迭代调优、试错、观察模型行为都在这里跑 |
| `val/` | 23 例(extract 12 / locsplit 5 / editparse 6) | **封存**:只在正式评测跑,见 §5 数据集纪律 |
| `legacy-contract/` | 6 例(s02/s04/s05/s06/s11/s15) | v1 历史合同存档,**不参评** |

旧 16 条 `tests/fixtures/samples/`(v1 冻结,2026-10-09)**原样保留不动**——`tests/extractDraft.test.js` 的样例集元测试与 v1 L0 合同仍消费它。本目录的处置:
- 仍合现行 v2 合同的 10 条迁入 dev/(s01、s07、s09、s12、s13、s14)与 val/(s03、s08、s10、s16),`origin=legacy`;
- 期望与现行 v2 目标相反或无 v2 对应语义的 6 条(s05 类 needs_split、s02/s04/s11 后缀期望、s15 错误面)入 `legacy-contract/`,每条带 `retired_reason` 与 `v2_note`(双标去处)。

## 2. 样例字段规范

每例一个 JSON 文件,必需字段:

```json
{
  "id": "val-ex-05",              // 与文件名一致,全局唯一
  "task": "extract | locsplit | editparse",
  "input": { … },                 // 直接可发给云函数的 event,三任务形状见 §3
  "essentials": [                 // 机器可判断言:全部通过 = PASS,任一不过 = FAIL
    { "path": "drafts.0.name", "op": "equals", "expect": "护照" },
    { "path": "drafts.0.mount_path", "op": "null" }
  ],
  "human_criteria": "一句话说清什么样的输出算真正正确(含 essentials 锁不死的弹性)",
  "origin": "真实语料(本周真机) | 新构 | legacy"
}
```

可选字段:`note`(判据依据/归因说明/校准史)、`deps`(见 §4)。

### essentials 判定语义(runner 必须按此实现)

- **path 根对象 = 生产链响应 JSON**:extract 是 `handler({text, protocol:2})` 的返回(`{ok, drafts[], original_text, truncated, engine}`);locsplit 是 `locationSplit` 的返回(`{ok, engine, path[], fallback}`);editparse 是 `draftEditParse` 的返回(`{ok, engine, intent, target, edits, added, new_location, needs_pick, picks}`)。
- path 以点号分隔,数组用数字下标(`drafts.0.name`、`edits.0.field`);**解析不到的路径(字段缺失/越界)按 JSON null 处理**——据此可用 `{"path":"drafts.5.name","op":"null"}` 断言「最多 5 件」。
- 三个操作符:
  - `equals`:JSON 深度相等(数组逐元素相等;对象键序无关);
  - `contains`:值为字符串时包含 `expect` 子串;值为数组时存在元素与 `expect` 深度相等(用于 name 跨度弹性、quote 最小片段弹性);
  - `null`:值为 JSON null(含字段缺失)。`null` 操作没有 `expect`。
- essentials 只锁**最小可判集**:锁不死的合理弹性(限定语跨度、两可的 vague、不强制断言的 mount_path)留给 `human_criteria`,并在 `note` 里写明为什么没锁。

## 3. 三任务 input 形状

```json
// extract(生产语音入口现行合同,miniprogram/utils/voice-entry.ts:361 同款)
{ "text": "……", "protocol": 2 }

// locsplit
{ "action": "locationSplit", "text": "……" }

// editparse(draft_id 为合成 36 位 UUID,不含真实数据)
{ "action": "draftEditParse", "text": "……", "batch_location": "……",
  "candidates": [ { "draft_id": "…", "name": "…" } ] }
```

## 4. deps:固定「今天」注入

涉日期补全/相对换算的样例带 `deps: {"today": "2026-10-18", "anchorToday": "2026-10-18"}`——runner 把它们包成函数传给 handler 的 `deps.today()`(prompt 里【今天】,无年份日期补全基准)与 `deps.anchorToday()`(服务端闭集换算锚点,Asia/Shanghai 口径),保证冻结期望不随运行日期漂移。不带 deps 的样例不得引入任何日期依赖。

## 5. 数据集纪律(防过拟合)

1. **dev 可看可调**:对着 dev 调 prompt/修补逻辑/参数随便调;调整后请把发现登记进版本记录(只登记结论,不贴 prompt 原文)。
2. **val 封存**:
   - 只许在正式评测(基线、里程碑、发布前)跑 val,不许在日常迭代里反复跑 val 挑实现;
   - **绝不许为了让某个实现通过 val 而修改 val 的任何样例、期望或 essentials**;
   - 发现 val 金标本身错了(判据错,不是实现不行):记录在案,以**新版本号**发布修正,并注明受影响样例与理由;旧版本分数不追溯混算。
3. **legacy-contract 不参评**:它只证明 2026-10-09 的 v1 合同通过史,不得进任何 v2 分数的分母分子。
4. 判分一律「essentials 全过 = PASS」;FAIL 的归因写模型层还是生产层,见 §6。

## 6. 归因分层(铁律②:每例同时看「模型原始输出」与「生产链结果」)

essentials 判的是**生产链终态**(含服务端修补)。E1 runner 必须另行截获并分开计分:

- **extract 链**:在引擎回调(`callLLM`/`callLocalLLM`)处截获模型原始 JSON,单独判模型层;`drafts` 是修补终态(锚定降级、B3 归属剥离、闭集换算都发生在服务端)。`remind_converted=true` 是服务端换算的指纹——`remind_at` 对而 `converted` 缺失,说明模型越权折算(会被对应锚定判 FAIL,不会误 PASS)。
- **locsplit 链(当前归因盲区)**:用已导出的 `validateLocationSplitOutput`(handler.js)对模型原始输出单独跑模型层判分;终态里的 `fallback:true` 是修补兜底的指纹。同形不同因的例子:`val-ls-05` 的单段是模型自觉(要求 fallback=false),fallback 兜底也是单段——必须靠原始输出区分。
- **editparse 链**:服务端强制 needs_pick/降级与模型意图判定已分层(`validateDraftEditOutput`),mock 已锁;缺模型层真实证据,val-ed-02/05 即其冻结样例。

## 7. 覆盖矩阵缺口 → val 样例映射(每缺口至少 1 例)

| 矩阵缺口(§5) | val 冻结样例 |
| --- | --- |
| 1. v2 多件逐件(截断/交叉配对) | val-ex-07(has_more 截断)、val-ex-08(否定插入语防交叉) |
| 2. 日期三态 + vague | val-ex-09(绝对日期+跨件归属)、val-ex-10(闭集换算 converted)、val-ex-11(闭集外灰行)、val-ex-03(无提醒态) |
| 3. 方位后缀剥离 | val-ex-05(s02 文本双标)、val-ex-06;dev 侧 dev-ex-07(0.7.0 原句) |
| 4. mount_path | val-ex-05、val-ex-06、val-ex-07(单段) |
| 5. locationSplit 层格实体 + #80/#81 模型层 | val-ls-01(#80)、val-ls-02(#81)、val-ls-03(本周原句,句尾目的地陷阱)、val-ls-04(上层) |
| 6. draftEditParse 语义锁定/行号反例 | val-ed-01(内容词锁定,本周原句)、val-ed-02(歧义)、val-ed-05(行号反例) |

铁律①的落地:历史合同(s05 类 needs_split、s02/s04/s11 后缀期望)在 `legacy-contract/` 带退役理由存档;同文本的 v2 判据在 dev-ex-09(dev)、val-ex-05/val-ex-12(val)另立,两套判据分开计分、不混判、不算回归。

## 8. 隐私与密钥纪律

- 全部样例为**合成语料**:「真实语料(本周真机)」条目是本周真实失败形态的合成复刻(合成物品/位置/UUID),不含任何家庭真实隐私数据。
- 密钥绝不入库、入样例、入日志:DeepSeek key 只从环境变量 `DEEPSEEK_API_KEY` 读;本地推理 token 只在运行时从 `~/Desktop/work/hm-llm-infra/.token` 读(环境变量或 fs 直读该路径,代码里只允许出现这个路径字符串)。
- 评测日志/证据文档只落:样例 id、PASS/FAIL/SKIP、失败的字段路径与差异码、engine、样例集版本;**绝不落 prompt 原文、用户输入原文、位置/物品内容**。

## 9. 版本记录

- v1(2026-10-18):首版冻结。dev 30 / val 23 / legacy-contract 6;覆盖矩阵全部 6 个样例缺口在 val 各有 ≥1 例;真实语料(本周真机)5 条:dev-ls-02、val-ls-01/02/03、val-ed-01(其余为新构或 legacy 迁移/双标)。校验:53 例 dev+val 金标经生产链回放(mock 理想模型输出→真实 handler/locationSplit/draftEditParse)全部自洽。
