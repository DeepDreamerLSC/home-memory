# 真实环境隔离与权限证据(对应架构评审 P0-2)

> 采集环境:AppID `wxf12c2884a2cfeb6a` / 云环境 `mine-d2gk3n3fq609fb244`(2026-10-09)
> 工具:`tests/e2e/security-probe.js`(miniprogram-automator,以小程序客户端身份发起,不经云函数)

## 证据 1:客户端直连 items 集合 —— 修复前(发现真实漏洞)

评审要求的探测落地后,确认权限设置过宽,**问题真实存在**:

| 探测 | 结果 | 含义 |
| --- | --- | --- |
| `wx.cloud.database().collection("items").get()` | `read-ok, count=6` | **任意客户端可直读全集合**,6 条为历史保留文档(软删测试数据与一条 bug 期空文档),含各家庭 name/location——跨家庭读取通道 |
| `wx.cloud.database().collection("items").add({data:{...}})` | `add-deny`,但拒绝原因是**唯一索引 E11000**(与既有空文档撞 null 键),非权限规则 | 权限层面写入同样开放;当前仅因一条 bug 期空文档占用 (null,null) 键而碰巧被挡,清掉该文档后写入即通 |

**修复动作**(控制台,无 CLI 通道):云开发控制台 → 数据库 → `items` → 权限设置 → 改为「**所有用户不可读不可写**」。所有业务访问都经云函数(管理端身份,不受权限规则约束),客户端不需要任何直连权限。

## 证据 2:客户端直连 items 集合 —— 权限收紧后(已复测通过)

控制台已将 items 权限改为「所有用户不可读不可写」后,同款探测复测:

| 探测 | 结果 |
| --- | --- |
| 直连读取 | `read-deny`:`Permission denied … DATABASE_PERMISSION_DENIED` |
| 直连写入 | `add-deny`:`Permission denied … DATABASE_PERMISSION_DENIED` |

**同时确认业务回归无损**:权限收紧后立即经云函数执行 create → `ok:true`(云函数以管理端身份运行,不受权限规则约束),读写链路正常。复测命令:`node tests/e2e/security-probe.js`。

## 证据 3:两套真实微信身份交叉不可见(已实测)

模拟器(身份 A,自动化执行)与真机预览(身份 B,人工操作)为两个真实 OPENID。实测记录:

| 步骤 | 结果 |
| --- | --- |
| B 侧(真机)记录「B侧测试物品」 | 人工操作完成 |
| A 侧 `query`「B侧测试物品」 | `{"ok":true,"items":[],"match_type":"none"}` —— 不可见 |
| A 侧 `list`(默认 50 条) | 仅含 A 侧物品(平板电脑、电脑等),无 B 侧条目 —— 不可见 |
| A 侧业务回归 | 权限收紧后 create/查询/删除均正常 |

关于 update/delete 交叉:身份 B 无法从任何列表获知 A 的 item_id(上表证明数据不可见);即使伪造 item_id 直调云函数,服务端条件更新/删除同样携带 `household_id` 过滤——该逻辑由离线双身份越权测试逐条覆盖(`tests/itemsApi.test.js`「越权」用例:A 查 B 空、A 改/删 B 均 NOT_FOUND、B 数据无损)。**读取不可见 + 写入双条件,构成纵深防御**。

## 结论

评审 P0-2 要求的两项真实环境证据均已落地:①客户端直连数据库被权限规则拒绝(且先坐实了收紧前的真实漏洞并已修复);②两套真实微信身份经 itemsApi 交叉 query/list 不可见,update/delete 由服务端 household 条件兜底并有离线双身份测试覆盖。
