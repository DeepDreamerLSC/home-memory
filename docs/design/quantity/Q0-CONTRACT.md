# Q0 公共合同:家庭物品轻量数量管理(issue #102,方案 A)

- 状态:**DESIGN FROZEN(Q0 合同冻结)/ NOT AUTHORIZED TO IMPLEMENT**。本文档是 issue #102 §4「Q0:合同与迁移审查」的唯一权威产物;Q1/Q2/Q3 的实施 PR 以本文为公共合同,实施前仍需 Owner 逐段单独授权。
- 需求唯一来源:issue #102 正文(§0 裁定、§1 领域合同、§2 录入入口、§3 语音数量操作、§4 分阶段、§5 反例验收、§7 并行编排)。本文引用其条目时写作「issue §x.y」。
- 所有权(issue §7 并行纪律 3):`items.quantity/unit` 数据合同、`ItemsApiEvent`/`ItemSummary`/`ItemRecord` 等公共类型、`createItem`/`updateItem`/`photoCommit`/`videoSceneCommit`/`quantityAdjust` 的公共协议定义**由 Q1 独占实现**;Q2/Q3 发现缺口一律提合同 change request 上报裁决,绝不自行修改公共定义。Q0(本文)只冻结合同,不改任何业务代码。
- 基线:main = 944bef3;`npm test` 1044/1044 全绿(本文为纯文档,Q0 交付后测试套件必须仍全绿——已验证,见 §15 变更记录)。
- 本文引用的行号均为 main=944bef3 时的代码位置,仅作现状锚定;实施阶段以最新 main 为准复核。

## 0. 一页摘要(冻结决定一览)

| 决定 | 冻结值 |
| --- | --- |
| 单位闭集 UNIT_SET | `件/个/包/盒/瓶/袋/支/双/套/卷/张/本/罐/只`(issue §1 候选 14 值全取,只增不减,见 §2.2) |
| quantity 类型与边界 | `Number.isInteger`;新建(create 类插入)1..9999;已有(update/quantityAdjust 结果)0..9999;0=确认「目前没有」 |
| legacy unset 读侧表达 | 投影携带 `quantity: number\|null` 与 `unit: string\|null`,**双 null ⇔ 数量未确认**;绝不回填、绝不由 note 推断(见 §2.4) |
| 新建缺省=1 触发条件 | 仅 create 类入口的**插入路径**且请求 `quantity` 键**缺席**(undefined)时写 `quantity:1, unit:"件"`(见 §5) |
| 语音数量写 action | 统一为单一 action `quantityAdjust`,`mode: "add"\|"subtract"\|"set"`(见 §7.1) |
| 语音数量解析提议 | extractDraft 新增零写 action `quantityIntentParse`(见 §7.8) |
| 照片同帧多框降级 | 合并行(≥2 个来源框)`photo.box = null` 整照关联;单来源行保留原框(见 §8) |
| 视频 observation ≠ quantity | observation 数/frame 数/VL confidence/名称匹配永不赋值 quantity;`location_scans.confirmed_count` 语义不变(见 §9) |
| UI 防双展示 | 确认态物品的 note 若为旧 `×N 后缀` 形状,展示时剥掉 `×N` 词元(存储原文不动,纯展示变换,见 §10) |
| 不做 | 库存流水/SKU/阈值提醒/单位换算/自动合并已入库 item/跨位置数量搬移/#87/#85/#101 R1(见 §13) |

## 1. 领域铁律(逐条可测,L1-L12)

以下每条都可映射为至少一个离线测试断言(映射见 §12 反例矩阵):

- **L1(quantity 是用户确认值)**:`quantity` 的唯一来源是用户在确认页/详情页/语音确认弹层的明确动作。任何服务端与客户端代码**不得**从 observation 条数、frame 条数、highlights 条数、VL confidence、名称匹配、note 文本推断 quantity。反例锚点:`parseIntakeQtyNote`(miniprogram/utils/intake-draft.ts:65)提取的首段数字只允许作**预填提示**,未经用户保存确认不得落库(§4.3)。
- **L2(0 = 确认目前没有,绝不删除)**:`quantity: 0` 是合法的已确认值。数量归零**不触发** item 软删、不删除位置挂载、不删除提醒、不删除照片/视频证据行。删除物品(itemsApi.delete)与数量归零是两个独立操作,互不蕴含。
- **L3(整数、无换算)**:quantity 必须是 JS number 且 `Number.isInteger === true`。小数、数字字符串、NaN、Infinity 一律 INVALID_INPUT。不存在任何单位换算(1 盒 ≠ 自动换算 10 支);不同单位不得默默叠加(加/减/设的算术只在同 unit 下执行,见 §7.4)。
- **L4(边界)**:新建(create 类插入路径)1..9999;已有记录的修改(update / quantityAdjust)0..9999。上限 9999 为冻结常量 `QUANTITY_MAX = 9999`。
- **L5(unit 冻结闭集)**:unit 必须 ∈ UNIT_SET(§2.2)且为 string。闭集**只增不减**:新增单位 = 公共合同变更,走 change request + Owner 裁定;永不移除/改名已有值(旧数据永不失效)。
- **L6(存量 items 无字段 = 数量未确认)**:Q1 上线前已存在的 items 文档无 `quantity/unit` 字段,读侧表达为「未确认」(投影双 null,§2.4)。**不迁移、不回填生产数据**;绝不允许把旧 note 中的 `×3`、`500ml`、`2号抽屉` 等字符串解析升格为已确认数量。用户首次核对后经 update/quantityAdjust 写新字段。
- **L7(单条记录 ≠ 一件实物)**:`item_id` 是用户确认的一组「同类、同位置、同单位」实物的持久身份。用户可选 A(一条 item quantity=N)或 B(N 条独立 item);**默认绝不按同名/VL confidence/相邻帧静默合并**(现状锚定:video-scene.ts:252-254 `mergeSameName===false` 为默认;itemsApi create 从不按 name 查重,handler.js:2049-2050 注释)。已入库的不同 item_id 的合并不在一期(issue §1.5)。
- **L8(confirmed_count 语义不变)**:`location_scans.confirmed_count` 统计「确认的 item/草稿结果条数」,不是数量总和。带 quantity 的提交不改变该口径(§9.2)。
- **L9(家庭隔离 fail-closed 零写)**:quantity 相关一切写动作沿用既有硬门——服务端派生 household_id、共享家庭 `expected_household_id`+`expected_scope_revision` 双 marker(FAMILY_SWITCHED/FAMILY_STALE_SCOPE 零写)、跨家庭/不存在/已删统一 NOT_FOUND、家庭解析失败 HOUSEHOLD_UNAVAILABLE 先于一切读写。`quantityAdjust` 进 WRITE_ACTIONS(handler.js:2653-2665 与 miniprogram/utils/api.ts:596-614 两份清单在 Q2 同步增补)。
- **L10(数量进入校验、幂等与签名)**:涉及新建或数量更新的动作,quantity/unit 必须①进参数校验(§6);②进幂等内容判断(create 的 sameCreateContent、update 的 changesFingerprint、quantityAdjust 的 QA 指纹,§4/§7);③进载荷签名(videoSceneCommit 的 scene_payload_sig,§4.4)。
- **L11(旧客户端合法)**:不带 `quantity/unit` 的旧请求在所有既有 action 上继续合法且零行为回归(缺省规则见 §5;photoCommit/videoSceneCommit 携带新字段与否的签名与幂等逐字节兼容,§4.3/§4.4)。
- **L12(同帧两件)**:同一帧(或同一张照片)中的两件同类物品,允许用户确认「1 条 item ×2」或「2 条 item ×1」;默认(用户未操作合并)是 2 条独立行。绝不静默合并、绝不把其中一个框冒充「两件」的全部位置(§8)。

## 2. 数据合同(items 集合)

### 2.1 字段

items 文档新增两个可选字段(与既有 `remind_vague_quote`、`location_node_id` 同款「只增不改」模式):

```
quantity?: number   // 正整数 0..9999(新建写入时恒 ≥1);缺省 = 数量未确认(legacy)
unit?: string       // UNIT_SET 成员;缺省 = 数量未确认
```

