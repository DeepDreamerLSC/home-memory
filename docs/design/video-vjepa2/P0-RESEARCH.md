# V-JEPA 2 / 2.1 P0 桌面调研(issue #100)

状态:**P0 完成(2026-10-23),零模型调用**;全部事实来自一手来源核验(GitHub/HF API/arXiv 全文/直链 HEAD 实测),模型效果数字一律 **NOT_RUN**。P1 未申请(见裁定)。

---

## 0. 一页裁定:STOP(本轮不接入;保留复评触发条件)

**对三个候选用途——跨帧同物关联 / 稳定关键帧选择 / 目标证据找回——现有公开证据不足以支持引入第二个视频编码器,且存在更便宜、证据更强的同门替代。不申请 P1 最小探针。**

四条理由(证据见 §2/§3,逐条带来源):

1. **三个用途两无正证据**。关键帧选择:论文与社区均无任何已发表验证(唯一相关工作 JEPA-WAM 是用冻结 V-JEPA 编码**已选好**的关键帧,arXiv:2609.20277)。跨帧同物关联:唯一相关工作是 V-JEPA 2.1 论文的 VOS 标签传播(DAVIS-17 69.0 J&F),**低于纯图像模型 DINOv3-7B(71.1)**;全库无实例身份/多实例判别的任何证据(GitHub 全库检索确认)。片段检索:HF 模型卡把 retrieval 列为 intended use,但两篇论文与仓库**均无检索基准与代码**,video-to-video 均值池化是维护者认可的社区做法(GitHub issue #35)却无 recall 数字;我们要的「拍一张照找回那一件」(image-to-video 实例级)公开证据为零。
2. **特征是类别语义,不是实例同一**——恰命中本仓库核心痛点:外观相近的同类多件(五个 PS5 盒、多包棉柔巾)会被特征粘连;而现有全部证据都是「给定首帧 mask 的单目标传播」,从未证明能区分同类两件。第三方鲁棒性研究(Poisson Labs,4 尺寸×230 片段)结论:"strong per-frame encoder with light temporal smoothing",时间一致性对运动模糊/弱光/噪声不敏感、非反射不变(水平翻转 M2=0.914)。
3. **域不匹配**。V-JEPA 优势集中在运动理解(SSv2 77.7 vs DINOv3-7B 70.1);本仓库素材是近乎静止的抽屉/柜面+短暂翻动。作者自述训练集"较少高杂乱室内场景"(VisionMix163M,分割落后的假设原因);为物体级任务(Ego4D STA)作者自己融合 1080p 高分辨率帧——承认 384px/tubelet-16px 对物体级不够,抽屉小物件同款问题。
4. **产品化两道硬伤**。(a) 许可:V-JEPA 2.1(唯一 dense 特征可用的版本,分割 47.9 vs 2.0 的 22.2 mIoU)权重只在 dl.fbaipublicfiles 直链分发、**无许可明文 [unknown,产品侧需 Owner 判断]**;V-JEPA 2 权重 HF 分发 MIT/Apache-2.0 商用无碍,但 dense 特征质量差。(b) 运行时:官方代码 CUDA-first,MPS 支持仍是未合并 PR(#81/#86,挂起一年+);macOS 需自换 decord;Mac 落地事实路径是社区 MLX 移植(lukasugar/vjepa2.1-mlx,parity≈1,非官方,自担维护)。

**复评触发条件(满足其一重开本 issue)**:

- T1:V-JEPA 后续版本发布实例级/物体级判别或检索基准证据,或 2.1 权重上架 HF 并明确许可;
- T2:#76 五人走查证实「视觉找回 / 跨帧重复线索分组」为高频痛点,且现有高亮片段回放不满足;
- T3:运动密集型录入场景(整屋漫游盘点)立项——那才是 V-JEPA 的优势域。

**后续实验方向(STOP 之后的替代路线,不属于本 issue)**:若 T2 坐实,先用**图像自监督特征(DINOv2/v3,MLX 生态成熟、VOS 基线更高)**做同样的「同名+特征相近」建议分组实验,§4 协议直接复用——同门证据更强、工程面更小(无视频 tubelet、无第二解码栈)。

## 1. P0 交付对照

- [x] 权重/许可证/最小接口/下游 probe/MPS 逐项核实,标注 verified / unknown / requires-adaptation(§2)
- [x] 与现有链路的数据流对比、最小插入点与不需修改的部分(§3)
- [x] 冻结评测协议(§4;STOP 状态下仅存档,P1 不执行)
- [x] 一页 GO / HOLD / STOP 建议 + 成本/风险清单(§0/§5)
- 模型效果:全部 **NOT_RUN**(未跑任何模型,本文不含任何自测效果数字)

## 2. 事实核验表

### 2.1 官方权重清单 **[verified]**(体积为 dl.fbaipublicfiles HTTP HEAD 实测)

| 版本 | 变体 | 参数 | 分辨率 | 实测体积 |
| --- | --- | --- | --- | --- |
| V-JEPA 2(2025-06) | ViT-L/16 | 300M | 256 | 5.13 GB |
| | ViT-H/16 | 600M | 256 | 10.37 GB |
| | ViT-g/16 | 1B | 256 | 16.46 GB |
| | ViT-g/16 | 1B | 384 | 16.46 GB |
| V-JEPA 2.1(2026-03) | ViT-B/16(蒸馏自 ViT-G) | 80M | 384 | 1.66 GB |
| | ViT-L/16(蒸馏) | 300M | 384 | 5.15 GB |
| | ViT-g/16(从头) | 1B | 384 | 16.88 GB |
| | ViT-G/16(从头) | 2B | 384 | 30.24 GB |

tubelet 2×16×16(T×H×W);预训练 16 帧,cooldown 至 64 帧(视频)/512(图像)。**ViT-B 仅存在于 2.1 且为蒸馏版;V-JEPA 2 无 ViT-B、多 ViT-H**。`.pt` 是训练态 dict(demo `torch.load(...)["encoder"]`),体积大于参数量对应值;HF safetensors / MLX fp16 版小得多(如 MLX fp16 ViT-L ≈650MB)。

### 2.2 许可证 **[verified + 一处 unknown]**

- 代码 **MIT**(LICENSE 逐字核验;randaugment/randerase/worker_init_fn 三文件 Apache-2.0)。
- V-JEPA 2 权重(HF facebook org 分发):HF API `license` 实测 **mit**(vitl/vith)**/ apache-2.0**(vitg)——商用、再许可明确允许;**个人主体公开小程序不构成许可障碍(用 HF 分发的 V-JEPA 2 权重)**。
- **V-JEPA 2.1 全部权重仅 dl.fbaipublicfiles 直链,无任何许可文件 [unknown → 产品使用需 Owner 判断或向 Meta 确认]**。
- 网络搜索摘要有声称权重为 CC-BY-NC-4.0 的说法,经 HF API 与模型卡 frontmatter 一手核验为**不实**。

### 2.3 最小推理接口 **[verified]**

- V-JEPA 2 有官方 HF transformers 支持(`AutoVideoProcessor` → `get_vision_features()` / `last_hidden_state`);2.1 无官方 HF 版(仅社区转换,如 davevanveen/vjepa2.1-vitb-fpc64-384)。
- 输出 `(B, S, D)` patch token(ViT-L@256×64帧 = 8192×1024;2.1 ViT-B@384×16帧 = 4608×768);**无 CLS token**,全局向量需 mean-pool 或 attentive probe(模型自带 3 层 pooler;HF 官方讨论区答复原文如此)。
- 图像输入:2.0 = 官方 workaround「单帧重复 16 次」;**2.1 = 原生 2D tokenizer,图文/视频同潜空间**(图→视频检索若做应选 2.1,许可风险见 2.2)。
- 预处理:Resize→CenterCrop→ImageNet 归一化;bf16 加载有官方示例。

### 2.4 官方下游能力 **[verified;零样本框/实例身份 = 没有]**

- 仓库内只有:attentive probe 训练/推理脚本(SSv2/Diving48/EK100/IN1K 等分类与预期)+ 两个 notebook(编码 demo、AC 世界模型能量景观)。
- **没有**:检索/kNN 工具、分割/深度/跟踪头、attention 可视化(decoder 可视化请求 issue #88 仍 open)。
- 物体级结果全部依赖外接组件:Ego4D STA 7.71 mAP 用 Faster R-CNN 检测头;VOS 65.8–69.0 J&F 需首帧 GT mask + 无参标签传播(论文协议:"matches local patch features across frames using cosine similarity…no learnable parameters",仓库无此代码需自实现)。

### 2.5 运行时与 Apple Silicon **[状态 verified / M5 Max 数字 unknown]**

- 官方 CUDA-first(README:"assumes your machine has a GPU");**MPS 未合并**(issue #80 报 hardcoded cuda;PR #81/#86 挂起;#86 在 M3 Max 128GB 跑通 demo);macOS 需自换 decord(eva-decord/decord2)。
- 社区 MLX 移植(非官方):lukasugar/vjepa2.1-mlx(2.1 ViT-B/L,与 PyTorch parity≈1;M1 Max 32GB 实测比 MPS 快 31%(图像)/38–57%(视频),**PyTorch MPS 在 64 帧 384 视频 OOM 而 MLX 成功**;torch.compile 在上游 RoPE 路径失败);mlx-community/V-JEPA2-vitl-fpc64-256(fp16 ≈650MB,`embed_video()` 返回池化 1024 维)。
- 原生实现性能灾难:RTX 3070Ti 384×64帧 >250 s/clip,HF SDPA 版 ≈0.8 s(差约 500×,GitHub issue #175);ViT-L 64 帧推理 ≈40GB 内存(issue #71)。
- **M5 Max 128GB 上 16 帧 384 ViT-B/L 的延迟/内存:无公开数据 [unknown],接入前必须自测。**

### 2.6 论文与第三方证据要点(全部带来源,详见来源清单)

- 2.1(ViT-G)dense 成绩**全面不超图像模型**:分割 ADE20K 47.9 vs DINOv3-7B 55.9;VOS DAVIS 69.0 vs 71.1;IN1K 85.5 vs 88.4;深度 NYU 0.307 vs 0.309。
- 检索:2.1 论文明言无检索实验(全文查证);text-to-video 需 VL-JEPA 全栈(arXiv:2512.10942,1.6B);image-to-video 实例级 [unknown]。
- 鲁棒性(Poisson Labs,全部 4 尺寸+200 SSv2+30 DAVIS):时间一致性只在丢帧(r=+0.370)/遮挡(+0.350)下预测跟踪失败,运动模糊(+0.093)/弱光(+0.049)/噪声(−0.055)≈0;非反射不变;"Bigger isn't reliably better"(Tier-1 扰动跨尺寸非单调)。
- 训练域:2.0=VideoMix22M、2.1=VisionMix163M(SSv2/K400/HowTo100M/YT 筛选+图像 LVD);作者假设分割落后因"较少高杂乱室内场景";小物体无专门讨论章节。
- 反方:Apple SALT(ICLR26)称冻结评测下小模型主导 V-JEPA 的 accuracy-FLOPs Pareto;DINOv2-g/14 曾在 K400 反超 V-JEPA 1 代;社区复现争议(issue #85 无法复现 SSv2、#178 STA 代码未发布、#179 可复现性质疑)。
- 尺寸性价比:2.1 蒸馏 ViT-L(76.5 SSv2/68.7 DAVIS)几乎追平 ViT-G(77.7/69.0);ViT-B 74.5/67.0。

## 3. 数据流对比与插入点

### 3.1 现状链路(已核仓库代码)

客户端抽帧(`miniprogram/utils/video-target.ts`,`VIDEO_TARGET_MAX_FRAMES=8`,A 线;场景线 `planSceneFrames` 密集采样,竖屏旋转修正)→ 逐帧 `callRecognize(image_base64)`(`video-scene.ts` `scanSceneVideo` 的注入回调)→ 云函数 → 托管 VL 网关(Qwen3-VL)→ 每帧 `VlCandidate[]{name, box}` → observation 聚合(每帧每候选一条,带高亮窗)→ `groupSceneObservations` **仅按显示名归组展示**(「N 条同名线索(不代表同一件)」)→ 用户显式 合并/同名开关/拆分(`createDraftsFromObservations`/`mergeSceneDrafts`/`splitSceneDraft`,**绝不自动合并**)→ `buildSceneCommitItems` → `videoSceneCommit`(票据流)→ items + evidence(高亮窗)+ location_scans。找回侧:搜索命中 → A/C 证据视频高亮片段回放(时间窗来自用户确认的高亮)。

### 3.2 三个候选插入点(①②不触冻结合同;③需 Owner 另行授权)

| 插入点 | 位置 | 改动面 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| IP-1 关键帧预筛 | 服务端:密集帧先编码→挑 K 帧给 VL | 云函数/网关可选步骤;客户端 frame plan 不动 | **无**(§0-1) | 省的是 VL 调用不是上传;多一次往返+每帧一次 encoder 前向 |
| IP-2 跨帧关联建议 | VL 响应附区域 patch 特征→客户端「同名+特征相近」**建议**排序 | `SceneRecognizeFrameResult` 可选字段(向后兼容)+ `groupSceneObservations` | 中-弱且偏负(类别语义粘连) | 仍只建议不自动合并,红线保持 |
| IP-3 跨视频找回检索 | evidence 提交时存定长特征摘要;检索=函数内暴力余弦(家庭内量小,非独立向量库) | evidence 行为变更+存储成本 | 弱-中(语义级可行/实例级无证据) | **触碰「不动 evidence 合同/不新增向量库」边界,任何 PR 前需 Owner 授权** |

不需要动的:票据流、evidence/location_scans 合同、删除/回收生命周期、确认页交互骨架。

## 4. 冻结评测协议(STOP 状态下仅存档;P1 若经 Owner 授权再执行)

- **素材与 Gold:复用 #85 已冻结资产**——三抽屉统一 2s/45 帧固定关键帧库 + gold-frozen-v1(49 CONFIRMED/20 REVIEW/9 黑名单),**不新标**;真实家庭画面仅本地处理(P1 红线,零上传)。
- 对照组:A=现状(VL 逐帧+人工确认);B1=VL+特征分组建议(IP-2);B2=VL+关键帧预筛(IP-1,同 VL 调用预算);B3(仅授权后)=图→视频检索(IP-3);退化=现状。
- 同预算纪律:同帧集、同 VL 调用数;encoder 编码成本单独计账(每 clip 秒数/峰值内存/环境版本)。
- 指标(issue 指定六项):跨帧重复(同物多报次数)/异物误合并(建议合并错对数)/定位正确性(高亮窗 vs Gold,人判)/有效关键帧召回(Gold 物品在选帧可见率)/人审耗时/找回成功率(仅在 H2 框架内测,不新开)。
- 判分纪律:人工 Gold 为唯一真值,模型输出不当真值;**阈值跑前冻结并预注册**(S1 教训);无实跑一律 NOT_RUN。
- 选型(若开):2.1 蒸馏 ViT-L(MLX 移植)优先、ViT-B 备选;同时跑 DINOv3 图像特征对照组(见 §0 替代路线)。

## 5. 成本/风险清单

- 成本:独立 encoder 权重(1.7–30GB)、每视频编码计算、(IP-3)特征存储、双栈维护(MLX 社区移植随上游漂移;原生 PyTorch 路径在 Mac 不可用)。
- 风险:2.1 权重许可 unknown;实例粘连导致的误合并建议会侵蚀用户对「建议」的信任;384px/16px-token 对抽屉小物件判别力存疑;社区移植断维护。
- 不接入的沉没成本:≈0(本 P0 为纯桌面调研)。

## 6. 来源清单(一手优先)

- 仓库/许可:github.com/facebookresearch/vjepa2(README/LICENSE/notebooks/evals;issues #35 #71 #80 #81 #85 #86 #88 #137 #175 #178 #179);huggingface.co/facebook/vjepa2-*(模型卡 frontmatter 与 API license 字段实测);dl.fbaipublicfiles.com/vjepa/*(HEAD 体积实测)。
- 论文:arXiv:2603.14482(V-JEPA 2.1, ECCV 2026)、arXiv:2506.09985(V-JEPA 2)、arXiv:2404.08471(V-JEPA 1)、arXiv:2512.10942(VL-JEPA)、arXiv:2609.20277(JEPA-WAM)。
- 第三方:poissonlabs.ai/research/vjepa-2-1-robustness;openreview.net/forum?id=3cB9243E9i(Apple SALT);learnopencv.com;bdtechtalks.com;towardsdeeplearning.com。
- MLX 移植:github.com/lukasugar/vjepa2.1-mlx(+ sugarz.me 博客);github.com/gaarutyunov/vjepa2-mlx;huggingface.co/mlx-community/V-JEPA2-vitl-fpc64-256。

---

**裁定重申:STOP。** P0 四项交付齐备;P1 不申请;复评触发条件 T1–T3 见 §0。本调研不改任何生产合同,不阻塞 #76/#85 既有计划。
