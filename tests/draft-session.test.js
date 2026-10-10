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