- 不变量 **I1(成对不变量)**:文档上 `quantity` 与 `unit` **同现同缺**。任何写路径(Q1 的 create/update、Q2 的 quantityAdjust)不得产出半态(有 quantity 无 unit 或反之)。违反 I1 的存量/异常文档按「未确认」读(§2.4 防御性解析),不修复、不报错。
- 不变量 **I2(单一版本链)**:quantity/unit 的一切写入都走既有 items 版本条件更新(version CAS +1)或 create 插入,不存在无条件改写。locations 函数族的挂载写(linkItem/unlinkItem/ensureAndLink/merge/applyScan/deleteLocation migrate)是**部分字段条件更新**,不得触碰 quantity/unit;Q1 须有测试断言「挂载/移动/合并后 quantity/unit 原样存活」。
- 不变量 **I3(delete 不碰数量)**:itemsApi.delete 软删时抹空 name/name_norm/location_text/note(handler.js:1175)但**不触碰** quantity/unit(已删文档永不被投影,抹不抹无观察差异;最小改动,且避免 delete 路径新增字段语义)。

### 2.2 UNIT_SET 冻结(unit 闭集)

```
UNIT_SET = ["件","个","包","盒","瓶","袋","支","双","套","卷","张","本","罐","只"]
```

- 取 issue §1 候选 14 值**全集**:每个都是家庭高频计量词,任意删减都会把常见表达推向「单位不支持」的引导分支,得不偿失;闭集本身足够小(14 项),UI 选择器一屏可容纳。
- 默认值 `unit = "件"`(issue §1)。新建缺省、语音未说单位、选择器初始选中均为「件」。
- 校验:unit 必须是 string 且逐字等于某一成员(无 trim、无全半角归一、无近义映射:「枝」「条」「瓶装」等一律 UNIT_UNSUPPORTED)。**任何输入清洗都不改变 unit 的字面值**(闭集成员本身无空白无变体)。
- 扩展纪律:新增 = append(只追加到数组尾,永不插入/改名/删除);实施于 Q1:客户端(types.ts)与服务端(itemsApi handler)各持一份**逐字面一致**的常量副本,由测试锁定(同 `kind` 冻结词表「有效期/开封后/下次维护」的现有做法);上表数组顺序即冻结顺序(= 选择器展示序)。

### 2.3 quantity 输入校验(全入口共用,纯函数)

冻结纯函数(供 create/update/photoCommit/videoSceneCommit/quantityAdjust 复用,Q1 落在 itemsApi handler 内,客户端镜像校验同口径):

```
parseQuantityInput(v, min) →
  v === undefined        → ABSENT
  typeof v !== "number"  → INVALID(QUANTITY_NOT_INTEGER)   // string/null/boolean/object 一律拒
  !Number.isInteger(v)   → INVALID(QUANTITY_NOT_INTEGER)   // 3.5、NaN、Infinity
  v < min || v > 9999    → INVALID(QUANTITY_OUT_OF_RANGE)
  otherwise              → OK(v)
```

- `min` 由调用方决定:create 类恒为 1;update/quantityAdjust 结果校验用 0(见 §6 各入口)。
- `NaN`/`Infinity` 不是 integer,被第二条拦下(不依赖范围判断)。
- **宽松清洗一律不做**:不 parseInt、不取整、不接受 "3"/3.0 之外的任何形态(3.0 即 3,`Number.isInteger(3.0) === true`,合法)。

### 2.4 读侧表达(投影字段名,legacy unset 的唯一表达)

itemsApi 的 `project()` 家族(handler.js:227-236;`projectDetail` 在其上扩展,:243-247)投影**增补两个字段**:

```
quantity: number | null
unit: string | null
```

- 投影覆盖的 action 响应:`create`、`update`、`get`、`query`、`list`(即全部走 `project()/projectDetail()` 的 items 投影)。**不覆盖**(保持零变化,后续经 change request 另议):`remindList` 行(remindRow,handler.js:860-874)、locations.list 的 items/unmounted_items、locationScanContext 的 subtree_items/household_items。Q2 语音定位候选经 `get/query` 读取当前数量,不需要扩这些投影。
- 读侧防御性解析 `readQuantity(doc)`(冻结):`typeof doc.quantity === "number" && Number.isInteger(doc.quantity) && doc.quantity >= 0 && doc.quantity <= 9999 && typeof doc.unit === "string" && UNIT_SET.indexOf(doc.unit) !== -1` → 返回 `{ quantity, unit }`;否则 → 返回 `null`。投影时 `null` ⇢ `quantity: null, unit: null`。**任何存储异常(半态、越界、闭集外单位)一律按未确认读,绝不伪造已确认值**。
- 旧客户端对新增投影键天然忽略(与 `engine`、`version` 字段新增同款先例,API_CONTRACT.md §extractDraft「双引擎」、types.ts:1056-1059)。
- 新客户端对**旧服务端**(部署窗口内)投影可能缺失这两个键:客户端统一归一 `typeof item.quantity === "number" ? item.quantity : null`(unit 同理),缺键 ≡ 未确认(§11)。

### 2.5 类型(miniprogram/types.ts,Q1 实施)

- `ItemRecord`(文档形状,types.ts:11-30)增 `quantity?: number; unit?: string;`(可选,反映存储缺省)。
- `ItemSummary`(投影形状,types.ts:33-40)增 `quantity: number | null; unit: string | null;`。
- `ItemsApiEvent` 的 create/update 分支、`PhotoCommitItem`、`VideoSceneCommitNewItem` 增对应可选入参;新增 `quantityAdjust` 分支(Q2 落,形状见 §7.1)。

## 3. 写入口总表(全部 create/update 写入口枚举)

以下为系统内**所有**触碰 items 文档内容(名称/位置/备注/数量)的写入口及数量合同的归属阶段。证据类/结构类写入口不触碰数量,一并列出以封边界。

| # | 入口 | 现状(锚定) | 数量合同 | 归属 |
| --- | --- | --- | --- | --- |
| E1 | itemsApi.create(语音批量逐行,确认页经 batch-save/draft-session 恢复) | handler.js:907-1066;幂等 sameCreateContent :72-79 | 增可选 `quantity`/`unit`;缺省 1/件;进幂等内容比对 | Q1 |
| E2 | itemsApi.create(确认页手动空白表单,manual 模式) | 同 E1 | 同 E1(手动表单默认不填 → 1/件;用户可改) | Q1 |
| E3 | itemsApi.update(item 详情编辑) | handler.js:1072-1158;指纹 :1114;重放三重条件 :1140-1157 | 增可选 `quantity`+`unit`(成对);进 changes → 自动进指纹 | Q1 |
| E4 | itemsApi.photoCommit(拍照批量,逐件复用 createItem) | handler.js:2256-2370;复用 :2322 | items[i] 增可选 `quantity`/`unit`;整批纯参数校验阶段拦截 | Q1(字段)/Q3(合并交互) |
| E5 | itemsApi.photoEvidenceRetry(证据补关联) | handler.js:2374 起 | **不涉及数量**(只写 photo_evidence);携带 quantity/unit → INVALID_INPUT | 无(边界) |
| E6 | itemsApi.videoSceneCommit target:"new"(视频场景/位置清点新物品) | video.js:1959-2077;复用 createItem :2056-2061;canonical 签名 :1007-1045 | items[i] 增可选 `quantity`/`unit`;**进 scene_payload_sig 签名** | Q1(字段)/Q3(归组交互) |
| E7 | itemsApi.videoSceneCommit target:"existing"(既有物品关联证据/移动) | video.js:2068-2076;D1 move :1410-1453 | **禁止携带数量**(QUANTITY_ON_EXISTING_TARGET);数量变更只走 update/quantityAdjust | Q1(门)/Q3(交互) |
| E8 | itemsApi.videoEvidenceAttach / videoEvidenceHighlightSave / videoEvidenceDelete / videoUploadBegin / videoUploadReceipt / videoUploadCancel / scanDelete | 各自 § | **不涉及数量**(票据/证据/scan 状态机) | 无(边界) |
| E9 | itemsApi.quantityAdjust(新增,语音/快捷数量操作) | 不存在(Q0 冻结合同) | §7 全文 | **Q2**(Q1 不实现,不留桩) |
| E10 | itemsApi.delete(软删) | handler.js:1168-1183 | 不触碰数量(I3);与归零互不蕴含 | Q1(回归测试) |
| E11 | itemsApi.remindComplete/remindClear/remindSet | reminders 集合,独立 | 不触碰 items 文档 | 无(边界) |
| E12 | locations.linkItem/unlinkItem/ensureAndLink/merge/applyScan/deleteLocation migrate | 部分字段版本条件更新 | **不得触碰 quantity/unit**(I2);Q1 回归测试锁定 | Q1(回归测试) |
| E13 | 恢复/重试路径(draft-session 恢复、photo 会话恢复、scene pending 载荷、详情页失败重试、quantityAdjust 响应丢失重试) | 各会话层 | 冻结载荷**逐字节重放**(含 quantity/unit);恢复会话绝不由新客户端注入原载荷没有的字段 | Q1/Q2(各归属) |

