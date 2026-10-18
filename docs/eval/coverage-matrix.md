# E0-A 能力覆盖与缺口矩阵(#83)

- 生成:2026-10-18,分支 `feat/issue83-eval-e0`,仅盘点不改测试代码。
- 范围:#83 三任务——语音/文字提取(extractDraft)、位置层级拆分(locationSplit)、语音受限编辑(draftEditParse)。拍照视觉识别(vlRecognize)不在本矩阵三维度内,见 §7 相邻注记。
- 判定词:**守住**(有自动门且当前通过)/ **部分**(只有某一层守住,另一层无证据)/ **缺口**(无任何资产守住)。
- 每行标注**责任层**:L0=确定性合同测试(mock 模型/纯函数);修补=服务端确定性修补代码;UI=小程序页面测试(stub 云函数);L1=真实模型调用证据。

## 0. 入口与引擎路由事实(评测 subject 的前提)

| 入口 | 代码 | 引擎链 |
| --- | --- | --- |
| extractDraft v1(单件合同,`needs_split`) | `cloudfunctions/extractDraft/lib/handler.js:148`,prompt `handler.js:34-47` | local 优先→DeepSeek 降级(`handler.js:239-251`);质量失败不降级 |
| extractDraft v2(`protocol:2` 多件逐件) | 路由 `handler.js:170`,prompt `handler.js:73-88`;**生产语音入口已用 v2**(`miniprogram/utils/voice-entry.ts:361`) | 同上 |
| locationSplit(`{action:"locationSplit",text}`) | `handler.js:1022`,prompt `handler.js:884-894`,输入限 1-200 码点(`handler.js:878`),≤6 段×30 码点(`handler.js:879-880`) | 同款双引擎(`handler.js:1073-1082`) |
| draftEditParse(`{action:"draftEditParse",…}`) | `handler.js:758`,prompt `handler.js:561-571`,`EDIT_DRAFT_ID_MAX=64`(`handler.js:548`) | 同款双引擎(`handler.js:837-846`) |
| 客户端确定性兜底 | `miniprogram/utils/photo-intake.ts:502-514` `splitLocationSegments`:仅按「·/​/-的/空白」切分,**拆不开无分隔符中文**,LLM 失败时兜底单段 | — |

关键事实:live 脚本 `tests/samples-live.js:107` 只发 `{text}`(**v1 合同,未带 `protocol:2`**),未调用 locationSplit/draftEditParse/vlRecognize;未配 Key 时 `samples-live.js:97` 打印指引后 **exit 0(SKIP 语义,不得计 PASS)**。

## 1. 矩阵一:语音/文字提取(extractDraft)

