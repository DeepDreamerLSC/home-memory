# PR #16 旧八屏设计 × 当前 main 能力覆盖矩阵

> 归档裁定文档(2026-10-15)。对象:PR #16「空间树浏览与编辑高保真八屏稿 + 可点击语音修改原型」(head 分支 `docs/issue15-location-tree-v0-prototype`,Refs #15)。对照基线:`origin/main` = `8be06b1`(PR #55 合并后)。
>
> **结论先行:旧原型不整包合并、不覆盖新实现。** 位置树已在 issue #18(PRs #19–#32、#24、#48、#54、#55)以完全不同的架构落地并迭代多轮;旧八屏稿作为 D0 设计候选完成了它的历史使命,其仍具价值的未实现交互在本文件登记为**保留设计资产**。PR #16 关闭归档,分支保留供参考。

## 0. 证据来源

| 证据 | 位置 |
| --- | --- |
| 旧设计交付说明(八屏定义、交互状态、验收场景、分期) | PR #16 `docs/design/location-tree-v0-handoff.md`(git show FETCH_HEAD,commit `d461c34`) |
| 旧可点击原型(S1–S4 + E1–E4 + renameplace + 未归类 + 搜索,共 15 个 screen) | PR #16 `docs/design/location-tree-v0-prototype.html` |
| 当前实现设计合同(issue #18) | `docs/design/location-tree.md`(main) |
| 当前实现代码 | `miniprogram/pages/index`、`pages/locations`、`pages/locationScan`、`pages/item`、`pages/confirm`、`utils/voice-entry.ts` 等,引用均注 `文件:行`(origin/main) |

旧八屏 = 浏览 S1 首页入口 / S2 房间总览 / S3 房间详情 / S4 抽屉物品,编辑 E1 编辑空间 / E2 新增位置 / E3 移动单件 / E4 语音编辑;原型另有「未归类清单」与首页搜索两个附属屏。

## 1. 浏览四屏(S1–S4)覆盖矩阵

| # | 旧设计交互 | 当前 main 状态 | 证据 |
| --- | --- | --- | --- |
| S1-1 | 首页搜索下新增**次级**入口「按空间逛逛」,不与录音主 CTA 抢眼 | **已过时(被更优形态取代)**:PR #48 起首页本身就是家庭地图(H1)——根层房间格子两列 + 到期横幅 + 尚未归类通栏,不再需要二级入口;录入主任务由全局语音条承担 | `pages/index/index.wxml:199`(roomgrid)、`:11`(page-with-voice-bar)、`:283`(voice-bar);`components/voice-bar/` |
| S1-2 | 保留搜索、语音双主任务 | **已实现(超出)**:搜索常驻首页(H1b 结果视图,空态不造假 + 「记一件」转化);语音为全局 voice-bar(issue #45)+ 首用态页内大 CTA | `pages/index/index.wxml:74-90`(searchbar)、`utils/voice-entry.ts:1-27`(全局语音条链路) |
| S1-3 | 「最近记住的」列表 | **已过时**:被家庭地图 + 搜索结果视图取代;找回路径改为搜索与逐层浏览 | `pages/index/index.wxml:92-125`(H1b) |
| S1-4 | 首页搜索(原型示意) | **已实现**:按名称/位置原文搜索,结果带 `location_text` 与更新时间 | `pages/index/index.wxml:92-125` |
| S2-1 | 房间卡:名称/子空间示例/子孙物品数 | **已实现(形态不同)**:首页房间格(首字/名称/计数);locations 页子节点行「N 件 + M 个子位置」。「子空间示例」文案(如「书桌、小冰箱等」)未实现(细节,不影响功能) | `pages/locations/locations.wxml:74-102`;`miniprogram/types.ts:347-358`(`item_count` = 整棵子树挂载的未删物品数) |
| S2-2 | 「尚未归类」入口 + 计数 | **已实现(超出)**:首页通栏格「N 件待核实」可点入整页明细(#36 真机反馈 Fix 3),行带「位置待核实」标签;locations 根层显示未归位计数 | `pages/index/index.wxml:161-176`(unmountedView)、roomgrid 通栏格;`pages/locations/locations.wxml:54-61` |
| S2-3 | 「+房间」入口 | **已实现**:locations 根层「+ 添加」→ `onAddTap`(添加房间)→ `doAdd`(`ensurePath` created_from:"manual") | `pages/locations/locations.ts:698-737` |
| S2-4 | 「按位置浏览的是上次记录,东西可能移动了」诚实提示 | **部分实现**:该语义由详情页只读大卡承担;浏览页无常驻提示卡(locations 页 stale banner 是缓存刷新失败口径,另一语义) | `pages/item/item.wxml:33`;`pages/locations/locations.wxml:48-49` |
| S3-1 | 可点击面包屑,深层可快速跳层 | **部分实现**:locations 页面包屑为纯文本(`crumb`),首页容器视图返回胶囊逐层退回;跨级直达跳层未实现 → 登记为保留设计资产(见 §4-A2) | `pages/locations/locations.wxml:28-29`;`pages/index/index.wxml:4`(backchip) |
| S3-2 | 「往里看看」子空间区块 | **已实现**:children 列表 / 首页点格子整页切入容器视图 | `pages/locations/locations.wxml:74-102` |
| S3-3 | 「直接记录在X」直属物品区块,不与子空间混淆、不漏显示 | **已实现**:locations「这里的物品」卡(与「位置」卡分开);首页容器视图「直接记录在{{containerName}}」区 | `pages/locations/locations.wxml:103-121`;`pages/index/index.wxml:237-244` |
| S3-4 | 子孙去重计数(12 = 8+3+1) | **已实现**:物品挂载点唯一,`item_count` 按子树聚合天然无重复 | `miniprogram/types.ts:353-354` |
| S3-5 | 「编辑」入口(进 E1) | **已实现(形态不同)**:无独立编辑态;行内「⋯」动作单(改名/移动到…/合并到…/删除)+ 卡头「+ 添加」;首页容器「⋯」整理位置复用同套交互 | `pages/locations/locations.ts:456-484`;`pages/index/index.ts:212,858` |
| S4-1 | 完整位置语境 + 物品数 | **已实现**:面包屑文本「我的家 / A / B」+ 层计数 | `pages/locations/locations.ts:307-311`(renderList breadcrumbText/countText) |
| S4-2 | 「这里只展示上次确认的位置」提示 | **部分实现**:物品行常显「原始记录:{location_text}」+ 详情页诚实提示;叶子页无常驻提示卡 | `pages/locations/locations.wxml:114`;`pages/item/item.wxml:33` |
| S4-3 | 物品行 → 物品详情 | **已实现**:`openItem` 携带 summary + 当前层 path(详情页只读大卡显示空间路径) | `pages/locations/locations.ts:864-889`;`pages/item/item.wxml:18-25` |
| S4-4 | 返回父节点 | **已实现**:导航返回 / backchip 逐层退回 | `pages/index/index.wxml:4` |
| 附-1 | 未归类清单:原文可见、不强迫归类、可搜索找回 | **已实现**:`certain=false` 一律先进「尚未归类」;摘除挂载回未归位且保留原话;明细页显示 `location_text || '没说放在哪儿'` | `pages/confirm/confirm.wxml:98`;`pages/locations/locations.ts:816-846`;`pages/index/index.wxml:161-176` |
| 附-2 | 不按名称自动合并同名节点;跨父同名独立 | **已实现**:`(household_id, parent_id, name_norm)` 唯一索引 + 同父同名 ensurePath 复用;合并必须人工发起 | `docs/design/location-tree.md` §1.1;`pages/locations/locations.ts:559-607`(merge) |

## 2. 编辑四屏(E1–E4)覆盖矩阵

| # | 旧设计交互 | 当前 main 状态 | 证据 |
| --- | --- | --- | --- |
| E1-1 | 编辑/完成切换的全局编辑态 | **已过时(被更轻交互取代)**:逐行「⋯」动作单,无全局编辑模式,浏览/操作合一 | `pages/locations/locations.ts:469-484` |
| E1-2 | 家具卡「修改」(改名) | **已实现**:`rename` 动作,modal 改名;服务端保证**不改写** items 的 `location_text`/`name`/`note` | `pages/locations/locations.ts:487-524`;`docs/design/location-tree.md` §0 验收 3 |
| E1-3 | 直属物品「移动」 | **已实现**:`linkItem` 携带 `expected_version` + `update_id` 幂等键,冲突不静默覆盖,提示后刷新重试 | `pages/locations/locations.ts:770-812` |
| E1-4 | 「+新增」位置 | **已实现**:同 S2-3 | `pages/locations/locations.ts:698-737` |
| E1-5 | 底部语音操作 CTA「说一句,帮我修改」 | **未实现但有价值 → 保留设计资产 A1(见 §4)**:当前语音仅录入记一件;`docs/design/location-tree.md` §0 明确「语音修改位置……后续设计,本 MVP 只做页面操作」 | `utils/voice-entry.ts:1-27`;`docs/design/location-tree.md` §0「MVP 之外」 |
| E1-6 | 编辑安全提示(改名≠搬家;子树/合并/删除需独立评审) | **已实现且超出**:合并/删除有二次确认、非空保护与悬挂挂载补偿扫描;子树移动(`move`)已按独立结构规则实现(旧设计原排期 V2) | `pages/locations/locations.ts:559-657`;`docs/design/location-tree.md` §3(NODE_NOT_EMPTY) |
| E2-1 | 上级位置选择 | **已实现(交互不同)**:手动添加固定在当前层;跨层挂载经物品「整理位置」候选分段(可直接改)或选择模式逐层下钻 | `pages/locations/locations.ts:721-737`;`pages/item/item.wxml:124-146` |
| E2-2 | 位置类型单选(房间/家具/抽屉) | **已过时**:issue #30(PRs #31/#33)移除类型业务依赖,类型仅作深度派生的历史兼容字段 | `docs/design/location-tree.md` §1.1(type 字段) |
| E2-3 | 名称输入 | **已实现**:modal 可编辑输入,30 字上限 | `pages/locations/locations.ts:702-716` |
| E2-4 | 自然语言 AI 回填候选(「书房有一个靠窗白柜」) | **已实现(三条路径,超出)**:① 详情页「整理位置」:`parseLocation` 零写库出候选分段 → 逐段核对(可改,顺序错乱有警示)→ 确认才 `ensurePath`+`linkItem`;② 录入确认页 `mount_path` 预览,可「换」(逐层选),**点「确认记住」才建路径,绝不静默建路径**;③ 批量扫描向导 `scanHousehold` → 候选树逐支确认 → `applyScan` 一次入库 | `pages/item/item.ts:486,559-728`;`pages/confirm/confirm.wxml:97-101`、`confirm.ts:54-63`;`pages/locationScan/locationScan.wxml:31-40` |
| E2-5 | 重名候选「复用 or 新建」显式二选 | **部分实现**:同名兄弟自动复用并提示「与已有的『X』同名,确认后直接用那个位置」;无「新建并存」分支(需改名)。防误拆/误并的原则已达成 | `pages/item/item.wxml:146`;`docs/design/location-tree.md` §1.1(唯一索引) |
| E2-6 | AI 不得擅自合并;确认后才建节点 | **已实现(红线,零回归)**:AI 类 action 全部零写库;`ensurePath` 是唯一建节点入口且只由用户确认后的客户端调用 | `docs/design/location-tree.md` §0 验收 4;`pages/confirm/confirm.ts:57` |
| R-1 | 改名影响范围预览(后代件数、引用数) | **部分实现**:不改写历史原话已由服务端保证;改名弹层无「含后代 N 件」预览 → 登记为保留设计资产 A3 | `pages/locations/locations.ts:487-524` |
| R-2 | 改名与移动语义分离 | **已实现**:独立 `rename` / `move` action | `pages/locations/locations.ts:487,526` |
| E3-1 | 同名物品辨识(不同 ID/不同上次位置) | **已实现(交互不同)**:移动从具体物品行发起,行内「原始记录:{location_text}」即辨识信息,`wx:key="item_id"`;不存在按名称定位物品的歧义入口 | `pages/locations/locations.wxml:103-121`;`pages/locations/locations.ts:770-812` |
| E3-2 | 原位置只读展示 | **部分实现**:原位置由当前层语境 + 行内原话承担;无独立「原位置 → 目标位置」对照卡 → 登记为保留设计资产 A4 | 同上 |
| E3-3 | 目标位置选择(逐层下钻) | **已实现(超出)**:pick 模式支持非根层「就选这里」直选(#29)、自身/子树禁选并给原因、选择器统一退栈(#32)、成功后落到目标层展示结果 | `pages/locations/locations.wxml:35-45,88-99`;`pages/locations/locations.ts:57-66,890-925`(unwindPickerAbove/openPicker/finishPick) |
| E3-4 | 影响范围「仅 1 件」显式声明 | **部分实现**:`linkItem` 单件语义天然只动一件;无显式影响范围卡 | `pages/locations/locations.ts:782-812` |
| E3-5 | 确认前重取版本,防覆盖他人修改 | **已实现(超出)**:`expected_version` 条件更新 + `update_id` 幂等 + `VERSION_CONFLICT` 刷新重试;当前分支 `feat/pr12-conflict-port` 进一步把 PR #12 四字段双值冲突对比移植到 D1 详情页(c13df26/6b2a6d8/18353a3,待评审) | `pages/locations/locations.ts:794-812`;`docs/design/location-tree.md` §1.2 |
| E3-6 | 「移动的是记录,不是现实搬动」提示 | **部分实现**:由详情页「这是上次记录的位置,东西可能已经移动」承担;移动弹层无此文案 | `pages/item/item.wxml:33` |
| E4 | 语音编辑整屏(转写可编辑→改后旧解析失效;AI 意图卡仅草稿;歧义 `resolved_item_id=null` 不得执行;同名必逐件选择;失败保留文字入口;`move_subtree` 不得借单件界面) | **未实现但有价值 → 保留设计资产 A1(整屏,见 §4)**:当前无任何语音修改链路 | PR #16 原型 `voiceedit` 屏;`utils/voice-entry.ts`(仅录入) |

## 3. 横切关注

| 旧设计要求 | 当前 main 状态 | 证据 |
| --- | --- | --- |
| 深浅色双主题 | **已实现(全局)**:`darkmode: true` + `theme.json` + `@media (prefers-color-scheme: dark)` | `miniprogram/app.json`、`miniprogram/app.wxss:43` |
| 视觉 tokens(奶油白/明黄/墨黑、44px 触点) | **已实现(超出)**:现行全局基线为 #45 冻结原型一比一还原(PR #50) | `miniprogram/app.wxss:2-58`;PRs #47/#50 |
| 网络失败真实提示,不拿旧目录冒充最新 | **已实现(超出)**:骨架屏、stale banner「当前为上次记录(刷新失败)」、请求序号 + 缓存代数防迟至上屏(#24) | `pages/locations/locations.wxml:13-49`;`pages/locations/locations.ts:241-303` |
| 件数从唯一 Item ID 计算、父子层不重复计数 | **已实现**:挂载点唯一 + 子树聚合 | `miniprogram/types.ts:353-354` |
| 「上次记录」而非 GPS 实时位置 | **已实现**:全局口径 | `pages/item/item.wxml:33` |

## 4. 保留设计资产(仍有价值、当前未实现)

未来推进 issue #15 后续阶段(或语音交互设计)时,以下旧设计交互应作为输入,无需重新发明:

- **A1|语音修改位置(E4 整屏)**——旗舰资产。当前语音只做录入(`utils/voice-entry.ts`),「说一句帮我改位置」链路完全未实现。旧设计沉淀的**安全交互约束**与现行红线(确认才写、版本并发、零静默)完全兼容,应整体继承:
  1. 转写文本可编辑;转写被修改后旧解析立即失效,重新解析前确认按钮禁用;
  2. AI 输出仅是可检验的结构化草稿(操作+对象+原/目标位置),永不直接执行;
  3. `resolved_item_id=null`(歧义未消除)时确认不得执行;同名物品必须逐件显式选择,不凭名称定 ID;
  4. 语音失败/空转写保留文字手动入口;
  5. 意图分类隔离:`move_subtree` 不得借用 `move_item` 的单件确认界面;
  6. AI 不擅自合并同名位置,候选需「复用 or 新建」确认。
- **A2|面包屑快速跳层**:深层位置(≥3 层)逐层退回成本高;可点击面包屑或层级直达可提升浏览效率。当前两处均为单层退回(`locations.wxml:28-29` 纯文本、`index.wxml:4` backchip)。
- **A3|改名/移动的影响范围预览**:改名弹层展示「该节点含后代 N 件、直接挂载 M 件」,合并/整支删除前展示受影响件数——旧设计强调的防误改 affordance,当前仅服务端保护 + 事后提示。
- **A4|移动单件的「原位置 → 目标位置」对照卡**:E3 的双栏对照让确认语义一目了然,当前挂载确认只有目标选择。

## 5. 当前 main 超出旧设计的能力(旧稿未画,防止「以旧代新」误读)

合并重复节点(merge,含悬挂挂载补偿)、批量扫描向导(scanHousehold → 逐支确认 → applyScan)、缓存先行 + 条件刷新(#23/#24)、挂载异常读侧容忍与计数上报、家庭共享与作用域门禁(#34/#35/#37/#39)、录入自动挂靠「确认即入位」(#55)、删除非空保护 + 整支删除、首页即家庭地图(H1,#48)、保质期提醒与快到期页(#36/#52)。

## 6. 归档裁定

1. **不整包合并**:PR #16 为 docs-only 设计资产,其 S/E 屏的信息架构(次级入口、全局编辑态、类型单选)已被现行实现以不同且更完整的形态取代,合并无增量价值。
2. **不覆盖新实现**:现行位置树承载 #34 家庭合同、日期纪律、自动挂靠红线(确认才建路径)等多轮已验收约束,任何旧稿元素回流必须走增量 PR + 对应测试,不得以「按旧设计改」为由回退现行交互。
3. **保留参考**:PR #16 分支保留不删;§4 的 A1–A4 登记为保留设计资产,供 issue #15 后续阶段与语音交互设计直接取用。
4. 旧设计验收案例中与安全/诚实相关的条款(不自动归类、不改写原话、同名不误并、零静默建路径)已全部在现行实现中以更强形式(服务端合同 + 测试)落实,无需按旧文档重验。
