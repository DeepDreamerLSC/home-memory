# 单件视频留证 · 合同与验收清单

**状态**:受控试验 · 未完成微信真机验收前不合并/不部署
**范围**:用户在某件物品详情页明确发起,拍/选一段视频,绑定为该物品的历史视觉证据;查找后主动点击回放。

## 1. 明确不做

- 不做整抽屉批量识物;
- 不按同名跨帧自动合并物理身份;
- 不自动生成高亮框;
- 不默认自动播放;
- 不把视频当当前位置事实,只作为历史证据。

## 2. 上传与归属

1. 客户端先调 `itemsApi.videoUploadBegin({item_id})`,服务端确认物品属当前家庭后签发随机上传票据,并返回固定路径 `video-evidence/<household_id>/<ticket>.<ext>`。
2. 客户端把视频上传到该路径后**立即调用 `videoUploadReceipt`** 把 fileID 落到服务端票据,再调 `videoEvidenceAttach`,携带票据、fileID、时长和尺寸。
3. 服务端校验:票据属当前家庭、未过期、票据已回执且 fileID 一致、物品仍存活、fileID 实际路径与票据路径逐字一致、文件可通过 `getTempFileURL` 取得临时链接。
4. 校验全过后才落证据行并把票据置 bound;同票据同 fileID 重放幂等。每次 begin 都必须签发新票据,不复用旧 pending。

> 路径前缀本身不是所有权证明。本版通过「服务端签发票据 + 路径完全匹配 + 文件可用性校验」建立可归属的上传凭据;仍不声称验证了云存储对象创建者元数据。

## 3. 保留、撤回与删除

- 证据行保存 `consent_version:"v1"`,客户端只展示该版本。
- 客户端只通过 `videoEvidenceGet` 获得云函数换取的临时链接;集合权限对所有用户不可读不可写。
- 删除视频:`videoEvidenceDelete` 逐文件解析 `cloud.deleteFile.fileList[].status`,仅 status 0(成功)或 -503003(文件已不存在)对应的证据行才删除;有失败时返回 `VIDEO_DELETE_FAILED` 并保留失败行。
- 绑定/清理/取消共享票据 CAS:`pending → binding`、`pending → cleaning`、`pending → cancelling` 只能有一个赢家。attach 命中已有证据时修复 bound;cleanup 抢到 cleaning 后必须二次核对 `video_evidence` 引用,有引用则只修复 bound,绝不删正式视频。
- begin、receipt、attach 与删除物品共用 `video_item_locks` 物品级锁:删除锁覆盖视频清理 + 软删 + 提醒级联;begin 锁覆盖票据创建;receipt 锁覆盖 fileID 回执与 CAS;attach 锁覆盖票据 binding + 证据写入。锁 60s 过期可接管,防止删后继续建票/回执/写证据。
- 删除物品时清理 bound 证据与 pending/binding/cleaning/cancelling 全部非终态票据;逐文件删除成功后才把票据置 deleted,失败则物品与票据都保留。
- `videoUploadReceipt` 使用 CAS `status:"pending"` 条件写入 fileID;若 receipt 读到旧 pending 后被 cancel 抢先,条件更新失败,绝不把 fileID 写回 cancelled 票据。
- `videoUploadCancel` CAS 到 cancelling 后强制重读票据最新快照,按最新 file_id 删除;封住 receipt 在 cancel 初读后写入 file_id、旧快照漏删的反向交错。
- `videoCleanup` 先恢复超过 10min 卡在 binding/cleaning/cancelling 的中间态:有证据修复 bound;binding/cleaning 无证据恢复 pending;cancelling 无证据按删除结果收敛 cancelled/pending。
- 客户端删除待关联视频不再直接删云文件:统一调 `videoUploadCancel`。服务端若发现证据已绑定,返回 `state:"bound"` 且不删除;未绑定才 CAS 到 cancelling、逐文件删除成功后再置 cancelled,删除失败恢复 pending。
- 删除物品:服务端在软删前清理 bound 证据,以及已回执 `file_id` 的 pending 票据;任一云删除失败则物品不删、返回可重试错误。避免「物品已隐藏、私密视频仍留存」。
- 票据过期:attach/receipt 返回 `VIDEO_TICKET_EXPIRED`;客户端提示删除待关联视频后重拍,不再无限重试。
- 上传成功但绑定失败:客户端在本地按家庭作用域保存 pending 记录,详情页展示「视频待关联」,可重试关联或删除待关联视频。
- 待关联视频未处理时,详情页阻止删除物品。

## 4. 仍存在的残余风险

- 客户端 uploadFile 成功到 `videoUploadReceipt` 之间仍有极小的进程被杀窗口;服务端此时尚不知道 fileID。首版通过「上传后立即回执 + 本地 pending」把窗口压到最小,但无法在纯客户端直传模型下彻底消除。该残余风险必须由运营巡检与所有者明确接受,不能仅依赖定时任务。
- 物品锁/票据中间态中断依赖 60s/10min 超时恢复;若云函数或数据库长时间不可用,恢复会顺延到下一次定时任务,期间该物品/票据会返回 busy 而非静默继续。
- 已实现 `videoCleanup` 定时云函数:每日扫描超过 24h 仍为 pending 且已回执 file_id 的票据,只删这些文件;bound 证据不进入该清理集。禁止对整个 `video-evidence/` 前缀配置统一 24h 生命周期删除。
- 跨家庭成员退出后,原有临时链接可能在有效期内继续可播;本版依赖临时链接短时有效,不在客户端缓存永久链接。

## 5. 微信真机验收清单(合并前必须完成)

- [ ] 目标机型:至少 iOS + Android 各一台;
- [ ] 横屏/竖屏视频各一段,拍摄与相册选择各一次;
- [ ] 确认上传大小/耗时、弱网中断与重试;
- [ ] 上传成功但 attach 失败时,pending 重试与删除路径;
- [ ] 返回/杀进程重进后 pending 恢复;
- [ ] 播放器默认折叠,用户点击后才播放;旋转/比例/黑边正常;
- [ ] 删除视频后逐文件 status 确认为 0/-503003,失败时证据行保留;
- [ ] 删除物品后 bound 与已回执 pending 视频都清理;失败时物品保留并提示可重试;
- [ ] `videoCleanup` 每日触发器已部署并手动执行一次:只清理已回执 file_id 的超时 pending,不触碰 bound;
- [ ] 确认未对 `video-evidence/` 全前缀配置统一生命周期删除;
- [ ] 跨家庭成员看不到/无法读取视频证据;
- [ ] 退出家庭后临时链接在合理时间内失效。

**本清单未完成前,PR 保持 HOLD;不得对真实家庭开放。**
