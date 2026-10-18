# E1 点火方案(#83)

- 生成:2026-10-18,分支 `feat/issue83-eval-e0`。本文是 **E0 交付的收口件**与 **E1 的执行方案**;其中标「建议」的数字需主会话 / #83 评审拍板后才生效,本文不自行生效。
- 上游四件套:覆盖矩阵 `docs/eval/coverage-matrix.md` → 冻结样例集 `tests/fixtures/eval/README.md`(v1)→ runner `scripts/eval/run.js` → 基线报告 `docs/eval/2026-10-18-{dev,val}-local.md`(同名 `.json`)。索引见 `docs/eval/README.md`。
- 三铁律贯穿全文(#83 评审):①历史合同(legacy-contract)与现行目标分开、不混判;②每例双判「模型原始」与「生产链终态(含修补)」;③没有可重放证据不宣称提升——**E0 只立新冻结基线 B1**,E1 起才允许「B1 vs Bn」的比较,且必须同样例集版本、同引擎、超过波动容差才算数。

## 0. E0 交付清单与基线 B1(事实,不是建议)

| 件 | 路径 | 状态 |
| --- | --- | --- |
| 覆盖与缺口矩阵 | `docs/eval/coverage-matrix.md` | 已交(E0-A) |
| 冻结样例集 v1 | `tests/fixtures/eval/`(dev 30 / val 23 / legacy-contract 6) | 已交(E0-B) |
| runner(双路归因) | `scripts/eval/run.js` | 已交(E0-C/D);`--set dev\|val\|all`、`--limit`、`--timeout-ms`(`run.js:67-105`) |
| 基线报告 B1 | `docs/eval/2026-10-18-dev-local.md` / `2026-10-18-val-local.md` + 同名 `.json` | 已交(E0-D,bug 修复 00eaaf4 后重跑) |

**基线 B1 的身份四元组**(新基线编号的依据,见 §7):样例集 **v1** · 引擎 **local**(mlx_lm.server,Qwen3.6-35B-A3B-4bit,temperature 0.1,max_tokens 2000,`cloudfunctions/extractDraft/lib/local-llm.js:103-104`;单调用超时 60000ms,`run.js:58`)· 生产代码与评测器 **commit 1459beb**(评测器修复 00eaaf4 已含)· DeepSeek 降级在评测中 **stub 禁用**(`run.js:341-344`)。

B1 数字(来自同名 `.json` 的 `summary`;生产通过率 = PASS/(PASS+PARTIAL+FAIL)):

| 集 | n | PASS | PARTIAL | FAIL | 生产通过率 | 模型层 PASS | 修补救回 | 需人工复核 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dev | 30 | 27 | 2 | 1 | 90% | 25 | 2(dev-ed-04/06) | 3(dev-ed-07, dev-ex-08, dev-ex-15) | 137.7s |
| val | 23 | 18 | 3 | 2 | 78% | 16 | 2(val-ed-03/04) | 5(val-ed-01, val-ed-02, val-ed-05, val-ex-01, val-ls-03) | 114.0s |

B1 的稳定性事实(`.json` 逐例 flags):53 例 **0 例触发坏 JSON 重试、0 例两路采样不一致、0 例 UNPARSE/UNAVAIL/SKIP**——即模型层全部可判、归因完整。分组:val 提取 11/12、位置拆分 4/5、语音编辑 3/6。

## 1. 模型范围

| 路 | 引擎 | 用途 | 权限/前置 | 现状 |
| --- | --- | --- | --- | --- |
| **主路** | 本地 A3B(Qwen3.6-35B-A3B-4bit,经隧道 `LOCAL_LLM_BASE`,OpenAI 兼容) | dev 调优、val 正式评测、所有新基线 | token 只在运行时从 `LOCAL_LLM_TOKEN` 或 `~/Desktop/work/hm-llm-infra/.token` 读(`run.js:54`、`:121`),绝不打印、绝不入库 | **可用**,B1 即此路 |
| **对照** | DeepSeek `deepseek-flash`(`cloudfunctions/extractDraft/lib/deepseek.js:33`) | 只做 val 并列对照,回答「本地主路相对云端是否明显掉队」;不做基线、不参与验收门槛 | ① 需主会话授权使用 `DEEPSEEK_API_KEY`(费用与来源由主会话定,云函数侧同名变量 `cloudfunctions/extractDraft/index.js:52`);② runner **目前没有** `--engine` 开关,DS 在评测中是即抛 stub(`run.js:341-344`),需先做 §6 的评测器扩展 | **当前不可跑**;未授权则对照项记 **SKIP**(不是 PASS、不是「视同通过」) |
| 不在范围 | vlRecognize 视觉识别、ASR 上游、locations 侧 parseLocation | 矩阵 §7 相邻范围;照片冻结样例未立 | E1 不评 |

引擎路由事实:handler 传入 `callLocalLLM` 即 local 优先、失败降级 `callLLM`;不传则直走 `callLLM`(`cloudfunctions/extractDraft/lib/handler.js:241-251`)。因此 DS 对照模式在 runner 里只需**不注入** `callLocalLLM`、把 `callLLM` 注入 `lib/deepseek.js` 的真实调用,生产链零改动。

## 2. 调用预算(每集每引擎次数上限)

每例调用数由 runner 结构决定(`run.js:321-424`):生产链 1 次 + 模型原始直调 1 次 = **2 次**;坏 JSON 带错重试**最多 1 次**(`handler.js:218-231`,locationSplit/draftEditParse 同款 `:393`/`:606`),且直调只复用首份 prompt、不重试 → 每例 **上限 3 次**。B1 实测 0 重试,常规按 2 次算。

| 集 | 例数 | 单轮全量(常规 / 上限) | 引擎 | E1 期间轮次上限(建议) | E1 期间调用上限(建议) |
| --- | --- | --- | --- | --- | --- |
| dev | 30 | 60 / 90 | 本地 A3B | 可看可调,**≤ 5 轮/日**,E1 总 **≤ 20 轮** | ≤ 1800 |
| val | 23 | 46 / 69 | 本地 A3B | 只在正式评测跑,每次正式评测 = **2 轮**(波动校验,§4.3),E1 **≤ 3 次正式评测**(点火复核后 / 调优收口 / 终验) | ≤ 414 |
| val | 23 | 46 / 69 | DeepSeek 对照 | **≤ 2 轮**(一次对照 + 一次复核重跑),需授权 | ≤ 138 |
| dev | — | — | DeepSeek | **0**(dev 只给主路调优用,不烧云端) | 0 |
| legacy-contract | 6 | — | 任何 | **0**(铁律①,`run.js:14` `--set` 不含它) | 0 |

时间预算:B1 实测 ≈ 4.6-5.0 s/例(含两路),一轮 all ≈ 4.2 min,一次正式 val 评测(2 轮)≈ 4 min;隧道/本地机器不在线时**该轮作废**(任一例 UNAVAIL 即归因不完整,不得出结论,`run.js:386`)。超时上限保持 60000ms,不为「让更多例过」而放宽。

超预算处置:超出即停、升级主会话,不「再跑一次看看」。dev 轮次上限是防止无意识刷分;val 轮次上限是防过拟合(§5)。

## 3. 素材权限

| 素材 | 状态 | E1 处置 |
| --- | --- | --- |
| 合成语料(dev 30 / val 23 / legacy-contract 6) | **已冻结 v1**,全部合成(含「真实语料(本周真机)」标注的 5 条也是合成复刻,`tests/fixtures/eval/README.md` §8) | 可入库、可跑、可引用 id 与 expect |
| 真实用户语音/照片素材 | **需用户授权,当前不进** | E1 **不使用**。即便将来授权:不入库、不入日志、不入样例文件,只允许本机运行时读;评测报告仍只落 id + 判定 + 字段路径 + 差异码。启用须另立阶段(E2)并先过隐私方案,本方案不预设 |
| 旧 16 条 `tests/fixtures/samples/` | v1 冻结(2026-10-09),`tests/extractDraft.test.js` 的 L0 合同仍消费 | 原样不动;不进 E1 分数 |
| `docs/samples-evidence.md`(2026-10-09 deepseek-flash 16/16) | v1 合同历史证据 | 只作历史参考,**不可外推**到 v2/拆分/编辑(矩阵 §4) |

## 4. 验收标准(建议——数字待主会话确认)

E1 验收的是「**评测流程成立且基线不退化**」,不是「质量达标」;三项同时满足才算过。

### 4.1 val 集 essentials 通过率阈值(不退化门)

以 B1 为锚、容差 1 例(23 例中 1 例 = 4.35 pp):

| 指标 | B1 | 建议门槛 |
| --- | --- | --- |
| val 生产层 PASS | 18/23(78%) | **≥ 17/23**(≥ 74%) |
| val 模型层 PASS | 16/23 | **≥ 15/23** |
| 分组生产 PASS:提取 / 位置拆分 / 语音编辑 | 11/12 · 4/5 · 3/6 | **≥ 10/12 · ≥ 3/5 · ≥ 2/6**(每组不得比 B1 少超过 1 例) |
| UNAVAIL / UNPARSE / SKIP | 0 | **= 0**,否则该轮无效 |
| 修补救回 | 2 | 不设门槛,但每一例必须有 §4.2 的 C1/C2 分类 |

这是**下限**不是目标:任何「比 B1 高」的说法,须同样例集版本、同引擎、两轮重跑都高出 B1 **超过容差(≥ 2 例)**才能写进报告(铁律③的 E1 延伸)。

### 4.2 人工复核闭环流程

输入 = runner 报告的「需人工复核」ids + 「修补救回」ids(`run.js:529-531`、`:454-457`)。B1 待复核:val 5 例 + dev 3 例 + 救回 4 例(val-ed-03/04、dev-ed-04/06),共 **12 例**。

每例结论**三选一**,登记到 `docs/eval/review-log.md`(列:id · 基线编号 · 结论类别 · 一句理由 · 处置 · 日期;**不记输入/输出原文**):

| 类别 | 含义 | 处置 |
| --- | --- | --- |
| **A 模型真错** | essentials 与 human_criteria 都对,模型就是没做到 | 样例**不动**;进「已知失败清单」作 dev 调优目标;只允许对着 dev 调(§5) |
| **B 判据锁太死 / 金标错** | human_criteria 认可的输出被 essentials 误判 | **唯一合法的改 val 途径**:以样例集**新版本号 v2** 发布修正,登记受影响 id 与理由;旧版本分数不追溯混算(`tests/fixtures/eval/README.md` §5.2) |
| **C 生产层问题** | 修补应兜住未兜、或修补误伤 | 代码 issue → 修复 → 重跑 all → 新基线编号(§7) |

修补救回例再分两类,避免把「形状补齐」误读成「模型质量问题」:**C1 形状补齐**(模型漏了字段、服务端补缺省——B1 的 val-ed-03/04、dev-ed-04 均为 `needs_pick:missing_or_null` 被补成 false,见 `.json` 的 `model.failed`)只登记不处置;**C2 语义改判**(服务端改写了模型的判断:`loc_repair_rewrote`/`ed_coerced_pick`/`ed_intent_changed`,`run.js:429-439`)须按 A/B/C 复核模型层是否真错。dev-ed-06 的差是 `target+edits.0.field`,须人工看属 C1 还是 C2。

**闭环定义**:12 例全部登记结论,A 类进已知失败清单、B 类已随 v2 发布、C 类已开 issue(修复可排在 E1 之后,但 issue 必须存在)。未闭环不得进入 §4.3 的正式评测。

### 4.3 两次重跑波动容差

temperature 0.1 非确定(B1 恰好 0 例两路不一致,但不能假定永远如此)。每次**正式** val 评测 = 同四元组下**连跑 2 轮**:

- 两轮总 PASS 差 **≤ 1 例**;逐例判定翻转(PASS ↔ 非 PASS)**≤ 2 例**;
- 翻转例列出 id、标「采样敏感」、进 §4.2 复核;
- 超出任一容差 → 该次评测标「不稳定」,先查引擎(隧道/服务状态、`raw_deviation` 标志),再加跑第 3 轮,**每例取三轮多数**作为该例判定,报告注明;三轮仍超容差 → 不出结论,升级主会话;
- 门槛(§4.1)按**两轮中较低的一轮**判。

在 runner 加 `--repeat n`(§6)之前,两轮用两条命令、两个 `--out` 文件名(后缀 `-r1`/`-r2`)手工完成,报告里并列引用。

## 5. 禁项(违反 = 该轮结果作废、返工)

1. **不得针对 val 修改提示词 / 修补规则 / 参数**:任何调优只对着 dev;val 只在正式评测跑(§2 轮次上限),不得在日常迭代里反复跑 val 挑实现。
2. **不得为了让实现通过 val 而改 val 的样例、期望或 essentials**:改 val 的唯一途径是 §4.2 的 B 类 → 新版本号。
3. **改动后必须重跑全量并出新基线版本号**:prompt、服务端修补、评测器判分逻辑、样例集任一变化 → 跑 `--set all` → 新编号 Bn(§7)。只跑 dev 或 `--limit` 小样本的结果**只能叫 smoke**,不得叫基线、不得进验收。
4. **不得把 legacy-contract 算进分数**(铁律①);不得把 s05 类 `needs_split` 当 v2 多件 Gold。
5. **不得宣称修复前后提升**,除非:两边都是可重放基线(有编号、同样例集版本、同引擎)、差异超过 §4.3 容差、且写明比较的是哪两个编号。B1 之前没有可重放基线,所以 **E1 内不得出现「相比修复前」字样**。
6. **不得在评测里真调 DeepSeek 降级**(本地失败如实记 `local_engine_failed`),除非是显式 `--engine deepseek` 对照模式且已授权;对照结果**单独出报告、不与本地混算**。
7. **密钥与隐私**:token/key 绝不入库、入码、入日志、入报告;代码里只允许出现 `~/Desktop/work/hm-llm-infra/.token` 这个路径字符串;报告/日志/review-log 绝不落 prompt 原文、输入原文、模型输出原文、位置/物品实际内容。
8. **评测器改动必须标注且不触样例 essentials**(E0-D 先例);评测器改动后 B1 的 `.json` 不得被重写——新结果一律新文件。
9. **不 push、不部署**;commit 前 `git branch --show-current` 必须为 `feat/issue83-eval-e0`。

## 6. E1 执行步骤(建议顺序;①不耗调用预算)

| 步 | 内容 | 产物 | 预算 |
| --- | --- | --- | --- |
| ① | 人工复核 B1 的 12 例(§4.2),登记 review-log | `docs/eval/review-log.md` | 0 |
| ② | 若有 B 类:样例集 v2(改 `tests/fixtures/eval/README.md` 版本记录 + 受影响样例)→ 跑 all → **B2** | 新报告 + v2 | 1 轮 all(≈106 次) |
| ③ | 评测器扩展(标注为评测器改动,不触样例):`--engine local\|deepseek`(DS 模式不注入 `callLocalLLM`、`callLLM` 与直调均走 `lib/deepseek.js`);`--repeat n` 自动两轮并出翻转清单;报告头部加基线编号与 commit hash | `scripts/eval/run.js` + 离线 smoke | smoke `--limit 3`(≤ 9 次) |
| ④ | dev 调优循环:针对 A 类已知失败改 prompt/修补 → 只跑 dev → 登记发现(结论,不贴 prompt) | dev 报告(smoke 性质) | §2 dev 上限内 |
| ⑤ | 收口:跑 all ×2 → **Bn**;按 §4.1/§4.3 判 | 新基线报告 ×2 | 2 轮 all |
| ⑥ | DeepSeek 对照(**仅在主会话授权 key 后**):`--engine deepseek --set val` | `docs/eval/<日期>-val-deepseek.md`(单独文件) | ≤ 2 轮 val |
| ⑦ | E1 收口报告:基线编号对照表(B1→Bn,四元组差异)、review-log 闭环状态、禁项自检、预算实耗 | `docs/eval/e1-report.md` | 0 |

④ 与 ⑤ 之间若 prompt/修补有改动,**必须**先 `npm test`(`node --test "tests/**/*.test.js"`)全绿与 `npm run typecheck` 过,再跑评测——L0 合同不能被 L1 调优打破。

## 7. 基线版本号规则

- 编号 **B1、B2、…**;**当且仅当**四元组 {样例集版本, 引擎/模型/采样参数, 生产代码(prompt 与修补)commit, 评测器判分逻辑 commit} 任一变化,并完成 `--set all` 全量重跑,才递增。
- 报告文件名保留 `docs/eval/<日期>-<set>-<engine>.md`,正式评测两轮加 `-r1`/`-r2`;报告头部(③扩展后由 runner 自动写入,之前手工加)注明编号、四元组、与上一编号的差异项。
- 旧编号的 `.md`/`.json` 永不改写;比较只在编号之间、按 §4.3 容差。
- DeepSeek 对照报告不占 B 编号,文件名以 `-deepseek` 区分,头部引用它对照的 B 编号。

## 8. 授权边界(需主会话 / 用户决定,本方案不代为决定)

1. §4 全部门槛数字(≥ 17/23、≥ 15/23、分组、容差 1 例/翻转 2 例)——本文为建议;
2. `DEEPSEEK_API_KEY` 的使用授权、费用上限与 key 来源——未授权则 §6 ⑥ SKIP;
3. 真实用户语音/照片素材——当前不进,启用须另立阶段与隐私方案;
4. §2 轮次上限——建议值,主会话可收紧或放宽;
5. 隧道/本地机器的可用时段——E1 正式评测需连续 ≈ 10 min 在线。

---

*证据:`scripts/eval/run.js`(CLI `:67-105`,引擎配置 `:120-146`,两路 `:321-424`,归因 flags `:426-457`,复核定义 `:529-531`);`cloudfunctions/extractDraft/lib/handler.js:218-231`(重试一次)、`:241-251`(引擎路由);`lib/local-llm.js:103-104`;`lib/deepseek.js:33`;`index.js:52`;`docs/eval/2026-10-18-{dev,val}-local.json` 的 `summary` 与逐例 `flags`/`model.failed`;`tests/fixtures/eval/README.md` §5/§6/§8;`docs/eval/coverage-matrix.md` §4/§6/§7。*
