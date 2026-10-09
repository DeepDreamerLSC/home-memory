# home-memory(家庭物品记忆助手)

用一句话记录物品位置(如「降压药放在厨房第二个抽屉」):AI 只负责从这句话提取**待确认草稿**,你确认后才入库;之后随时按名称查询位置,可修改、可删除。AI 绝不直接写事实,不确定时禁止猜测,任何失败绝不静默写入。

**PR1 范围(文字闭环)**:一句话记录 → AI 提取草稿 → 用户确认入库 → 按名查询 → 修改 → 删除,全流程可用。语音录入属 PR2,真实家庭试用属 PR3(见 [docs/PR1.md](docs/PR1.md))。PR1 中一个微信用户即一个私人家庭空间,不做多成员共享。

技术栈与行为契约见 **[docs/API_CONTRACT.md](docs/API_CONTRACT.md)**(唯一事实源,本 README 只讲怎么跑起来)。

## 技术栈

- **小程序端**:微信原生小程序,TypeScript(`miniprogram/tsconfig.json` 为 strict 模式)。**采用预编译**:修改 `.ts` 后运行 `npm run build:mp`(即 `tsc -p miniprogram`)在源码旁产出 `.js`,开发者工具与 CLI preview/upload 直接使用编译产物。不使用 `useCompilerPlugins`(实测部分版本在 CLI/preview 构建路径上不产出 JS,导致「未找到 pages/xxx.js」);类型检查用 `npm run typecheck`。
- **服务端**:微信云开发 Node.js 云函数(JavaScript CommonJS,除 `wx-server-sdk` 外零 npm 依赖),小程序通过 `wx.cloud.callFunction` 调用。
- **数据库**:CloudBase 文档数据库,仅一个 `items` 集合。
- **AI**:DeepSeek Chat Completions(model `deepseek-flash`,显式禁用思考模式),**仅服务端调用**,API key 只走云函数环境变量。
- 不引入 Redis、向量库、FastAPI、自研队列。

## 目录结构

```
project.config.json      小程序工程配置(appid 为占位符,见下方部署步骤 1)
package.json             根脚本:test / typecheck / samples:live
miniprogram/             小程序端(TypeScript,strict)
  config.ts              云环境 ID 配置(cloudEnv,占位 YOUR_ENV_ID)
  types.ts               与契约一致的领域类型
  utils/api.ts           云函数调用封装、超时与错误映射、operation_id 的 uuid
  pages/index            首页:记一件(AI 提取)/ 找东西(查询)/ 最近记录
  pages/confirm          确认页:AI 草稿确认与手动录入
  pages/item             详情页:查看 / 修改 / 删除
cloudfunctions/
  itemsApi/              items 集合的 create/update/delete/query/list
    index.js             薄适配层(wx-server-sdk 胶水,OPENID 派生 household_id)
    lib/handler.js       纯函数业务逻辑(依赖注入,可离线测试)
    lib/normalize.js     名称归一化(NFC/全角转半角/小写/去空白/去标点)
  extractDraft/          一句话 → 物品位置草稿
    index.js             胶水层(读环境变量 DEEPSEEK_API_KEY)
    lib/handler.js       纯函数:prompt 构造、坏 JSON 重试一次、结果分流
    lib/deepseek.js      DeepSeek HTTP 客户端(Node 内置 https,20 秒超时)
    lib/validate.js      服务端草稿校验(幻觉防护、needs_split、长度规则)
tests/                   离线测试(node:test + node:assert,零外部依赖)
  helpers/memoryDb.js    内存版 CloudBase 语义(含云函数端 get() 单次 100 条上限)
  itemsApi.test.js       itemsApi 契约测试(18 项)
  extractDraft.test.js   extractDraft 契约测试(20 项)
  samples-live.js        真实调用 DeepSeek 的样例集验证脚本
  fixtures/samples/      16 条中文样例(s01–s16,覆盖八类情形)
docs/
  API_CONTRACT.md        接口契约(唯一事实源)
  PR1.md                 PR1 交付说明
```

## 本地离线验证(不需要微信开发者工具、不需要 API key)

环境要求:Node.js 21 及以上(在 v26 上验证通过;测试脚本依赖 `node:test` 与 glob 文件匹配)。

