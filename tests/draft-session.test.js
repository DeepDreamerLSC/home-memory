"use strict";

const test = require("node:test");
const assert = require("node:assert");

const ds = require("../miniprogram/utils/draft-session.js");

const DRAFT = {
  name: "钥匙",
  location_text: "玄关抽屉",
  certain: true,
  qualifiers: [],
  source_quote: "钥匙放在玄关抽屉",
};

test("草稿会话:create → get 回放原话与草稿 → clear 后不可再取", function () {
  const sid = ds.createDraftSession("钥匙放在玄关抽屉", [DRAFT], false);
  assert.match(sid, /^[0-9a-f-]{36}$/, "sid 应为 uuid 形态");
  const payload = ds.getDraftSession(sid);
  assert.ok(payload, "刚创建的会话应可取");
  assert.equal(payload.originalText, "钥匙放在玄关抽屉");
  assert.equal(payload.drafts.length, 1);
  assert.equal(payload.drafts[0].name, "钥匙");
  assert.equal(payload.truncated, false, "未超限时 truncated 为 false");
  ds.clearDraftSession(sid);
  assert.equal(ds.getDraftSession(sid), null, "清除后取不到");
  ds.clearDraftSession(sid); // 幂等
});

test("草稿会话:未知 sid 返回 null(如实,不编造空草稿)", function () {
  assert.equal(ds.getDraftSession("not-exist"), null);
});

test("草稿会话:超过 TTL 的会话视为过期并清理", function () {
  const sid = ds.createDraftSession("猕猴桃在果篮", [
    Object.assign({}, DRAFT, { name: "猕猴桃", source_quote: "猕猴桃在果篮" }),
  ], true);
  const created = ds.getDraftSession(sid).createdAt;
  const justBefore = created + 24 * 60 * 60 * 1000; // TTL 边界(24 小时恢复窗口)内仍可用
  assert.ok(ds.getDraftSession(sid, justBefore), "TTL 内可取");
  const justAfter = created + 24 * 60 * 60 * 1000 + 1;
  assert.equal(ds.getDraftSession(sid, justAfter), null, "超时即过期");
  assert.equal(ds.pruneDraftSessions(justAfter), 0, "过期会话已被清理");
});

// ---------- 三轮评审:进程回收后的幂等恢复 ----------

test("行状态回写与恢复:中途退出 → getUnfinishedDraftSession 可见,进程重启后沿用原键", function () {
  const sid = ds.createDraftSession("钥匙放玄关,充电宝放客厅", [
    Object.assign({}, DRAFT, { name: "钥匙", source_quote: "钥匙放玄关" }),
    Object.assign({}, DRAFT, { name: "充电宝", location_text: "客厅", source_quote: "充电宝放客厅" }),
  ], false);
  // 确认页逐行回写:第一件已保存,第二件结果未知(超时)
  ds.updateDraftSessionRows(sid, [
    { key: "row-0", name: "钥匙", locationText: "玄关", checked: true, status: "saved", failMsg: "", operationId: "op-a" },
    { key: "row-1", name: "充电宝", locationText: "客厅", checked: true, status: "failed", failMsg: "timeout", operationId: "op-b" },
  ]);
  const unfinished = ds.getUnfinishedDraftSession();
  assert.ok(unfinished, "中途退出后会话保留,首页应显示恢复入口");
  assert.equal(unfinished.sid, sid);
  assert.equal(unfinished.payload.rows[0].status, "saved", "已保存状态随会话保留");
  assert.equal(unfinished.payload.rows[1].operationId, "op-b", "失败行原幂等键随会话保留");

  // 模拟进程回收:内存会话清空,持久层仍在
  ds.simulateProcessRestartForTest();
  const restored = ds.getDraftSession(sid);
  assert.ok(restored, "进程重启后按 sid 从持久层恢复");
  assert.equal(restored.rows[0].operationId, "op-a", "恢复后沿用原键(不产生新键,不重复建档)");
  assert.equal(restored.rows[1].status, "failed");
  assert.equal(restored.originalText, "钥匙放玄关,充电宝放客厅");

  // 恢复后完成收尾:clear 即干净离场
  ds.clearDraftSession(sid);
  assert.equal(ds.getUnfinishedDraftSession(), null);
});

