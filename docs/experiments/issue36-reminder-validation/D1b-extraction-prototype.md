# D1b 一句话提取原型:prompt 设计、冻结语料与离线 mock 评测(issue #36 研究件)

> 定位:issue #36 §3 P0 研究「语音/文字一句话同时提取物品、明确位置、用户说出的时间与事项」的**原型规格与评测框架**。docs-only:零部署、零 key、零网络,不改生产代码、不建生产 schema;本文件与 `scripts/experiments/reminder-spike/` 共同构成交付件。
> 与现有 `extractDraft`(只提物品+位置)的关系:本原型在其「只提取、待确认、禁幻觉」的契约上扩展时间/事项维度;**不是**要改动现有云函数,未来是否落地由 #36 GO 决策另立 PRD 再授权。

## 1. 输出 schema(prompt 草案全文见 `scripts/experiments/reminder-spike/prompt-draft.txt`)

一句话 → 一个 `items` 数组(本批语料每句单事项),每件:

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `item_name` | str ≤50 | 物品名(允许去掉纯连接词「的」;不要求逐字,但不得无中生有) |
| `location_text` | str ≤200 | 位置,**必须来自原文**(语气词可剔除);不确定则空串 |
| `location_certain` | bool | 位置是否肯定(沿用现有 extractDraft 语义) |
| `task.kind` | enum | replace / clean / warranty / return / consume / expiry / other / none |
| `task.raw` | str ≤50 | 原话中的事项动词,逐字;没有则空串 |
| `time.type` | enum | absolute_date / relative_weekday / relative_period / recurring_period / after_open / production_shelf_life / vague / none |
| `time.raw` | str ≤50 | 原文时间表达逐字保留 |
| `time.period_value` + `period_unit` | int + day/week/month/year | 周期数值与单位(适用时) |
| `time.base` | enum | record_date / completion_date / open_date / open_date_unstated / production_date / null —— **基准日必须显式** |
| `time.production_date` | YYYY-MM-DD / null | 仅 production_shelf_life:用户陈述的生产日期 |
| `time.repeat` | bool | **仅用户明说「每/每隔」才为 true**;「半年后」是单次 |
| `due.date` | YYYY-MM-DD / null | 候选日期;给不出就 null |
| `due.month` | YYYY-MM / null | 月精度候选(如「保修到2027年3月」) |
| `due.need_confirm` | bool | 是否必须用户确认(默认 true) |
| `due.reason` | 固定码 | EXPLICIT_DATE / RELATIVE_BASE_MUST_CONFIRM / WEEKDAY_AMBIGUOUS / AFTER_OPEN_BASE_UNKNOWN / OPEN_DATE_BASE_MUST_CONFIRM / PRODUCTION_CONVERSION / MONTH_PRECISION / VAGUE_EXPRESSION / NO_TIME_STATED / MEDICAL_EXCLUDED_ROUND1 / NO_TASK |
| `suggest_period` | {period_value, period_unit} / null | **仅 vague** 时允许给建议周期(供用户一键确认),不是日期 |
| `excluded_medical` | bool | 药品/医疗类首轮排除标记 |
| `has_reminder` | bool | 是否产生提醒候选(纯位置记录为 false) |
| `source_quote` | str ≤200 | 原话逐字子串(证据锚定,同 extractDraft 协议 v2) |

## 2. 日期纪律(#36 §6 的可执行化)

| 时间表达 | type | 基准 | 候选日期 | need_confirm |
| --- | --- | --- | --- | --- |
| 「2027年6月30号保修到期」 | absolute_date(日) | — | 原文日期 | **false**(EXPLICIT_DATE) |
| 「保修到2027年3月」 | absolute_date(月) | — | 只给 `due.month`,不给日 | true(MONTH_PRECISION) |
| 「半年后提醒我换」 | relative_period | record_date(明示) | 录入日+6 月 | true(RELATIVE_BASE_MUST_CONFIRM) |
| 「每三个月换一次」 | recurring_period | record_date / completion_date | 首次=基准+3 月,repeat=true | true |
| 「下周五要还」 | relative_weekday | record_date | 日历推算 | true(WEEKDAY_AMBIGUOUS) |
| 「开封后三个月用完」(没说何时开封) | after_open | open_date_unstated | **null** | true(AFTER_OPEN_BASE_UNKNOWN) |
| 「昨天开封,开封后六个月过期」 | after_open | open_date(=录入日-1,须换算) | 开封日+6 月 | true(OPEN_DATE_BASE_MUST_CONFIRM) |
| 「生产日期10月5号,保质期六个月」 | production_shelf_life | production_date | 生产日期+保质期 | true(PRODUCTION_CONVERSION) |
| 「差不多半年就该换了」 | vague | — | **null**,只给 suggest_period | true(VAGUE_EXPRESSION) |
| 「记得除垢」(没说时间) | none | — | **null** | true(NO_TIME_STATED) |
| 「备用遥控器在抽屉里」(没有事项) | none | — | null | false(NO_TASK,纯位置记录) |
| 药品/医疗类(胰岛素、退烧药…) | — | — | **null**,`excluded_medical=true`,`has_reminder=false` | true(MEDICAL_EXCLUDED_ROUND1) |