```bash
npm install          # 仅安装 typescript 与 miniprogram-api-typings 两个 devDependencies
npm test             # 离线全量测试:48 项(itemsApi 25 + extractDraft 20 + 胶水层 3),全部通过
npm run typecheck    # miniprogram 的 tsc --noEmit,严格模式类型检查
npm run samples:live # 真实样例试运行,见下文「真实样例试运行」
```

- 测试只 require `cloudfunctions/*/lib` 与 `tests/helpers`,绝不 require `wx-server-sdk`,不连网。
- `tests/helpers/memoryDb.js` 模拟 CloudBase 语义,包括云函数端 `get()` 单次最多 100 条的真实上限,因此「文档超过 100 条后查询被静默截断」这类缺陷在离线测试中即可发现。

## 部署到微信云开发

按顺序完成以下步骤。1–4 在微信开发者工具中操作,5–7 在云开发控制台中操作。

### 1. 替换 appid 并导入项目

`project.config.json` 里的 `appid` 是占位符 `touristappid`。请先把它替换为你自己的小程序 AppID(注册见微信公众平台,也可导入后在开发者工具「详情 → 本地设置」中覆盖),再用微信开发者工具「导入项目」打开本仓库根目录。

### 2. 开通云开发

开发者工具顶部「云开发」→ 开通并创建一个云环境,记下**环境 ID**(形如 `cloud1-xxxx`)。

### 3. 替换 cloudEnv

把 `miniprogram/config.ts` 里的 `cloudEnv = "YOUR_ENV_ID"` 替换为你的环境 ID。未替换时小程序启动会弹窗如实提示(见 `miniprogram/app.ts`),云函数调用无法成功。

### 4. 创建 items 集合、唯一索引与权限(必做,缺一不可)

云开发控制台 → 数据库 → 创建集合 `items`。随后完成两项配置:

**① 组合唯一索引**:

> items 集合 → 索引管理 → 添加索引:字段一 `household_id`(升序)+ 字段二 `operation_id`(升序),勾选「**唯一**」。

**为什么必须建**:`create` 的幂等在代码层是「先查后插 + 同键同内容比对」(`cloudfunctions/itemsApi/lib/handler.js` 的 `createItem`),对先后到达的重放有效;但对**并发**重放(两笔同 `operation_id` 的请求几乎同时到达)不是原子的。唯一索引在数据库层兜底:第二笔插入被数据库拒绝后,服务端捕获该错误回查并返回稳定结果(同内容 `duplicated: true`;异内容或命中已删文档 `OPERATION_CONFLICT`),绝不静默双写。

**② 权限设置(安全必做)**:

> items 集合 → 权限设置 → 选「**所有用户不可读不可写**」(或自定义安全规则 `{"read": false, "write": false}`)。

**为什么必须改**:所有业务访问都经云函数(管理端身份,不受权限规则约束),客户端不需要任何直连权限。默认权限曾实测允许任意客户端直读全集合(见 `docs/security-evidence.md` 证据 1)——不改等于向所有用户开放全部家庭数据。

### 5. 为 extractDraft 配置 DEEPSEEK_API_KEY