提案类(零写库,产出「提议」供确认页;不是写入口但冻结其输出形状):extractDraft v2 草稿数量三项(§4.6,归属 Q1——语音新建预填;意图解析 Q2 §7.8)、vlRecognize `qty_note`(现状原样,§4.7)、draftEditParse `qty_note` 受限编辑(§4.7)。

## 4. 逐入口冻结细则

### 4.1 itemsApi.create(E1/E2)

**请求增量**(均可选,追加在现有入参之后):

```
{ action:"create", operation_id, name, location_text, note?, reminder?, remind_vague_quote?,
  quantity?: number,        // 1..9999 整数;缺席 → 服务端写 1(§5)
  unit?: string             // UNIT_SET 成员;quantity 在场而 unit 缺席 → "件";
                            // unit 在场而 quantity 缺席 → INVALID_INPUT(QUANTITY_UNIT_PAIR)
  , expected_household_id?, expected_scope_revision? }   // 现有 F2 双 marker不变
```

**校验**(顺序:先纯参数校验,任何失败 INVALID_INPUT 零写入,与现有纪律一致):
1. 现有字段门全部照旧(operation_id/name/location_text/note/reminder/remind_vague_quote,handler.js:908-930);
2. `quantity === null`(显式 null)→ INVALID_INPUT(QUANTITY_NOT_INTEGER)——新建的物品必然被用户确认存在,不存在「新建且未确认数量」;
3. `quantity` 在场:§2.3 校验(min=1);`unit` 在场:闭集校验,否则 UNIT_UNSUPPORTED;
4. `unit` 在场而 `quantity` 缺席 → INVALID_INPUT(QUANTITY_UNIT_PAIR);
5. quantity 相关 INVALID_INPUT 一律携带 `detail: { reason }`(§6)。

**写入**:插入路径写 `quantity: effQ, unit: effU`,其中 `effQ = event.quantity ?? 1`、`effU = event.unit ?? "件"`(**缺省=1 的唯一落点**,§5)。

**幂等扩展(L10②)**:`sameCreateContent(doc, name, locationText, note)`(handler.js:72-79)增第四步数量比对,冻结规则:

```
sameQuantityContent(doc, eventQuantity, eventUnit):
  docQ = readQuantity(doc)                       // §2.4,legacy/异常 → null
  if eventQuantity === undefined:                // 请求未带数量(旧客户端或未说数量)
    return docQ === null                         //   命中 pre-Q1 旧文档 → 视为同内容(跨部署重放窗口)
           || (docQ.quantity === 1 && docQ.unit === "件")   //   命中 post-Q1 缺省建出的文档
  effU = eventUnit ?? "件"
  return docQ !== null && docQ.quantity === eventQuantity && docQ.unit === effU
```

四项(name/location_text/note/quantity)全同才 duplicated:true;quantity 不同 → OPERATION_CONFLICT(现有语义,绝不静默吞掉变更)。E11000 并发回查分支(handler.js:982-1013)套用同一规则。**旧 note 的 ×N 不参与任何比对或升格**(L6)。

**响应增量**:`item` 投影增 `quantity/unit`(§2.4)。顶层结构不变(`{ ok, item, duplicated }`)。

### 4.2 itemsApi.update(item 详情编辑,E3)

**请求增量**:

```
{ action:"update", item_id, expected_version, update_id?, name?, location_text?, note?,
  quantity?: number,        // 0..9999 整数(min=0);与 unit 成对携带
  unit?: string             // UNIT_SET;允许与当前单位不同(表单显式改单位,见下)
  , ... F2 双 marker }
```

- **成对纪律**:quantity 与 unit 在 update 上**同携同缺**(一方在场另一方缺席 → INVALID_INPUT(QUANTITY_UNIT_PAIR))。理由:update 是部分字段更新,半对会要求「保留当前单位」的解析,而对未确认物品不存在「当前单位」——成对携带让客户端永远显式,杜绝半态(I1)。
- **允许改单位**:update 是详情表单编辑,用户同时看到并提交数量+单位,允许 `unit` 与当前不同(例:3 件 → 5 包,是显式修正,不是「默默叠加」;L3 禁止的是跨单位算术)。Q2 的 quantityAdjust 则永不改单位(§7.4)。
- **不携带 quantity 的 update 完全不触碰数量字段**(名称/位置/备注编辑不回填数量,L6);对 legacy 行亦然。
- **指纹(L10②,零新机制)**:quantity/unit 进 `changes` → `changesFingerprint`(handler.js:167-174,键排序 JSON)自动覆盖。同 update_id 异数量重试 → 指纹失配 → VERSION_CONFLICT(绝不把新内容当重放吞掉,现有语义 :1145-1155 原样适用)。
- **响应增量**:`item` 投影增 quantity/unit。replayed:true 收敛分支照旧。
- 详情页 UI 纪律:未确认行的数量输入框显示占位「未确认」,**绝不预填 1**;仅在用户主动填写后 update 才携带 quantity/unit(§10.3)。

### 4.3 itemsApi.photoCommit(E4)

**请求增量**:items[i] 增可选 `quantity?: number`(min=1)、`unit?: string`,规则与 create 完全一致(缺省 1/件、unit 不得单独在场、quantity 恒 ≥1)。校验发生在**整批纯参数校验阶段**(handler.js:2265-2315 现有循环内增补),任一件数量非法 → 整批 INVALID_INPUT 零写入(与「参数错误是客户端 bug」纪律一致);`detail` 增 `index`(该件在 items 内的 0-based 下标)。逐件执行继续复用 createItem(:2322),数量幂等/缺省全部白拿(§4.1)。

**note 与数量解冻(Q1 客户端)**:
- 现状:候选行 `qty`(1-99,intake-draft.ts:48-49)经 `composeNote` 拼成 `note: "×{qty} {suffix}"`(photo-intake.ts:314),「数量只是备注不做库存」。
- Q1 起:**`quantity/unit` 进 photoCommit 字段;note 不再由数量拼出**——`note` 只承载用户手输的自由备注(空则不携带);`composeNote` 不再用于构造提交载荷(保留函数仅供 §10 展示层判断旧形状使用,或 Q1 顺手内联废弃,由 Q1 定)。
- `parseIntakeQtyNote` 的预填规则(§2 入口表「拍照确认」):VL `qty_note`(如「约2根」)经它提取的首段数字**只作步进器预填提示**,行上标「数量待核对」,直到用户触碰步进器或单位选择器;最终确认弹层逐行列出「名称 ×数量 单位」,用户点确认 = L1 的「用户确认」。预填数字不合法(超出 1..9999)→ 归 1。**qty_note 的文字部分(「约」「根」)永不解析成 unit**(unit 只来自用户的选择器选择,默认「件」;「根」不在闭集,不引导映射)。
- `PhotoCandidate` 客户端形状:qty/suffix 字段语义迁移为「数量预填提示」(suffix 仅存 VL 原文供展示);形状细节由 Q1 在客户端层落定,公共 API 只认 §4.3 的 items[i] 字段。
- **多框合并(box=null 降级)**:见 §8。
- **响应增量**:results 行不变(item_id/duplicated/evidence_saved/version);数量可从 item 投影回读,行内不重复携带。

**幂等**:photoCommit 无自身幂等键,逐件靠 operation_id;原键原内容(含 quantity/unit)重试 → duplicated;原键改数量 → OPERATION_CONFLICT(§4.1 规则)。photo 会话恢复(E13)按冻结载荷逐字节重放,**新客户端不得给 pre-Q1 会话载荷注入 quantity**。

### 4.4 itemsApi.videoSceneCommit(E6/E7)

**请求增量**:items[i] 在 target:"new" 时增可选 `quantity?: number`(min=1)、`unit?: string`(规则同 create,缺省 1/件)。

**签名扩展(L10③,冻结)**:`canonicalSceneItems`(video.js:1007-1030)对 target:"new" 逐件追加:

```
if (it.quantity !== undefined) one.quantity = it.quantity;
if (it.unit !== undefined) one.unit = it.unit;
```