test("新会话覆盖旧持久(只保留最新一个未完成会话;入口必须有门禁,见 DG-1)", function () {
  const sidA = ds.createDraftSession("旧句子", [DRAFT], false);
  const sidB = ds.createDraftSession("新句子", [DRAFT], false);
  const unfinished = ds.getUnfinishedDraftSession();
  assert.equal(unfinished.sid, sidB, "持久层只保留最新会话");
  assert.notEqual(unfinished.sid, sidA);
});

// ---------- 四轮评审:未完成批次的新建入口门禁(阻断项回归) ----------
// 页面入口(index.onExtractTap)在存在未完成会话时必须先让用户裁决,本测试
// 锁住三条路径在持久层的可观测契约,防止门禁被移除后静默覆盖复活。

test("DG-1:未完成批次存在时,新建必须经用户裁决——恢复保留幂等键/放弃先清除/无门禁直接新建必丢失", function () {
  // 场景基线:旧批次两件,第一件已保存(持有 operation_id 幂等键),第二件未保存
  const sidA = ds.createDraftSession("钥匙放玄关,充电宝放客厅", [
    Object.assign({}, DRAFT, { name: "钥匙", source_quote: "钥匙放玄关" }),
    Object.assign({}, DRAFT, { name: "充电宝", location_text: "客厅", source_quote: "充电宝放客厅" }),
  ], false);
  ds.updateDraftSessionRows(sidA, [
    { key: "row-0", name: "钥匙", locationText: "玄关", checked: true, status: "saved", failMsg: "", operationId: "op-dg-a" },
    { key: "row-1", name: "充电宝", locationText: "客厅", checked: true, status: "pending", failMsg: "", operationId: "op-dg-b" },
  ]);

  // 路径一(恢复):入口不得触碰持久层——旧会话完整、幂等键原样、仍是未完成入口
  const before = ds.getUnfinishedDraftSession();
  assert.ok(before, "存在未完成会话时入口应先看到它");
  const restored = ds.getDraftSession(before.sid);
  assert.equal(restored.rows.length, 2);
  assert.equal(restored.rows[0].status, "saved");
  assert.equal(restored.rows[0].operationId, "op-dg-a", "已保存行幂等键不丢(重放不双写)");
  assert.equal(restored.rows[1].operationId, "op-dg-b");

  // 路径二(放弃):必须显式 clearDraftSession 后才 createDraftSession——旧批次
  // 不可再恢复、新会话干净落地,持久层不残留旧幂等键
  ds.clearDraftSession(before.sid);
  const sidB = ds.createDraftSession("新的句子", [DRAFT], false);
  assert.equal(ds.getDraftSession(before.sid), null, "放弃后旧批次不再可恢复(用户已明确选择)");
  const after = ds.getUnfinishedDraftSession();
  assert.equal(after.sid, sidB);
  assert.equal(after.payload.drafts[0].name, "钥匙", "新会话内容为本次输入,非旧批次残留");

  // 反例锚(为什么门禁必须在入口):不 clear 直接 create(旧版静默覆盖行为)
  // 会把旧批次的恢复入口与幂等键一并冲掉——持久层从不拒绝,防线只在入口。
  ds.simulateProcessRestartForTest();
  const sidC = ds.createDraftSession("第三句", [DRAFT], false);
  const unfinishedC = ds.getUnfinishedDraftSession();
  assert.notEqual(unfinishedC.sid, sidB, "无门禁时持久层只保留最新——旧幂等键随 sidB 消失");
});

// ---------- 五轮评审:持久层归属检查(CAS 守卫)----------
// 旧确认页的迟到回调(persistRows → updateDraftSessionRows)不得把已退役的
// sid 反向写回 storage,否则会顶掉新批次的恢复入口与其幂等键。