云开发控制台 → 云函数 → extractDraft → 配置 → 环境变量,添加 `DEEPSEEK_API_KEY`,值为你在 DeepSeek 开放平台(https://platform.deepseek.com)创建的 API Key。

- Key **只**从这个环境变量读取(`cloudfunctions/extractDraft/index.js`),绝不出现在代码、小程序端或日志中。
- 未配置时 extractDraft 一律返回 `AI_UNAVAILABLE` 并提示「可手动录入」,小程序会弹窗引导进入手动录入模式——这是设计内行为,不是故障。
- itemsApi 不需要任何环境变量。

### 6. 部署两个云函数

在微信开发者工具的资源管理器中,分别右键 `cloudfunctions/itemsApi` 与 `cloudfunctions/extractDraft` →「**上传并部署:云端安装依赖**」。两个云函数除 `wx-server-sdk` 外没有其他 npm 依赖,部署很快。

部署后在控制台调整**函数超时**(默认 3 秒不够用):云开发控制台 → 云函数 → 各自进入「函数配置」→ 编辑 → 超时时间:**extractDraft 改 30 秒**(要等 DeepSeek 推理),**itemsApi 建议 10 秒**(避免冷启动偶发超时)。也可用 CLI 部署:`cli cloud functions deploy --env <环境ID> --names itemsApi extractDraft --project <项目根> -r`。

### 7. 小程序里验证

编译运行小程序(工具内即可):首页输入「降压药放在厨房第二个抽屉」→ 点击提取 → 确认页应出现 AI 草稿 → 保存 → 首页「找东西」输入「降压药」应查到位置。

## 真实样例试运行(npm run samples:live)

`tests/fixtures/samples/` 下有 16 条中文样例(每条 `{ id, text, expect }`),覆盖典型一句话、带限定语、多件需拆分、口语化模糊位置、无位置信息、可容忍别字、长度边界与无法提取名称。两种运行方式:

```bash
npm run samples:live                                # 未设 DEEPSEEK_API_KEY:打印操作指引,退出码 0
export DEEPSEEK_API_KEY=sk-xxxxxxxx                 # 换成你自己的 Key(仅当前终端会话有效)
npm run samples:live                                # 逐条真实调用 DeepSeek,与 expect 逐字段对比
```

真实调用完成后,Markdown 结果表写入 `docs/samples-evidence.md`(样例、类别、成功/失败、差异);存在失败样例时退出码为 1。注意此脚本在**本机**直接调用 DeepSeek API(不经云函数),用于验证提取质量;云函数侧的行为已由离线测试覆盖。

## 隐私与安全

- **日志只记元数据,不记内容**:itemsApi 的日志只含 `action`、错误码、耗时、计数(`lib/handler.js` 的 `logResult`);extractDraft 的日志只含文本长度、耗时、错误码(`lib/handler.js`)。两套测试各有专门用例断言日志不出现物品名、位置、原文、身份与 operation_id 原文。
- **身份不下库、不上传**:云函数用 `getWXContext().OPENID` 取身份,落库的是 `household_id = "hh_" + sha256(openid) 前 32 位`,不存裸 openid;客户端不信任、不上传任何身份字段,服务端对 event 里的身份字段一律忽略。
- **软删除抹内容**:删除不是打标记了事,而是同时把 `name`、`name_norm`、`location_text`、`note` 全部抹成空字符串,文档里不再残留隐私内容;查询与列表永远过滤已删除文档。
- **密钥只走环境变量**:DeepSeek API key 只存在于云函数环境变量中,代码、样例、测试、小程序端与日志里都没有;`lib/deepseek.js` 只接受调用方传参,不读环境变量、不打印请求内容。

## 常见问题

**Q:`npm test` 报 `Could not find ... tests/**/*.test.js` 之类错误?**
测试脚本用 glob 匹配测试文件,需要 Node.js 21+。运行 `node --version` 确认;建议用 nvm 切换到新版 Node。

**Q:小程序一启动就弹「请先配置云环境」?**
`miniprogram/config.ts` 的 `cloudEnv` 还是占位符 `YOUR_ENV_ID`,按部署步骤 3 替换为你的云环境 ID。

**Q:提取按钮总是提示「AI 暂时不可用,可手动录入」?**
按设计这是可用的降级路径,但根因通常是 extractDraft 未配置环境变量 `DEEPSEEK_API_KEY`(部署步骤 5)。配置后无需重新部署代码,但云函数可能有短暂缓存,必要时重试或重新部署该函数。

**Q:同一条记录保存了一次却出现两条?**
确认 items 集合已建 `(household_id, operation_id)` 组合唯一索引(部署步骤 4)。代码层的先查后插已挡住先后到达的重放;唯一索引挡住并发重放。

**Q:查「充电线」查不到「iPhone 充电线」?**
能查到:查询词与名称都会归一化(全角转半角、忽略大小写、去空白与标点),且支持前缀与包含匹配——输入「iphone」是前缀命中,输入「电线」是包含命中。若确实查无此物,返回空列表是正常结果,不是错误。

**Q:保存时提示「内容已被修改,已为你刷新,请重试」?**
两个客户端同时改同一条记录触发了乐观并发保护(至多一笔成功)。页面已自动拉取最新内容,基于刷新后的内容再点一次保存即可。

**Q:删除的记录还能恢复吗?**
不能。软删除会抹掉全部内容字段,页面上也不再出现;这是隐私设计,没有恢复入口。

**Q:想看真实 API 的提取效果?**
见上文「真实样例试运行」,设置 `DEEPSEEK_API_KEY` 后运行 `npm run samples:live`,结果表在 `docs/samples-evidence.md`。