- **不携带时 canonical 输出与现行逐字节相同**(与 D1 的 node_id 增量同款手法,video.js:1021)——旧票据/旧载荷重试零感知。
- 携带数量后,同票据重试改数量/改单位 → 签名失配 → OPERATION_CONFLICT(现有硬门 :2042-2044 原样适用)。
- target:"existing" **禁止携带 quantity/unit**(parseSceneCommitItems :1904-1957 增一条形状门):携带 → INVALID_INPUT(QUANTITY_ON_EXISTING_TARGET)整批零写。既有物品的数量变更只走 update/quantityAdjust(E7 边界;existing 路径没有数量 CAS 的位置,绝不让证据关联成为第二条数量写路径)。
- 逐件执行:target:"new" 把 quantity/unit 透传 createItem(:2056-2061),缺省/幂等白拿。

**响应增量**:results 行不变;`scan.confirmed_count` **语义零变化**(§9.2)。

### 4.5 恢复/重试路径(E13)总规则

1. **冻结载荷逐字节重放**:draft-session(语音批量)、photo 会话、scene pending 提交、详情页失败重试、quantityAdjust 重试——恢复时重放**当初冻结的载荷**(含 quantity/unit 原值),不做任何再推导。新客户端恢复 pre-Q1 会话时**不得注入**原载荷没有的字段(注入会导致异内容冲突或签名失配,宁可按「待核对」引导用户重新确认)。
2. 语音批量已保存行不再提交(draft-session 现状);失败行沿用原 operation_id/原内容重试;用户改内容(含数量)后沿用原键 → 服务端 OPERATION_CONFLICT 如实暴露(现状语义,数量并入「内容」)。
3. videoSceneCommit 未完成件(evidence_failed)用**完全相同的冻结载荷**重试(现状);数量在载荷里,改数量 = 新载荷 = 同票据签名失配 → OPERATION_CONFLICT,客户端须丢弃 pending 会话重新走确认(与 D2「scan 生命周期终结旧提交不得复活」同族的诚实语义)。

### 4.6 extractDraft v2 数量三项(语音新建预填,Q1)

每件 draft 增**三项同现同缺**的可选数量组(结构仿 remind 三项,API_CONTRACT.md extractDraft v2 节):

```
quantity: integer|null      // 1..9999;null = 原话没说数量
unit: string|null           // UNIT_SET 成员;null 同上
quantity_quote: string|null // 原话中承载该数量的逐字子串(如「3包」「三包」),锚定用
```

**服务端硬门**(任一失败 → 三项整体置 null,物品照常提取,不废件——同 remind 三项纪律):
- 形状:三项同现同缺(半态 → 全 null);quantity 非正整数或超 1..9999 → 全 null;unit 非 UNIT_SET 成员 → 全 null;
- **数量锚定(防模型幻觉/推算)**:服务端用冻结数字解析器(§7.8.2 同一实现)从 `quantity_quote` 解析出「数字+单位」,必须与模型报的 quantity/unit 完全一致,且 quantity_quote 必须是原话逐字子串(去空白比对,同 source_quote 口径)——「买了 3 包棉柔巾」quote「3包」→ 数量 3/包;模型把「一箱」折报成 quantity:24(按箱装数推算)→ 锚定失败 → 三项全 null;
- 「买了/新增/又买了」等动词**不产生数量语义**,只走 create(「买了 3 包」= 新建 quantity=3 待确认,**不是**对已有 item 的 add;issue §2 入口表边界);
- 模糊表达(「几包」「一些」「半打」)、小数(「1.5 升」)、闭集外单位(「一箱」「500ml」)→ 三项全 null,确认页数量预填 1/件 + 「待核对」;
- v1 响应零变化;v2 现有字段(name/location_text/certain/qualifiers/source_quote/anchor_shared/remind 三项/remind_vague_quote/mount_path)零变化。

**确认页**:数量行 = 步进器(quantity)+ 单位选择器(unit),三项 null 时预填 1/件并标「待确认」;用户可改可清(清 = 回到 1/件,不存在「清成未确认」——create 必然落确认值)。行 → create 映射(batch-save)随行携带 quantity/unit。

### 4.7 提案类的数量映射(vlRecognize / draftEditParse)

- **vlRecognize.qty_note**:现状原样(≤40 码点原样保留,extractDraft handler.js:416-420)。它不是数量事实,只经 §4.3 的预填规则进确认页。**不新增字段、不服务端解析**。
- **draftEditParse**(拍照页语音受限编辑):`edit` 的 `qty_note` 字段白名单不变;客户端把新 qty_note 经 `parseIntakeQtyNote` 拆出的数字写进行内 quantity(仍标「待核对」),其后缀若**逐字等于**某 UNIT_SET 成员则同步写 unit,否则 unit 不变;`add` 的 `added.qty_note` 同规则。语音编辑永不直接落库(只改行内状态,保存仍走 photoCommit 确认)。

### 4.8 明确不涉及数量的写方(边界冻结)

photoEvidenceRetry(E5)、video 证据/票据/scanDelete 各 action(E8)、remind 三 action(E11)、locations 全部写 action(E12,不触碰 + Q1 回归锁定)、itemsApi.delete(E10,不触碰)。这些入口的现行为、幂等与锁序**一字不改**;对请求里意外出现的 quantity/unit 键**一律静默忽略**(与 itemsApi handler 只读取已知键、不校验多余键的现有宽松口径一致,零客户端回归风险)。§6 的 reason 枚举不含这些入口。**唯一显式拒绝的例外是 E7(videoSceneCommit target:"existing")**:它有整批纯参数校验阶段,且放行混入数量会制造第二条绕过 CAS 的数量写路径(QUANTITY_ON_EXISTING_TARGET)。

## 5. 新建缺省 = 1 的精确触发条件

**「新建请求未带数量才在服务端默认 1」(issue §1.3)冻结为以下充要条件,除此之外任何路径不写缺省:**

1. 入口 ∈ {itemsApi.create(E1/E2), photoCommit 的 items[i](E4), videoSceneCommit 的 target:"new" items[i](E6)}——即**所有最终走 createItem 插入路径**的入口;
2. 阶段 = **插入路径**(新文档组包,handler.js:963-978);duplicated/OPERATION_CONFLICT 分支只比对、绝不写;
3. 条件 = `event.quantity === undefined`(键**缺席**;显式 `null`/非法值 → INVALID_INPUT,见 §4.1);
4. 效果 = 文档写 `quantity: 1, unit: (event.unit === undefined ? "件" : event.unit)`——而 unit 单独在场已被 §4.1-4 拒绝,故实际只有 `quantity: 1, unit: "件"` 一种缺省形态。

**明确不适用缺省的场景**(负面清单,可测):
- update 不携带 quantity → 字段不动(legacy 行保持未确认;已确认行保持原值);
- quantityAdjust 不存在「缺省」(amount 必填);
- 任何读路径/投影/迁移脚本/管理动作(不存在迁移脚本,L6);
- 存量 items 文档(无物理回填);
- photoCommit/videoSceneCommit 的 duplicated 重放分支。

**推论**:Q1 部署后新插入的每一行 items 都有确认数量(旧客户端建的也是 1/件——「一条记录 = 用户确认记了一件」是 Q1 之前的产品前提,该默认与 issue §1.3 表述一致);Q1 之前的存在行全部保持未确认。

## 6. 校验汇总与 detail.reason 冻结枚举

quantity/unit 相关的 INVALID_INPUT **必须**携带 `detail: { reason, index?, current_quantity?, current_unit? }`(顶层 `error` 仍是 INVALID_INPUT,不新增错误码;`detail` 结构化补充沿用 locations/D1 先例,API_CONTRACT.md:91/98)。`index` 仅批量入口(photoCommit/videoSceneCommit)携带。冻结枚举(11 值,Q1/Q2 公共):