| 能力点 | 现有资产(引用) | live 证据 | 判定 | 说明(归因层) |
| --- | --- | --- | --- | --- |
| 单件提取(name/location_text/certain/qualifiers) | 冻结样例 12 条(s01-s04、s07-s14、s16;其中 s07-s10 为不肯定/无位置,s13/s14 为长度边界);`tests/extractDraft.test.js:160`(逐条 validateDraft)、`:172`(handler 全链)、`:187`(不肯定空位置)、`:202`(幻觉防护);样例集元测试 `:140` | `docs/samples-evidence.md`(2026-10-09,deepseek-flash,16/16)——**仅 v1 合同** | **守住**(v1 合同层) | L0 全绿(本分支实测 `node --test tests/extractDraft.test.js tests/photo-location-split.test.js tests/photo-draft-edit.test.js` 121/121 通过);L1 只有 2026-10-09 的 v1 历史证据,**不能外推 v2 生产链**(生产走 protocol:2) |
| 多件逐件提取(现行「一句话多件」目标) | 仅 mock:`tests/extractDraft.test.js:525`(两件拆分)、`:540`(共用位置)、`:577/:591`(拒空/超5件/名称非法不静默丢件)、`:637`(has_more 截断)、`:680/:695`(交叉配对防护)、`:747/:760`(anchor_shared) | **无**(live 脚本只跑 v1) | **缺口**(L1 层)/ L0 部分 | v2 无一条冻结样例;s05/s06 是 v1 `needs_split` 历史合同,**不是** v2 多件 Gold(见 §4) |
| 日期三态(明确绝对日期带提醒候选 / 模糊·相对·月精度不换算 / 无时间) | 仅 mock:`tests/extractDraft.test.js:874`(金标)、`:891`(类别枚举)、`:970`(对抗:折算穿透不了硬门)、`:1047/:1064`(quote 锚定)、`:1125`(格式硬门)、`:1152`(半态禁止)、`:1281-:1342`(B2 显式年份遮蔽)、`:1395-:1510`(B3 跨件日期归属) | 无 | **部分** | L0 硬门密不透风(全部 mock);16 条冻结样例**零日期样例**,模型在真实输入上会不会按第 7 条自觉输出 null——无任何证据 |
| 模糊时间透明标记(vague)+闭集换算 | 仅 mock:`tests/extractDraft.test.js:1540`(半年后→converted)、`:1564`(互斥)、`:1579`(反例)、`:1621`(词形)、`:1662`(对抗);换算器 L0:`tests/relative-date.test.js`;v1 零变化 `:1739` | 无 | **部分** | 换算在服务端组包层(`handler.js:270-272`),L0 已锁;模型「标不标 vague、标得对不对」无真实证据、无冻结样例 |
| 方位后缀剥离(「冰箱里面」→「冰箱」) | 仅 mock v2:`tests/extractDraft.test.js:1971`(正例)、`:1989`(旧式带后缀同样过锚定=零放松)、`:2010`(prompt 纪律) | 无 | **部分** | 现行 v2 目标是剥后缀裸实体(`handler.js:77` 规则2);**旧冻结样例 s02/s04/s11/s12 的期望反而是带后缀原样**(v1 合同,见 §4)——现行目标零冻结样例且历史期望与之相反 |
| mount_path 放进路径预览 | 仅 mock v2:`tests/extractDraft.test.js:1780`(正例逐字投影)、`:1798`(多件独立)、`:1812`(certain=false 强制 null)、`:1825`(模糊不猜)、`:1845`(错序/编造 null)、`:1863`(形状门)、`:1884`(方位词并入前段)、`:1903/:1930`(零回归)、`:1951`(prompt 纪律) | 无 | **部分** | 服务端锚定硬门 L0 守住;模型「层级拆不拆得对」无冻结样例、无 live 证据。照片流不走此链(`photo-intake.ts:489-497` 注释:photo 流程无 v2 mount_path 环节,走 locationSplit) |
| 输入/形状边界(1-500 码点、坏 JSON 重试、AI_UNAVAILABLE) | `tests/extractDraft.test.js:315`(超长/空白)、`:260/:275`(坏 JSON 重试)、`:287/:300`(抛错→AI_UNAVAILABLE);双引擎链 `tests/extractDraft-local-llm.test.js:276-:381` | n/a | **守住**(L0) | 与语义能力无关的合同层,已覆盖 |
| 可容忍别字(ASR 误转写近似) | s11(「玄官」)、s12(「充气简」)冻结样例 + `:160/:172` 逐条驱动 | 2026-10-09 v1 过 | **守住**(v1)/ v2 未测 | #83 E0-B 点名的「ASR 同音误转写」族只有这 2 条近似正例,无成族反例(如语序倒装、口癖插入) |

## 2. 矩阵二:位置层级拆分(locationSplit)

真实失败史:#80「书房桌子的右边抽屉」方位词独立成段、层级漏拆;#81 二次「书房桌子中间抽屉」方位词向后粘(`桌子中间|抽屉`)。现行防线 = prompt 规则(`handler.js:884-894`)+**服务端确定性修补**(`handler.js:946-1007`:方位词独立段并后/前段、段尾方位词前移、逐字有序锚定,不过即整串单段兜底 `fallback:true`)+ 手动改层级 UI 收口。