硬规则(写入 `run_mock.py` 的校验器,违规即保守修正并记违规码):

- **R1** 位置锚定:`location_certain=true` 时位置必须是 `source_quote`(退而求其次为原话)的子串,否则清空降级——幻觉防线,同现有 extractDraft 协议 v2;
- **R2** vague 绝不折算日期;**R3** 开封日未陈述不给日期;**R4** 月精度只给 month 且必须确认;
- **R5** `need_confirm=false` 仅限「用户明说完整年月日」的 absolute_date;
- **R6** 医疗排除:不得为医疗类产出提醒候选;**R7** 未明示周期不循环(repeat 仅 recurring_period);**R8** 一切换算/推算类一律 need_confirm=true。
- 禁止根据物品名称猜测维护周期或保质期(如看到「墨盒」就编 6 个月)。

## 3. 冻结语料(34 句,≥30 达标;金标基准日 2026-10-13)

类别覆盖(对应 #36 D1b 要求):相对周期 5(c01–c04、c32)/ 明示循环 4(c05–c07、c33)/ 星期表达 1(c08)/ 绝对日期 4(c09–c11、c20)/ 开封后 3(c12–c14)/ 生产日期+保质期换算 3(c15–c17)/ 保修期 3(c18–c20,含月精度 2)/ 无日期纯位置 5(c21–c24、c34)/ 有事项无日期 2(c25–c26)/ 模糊表达 3(c27–c29)/ 医疗排除 2(c30–c31)/ ASR 口语噪声 2(c32–c33)/ 用户自我取消 1(c34);归还日由 c08/c09 覆盖。

- 文件:`scripts/experiments/reminder-spike/corpus.jsonl`(逐句 `{id, category, text, gold}`)。
- **性质声明**:语料为研究员按真实口语风格编写,不是用户真实录音;只用于评测提取规则,**不得当作用户行为或需求证据**。
- 冻结留档(sha256,2026-10-13):corpus `b5069b54a77b94bd457d55d0927a5248b82751189818c411abf4e71857a6eeb4`;mock `f045468a6aa5f8f96ea07fff419361012a99cf9dd88cd0190c97a55bd711ab92`;prompt `b9f31a3da6dd2738f061376d08a9cd46436b7a4d8f39ef453659d66054e7d9a7`。

## 4. 离线 mock 评测(`run_mock.py`,零 key 零网络)

- **管线**:固定 mock 响应 → JSON 提取(同 `extractDraft/lib/validate.js` 的围栏容忍口径)→ 结构校验 + R1–R8 纪律修正 → 与金标逐字段 deep diff → `outputs/report.json` / `report.md`。
- **注入偏差**(6 处,证明三层检出能力,不代表真实模型表现):c01 位置幻觉 / c07 换算未要求确认 / c13 开封基准日算错(校验器测不出的算术错,靠金标比对层抓)/ c27 模糊表达被静默折算 / c30 医疗类未排除 / c34 响应非 JSON。
- **2026-10-13 运行结果**:语料 34 句;注入 6 检出 6;干净句意外差异 0;结论 **PASS**(退出码 0)。完整表格见 `scripts/experiments/reminder-spike/outputs/report.md`。
- **TODO(不在本批)**:真实 LLM 跑批(如 DeepSeek)须另立实验授权后,把 `mock-responses.jsonl` 换成真实响应源;金标日期字段需按运行日重算或维持固定基准日并明示。

## 5. 红线自检

- 未创建生产提醒表/云函数/推送任务;未改 `miniprogram/`、`cloudfunctions/`、`tests/`;无 `.ts` 新增;
- 全部输出为**待确认候选**,schema 层面不可能静默持久化虚构日期/位置(R1–R8 + UI 待确认态);
- 医疗类首轮排除已进 schema 与校验器;药品有效期判断不做(#1 非目标维持不变)。