| reason | 语义 | 触发 |
| --- | --- | --- |
| `PARAM_SHAPE` | quantity 之外的其他参数形状错(item_id/expected_version/update_id/mode 等非法) | 各写入口 |
| `QUANTITY_NOT_INTEGER` | quantity 非 number / 非整数 / 显式 null / NaN | 全入口 |
| `QUANTITY_OUT_OF_RANGE` | **输入值**越界:create 类 quantity <1 或 >9999;update 的 quantity <0 或 >9999;quantityAdjust set 的 amount <0 或 >9999、add/subtract 的 amount <1(0 被拒,见 §7.3) | create/update/photo/video/adjust |
| `QUANTITY_BELOW_ZERO` | add/subtract **计算结果** < 0(「库存不足」;detail 附 current_quantity) | quantityAdjust |
| `QUANTITY_OVER_MAX` | 计算结果 > 9999 | quantityAdjust |
| `QUANTITY_UNIT_PAIR` | update 上 quantity/unit 只携其一;create/照片/视频上 unit 在场而 quantity 缺席 | update/create/photo/video |
| `UNIT_UNSUPPORTED` | unit 非 string / 不在 UNIT_SET | 全入口 |
| `UNIT_REQUIRED` | quantityAdjust set 模式作用于未确认行而未携 unit | quantityAdjust |
| `UNIT_MISMATCH` | quantityAdjust 携 unit 与当前 unit 不符(detail 附 current_unit) | quantityAdjust |
| `QUANTITY_UNCONFIRMED` | quantityAdjust add/subtract 作用于未确认行(detail 附 current_quantity:null) | quantityAdjust |
| `QUANTITY_ON_EXISTING_TARGET` | videoSceneCommit target:"existing" 携带 quantity/unit | videoSceneCommit |

非 quantity 相关的失败沿用现有错误码零变化:OPERATION_CONFLICT(幂等异内容/签名失配)、VERSION_CONFLICT(CAS/重放识别失败)、NOT_FOUND、FAMILY_SWITCHED / FAMILY_STALE_SCOPE / HOUSEHOLD_UNAVAILABLE(L9)。

## 7. 语音数量操作合同(Q2;Q1 不实现、不留桩)

### 7.1 统一 action:`quantityAdjust`

采用**单一 mode action**(issue §3 允许的两种形态之一),不另设 quantitySet:一个 action 一条 CAS 路径、一个 WRITE_ACTIONS 条目、指纹天然含 mode(add 2 与 set N+2 同 update_id 也被判为不同操作)。

**请求**(写类 action,进 WRITE_ACTIONS 与 ITEMS_MUTATING_ACTIONS 双清单,走 F2 双 marker 硬门):

```
{ action:"quantityAdjust",
  item_id: string,               // 用户在确认页从候选中选定并确认的目标
  expected_version: number,      // 必填,正整数(确认页读到的 version)
  update_id: string,             // 必填,1-64(同一次用户确认的稳定标识;与 update 的可选不同,
                                 //  这里强制——每次数量操作都必须可重放识别,§7.5)
  mode: "add" | "subtract" | "set",
  amount: number,                // add/subtract: 1..9999;set: 0..9999
  unit?: string,                 // 可选;携带时必须 === 目标当前 unit(UNIT_MISMATCH);
                                 // set 作用于未确认行时必填(UNIT_REQUIRED)
  expected_household_id?, expected_scope_revision? }
```

`unit` 超出 issue §3 最小集,冻结为可选校验参数:确认页展示「位置/单位」时用户看到的单位随请求回传,服务端校验一致——错单位(把「盒」当「包」加)在写前 fail-closed,而不是写错后靠用户发现。不携带 = 不校验(最小集兼容)。

### 7.2 校验顺序(确定性,全部先于任何写入)

1. 纯参数形状:item_id 非空串 / expected_version 正整数 / update_id 1-64 / mode ∈ 闭集 / amount 整数且在 mode 域内 → 违者 INVALID_INPUT(对应 reason:PARAM_SHAPE / QUANTITY_NOT_INTEGER / QUANTITY_OUT_OF_RANGE);
2. 读取目标(where _id + household_id + deleted:false):查无(含跨家庭/已删)→ NOT_FOUND(零写);
3. `readQuantity(doc)`(§2.4):
   - mode ∈ {add, subtract} 且未确认 → INVALID_INPUT(QUANTITY_UNCONFIRMED);
   - mode = set 且未确认且 unit 缺席 → INVALID_INPUT(UNIT_REQUIRED);mode = set 且未确认且 unit 在场 → 首次确认,合法;
   - unit 在场且已确认且 unit ≠ doc.unit → INVALID_INPUT(UNIT_MISMATCH);
4. 计算:newQ = add ? cur+amount : subtract ? cur-amount : amount;newQ < 0 → INVALID_INPUT(QUANTITY_BELOW_ZERO,附 current_quantity);newQ > 9999 → INVALID_INPUT(QUANTITY_OVER_MAX);
5. **范围验证在写前执行**(issue §3):第 1-4 步任一失败 → 零写入。

### 7.3 语义细则

- **add 是数量调整,不是新建 item**(issue §3 意图词表);「买了」不走本 action(§4.6)。
- add/subtract 的 `amount === 0` → QUANTITY_OUT_OF_RANGE(拒绝空操作:空操作也会推 version,意图不明);set 的 `amount === 0` 合法(归零,L2)。
- set 永不改 unit(改单位走详情表单 update,§4.2);set 于已确认行要求 unit 携带时必须等于当前值。
- 单 item 单操作:一次 quantityAdjust 只改一件一个数量;复合指令(「棉柔巾加两包抽纸加一包」)由解析层拆成多次确认,绝不在一个 action 里打包(issue §4 Q2 边界)。
- 移动句子(「把两包棉柔巾拿到卧室」)属移动/拆分,一期不支持跨位置数量搬移:解析层判 `other(move)`,客户端提示「当前不支持,请到详情页手动修改位置」,**绝不**折算成 subtract(issue §3 表)。
- 找回查询(「找一下棉柔巾」)判 `other(find)`,走既有 query,绝不触碰数量。

### 7.4 版本 CAS 与 QA 指纹

- 条件更新:where(`_id` 且 `household_id` 且 `deleted:false` 且 `version === expected_version`)写 `{ quantity:newQ, unit:effU, version:expected_version+1, updated_at, last_update_id:update_id, last_update_fingerprint:qaFp }`。effU = 未确认 set ? event.unit : doc.unit(不动)。
- **QA 指纹(L10②,冻结)**:`qaFp = changesFingerprint({ mode, amount, unit:effU })`(复用 handler.js:167-174 键排序 JSON)——**只覆盖请求内容,不含计算结果 newQ**。理由(重放可重算性):响应丢失重试时 CAS 未命中,服务端只能从「请求 + 当前文档」重算指纹;若指纹含 newQ,重试读到的 cur 已是首次写入后的 newQ,add 再算会得 newQ+amount,指纹永远对不上。请求内容指纹天然可重算:event.mode/amount 不变;effU = event.unit ?? doc.unit,而 quantityAdjust **永不改 unit**,重试读到的 doc.unit 与首次相同 → 指纹稳定重算。区分度仍完整:同 update_id 下 add 2 与 set 7 → {add,2,·} ≠ {set,7,·},mode/amount/unit 任一改 → 指纹失配 → VERSION_CONFLICT,「改值必须生成新操作」由结构保证。(边界如实披露:同一用户对同一 item 前后两次确认完全相同的 mode+amount 却复用同一 update_id,会被识别为重放——这是 update_id 语义的固有属性,与既有 update 重放同族,由客户端「新确认新 update_id」纪律约束。)
- version+1;`quantityAdjust` 不改 name/location_text/note/name_norm/location_node_id/remind_vague_quote。

### 7.5 重放语义(响应丢失重试)

- 同一次用户确认生成稳定 update_id;响应丢失的重试使用**原 expected_version 与原 payload**(同 item_id/mode/amount/unit/update_id),命中 0 条后回查(与 updateItem :1140-1157 完全同构):`version === expected_version+1 && last_update_id === update_id && last_update_fingerprint === qaFp` 三重全中 → `{ ok:true, item(投影), replayed:true }`(最多生效一次);
- 相同 update_id 但 mode/amount/unit 任何不同 → 指纹失配 → **VERSION_CONFLICT,绝不把新内容当重放吞掉**;改值必须生成新 update_id + 刷新后的 expected_version(新操作);
- **依赖 last_update_id/last_update_fingerprint 的「最后一笔」语义,不承诺识别任意交错之后的历史操作**(issue §3 如实表述):重试时若该 item 已被**其他**写入推进(version ≥ expected_version+2 或 last_update_id 是别人的)→ VERSION_CONFLICT,此时结果**不可知**(可能已生效可能没有)——客户端一律呈「结果待核对,请刷新」,经 get 重读当前数量后由用户决定下一步,**绝不自动把旧 delta 重新套用、绝不自动再减库**(issue §5-7「未知结果遇后续其他写入绝不盲重减」);
- 不建永久流水(§13);Q1 的 update 重放与 Q2 的 quantityAdjust 重放共享同一 last_update_* 字段,互不干扰(指纹内容不同天然互斥)。

### 7.6 响应

```
{ ok:true, item: { ...投影(含 quantity/unit) }, replayed?: true }
失败:{ ok:false, error, message(中文), detail?: { reason, ... } }
```