| 能力点 | 现有资产(引用) | live 证据 | 判定 | 说明(归因层) |
| --- | --- | --- | --- | --- |
| 连接字(「的/了」前后实体拆开,不出现在段内) | prompt 规则2+worked example(`handler.js:888/:892`,字符串断言 `tests/photo-location-split.test.js:409-410`);跳连接字锚定正例 `:97`(主卧的床头柜→[主卧,床头柜]) | 无 | **部分** | **「的」粘段修补不剥**:模型输出 `[书房,桌子的右边抽屉]` 时锚定合法、原判直通,靠手动编辑收口——这是测试**如实锁定**的行为(`tests/photo-location-split.test.js:421-422` 注释「由手动改路径收口」;UI 收口 `tests/photo-page.test.js:2183` PP-LOCPATH-6)。模型层是否真拆开「的」:零证据 |
| 方位词独立成段(#80 失败族) | 修补层:`handler.js:978-997`(并后段→并前段→fallback);回归测试 `tests/photo-location-split.test.js:407` LOC-SPLIT-DIR:模型 4 段(右边独立)→修补成 3 段;末位方位段并前段 `:424-428` | 无 | **守住**(修补层 L0)/ 模型层缺口 | 断言对象全是**修补后终态**——「模型拆对」还是「修补救的」目前不可区分(#83 评审铁律②;`validateLocationSplitOutput` 已导出 `handler.js:1121`,E1 可用它对模型原始输出单独判分实现归因分层) |
| 前后粘:段尾方位词前移(#81 失败族) | 修补层:`handler.js:951-977`;回归测试 `tests/photo-location-split.test.js:434` LOC-SPLIT-DIR2:`桌子中间\|抽屉→桌子\|中间抽屉`;**负例/同族反例**:末段段尾方位词保留真语义(`书房桌子中间` 原判直通,`:443-444`)、前移不锚定维持原判走整体锚定门(`:446-447`) | 无 | **守住**(修补层 L0,含同族正反例对)/ 模型层缺口 | 同上,断言在修补后终态;模型是否原生输出 `[书房,桌子,中间抽屉]` 无真实证据 |
| 层格实体独立成段(「第二层」「上层」) | 仅 prompt 规则3例外句 + 例句「厨房冰箱第二层」(`handler.js:889/:892`) | 无 | **缺口** | 无任何测试断言层格实体独立成段、且不被方位词修补误并(DIR_WORDS 词表 `handler.js:949-950` 不含「第二层/上层」,但这个「不误伤」没有测试锁定);无冻结样例 |
| 单实体(拆不出层级→单段整串) | `tests/photo-location-split.test.js:86`(玄关→[玄关],fallback=false) | 无 | **守住**(L0 mock) | 无真实输入证据,但该行为由代码确定性保证,风险低 |
| 超长/形状门(text>200、>6 段、段>30 码点、编造/乱序段) | `tests/photo-location-split.test.js:204`(超 200 INVALID_INPUT)、`:145`(超限→单段兜底)、`:163`(恰 6 段×恰 30 码点过)、`:124`(编造段兜底)、`:138`(乱序兜底);坏 JSON 重试 `:179/:192`;引擎链 `:225-:252`;日志纪律 `:268`;胶水 `:352` | n/a | **守住**(L0) | 小缺口:text **恰 200 码点放行**无断言(只有 201 拒绝)。UI 侧行为(在途去重/慢解析不阻塞保存/失败零打扰)由 `tests/photo-page.test.js:2023-:2175` PP-LOCPATH-1..5 守住(stub 云函数) |

## 3. 矩阵三:语音受限编辑(draftEditParse)

| 能力点 | 现有资产(引用) | live 证据 | 判定 | 说明(归因层) |
| --- | --- | --- | --- | --- |
| 三类操作(edit / add / batch_location)+ none | `tests/photo-draft-edit.test.js:103`(edit 逐字段)、`:123`(add)、`:133`(batch_location)、`:142`(none);edits 硬门 `:232`(白名单/空值/超3项截断);降级 `:264`;引擎链 `:312-:360`;日志纪律 `:377`;胶水 `:460`;UI 全链 `tests/photo-page.test.js:546-:714` PP-VOICE-1..6(diff 逐字段勾选/add/batch_location/none/AI_UNAVAILABLE)+ 手动编辑面板 PP-EDIT(`:989` 起) | 无 | **守住**(L0+UI,均离线 mock)/ L1 缺口 | UI 测试 stub 了云函数(locationSplit 默认桩 `tests/photo-page.test.js:38`、路由 `:76`),「按内容词锁定候选」的**语义匹配能力**(如「品客的薯片罐」→「黄色薯片罐」,prompt 规则1 `handler.js:564`)只有 mock 假设,无冻结样例无真实证据 |
| 歧义(needs_pick:对不上唯一候选绝不执行) | 服务端强制:`handler.js:657-662`(draft_id 不在清单→强制 needs_pick+全量 picks+edits 清空)、`:703-705`(picks 回退全量);测试 `tests/photo-draft-edit.test.js:172/:193/:216`;UI 点选重放 PP-VOICE-3(`tests/photo-page.test.js:618`) | 无 | **守住**(L0+UI)/ L1 缺口 | 「绝不按第N个行号锁定」的负例(用户说行号时的行为)无样例 |
| 跨端契约 #68(draft_id 真实 UUID 36 位) | `tests/photo-draft-edit.test.js:499`(36 位 uuid 过形状门,真机回归 0.9.8)+ `:295`(65 位拒);上限 64 `handler.js:548` | n/a | **守住**(L0,评审已裁定留在 L0,不花 L1 token) | — |

## 4. 历史合同样例 vs 现行目标差异(评审铁律①:分开标注,不混判)

16 条 fixture 冻结于 2026-10-09(commit fe94c27),**早于** v2 协议、#80/#81 修复(2026-10-17/18)与 locationSplit 上线。逐项差异:

| 样例 | 历史合同(v1,仍然有效) | 与现行目标的差异 |
| --- | --- | --- |
| s05/s06(多件需拆分) | `needs_split:true` + 固定话术「一次只记一件物品,请分开说」(`handler.js:40` 规则4;`tests/extractDraft.test.js:131`) | **现行目标是 v2 逐件提取进 items[]**(`handler.js:76`,生产 `voice-entry.ts:361`)。s05/s06 只守 v1 旧客户端合同,**不得充当 v2 多件 Gold**;v2 评分须另立样例。两条责任线并存,不删旧例也不混判 |
| s02/s04/s11/s12(位置含方位后缀) | v1 期望 `location_text` 原样含「里/上/最里面」等后缀 | 现行 v2 目标是**剥后缀裸实体**(`handler.js:77` 规则2)。同一输入在 v1/v2 下的正确答案不同——E1 若用这些文本跑 v2,expect 必须双标(v1 原样 / v2 剥后缀),否则误判为回归 |
| s13/s16(真机校准) | note 字段记录 2026-10-09 按实测校准(「过冬的厚被子」「最上面」) | 其 authority 是「模型实测+人工复核」的软金标,不是纯人工预期——冻结时须标注此身份(#83 E0-B 的 authority 字段) |
| s15(无法提取名称) | v1 合同:空名称→`AI_UNAVAILABLE` | v2 同类输入是「名称非法整次拒绝」路径(`tests/extractDraft.test.js:591`),错误面形状不同;跨协议复用需重写 expect |
| 全部 16 条 | 均无日期/vague/mount_path 字段,均为单件或 needs_split | 对 §1 中「日期三态/模糊时间/方位后缀剥离/mount_path/多件逐件」五个现行维度**零覆盖** |

live 证据同理:`docs/samples-evidence.md`(2026-10-09T11:04:53Z,deepseek-flash,16/16)只证明当日 v1 合同通过,**不可外推**为 #80/#81 之后的拆分质量或任何 v2 能力(铁律③:无原始响应/模型/代码标识的可重放证据,不宣称修复前后提升,本轮只立新冻结基线)。

## 5. 缺口汇总(E0-B 冻结样例的优先方向)

按「现行目标零冻结样例」排序:

1. **v2 多件逐件**(一句话多件/共享位置/交叉配对反例)——0 样例;
2. **日期三态 + vague**——0 样例(对抗硬门已有 L0,缺的是模型自觉性证据);
3. **方位后缀剥离**——0 样例,且旧样例期望相反需双标;
4. **mount_path**——0 样例;
5. **locationSplit 层格实体**(第二层/上层)——0 样例 0 测试;#80/#81 已有**修补层**同族正反例对(LOC-SPLIT-DIR/DIR2 含末段保留负例),但**模型层**正反例对 0(#83 E0 Exit 要求的「同族正反例对」在模型责任层尚未成立);
6. **draftEditParse 语义锁定**(内容词匹配/行号反例)——0 样例;
7. live runner 缺口:无 PASS/FAIL/SKIP 状态区分(SKIP=exit 0,`tests/samples-live.js:97`)、无 engine/prompt/样例集版本标识、只驱动 v1 一个入口——E1 按评审「原位扩展 samples-live.js」补,不新建框架;
8. L0 小缺口:locationSplit text 恰 200 码点放行无断言(`tests/photo-location-split.test.js:204` 只测 201 拒)。

## 6. 归因分层现状(铁律②)

- 提取链:模型输出→`validateDrafts` 硬门/服务端换算(`handler.js:270-272`),现有测试以 mock 分别锁两层,归因可行;
- **拆分链是当前归因盲区**:所有断言都在「修补后终态」上。E1 须对每例同时记录 ①模型原始 path ②修补后生产 path(及 `fallback`/是否触发前移/合并),两者分开计分——`validateLocationSplitOutput`(`handler.js:1121` 已导出)即可作为分层判分钩子,无需新框架;
- 编辑链:服务端强制 needs_pick/降级逻辑与模型意图判定已分层(`handler.js:616-720`),mock 锁得住;缺真实模型层。

## 7. 相邻范围(不在本矩阵展开)

- 视觉识别 vlRecognize(`handler.js:440`):L0 由 `tests/photo-vl.test.js`(参数/坐标/日志/胶水 24 例)与 photo-* 系列守住;真实视觉质量 L1(漏检/重复/框漂,#65)0 证据,照片冻结样例(8-12 目标)属 #83 E0-B 单独清单,不混入本三任务矩阵。
- ASR 转写上游:`tests/transcribe.test.js` 为合同测试;「同音误转写成族样例」尚未冻结。
- locations 侧交互式 parseLocation(LLM 候选+逐段人工核对)是另一条位置链,`photo-intake.ts:489-497` 已注明与 locationSplit 的分工,本矩阵不计。

---

*证据索引:`gh issue view 83`(正文+架构评审评论 2026-10-18)、`tests/fixtures/samples/s01-s16.json`、`tests/samples-live.js`、`tests/extractDraft.test.js`、`tests/extractDraft-local-llm.test.js`、`tests/photo-location-split.test.js`、`tests/photo-draft-edit.test.js`、`tests/photo-page.test.js`、`tests/photo-vl.test.js`、`cloudfunctions/extractDraft/lib/handler.js`、`miniprogram/utils/photo-intake.ts`、`miniprogram/utils/voice-entry.ts`、`docs/samples-evidence.md`、git log(fixtures 冻结 fe94c27=2026-10-09;#80=24e0402、#81=6fbabbb)。本分支离线验证:`node --test tests/extractDraft.test.js tests/photo-location-split.test.js tests/photo-draft-edit.test.js` → 121 pass / 0 fail(零网络)。*
