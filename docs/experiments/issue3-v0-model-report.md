# Issue #3 V0 视觉模型选型调研报告(规格调研,非连通性验证)

- 日期:2026-10-10
- 调研人:V0 实验准备(issue #3)
- 性质声明:**本文是规格/价格桌面调研。截至本文撰写时,作者没有任何一家的 API key,未真实调用过任何下述接口。**所有数字来自 2026-10-10 抓取的官方文档页面(来源链接逐条标注),不构成连通性、识别质量或实际计费金额的验证。真实调用验证由探针脚本 `scripts/experiments/v0-visual/probe-model.mjs` 在拿到 key 后完成。
- 需求出处:issue #3「最小实现合同」第 2 条要求「先验证选定模型 API 的真实视觉输入规格与限制;PR 1 的 DeepSeek Flash 文本模型选择不自动证明图片/视频能力已经跑通」。仓库现行 `extractDraft` 云函数仅调用 DeepSeek 文本接口(`docs/API_CONTRACT.md`「extractDraft 协议」节),与本调研对象无关。

## 候选范围

按 issue 建议在「GLM-4V 系、Qwen-VL 系、腾讯混元 vision」中选取,共调研三家:

1. 智谱 BigModel(GLM 系视觉模型)
2. 阿里云百炼 Model Studio(Qwen 系视觉模型)
3. 腾讯云混元(hunyuan-vision)

> 注:三家厂商 2026 年内均完成过一次模型代际更新(智谱当前视觉主力为 GLM-4.6V/GLM-5.3-Flash 系,阿里为 qwen3.8 系,旧 qwen-vl-max 已不在模型列表中),本报告以调研当日在线文档为准记录「当前可用的具体型号」,同时保留旧型号数字以便对照。

## 一、智谱 BigModel(GLM 系)

### API 形态

OpenAI Chat Completions 风格兼容。endpoint:`https://open.bigmodel.cn/api/paas/v4/chat/completions`,请求体为 `messages`/`temperature`/`stream` 等字段,鉴权为标准 HTTP Bearer(密钥在 bigmodel.cn 控制台「API Keys」页获取)。来源:[GLM-4.5V 模型页](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.5v)、[对话补全 API 参考(securitySchemes: bearerAuth)](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8.md)。

### 图片输入规格(对话补全接口通用限制)

| 项 | 数值 |
|---|---|
| 支持格式 | `jpg`、`png`、`jpeg` |
| 单张大小 | 5M 以下 |
| 像素上限 | 不超过 6000×6000 |
| 单请求最多图片数 | GLM-5.3-Flash 系列、GLM-5V-Turbo、GLM-4.6V、GLM-4.5V 系列:**50 张**;GLM-4V-Plus-0111:**5 张**;GLM-4V-Flash:**1 张** |
| 传入方式 | `image_url.url` 支持图片 URL 或 Base64 编码;**GLM-4V-Flash 不支持 Base64** |
| 图片 token 计算方式 | 官方文档未提供 |

来源:[对话补全 API 参考](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8.md)(2026-10-10 抓取)。

### 视频输入规格

| 项 | 数值 |
|---|---|
| 支持格式 | `mp4`、`mkv`、`mov` |
| 单个视频大小 | GLM-5.3-Flash 系列、GLM-5V-Turbo、GLM-4.6V、GLM-4.5V 及其他多模态模型:200M 以内;GLM-4V-Plus:20M 以内 |
| 时长 | 仅 GLM-4V-Plus 明确标注不超过 30s |
| 位置要求 | GLM-4V-Plus-0111 的 `video_url` 必须放在 content 数组第一位 |
| 帧 token 计算 | 官方文档未提供 |

来源:同上(对话补全 API 参考)。即:**GLM 系支持原生视频文件输入,但 V0 仍按 issue 合同走「ffmpeg 抽帧→多图输入」,原生视频输入可作附加对照**。

### 价格(元/百万 Tokens,按量后付费)

| 模型 | 输入 | 输出 | 缓存命中 |
|---|---|---|---|
| GLM-5.3-Flash(图片/视频/文件/文本) | 0.8 | 2.8 | 0.23 |
| GLM-5.3-FlashX(同上) | 2 | 7 | 0.57 |
| GLM-4.6V(<32K) | 1 | 3 | 0.2 |
| GLM-4.6V(32K–128K) | 2 | 6 | 0.4 |
| GLM-4.6V-FlashX(<32K / ≥32K) | 0.15/0.3 | 1.5/3 | 0.03 |
| **GLM-4.6V-Flash** | **免费** | **免费** | 免费 |
| GLM-4.5V(<32K) | 2 | 6 | 0.4 |
| GLM-4.5V(32K–64K) | 4 | 12 | 0.8 |
| GLM-4V-Plus-0111(视频+图像) | 4 | 4 | 2 |
| **GLM-4V-Flash** | **免费** | **免费** | 不支持 |
| GLM-4.1V-Thinking-Flash | **免费** | **免费** | 不支持 |

来源:[BigModel API 定价页](https://docs.bigmodel.cn/cn/guide/start/pricing.md)(2026-10-10 抓取;标注「缓存存储」列为限时免费)。

### 免费额度

- 定价表明确列出免费模型:GLM-4.6V-Flash、GLM-4V-Flash、GLM-4.1V-Thinking-Flash(输入/输出均免费)。来源同上定价页。
- GLM-4V-Flash 上下文 16K、最大输出 1K、单请求 1 张图、不支持 Base64,只适合单图识别;GLM-4.6V-Flash 未在概览页单列上下文(GLM-4.6V 系为 128K/32K)。来源:[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview.md)。

### 已知缺口(如实记录)

- 图片 token 计算方式未公开 → **无法事先精确估算单请求成本**(免费模型不受此影响)。
- 定价表按量表中未见 GLM-4V 本体单价(仅私有实例算力单元计价),GLM-4V-Plus-0111 之外旧 4V 型号是否仍在售未验证。

## 二、阿里云百炼 Model Studio(Qwen 系)

### API 形态

双通道:OpenAI 兼容接口(`/compatible-mode/v1/chat/completions`,Bearer 认证,环境变量 `DASHSCOPE_API_KEY`)与 DashScope 原生接口。北京地域推荐域名为业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;旧域名 `https://dashscope.aliyuncs.com/compatible-mode/v1` 文档注明「现有域名仍可正常使用」。API Key 绑定地域,跨地域调用返回 401。来源:[OpenAI 兼容文档](https://help.aliyun.com/model-studio/developer-reference/compatibility-of-openai-with-dashscope)、[图像与视频理解](https://help.aliyun.com/model-studio/vision)(2026-10-10 抓取)。

### 图片输入规格

| 项 | 数值 |
|---|---|
| 支持格式(<4K 分辨率) | BMP、JPEG、PNG、TIFF、WEBP、HEIC;4K(3840×2160)~8K(7680×4320)仅支持 JPEG、JPG、PNG |
| 单张大小(公网 URL) | qwen3.8/3.7/3.6/3.5、Qwen3-VL 系 ≤20MB;其他(如 Qwen2.5-VL、Qwen-VL)≤10MB |
| 单张大小(本地路径) | ≤10MB(Base64 编码前同上限档) |
| 请求体整体 | ≤64MB(Base64 Data URI ≤20MB) |
| 分辨率约束 | 宽高均须 >10 像素;长宽比 ≤200:1;推荐 ≤8K,超过易超时 |
| 单请求图片数 | URL/本地路径:qwen3.8-Max/Flash、qwen3.7-Plus 最多 **2048 张**;qwen3.7-Flash、qwen3.6/3.5、Qwen3-VL、Qwen-VL、QVQ 最多 256 张;Base64 最多 250 张 |
| 图片 token 计算 | `图像 Token = h_bar × w_bar / token_pixels + 2`(token_pixels 为 32×32;QVQ 为 28×28);默认 `max_pixels`=2,621,440(约 2560 tokens/张);`vl_high_resolution_images=true` 时固定 Token 上限 16384、像素上限 16,777,216;单图 Token 下限 4 |

来源:[图像与视频理解](https://help.aliyun.com/model-studio/vision)(2026-10-10 抓取)。

### 视频输入规格

| 项 | 数值 |
|---|---|
| 支持格式 | MP4、AVI、MKV、MOV、FLV、WMV 等 |
| 大小(URL) | qwen3.8/3.7/3.6/3.5、Qwen3-VL ≤2GB;Qwen2.5-VL 开源、QVQ ≤1GB;其他 ≤150MB(Base64 编码后 <10MB;本地路径 ≤100MB) |
| 时长 | qwen3.8/3.7/3.6/3.5:2 秒~2 小时;Qwen3-VL-Plus 2 秒~1 小时;Qwen2.5-VL 开源 2 秒~10 分钟;其他模型 2 秒~40 秒 |
| 抽帧规则 | `fps` 参数取值 [0.1, 10],默认 2.0(每隔 1/fps 秒抽一帧);`max_frames` 限制抽帧上限(仅 DashScope SDK) |
| 预抽帧输入 | 支持「图像列表」当视频传:content `type:"video"` + 可传 `fps` 告知帧间隔;帧数上限 qwen3.8 系 8000 张、Qwen3-VL-Plus 2000 张、Qwen3-VL 开源 512 张;单请求最多 64 个视频;不支持理解视频音轨 |

来源:同上。「预抽帧图像列表」接口与 V0 的 ffmpeg 离线抽帧方案**一一对应**——本地抽好的帧可以直接按多图/视频帧列表语义传入,不必先传原始视频。

### 价格(北京地域,元/百万 Token,按量后付费)

| 模型 | 输入 | 输出 | 免费额度 |
|---|---|---|---|
| qwen3.8-flash(0<Token≤1M) | 0.8 | 2.7 | 100 万 Token |
| qwen3.8-max / qwen3.8-max-0902 | 12 | 36 | 100 万 Token |
| qwen3.7-plus(≤256K;限时 8 折) | 原价 2(折后 1.6) | 原价 8(折后 6.4) | 100 万 Token |
| qwen3.7-flash(≤32K 档) | 0.2 | 0.8 | 100 万 Token |
| qwen3-vl-plus(≤32K 档,旧版) | 1 | 10 | 100 万 Token |

免费额度有效期:自开通百炼/模型发布/申请通过之日起 90 天内(以较晚者为准);免费额度仅华北2(北京)地域模型享有。qwen-vl-max / qwen3-vl-max 在 2026-10-10 的模型列表与价格表中均未出现。来源:[模型调用价格](https://help.aliyun.com/model-studio/model-pricing)、[视觉理解模型详情](https://help.aliyun.com/model-studio/vision-model)(2026-10-10 抓取)。

### 成本粗算(标注:非官方数字,是按上表公式的自行推算)

按「图像 Token = 像素/(32×32)+2、默认 max_pixels=2,621,440」推算:一张超过默认像素上限的照片会被缩放到上限、约 2560 tokens。V0 单区域 8 帧 + 约 500 token 提示词 ≈ 21k 输入 tokens;qwen3.8-flash(0.8 元/百万)单次请求输入成本 ≈ **0.017 元**,输出按 1k tokens(2.7 元/百万)≈ 0.003 元。**此为公式推算,真实计费以账单为准。**智谱侧因图片 token 公式未公开,无法做同类推算(但免费模型 GLM-4.6V-Flash 不产生费用)。

## 三、腾讯云混元(hunyuan-vision)

### API 形态

OpenAI 兼容:`https://api.hunyuan.cloud.tencent.com/v1/chat/completions`,`Authorization: Bearer $HUNYUAN_API_KEY`(密钥在控制台「API Key」页创建)。另有腾讯云原生 TCCLI 签名的 ChatCompletions 接口。来源:[混元 OpenAI 兼容接口](https://cloud.tencent.com/document/product/1729/111007)、[ChatCompletions 接口文档](https://cloud.tencent.com/document/product/1729/105701)(2026-10-10 抓取)。

### 平台状态(重要风险)

- 原生 ChatCompletions 接口标注「预下线状态,预计 **2026-12-21** 下线」。
- 混元能力正逐步迁移至 TokenHub(大模型服务平台),官方注明迁移后「原平台将不再新增模型能力,并停止支持新购模型服务」。
- 混元生文接口默认 5 并发(主子账号共享),Messages 长度最多 40。

来源:同上两页 + [TokenHub 产品页(搜索摘要)](https://intl.cloud.tencent.com)。

### 图片输入规格

| 项 | 数值 |
|---|---|
| 传入方式 | `contents` 数组内 `image_url` 类型;`ImageUrl.Url` 支持图片链接与 Base64(前缀 `data:image/jpeg;base64,`,png/webp/bmp 需改对应 MIME) |
| 支持格式 | 文档举例 jpeg/png/webp/bmp,**未见完整格式清单** |
| 单张大小上限 | **官方文档未给出数字** |
| 单请求图片数 | **官方文档未给出数字**(仅存在错误码 `ImageCountLimitExceededError` 图片数量超限,示例传 2 张) |

来源:[ChatCompletions 接口文档](https://cloud.tencent.com/document/product/1729/105701)。

### 视频输入规格

支持专用模型 `hunyuan-turbos-vision-video`,通过 `video_url` 类型传入,`VideoUrl` 含 `Url` 与 `Fps` 字段(示例 Fps=1)。大小/时长限制未在该页给出。来源:同上。

### 价格与免费额度(元/百万 Tokens,后付费刊例价)

| 模型 | 输入 | 输出 |
|---|---|---|
| Tencent HY Vision 1.5 Instruct | 3 | 9 |
| hunyuan-turbos-vision | 3 | 9 |
| hunyuan-t1-vision | 3 | 9 |
| hunyuan-turbos-vision-video | 3 | 9 |

免费额度:与 Hunyuan-a13b 等共享 100 万 tokens,资源包有效期 1 年;免费额度耗尽或到期后**默认不自动转后付费**,需在控制台「设置>后付费设置」主动开通。来源:[混元计费概览](https://cloud.tencent.com/document/product/1729/97731)(2026-10-10 抓取)。

### 已知缺口

- 图片大小/数量/分辨率硬限制无官方数字(第三方页面提到 ≤10MB,非官方来源,不采信进结论)。
- 模型迭代与平台迁移并行期,V0 期间(1–2 个月)接口稳定性与价格变动风险高于另外两家。

## 四、对照总表

| 维度 | 智谱 GLM 系 | 阿里 Qwen 系 | 腾讯混元 vision |
|---|---|---|---|
| OpenAI 兼容 | 是(v4 chat/completions) | 是(compatible-mode/v1) | 是(/v1,原生接口预下线) |
| 图片格式 | jpg/png/jpeg | BMP/JPEG/PNG/TIFF/WEBP/HEIC | jpeg/png/webp/bmp(举例,未见完整清单) |
| 单张大小 | ≤5M | ≤10–20MB(按传入方式) | 未文档化 |
| 像素限制 | ≤6000×6000 | 宽高>10px、长宽比≤200:1、默认 max_pixels≈2.62M | 未文档化 |
| 多图/请求 | 4.5V/4.6V/5.3-Flash 系 50 张 | qwen3.8-Max/Flash 2048 张 | 未文档化 |
| 原生视频输入 | 是(≤200M;4V-Plus 20M/30s) | 是(URL ≤2GB、2s–2h、fps 0.1–10) | 专用模型(限制未文档化) |
| 预抽帧图像列表 | 直接多图传(50 张内) | 原生支持(type:"video"+fps) | 未见对应接口 |
| 低价主力 | GLM-5.3-Flash 0.8/2.8 元 | qwen3.8-flash 0.8/2.7 元 | 3/9 元(视觉系) |
| 免费路径 | GLM-4.6V-Flash、GLM-4V-Flash 免费 | 各模型 100 万 token×90 天(北京) | 共享 100 万 token×1 年 |
| 主要风险 | 图片 token 公式未公开 | endpoint 向 workspace 专属域名迁移中 | 接口预下线+平台迁移,限制未文档化 |

## 五、选型建议

**主选:智谱 BigModel,V0 主跑 GLM-4.6V-Flash(免费),兜底 GLM-5.3-Flash(输入 0.8/输出 2.8 元/百万 tokens)。**

理由:

1. **免费模型覆盖 V0 全程**:3 个区域 × A/B/C 多轮重复对照的调用量不小,GLM-4.6V-Flash 输入/输出免费,不占实验预算;且属于 50 张多图上限的系列,支持「多帧同请求」。
2. **API 形态与现有代码同构**:`open.bigmodel.cn/api/paas/v4/chat/completions` 就是 OpenAI chat/completions 形状,与仓库现有 DeepSeek 调用(`cloudfunctions/extractDraft/lib/deepseek.js` 同为 chat/completions)迁移面最小,探针脚本可以直接复用同一形状。
3. **硬限制数字齐全**:格式/单张 5M/6000×6000/50 张都有官方数字,便于设计抽帧与压缩参数。

**次选(对照与备胎):阿里百炼 qwen3.8-flash。**规格文档三家中最完整,且「预抽帧图像列表」接口与 V0 的 ffmpeg 抽帧路线语义直接对应;100 万 token×90 天免费额度足够 V0;输入 0.8 元/百万 tokens 与智谱付费档同量级。作为 GLM 免费模型限流或识别质量不足时的 A/B 对照。

**不建议 V0 采用:腾讯混元 vision。**三个原因:原生接口 2026-12-21 预下线、平台迁移期「不再新增模型能力、停止支持新购」;图片大小/数量限制无官方数字,违背 issue「先验证真实视觉输入规格」的合同精神;同档价格(3/9 元)约为另两家低价档的 3–10 倍。待 TokenHub 迁移稳定后可重新评估。

**视频路线备注**:三家都支持原生视频输入,但 issue #3 V0 合同明确「视频=关键帧抽取→多图理解→候选去重」,故 V0 统一走 ffmpeg 抽帧(见 `scripts/experiments/v0-visual/extract-frames.sh`),原生视频输入仅在抽帧方案失效时作附加对照,不作为主路线。

## 六、遗留与待验证(不假装已完成)

1. **所有规格均未经真实调用验证**——拿到 key 后第一步是运行 `probe-model.mjs`(单张测试图)确认:实际可用性、真实 token 消耗、免费模型是否需要开通。
2. 智谱图片 token 计算公式未公开,GLM-5.3-Flash 付费档的单请求成本需以账单回填。
3. 阿里 OpenAI 兼容旧域名(`dashscope.aliyuncs.com`)文档注明仍可用但推荐迁移 workspace 专属域名,探针默认旧域名,若 401/404 需按文档换域名验证。
4. 三家服务商的**数据处理条款**(训练用途、保留期、地域)尚未逐条审阅——issue 隐私红线要求「真实试用前明确删除策略和外部视觉服务商数据条款」,此项列为 V0 开跑前的必办检查,本文未覆盖。
5. 价格与额度均为 2026-10-10 抓取值,开跑前应复核一次定价页。