不额外返回 before/after(确认前客户端已展示「原数量 → 变化值 → 结果数量、位置/单位」;响应 item.quantity 即结果)。

### 7.7 失败关闭矩阵(冻结)

| 条件 | 结果 | 零写 |
| --- | --- | --- |
| 参数形状/mode/amount 非法 | INVALID_INPUT(+reason) | ✅ |
| 目标不存在/已删/跨家庭 | NOT_FOUND | ✅ |
| add/subtract 于未确认行 | INVALID_INPUT(QUANTITY_UNCONFIRMED) | ✅ |
| set 于未确认行且未携 unit | INVALID_INPUT(UNIT_REQUIRED) | ✅ |
| unit 与当前不符 | INVALID_INPUT(UNIT_MISMATCH) | ✅ |
| subtract 结果 < 0 | INVALID_INPUT(QUANTITY_BELOW_ZERO) | ✅ |
| 结果 > 9999 | INVALID_INPUT(QUANTITY_OVER_MAX) | ✅ |
| expected_version 过期且非重放 | VERSION_CONFLICT(客户端刷新→**显式重确认**后才可再发;绝不自动套旧 delta 到新版本) | ✅ |
| 共享家庭缺/错双 marker | FAMILY_SWITCHED / FAMILY_STALE_SCOPE | ✅ |
| 家庭解析失败 | HOUSEHOLD_UNAVAILABLE(先于一切) | ✅ |
| 数量归零(set 0) | 成功;item/位置/提醒/证据全保留(L2) | — |

### 7.8 解析提议层:extractDraft 新增 `quantityIntentParse`(零写库)

issue §3 交互合同:「解析结果只是提议 `{intent,item_query,quantity_or_delta,unit,source_quote}`,目标 item_id 必须由服务端授权范围内候选检索+用户确认选择;不能让模型自行填 item_id 并直接修改数据库」。冻结:

**请求**:`{ action:"quantityIntentParse", text(1-200 码点), candidates: 0-12 项 [{ item_id, name, location_text, quantity?, unit?, version }] }`——candidates 为客户端经 get/query 读到的本家庭候选(含当前数量与 version,供确认页展示「原数量 → 结果」),**不是**数据库事实。

**响应**(提议,绝不写库;intent 闭集):

```
{ ok:true, engine, intent: "add" | "subtract" | "set" | "unknown" | "other",
  match?: { candidate_index, matched_word },   // 模型从 candidates 里挑的候选(提议;歧义/未命中 → 缺席 + needs_pick)
  needs_pick: boolean,                          // 多候选命中/同名多位置/单位不明 → true,客户端弹选择
  item_query: string,                           // 展示用目标描述词
  delta?: number,   value?: number,             // add/subtract → delta(±1..9999);set → value(0..9999)
  unit?: string,                                 // ∈ UNIT_SET
  source_quote: string,                         // 原话逐字子串(锚定,见下)
  ambiguity?: "maybe_total" | "location_unclear" | "unit_unclear" }
```

**硬门**(服务端,失败降级 intent:"unknown"/"other",绝不猜):
- 数字锚定:delta/value 与 unit 必须能由冻结数字解析器(下述)从 source_quote(原话逐字子串,去空白比对)独立解析得到且一致——「加两包」→ delta:+2, unit:包;模型推算(「大概还剩一半」折成 3)→ unknown;
- 「还有/大概/差不多」等存在「加还是总数」歧义 → intent:"unknown" + ambiguity:"maybe_total",绝不静默按任一语义执行(issue §3「『还有』存在歧义时允许 unknown,不静默执行」);
- 移动句式(「拿到/搬到/放到 + 别的位置词」)→ intent:"other"(客户端提示一期不支持);找回句式(「找一下/在哪」)→ intent:"other";
- 模型输出 item_id 越过 candidates(编造)→ 丢弃 match、needs_pick:true;
- 日志纪律同 extractDraft 现状:只记 action/文本长度/耗时/engine/intent/error,绝不记原文与解析结果。

**7.8.2 冻结数字解析器**(quantity 意图的唯一数字语义实现,Q1 的 extractDraft v2 数量三项与 Q2 的 quantityIntentParse 共用,单一实现点):
- 阿拉伯数字串(0-9,十进制,无千分位);中文数字:一二两三四五六七八九十及其组合(十五、二十三、一百、两千),「两」=2;上限 9999,超出/小数(「1.5」)、「半」「几」「一些」→ 解析失败 → null;
- 与 relative-date 的中文数字表(API_CONTRACT.md「v2 remind_converted」节)同源口径,但独立于日期换算(不复用其日历算术)。

**客户端确认流(Q2)**:解析提议 → 候选匹配(五级匹配纯函数,item-match.ts 现状复用)+ needs_pick 时用户点选 → 弹层展示「原数量 N → N±delta / → value,位置/单位」→ 用户确认 → 生成 update_id + 携 expected_version(确认页从 candidates 读到的 version)调 quantityAdjust → VERSION_CONFLICT 时 get 刷新并**显式重确认**。取消 = 丢弃,零写入。

## 8. 照片同帧多框:box=null 降级规则(Q3 交互,Q1 字段已备)

现状:photoCommit 每件只有一个 `photo.box`(0-1 或 null,parsePhotoInput handler.js:2108-2163;photo_evidence 行单框,handler.js:2204-2238);「多框持久化是独立后续合同,不借本期扩张」(issue §2)。

冻结规则:
1. **合并行(≥2 个来源框)**:用户把同一张照片里的多个候选框合成一条 quantity=N 的物品时,提交的 `photo.box` **必须为 null**(整张照片关联)——绝不把其中任何一个框冒充「两件」的全部位置(issue §2 照片证据现实约束)。多框各自的坐标不持久化,只在确认页客户端侧保留来源候选可展开查验(候选 id/框/名称,会话内存,不落库);
2. **单来源行**(用户未合并,只把步进器调到 N):保留该行唯一的 box(该框就是用户确认的那一件的区域,数量 N 是用户对同类可互换实物的断言)——允许 box 非 null 且 quantity>1,这不是「一框冒充两件」,因为没有第二个框被丢弃;
3. **全部来源无框**(语音/手动行):box=null(现状);
4. **source 归并**:合并行 = 所有来源均 "vl" → "vl",否则(含 circle 或混合)→ "circle"(合并本身是用户动作,凡含用户圈选即用户确认痕迹);单来源行保持来源;
5. **服务端不做合并判定**(无法验证、也不该猜):photoCommit 形状门只继续校验 box ∈ null|四值 0-1 且 x2>x1/y2>y1,quantity 与 box 任意组合均合法;规则 1/2/4 是**客户端合同**,由 Q3 的客户端测试锁定;
6. photo_evidence 行形状不变(单 box 字段);证据行仍以 (household_id, item_id, file_id) 幂等只增。

## 9. 视频:observation ≠ quantity 声明

### 9.1 永不互相赋值(issue §2/§5)

- `observation_count`、frame 条数、`SceneDraftItem.observationIds.length`(video-scene.ts:201)、`highlights` 条数、VL confidence、同名分组大小——**任何一个都不得赋值给 quantity**。quantity 的唯一来源:确认页上用户对草稿行数量控件的显式设置(或其缺席时的 create 缺省 1,§5)。
- 一件东西出现在 6 帧(6 个 observation,或 1 个草稿带 6 条高亮)≠ 6 件:提交 quantity 缺席 → 落 1;用户在合并行上手动确认 2 → 落 2。
- 同帧两件同名:默认两个独立草稿(video-scene.ts:252-254 mergeSameName 默认 false)→ 2 条 item ×1;用户显式合并 → 1 条 ×2(用户填的数量),绝不由「同帧出现两次」自动推断成 1 或 2(issue §5-4「同帧同时两件:允许用户确认数量 2,不得自动推断成 1」)。
- 拆分(splits)与证据保留:同名不同物可拆分为多件,每件保留自己的 observations/highlights/时间窗/帧(现状 manualHighlights/observationIds 机制零变化);单 item 高亮上限 8 条不变。
- target:"existing" 关联不碰数量(E7);#101 R0 的观察折叠/归组是纯前端 UX,其输出仍经本合同确认。

### 9.2 location_scans.confirmed_count 语义不变(L8)