test("DG-2:迟到回写不得复活已退役会话——恢复入口始终是新批,clear(A) 不清 B", function () {
  // 评审反例:create(A) → create(B) → late update(A)
  const sidA = ds.createDraftSession("旧批:钥匙放玄关", [
    Object.assign({}, DRAFT, { name: "钥匙", source_quote: "钥匙放玄关" }),
  ], false);
  const sidB = ds.createDraftSession("新批:充电宝放客厅", [
    Object.assign({}, DRAFT, { name: "充电宝", location_text: "客厅", source_quote: "充电宝放客厅" }),
  ], false);
  assert.equal(ds.getUnfinishedDraftSession().sid, sidB, "前置:当前持久化会话是 B");

  // 旧确认页迟到回写 A(内存里 A 仍在,模拟旧页仍活跃/提交在途)
  ds.updateDraftSessionRows(sidA, [
    { key: "row-0", name: "钥匙", locationText: "玄关", checked: true, status: "saved", failMsg: "", operationId: "op-late-a" },
  ]);
  assert.equal(ds.getUnfinishedDraftSession().sid, sidB, "迟到回写 A 不得把 storage 改回 A");
  const bPayload = ds.getDraftSession(sidB);
  assert.ok(bPayload, "新批 B 完好");
  assert.equal(bPayload.originalText, "新批:充电宝放客厅", "B 的内容未被 A 的回写污染");

  // 正向对照:当前会话 B 的回写照常落盘
  ds.updateDraftSessionRows(sidB, [
    { key: "row-0", name: "充电宝", locationText: "客厅", checked: true, status: "saved", failMsg: "", operationId: "op-late-b" },
  ]);
  const unfinished = ds.getUnfinishedDraftSession();
  assert.equal(unfinished.sid, sidB);
  assert.equal(unfinished.payload.rows[0].operationId, "op-late-b", "当前会话回写正常持久化");

  // 进程回收后(迟到回调跨进程场景):storage 归属仍是 B
  ds.simulateProcessRestartForTest();
  assert.equal(ds.getUnfinishedDraftSession().sid, sidB, "进程重启后恢复入口仍是 B");

  // clear(A) 不得清 B(旧批次收尾不得误伤新批)
  ds.clearDraftSession(sidA);
  const afterClear = ds.getUnfinishedDraftSession();
  assert.ok(afterClear, "clear(A) 不得清掉 B");
  assert.equal(afterClear.sid, sidB);
});

test("DG-3:放弃路径的时序——clear(A) 之后到达的 A 迟到回写,不得重建 A 的持久入口", function () {
  const sidA = ds.createDraftSession("旧批:猕猴桃在果篮", [
    Object.assign({}, DRAFT, { name: "猕猴桃", source_quote: "猕猴桃在果篮" }),
  ], false);
  // 用户明确放弃 A(入口门禁路径):恢复入口清空
  ds.clearDraftSession(sidA);
  assert.equal(ds.getUnfinishedDraftSession(), null, "放弃后无恢复入口");
  // A 的迟到回写才到:不得复活持久入口(内存已随 clear 移除,此处顺带覆盖该早退分支)
  ds.updateDraftSessionRows(sidA, [
    { key: "row-0", name: "猕猴桃", locationText: "果篮", checked: true, status: "saved", failMsg: "", operationId: "op-late-c" },
  ]);
  assert.equal(ds.getUnfinishedDraftSession(), null, "迟到回写不得复活已放弃的会话");

  // 用户随即记新批:正常落地,不受 A 残留影响
  const sidB = ds.createDraftSession("新批:雨伞在门口", [
    Object.assign({}, DRAFT, { name: "雨伞", location_text: "门口", source_quote: "雨伞在门口" }),
  ], false);
  assert.equal(ds.getUnfinishedDraftSession().sid, sidB);
});
