# reminder-spike 离线 mock 评测报告(自动生成)

- 生成时间:2026-10-13T11:01:16.173338+00:00
- 参考日期(金标基准):2026-10-13
- 声明:响应来自固定 mock 文件,零网络零 key;检出结论只证明**评测框架可跑**,不代表任何真实模型表现。真实 LLM 跑批为 TODO(需独立实验授权)。
- sha256 留档:corpus=b5069b54a77b94bd… / mock=f045468a6aa5f8f9… / prompt=b9f31a3da6dd2738…

| id | 类别 | 解析 | 纪律违规 | 金标差异 | 注入偏差检出 |
| --- | --- | --- | --- | --- | --- |
| c01 | relative_period | ok | R1_HALLUCINATED_LOCATION | $.location_certain: False != True; $.location_text: '' != '厨房水槽下面的柜子里' | hallucinated_location → validator:R1_HALLUCINATED_LOCATION |
| c02 | relative_period | ok | - | - | - |
| c03 | relative_period | ok | - | - | - |
| c04 | relative_period | ok | - | - | - |
| c05 | recurring_period | ok | - | - | - |
| c06 | recurring_period | ok | - | - | - |
| c07 | recurring_period | ok | R5_CONFIRM_FREE_TOO_LOOSE | - | need_confirm_violation → validator:R5_CONFIRM_FREE_TOO_LOOSE |
| c08 | relative_weekday | ok | - | - | - |
| c09 | absolute_date | ok | - | - | - |
| c10 | absolute_date | ok | - | - | - |
| c11 | absolute_date | ok | - | - | - |
| c12 | after_open | ok | - | - | - |
| c13 | after_open | ok | - | $.due.date: '2027-04-13' != '2027-04-12' | wrong_open_base_date → comparator:due |
| c14 | after_open | ok | - | - | - |
| c15 | production_shelf_life | ok | - | - | - |
| c16 | production_shelf_life | ok | - | - | - |
| c17 | production_shelf_life | ok | - | - | - |
| c18 | warranty_month | ok | - | - | - |
| c19 | warranty_month | ok | - | - | - |
| c20 | warranty_day | ok | - | - | - |
| c21 | location_only | ok | - | - | - |
| c22 | location_only | ok | - | - | - |
| c23 | location_only | ok | - | - | - |
| c24 | location_only | ok | - | - | - |
| c25 | task_no_time | ok | - | - | - |
| c26 | task_no_time | ok | - | - | - |
| c27 | vague | ok | R2_VAGUE_DATE_FORBIDDEN | - | silent_guess_on_vague → validator:R2_VAGUE_DATE_FORBIDDEN |
| c28 | vague | ok | - | - | - |
| c29 | vague | ok | - | - | - |
| c30 | medical_excluded | ok | - | $.excluded_medical: False != True; $.has_reminder: True != False | medical_not_excluded → comparator:excluded_medical |
| c31 | medical_excluded | ok | - | - | - |
| c32 | asr_noise | ok | - | - | - |
| c33 | asr_noise | ok | - | - | - |
| c34 | user_cancel | RESPONSE_NOT_JSON | - | - | malformed_json → parse_error |

## 汇总

- 注入偏差 6 处,检出 6 处
- 干净句 28 句,意外差异/违规 0 句
- 结论:**PASS**