- confirmed_count = 本次提交确认的 item/草稿**条数**(现状,D1 契约 API_CONTRACT.md:90-93)。带数量后**仍数条数不数总量**:提交 2 条新物品(quantity 5 与 3)→ confirmed_count = 2(不是 8)。
- 候选数 candidate_count 语义不变;scanDelete/videoCleanup/引用回收/D2 全部契约零变化(issue §5-8「视频资产引用回收合同不变」)。

## 10. UI 展示规则(防「旧 ×N 与新数量」双展示)

### 10.1 徽标规则

- 已确认(quantity !== null):列表行/详情头显示数量徽标 `×{quantity}{unit}`(如「×3包」),数据来自投影字段,**唯一来源**;
- 未确认(双 null):**不显示徽标**(绝不显示误导性的「×1件」——issue §1.3「不显示『确定有 1 件』的误导性值」);列表行无任何数量占位;详情页显示轻量入口「数量未确认 · 点击确认」(进数量表单,不预填)。

### 10.2 防 ×N 双展示(冻结纯函数)

问题:存量行 note 可能是旧拼法 `×3 备忘`(composeNote 产物,intake-draft.ts:90-96);确认数量后徽标「×3包」与 note「×3 备忘」并排 = 双重/冲突展示(issue §1.3)。冻结:

```
displayNoteFor(note: string, quantityConfirmed: boolean): string
```

- `quantityConfirmed === false` → note **原样**展示(旧 ×N 是仅有的信息,不隐藏、不升格);
- `quantityConfirmed === true` 且 note 匹配旧形状 `^×\s*\d+(\s+.*)?$` → 剥掉 `×N` 词元,只展示后缀文本;后缀为默认占位「备注」或剥后为空 → 整条 note 不展示;
- `quantityConfirmed === true` 且 note 不匹配该形状 → note 原样展示(用户自由备注与数量无关,如「2号抽屉那盒」——**绝不**因为含数字而隐藏或解析);
- 该变换是**纯展示层**函数(实现于 miniprogram/utils,Q1 落地):存储 note 一字不改;详情页编辑框始终显示存储原文;正则即上面这一条,不做更聪明的解析(防误伤自由备注)。

### 10.3 编辑与确认态纪律

- 详情表单:未确认行数量框显示占位「未确认」、单位选择器默认「件」,不预填 1;提交仅在用户填了数量后携带 quantity+unit(成对,§4.2)。
- 照片确认页:VL qty_note 预填行标「数量待核对」;最终确认弹层逐行列「名称 ×数量 单位」(含被预填值——用户点确认即 L1 确认)。
- 语音 v2 确认页:quantity_quote 锚定成功的行预填并标「待确认」(用户说了数量但需过目);三项 null 的行预填 1/件 + 「待确认」。
- Q1 起 photoCommit/create 载荷不再由数量拼 note(§4.3),新数据不再产生旧形状 note;10.2 只服务存量行。

## 11. 兼容矩阵与部署顺序

| 场景 | 行为 |
| --- | --- |
| 旧客户端 × 新服务端 | create/photoCommit/videoSceneCommit 不带 quantity → 缺省 1/件(§5);update 不带 → 数量不动;旧 photo 会话恢复 → 原载荷(无数量)重放,pre-Q1 会话撞 duplicated 收敛(§4.1 幂等窗口);投影多出的 quantity/unit 键被忽略 |
| 新客户端 × 旧服务端(部署窗口) | 投影缺 quantity/unit 键 → 客户端归一为 null(未确认,§2.4);create 携带的 quantity 被旧服务端**静默丢弃**(旧 handler 不读未知键)→ 行读回为未确认——与 remind_converted 等既往字段新增同族的已知窗口风险;**部署顺序冻结:先云函数后小程序发版**(本仓各阶段一贯做法),把窗口压到零用户可见 |
| 新客户端 × 新服务端 | 全合同生效;quantityAdjust 在 Q2 服务端落地前被旧服务端按未知 action 拒(INVALID_INPUT),客户端须按能力降级(Q2 发版时序:云函数先行) |
| 共享家庭旧客户端 | 写类 action 维持现行 FAMILY_SWITCHED 受控阻断(现状,数量不改变该门) |

## 12. 反例矩阵:issue §5 九条验收 → Q1/Q2/Q3 可测反例清单

> 每条:输入 / 期望 / 归属阶段。离线测试(node:test + memoryDb + 客户端纯函数)为 Q1/Q2/Q3 各自 PR 的必过门;issue §5-9 的全量门(npm test / typecheck / build:mp / 微信 upload 编译 / 双家庭并发真机弱网)是各 PR 的验收门,其中 upload 编译与真机项为 Owner 人工门,自动化 CI 不可替代——各阶段如实报告,不假报。

### A. 对应 issue §5-1(新建缺省/明确数量/非法值/单位)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| A1 | create 不带 quantity(模拟旧客户端) | 文档 quantity=1/unit=件;投影回读 1/件;duplicated:true | Q1 |
| A2 | create { quantity:3, unit:"包" } | 落 3/包;投影一致 | Q1 |
| A3 | create { quantity:0 } | INVALID_INPUT,reason=QUANTITY_OUT_OF_RANGE,零写 | Q1 |
| A4 | create { quantity:3.5 } / { quantity:"3" } / { quantity:null } | INVALID_INPUT,reason=QUANTITY_NOT_INTEGER,零写 | Q1 |
| A5 | create { quantity:10000 } / { quantity:-2 } | INVALID_INPUT,reason=QUANTITY_OUT_OF_RANGE | Q1 |
| A6 | create { quantity:3, unit:"箱" } | INVALID_INPUT,reason=UNIT_UNSUPPORTED(箱不在闭集) | Q1 |
| A7 | create { unit:"包" }(quantity 缺席) | INVALID_INPUT,reason=QUANTITY_UNIT_PAIR | Q1 |
| A8 | update { quantity:5, unit:"包" } 于 (3,件) 行 | 成功 5/包(显式表单改单位,version+1) | Q1 |
| A9 | update 只携 quantity 不携 unit | INVALID_INPUT,reason=QUANTITY_UNIT_PAIR,数量零写 | Q1 |
| A10 | quantityAdjust { mode:"add", amount:2, unit:"盒" } 于 (5,包) 行 | INVALID_INPUT,reason=UNIT_MISMATCH,零写(不同单位绝不默默叠加) | Q2 |

### B. 对应 issue §5-2(legacy 不生成库存事实;新旧并存)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| B1 | 直插无 quantity/unit 的存量文档 → get/query/list | 投影 quantity:null, unit:null(可区分未确认);列表无徽标 | Q1 |
| B2 | 存量行 note="×3 备忘" → 展示层 displayNoteFor(note,false) | note 原样;不解析成数量;投影仍 null | Q1(客户端)/Q1(服务端 B1) |
| B3 | 存量行 note="500ml 2号抽屉" | 投影 null;displayNoteFor(note,true) 场景 note 原样(不匹配 ×N 形状,不隐藏) | Q1 |
| B4 | displayNoteFor("×3 备忘", true) | 剥 ×3 →「备忘」;displayNoteFor("×3 备注", true) → 整条不展示;displayNoteFor("×3 2号抽屉", true) →「2号抽屉」 | Q1(客户端) |
| B5 | 旧客户端 create 不带数量 → 重试同键不带数量(post-Q1 文档 1/件) | duplicated:true(§4.1 sameQuantityContent 缺席分支) | Q1 |
| B6 | pre-Q1 存量行 + 旧客户端原键重试(载荷无数量) | duplicated:true(跨部署重放窗口:docQ null + 请求缺席 → 同内容) | Q1 |
| B7 | pre-Q1 存量行 + 新客户端原键重试携 quantity=2 | OPERATION_CONFLICT(内容不同,绝不静默改) | Q1 |
| B8 | 新客户端对旧服务端投影(缺键) | 归一 null = 未确认 | Q1(客户端) |
| B9 | photo 会话(pre-Q1 冻结载荷)由新客户端恢复 | 逐字节重放,不注入 quantity;撞 duplicated 收敛 | Q1 |

### C. 对应 issue §5-3(同帧两盒:1×2 / 2×1 / box=null / 不偷偷合并)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| C1 | 照片两候选(框 B1/B2),用户显式合并 → photoCommit items=[{quantity:2, photo.box:null}] | 落 1 条 quantity=2;证据行 box=null(整照);绝不落 B1 或 B2 冒充 | Q3(客户端合同)/Q1(服务端形状门) |
| C2 | 同上不合并 → items=[{quantity:1, box:B1},{quantity:1, box:B2}] | 2 条 item 各 ×1,框各自保留 | Q1(服务端)/Q3(默认行为) |
| C3 | 默认(用户不操作)两候选 | 两行独立提交(2 条 item);不存在任何自动合并路径 | Q3 |
| C4 | 单来源行步进器调到 2(box=B1) | 合法落 quantity=2 + box=B1(§8 规则 2) | Q1 |
| C5 | photoCommit { quantity:2, box:B1 } 的服务端形状 | 接受(服务端不判合并;§8 规则 5) | Q1 |

