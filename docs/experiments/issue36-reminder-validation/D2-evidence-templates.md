# D2 匿名事件表 + 真实机会分母模板(issue #36 研究件)

> 定位:issue #36 §7 交付件 D2,服务 §4 E1 记录与 E2「30 天自然使用观察」。**不追求录入件数好看**;分母=真实机会,机会不足单列,绝不算成功/失败;人工提醒的效果不得写成小程序已支持的通知能力。
> 载体:本模板定义字段与口径,实际记录用离线表格(CSV/表格软件),**不建任何生产集合,不向真实家庭写共享数据**(#34 边界)。

## 0. 匿名规则

- 家庭匿名 id:`F##`(如 F03),参与者 `F##-P1 / F##-P2`;id→真实身份映射表只存研究者本地加密存储,**绝不入仓库**。
- 事件时间只记到「日」,不记时分;自由文本先脱敏(人名/地址/手机号/微信号为「某人/某处」)。
- 原始录音与用户授权上传的照片按最小留存原则:试验结束 30 天内删除,不进原始日志。

## 1. 匿名事件表(一行 = 一个事件)

| 字段 | 类型 / 枚举 | 说明 |
| --- | --- | --- |
| `event_id` | 字符串 | 全局唯一(如 F03-E012) |
| `household_anon_id` / `participant_anon_id` | F## / F##-P# | 匿名 id |
| `event_date` | YYYY-MM-DD | 只到日 |
| `event_type` | record_created / record_edited / lookup / reminder_due / completed / snoozed / disabled / no_action / record_deleted / negative | 事件类型 |
| `slice_or_tool` | A / B / C / D / own_tool | 该事件发生的切片或用户自选工具(自然使用期出现 own_tool 很重要,记下是什么) |
| `item_anon` | 字符串 | 物品匿名描述(「净水器滤芯」可直接记,含人名地名时脱敏) |
| `entry_source` | self_initiated / researcher_prompted / researcher_entered / task_forced | **录入来源标注**(#36 §4,分母纪律) |
| `time_breakdown` | 引用 D1 §7.1 字段组 | t_asr / t_extract / t_review_edit / t_correction_total / t_save / t_total_s(仅 record_created 填;人工模拟标 wizard_manual) |
| `corrections` | 引用 D1 §7.1 字段组 | 分字段纠错数 + 纠错性质 |
| `opportunity_occurred` | bool | 该事件是否对应一次「真实机会」(定义见 §2) |
| `opportunity_type` | maintenance_due / expiry_due / warranty_window / return_due / tidying / cannot_find / purchase / none | 机会类型 |
| `reminder_status` | due_in_window / scheduled_future / outside_window / no_reminder | 提醒是否在观察窗内真实到期(**窗口外与无提醒单列,不算成败**) |
| `action_result` | completed / snoozed_correct / snoozed_wrong / disabled / no_action / pending_outside_window | 行动结果;`snoozed_wrong`=反复延期或延到过期之后 |
| `location_helped` | yes / partially / no / not_needed + 备注 | 位置是否帮助找到物品/完成事项 |
| `position_status` | correct / moved / wrong / unknown | 上次确认位置与实际对比 |
| `wizard_delivered` | bool + 渠道 | 是否为研究员人工送达提醒(人工介入率分子) |
| `negative_note` | 文本 | 负面案例备注(错日期/骚扰/负担/误点等) |
| `researcher_note` | 文本 | 研究员观察,双源核对用 |

## 2. 真实机会分母定义(#36 §4 E2 口径)

一次**真实机会**须同时满足:

1. **真实发生**:观察窗内该家庭发生了一个可记录或可行动的具体事件(到期/维护/保修/归还/收纳/找不到),用户能说出时间与对象;「应该会有」「大概会换」不算;
2. **未经提示**:事件发生时用户未被研究员当场引导(研究员提示后代录的,单独归为「提示机会」,只统计不进主动分母);
3. **与试验对象相关**:或与已录入物品/提醒相关,或用户面对该机会选择用了别的工具(记 `slice_or_tool=own_tool` + 是什么——这是 D0 对照表的现场证据)。

**机会不足**:观察窗内无满足上述定义的事件 → 家庭记 `opportunity_insufficient`,**单列,不进任何成败分母**。

指标映射(阈值只用于本轮决策,#36 §5):

| §5 指标 | 用本表算式 |
| --- | --- |
| 主动二次使用 | 有第二次 `entry_source=self_initiated` 录入的家庭数 ÷ 发生 ≥1 次真实机会的家庭数(机会不足剔除单列) |
| 真实兑现 | 窗内真实到期事件中 (completed + snoozed_correct) 占比;no_action 单列;样本不足只报原始数 |
| 组合独立增益 | `location_helped ∈ {yes, partially}` 且 `event_type ∈ {completed, snoozed_correct}` 的可复盘案例数(目标 ≥3),同时报告无增益案例 |
| 事实与安全 | 虚构日期/位置被持久化的次数(目标 0,双源核对:事件表 × 研究员日志);跨家庭访问/误写次数(目标 0) |
| 人工介入率 | `wizard_delivered=true` 的事件数 ÷ 全部 reminder_due 事件(解读结论时必须随附此率) |

## 3. 7–14 天首轮记录表(E1 结束即建,逐日更新)

**家庭级 sheet(一行 = 一户)**:

| 字段 | 说明 |
| --- | --- |
| `household_anon_id` / 需求分层(强/弱)/ S5 日历习惯(是/否) | 招募信息回填 |
| `entered_count_by_source` | 四类 entry_source 的录入条数分布 |
| `opportunity_count` / `opportunity_insufficient` | 真实机会数;机会不足标记 |
| `second_self_initiated` | yes / no / insufficient_opportunity |
| `reminders_due` / `action_breakdown` | 窗内到期数与五类行动结果分布 |
| `wizard_delivery_count` | 人工提醒送达次数(介入率) |
| `negative_case_ids` | 关联负面案例编号 |
| `dropped_out` + 原因 | 退出/失联 |
| `daily_checkin_compliance` | 每日一句话打卡完成率(衡量记录质量,不衡量用户) |

**事件级 sheet**:即 §1 事件表。**记录节奏**:每日一句话事件打卡(微信)+ 每周一次 15 分钟电话回访;研究员人工提醒送达后 48 小时内补记 `action_result` 与 `location_helped`。

## 4. 30 天复访表(E2,半结构化 30 分钟)

数据核对优先于访谈:逐条对齐事件表后再问感受。

| 编号 | 问题 | 核对/记录字段 |
| --- | --- | --- |
| R1 | 这 30 天,家里真实发生了哪些和「到期/维护/保修/归还/找东西」有关的事?(逐件核对事件表,补漏、纠错) | 事件表增补 + `corrections_made`(用户纠正研究员记录的条数) |
| R2 | 每次提醒到达时你实际做了什么?(逐条核对 action_result;没有行动的问清是「不需要」还是「没顾上」) | action_result 修正 |
| R3 | 「上次确认位置」有没有真的帮你找到东西/完成事项?有没有位置已经变了的? | location_helped / position_status 修正 + 案例原话 |
| R4 | 有没有第二次(以及之后)你自己主动去记?当时是什么场景? | second_self_initiated + 场景描述 |
| R5 | 这 30 天你实际在用什么工具处理这些事?(对照 D0 表逐行问变化) | slice_or_tool=own_tool 的分布变化 |
| R6 | 还是那三张卡:只保留一个功能,现在你选谁?和一个月前一样吗?为什么变了? | 排序变化 + 原话 |
| R7 | 有没有觉得烦、错、多余的提醒?差点被记错的日期/位置? | 负面案例登记(§5) |
| R8 | 接下来还愿意继续这样用吗/愿意推荐给家里人吗? | 意愿记录(不当作行为证据) |

**家庭级 30 天卡片**(每户一张,进入 D3 决策材料):机会数、行动分布、二次使用结论、组合增益案例(≥1 个详细复盘)、负面案例数、人工介入率、`corrections_made`、研究员备注。

## 5. 负面案例记录格式(单独登记,不许省略)

| 字段 | 说明 |
| --- | --- |
| `case_id` / `household_anon_id` / 关联 `event_id` | 索引 |
| `type` | 虚构候选差点入库 / 日期或基准错 / 位置错或失效 / 提醒骚扰或疲劳 / 维护负担 / 误点完成或重复提醒 / 隐私不适 / 其他 |
| `what_happened` | 匿名化描述(发生了什么、谁发现、何时) |
| `root_cause` | 候选错 / 用户误操作 / 研究员流程错 / 规则缺口(D1b R1–R8 未覆盖) |
| `user_quote` | 用户原话(脱敏) |
| `consequence` / `resolution` | 后果与处置(撤回/停用/道歉/数据更正) |
| `metric_impact` | 对 §5 哪项指标有影响(如「事实与安全 +1」) |
| `design_implication` | 免费记录,不构成任何功能承诺 |

## 6. 口径红线(引用 #36,防止数据漂移)

- 周期长达数月的事项只验证**预约提醒的愿望**,不假装已验证半年后的履约价值;
- 无真实触发的事项、窗口外到期、机会不足的家庭,**单列,绝不计入成败**;
- 用户改用手机日历/其他工具完成事项,是**有效观察结果**(进入 STOP/PIVOT 证据),不是「流失」;
- 人工提醒的一切效果只归因于人工渠道,`wizard_delivered` 必须随结论披露;
- n 小:只报告原始数与逐案例复盘,禁止宣称统计显著性与市场结论。