### D. 对应 issue §5-4(视频 6 帧 ≠ 6;同帧两件;可拆分;证据保留)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| D1 | 6 个同名 observation(不同帧)用户合并为 1 草稿,数量控件未动 → videoSceneCommit items=[{target:new, highlights:6 条, quantity 缺席}] | 落 1 条 quantity=1(缺省),绝不 6 | Q1(服务端) |
| D2 | 同帧 2 个同名 observation → 默认 | 2 个独立草稿(mergeSameName=false 现状)→ 2 条 ×1 | Q3(客户端) |
| D3 | 同帧 2 observation,用户合并并在行上确认数量 2 | 落 1 条 quantity=2(用户确认;不得自动推断成 1) | Q3(客户端)/Q1(服务端 D1 型) |
| D4 | 用户把 1 草稿拆成 2 件(splits) | 2 条 item,各自 observationIds/highlights/时间窗;高亮上限 8 不变 | Q3 |
| D5 | videoSceneCommit items=[{target:"existing", quantity:1, ...}] | INVALID_INPUT,reason=QUANTITY_ON_EXISTING_TARGET 整批零写 | Q1 |
| D6 | 提交 2 条新物品(quantity 5/3,带 location)→ scan 行 | confirmed_count=2(数条数不数总量) | Q1 |

### E. 对应 issue §5-5(语音 add/subtract/set 区分;歧义不写)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| E1 | quantityIntentParse「卫生间棉柔巾加两包」(候选含该 item) | intent=add,delta=+2,unit=包,source_quote「加两包」锚定通过 | Q2 |
| E2 | 「用掉三包棉柔巾」 | intent=subtract,delta=-3 | Q2 |
| E3 | 「卫生间棉柔巾现在有四包」 | intent=set,value=4,unit=包 | Q2 |
| E4 | 「棉柔巾还有四包」 | intent=unknown,ambiguity=maybe_total;绝不按 set 或 add 执行 | Q2 |
| E5 | 「把两包棉柔巾拿到卧室」 | intent=other(移动);客户端提示不支持;零数量写 | Q2 |
| E6 | 「找一下棉柔巾」 | intent=other(找回);不触碰数量 | Q2 |
| E7 | 候选同名多位置命中 | needs_pick=true;用户未选定 → 零写 | Q2 |
| E8 | 模型编造 candidates 外 item_id / 推算数量(「大概一半」→3) | 丢弃 match / unknown(锚定失败);零写 | Q2 |
| E9 | quantityAdjust subtract amount=3 于 (2,包) 行 | INVALID_INPUT,reason=QUANTITY_BELOW_ZERO(附 current_quantity:2),零写 | Q2 |
| E10 | quantityAdjust add 于未确认行 | INVALID_INPUT,reason=QUANTITY_UNCONFIRMED,零写 | Q2 |

### F. 对应 issue §5-6(并发不覆盖;冲突重确认;跨家庭零写)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| F1 | 同家庭 A、B 各读 (5,包,v);A quantityAdjust +2 成功;B 携旧 expected_version 请求 -1 | B 得 VERSION_CONFLICT;文档 7/v+1;B 须 get 刷新并显式重确认后才可再发;绝不自动套旧 delta | Q2 |
| F2 | B 重确认后以新 update_id+expected_version=v+1 发 -1 | 成功 6/v+2 | Q2 |
| F3 | quantityAdjust 目标为他家 item_id | NOT_FOUND,零写(household 服务端派生) | Q2 |
| F4 | 共享家庭缺 expected_household_id / scope_revision 过窗 | FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零写 | Q2 |
| F5 | update 并发族回归:A 改数量、B 同时改名称,一方 CAS 失败重确认 | 既有 update 语义零回归(数量并入指纹) | Q1 |

### G. 对应 issue §5-7(响应丢失重试;重放参数更改拒绝;create 不合并)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| G1 | quantityAdjust +2 成功但响应丢失 → 同 update_id+expected_version+payload 重试 | replayed:true,quantity 只生效一次(7 不变 9) | Q2 |
| G2 | 同 update_id 但 amount 2→3 重试 | VERSION_CONFLICT(指纹失配),绝不吞新内容 | Q2 |
| G3 | +2 响应丢失后,他人在该 item 又写入(version 推进)→ 原参重试 | VERSION_CONFLICT;客户端「结果待核对/请刷新」,绝不盲重减 | Q2 |
| G4 | create 同名不同 operation_id 两笔 | 2 条独立 item(现状,绝不按 name 合并) | Q1(回归) |
| G5 | videoSceneCommit 同票据重试改 items[0].quantity 3→4 | 签名失配 → OPERATION_CONFLICT | Q1 |
| G6 | videoSceneCommit 不带数量的载荷重试(旧会话) | 与现行签名逐字节一致,正常收敛 | Q1 |

### H. 对应 issue §5-8(数量 0 保留一切;删除≠归零;confirmed_count/回收合同不变)

| # | 输入 | 期望 | 阶段 |
| --- | --- | --- | --- |
| H1 | update { quantity:0, unit:"包" } | 成功;item 未删、location/location_node_id/提醒(active 行)/照片证据/video_evidence 全保留;投影 quantity=0 | Q1 |
| H2 | quantity=0 行照常 query/list/get | 正常出现(未删);徽标「×0包」 | Q1 |
| H3 | delete(quantity=0 的行) | 软删成功(独立操作);反向:delete 不因数量非零受阻 | Q1 |
| H4 | delete 后行 quantity/unit 字段 | 未被 delete 触碰(I3;已删文档不投影,无观察差异) | Q1 |
| H5 | D2 回归:scanDelete / videoCleanup / 引用回收 / video_reclaimed 语义 | 数量合同零触碰,全部现有测试原样绿 | Q1(回归) |
| H6 | 提醒实体:quantity=0 行的 remindList/remindComplete | 照常(数量与提醒零耦合) | Q1 |

### I. 对应 issue §5-9(全量门,各阶段 PR 验收)

| # | 门 | 口径 | 阶段 |
| --- | --- | --- | --- |
| I1 | 全量 `npm test`(node --test tests/) | 各阶段 PR 全绿(含本文档 Q0 交付后基线 1044+ 不回归;Q1 起为本矩阵新增测试) | Q1/Q2/Q3 |
| I2 | `npm run typecheck`(tsc -p miniprogram --noEmit) | 零错误 | Q1/Q2/Q3 |
| I3 | `npm run build:mp`(.ts→.js 成对提交) | 产物齐全 | Q1/Q2/Q3 |
| I4 | 微信 devtools upload 编译 | Owner 人工门(自动化不可替代,如实报告「未跑」不得假报) | 各阶段发版前 |
| I5 | 双家庭身份并发 + 真机弱网重试 | Owner 人工门(重点:§F/§G 场景真机复现) | Q2/Q3 |

## 13. 明确不做(issue §6,重申)

库存流水/账本、采购/补货提醒与阈值(#87 保持独立 Discovery)、库存预测、SKU/条码、批次/保质期、跨单位自动换算、自动合并已入库 item、跨位置数量迁移、无人确认的自动扣减、定时扫描、独立库存服务、向量库、通用事务引擎、V-JEPA/DINO 接入、#101 R1 多帧模型、#85。**不迁移生产数据**;不新增 npm 依赖;不建新集合(quantity/unit 落在 items 文档;quantityAdjust 落 itemsApi 既有 action 路由;quantityIntentParse 落 extractDraft 既有 action 路由,零新集合零新索引)。

## 14. 开放问题

无(全部决定见 §0 摘要表;UNIT_SET 取 14 值全集的理由见 §2.2,若 Owner 希望首版更窄须在 Q1 开工前推翻本文——闭集只增不减,宽起步的唯一代价是单位选择器多几项)。

## 15. 变更记录

- 2026-10-23:Q0 初版(Owner 授权工作包 0)。基线 main=944bef3;`npm test` = 1044/1044 全绿(交付前实测);`npm run typecheck` 未跑(纯文档交付,无 .ts 改动,见 §12-I2 为 Q1+ 阶段门)。
