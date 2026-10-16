"use strict";

/**
 * issue #36 V1.5(remindNotify 云函数:到期微信提醒推送)离线合同测试:
 * - RN-AGG:聚合纯函数(lib/aggregate.js)——上海时区自然日/日期算术/到期窗口
 *   (今天+明天纳入,昨天/后天不纳入)/按家庭分组出卡片四字段(单件名称直取、
 *   多件「X 等 N 件」、位置不同写「家中多处」、20 码点截断、今天优先文案);
 * - RN-ELIG:发送前资格复核纯函数(lib/eligibility.js)——member_key 重算不一致
 *   跳过 / 共享家庭被移出会员表跳过 / 家庭解散跳过 / 个人家庭按确定性派生判定;
 * - RN-IDEM:幂等——last_sent_date 等于今天则跳过(触发器重试不重复打扰);
 * - RN-SUB:recordSubscription——个人家庭与共享家庭成员订阅落库(upsert 幂等)、
 *   家庭解析失败零写入(fail-closed);
 * - RN-SCAN:timer 扫描全链——窗口过滤/物品连接(悬挂行容忍)/资格复核/发送
 *   (send 注入替身)/发送成败都盖章 last_sent_date/错误绝不上抛;
 * - RN-LOG:日志只落计数与布尔,绝不落 openid/member_key/物品名/位置/家庭名/
 *   提醒日期明细;
 * - RN-GLUE:index.js 胶水层真实加载(stub wx-server-sdk)——缺 OPENID 拒绝 /
 *   订阅落库 / timer 入口经 cloud.openapi 发送且 miniprogramState=formal。
 * 零网络、零外部依赖;绝不 require wx-server-sdk。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var crypto = require("node:crypto");
var Module = require("node:module");

var householdLib = require("../cloudfunctions/itemsApi/lib/household");
var aggregate = require("../cloudfunctions/remindNotify/lib/aggregate");
var eligibility = require("../cloudfunctions/remindNotify/lib/eligibility");
var rnHandler = require("../cloudfunctions/remindNotify/lib/handler");
var handler = rnHandler.handler;
var createMemoryDb = require("./helpers/memoryDb").createMemoryDb;

var ROOT = path.join(__dirname, "..");

/** 订阅消息模板 ID(「质保即将过期提醒」编号 75799,与 remindNotify lib/handler.js 同一常量;旧模板 2026-10-16 服务端失效已弃用) */
var TEMPLATE_ID = "fM4crRcrPk2kQ5iRL0WwTPoRhNS7Da8skrWqfcEdBSM";
var TEMPLATE_PAGE = "pages/reminders/reminders";

function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeDb() {
  return createMemoryDb({
    uniqueIndexes: {
      remind_subscriptions: [["_id"]]
    }
  });
}

/** timer 触发时刻:北京时间 2026-10-14 08:00(UTC 00:00),今天=2026-10-14 */
var TIMER_NOW = "2026-10-14T00:00:00.000Z";

/** 组装 timer 扫描 deps(now 固定在北京 08:00;send 默认记录型替身) */
function scanDeps(db, opts) {
  opts = opts || {};
  var sent = [];
  return {
    db: db,
    now: function () {
      return new Date(opts.now !== undefined ? opts.now : Date.parse(TIMER_NOW)).toISOString();
    },
    memberKeyOf: function (openid) {
      return sha256hex(openid);
    },
    send:
      opts.send ||
      function (payload) {
        sent.push(payload);
        return Promise.resolve({ errCode: 0 });
      },
    sent: sent,
    logger: opts.logger || { log: function () {} }
  };
}

/** 组装 recordSubscription deps(index.js 每次调用都重新解析,测试同构) */
async function recordDeps(db, openid, opts) {
  opts = opts || {};
  var resolved = await householdLib.resolveActiveHousehold(db, openid);
  return {
    db: db,
    now: function () {
      return new Date(opts.now !== undefined ? opts.now : Date.parse(TIMER_NOW)).toISOString();
    },
    memberKeyOf: function (o) {
      return sha256hex(o);
    },
    memberKey: householdLib.memberKeyOf(openid),
    openid: openid,
    resolved: opts.resolved !== undefined ? opts.resolved : resolved,
    logger: opts.logger || { log: function () {} }
  };
}

function seedItem(db, householdId, itemId, name, locationText, extra) {
  extra = extra || {};
  return db.collection("items").add({
    data: {
      _id: itemId,
      household_id: householdId,
      name: name,
      name_norm: name,
      location_text: locationText,
      note: "",
      version: 1,
      deleted: extra.deleted === true,
      operation_id: "op-" + itemId,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z"
    }
  });
}

function seedReminder(db, householdId, itemId, dueDate, extra) {
  extra = extra || {};
  return db.collection("reminders").add({
    data: {
      _id: "rh_" + itemId + "_g1",
      household_id: householdId,
      item_id: itemId,
      status: extra.status || "active",
      generation: 1,
      due_date: dueDate,
      kind: "有效期",
      quote: "",
      created_at: "2026-10-01T00:00:00.000Z"
    }
  });
}

function seedSubscription(db, householdId, openid, extra) {
  extra = extra || {};
  return db.collection("remind_subscriptions").add({
    data: {
      _id: "rsub_" + householdId + "_" + sha256hex(openid),
      household_id: householdId,
      member_key: sha256hex(openid),
      openid: openid,
      template_id: TEMPLATE_ID,
      last_sent_date: extra.last_sent_date || "",
      updated_at: "2026-10-01T00:00:00.000Z"
    }
  });
}

/** 造一个共享家庭(households 元数据 + 会员行),返回 household_id */
async function seedSharedHousehold(db, householdId, openids, extra) {
  extra = extra || {};
  await db.collection("households").add({
    data: {
      _id: householdId,
      display_name: extra.display_name || "测试之家",
      dissolved: extra.dissolved === true,
      scope_revision: 1,
      created_at: "2026-10-01T00:00:00.000Z"
    }
  });
  for (var i = 0; i < openids.length; i++) {
    await db.collection("household_members").add({
      data: {
        household_id: householdId,
        member_key: sha256hex(openids[i]),
        role: i === 0 ? "owner" : "member",
        joined_at: "2026-10-01T00:00:00.000Z",
        invited_by: null
      }
    });
  }
  return householdId;
}

async function rawDocs(db, name) {
  var res = await db.collection(name).where({}).get();
  return res.data || [];
}

// ---------- RN-AGG:聚合纯函数(lib/aggregate.js) ----------

test("RN-AGG-1:shanghaiYmd 按 Asia/Shanghai(UTC+8 固定偏移,无夏令时)取自然日", function () {
  // 北京 2026-10-15 00:30 = UTC 2026-10-14 16:30:即使 UTC 日期还是 14,今天也是 15
  assert.equal(aggregate.shanghaiYmd("2026-10-14T16:30:00.000Z"), "2026-10-15");
  assert.equal(aggregate.shanghaiYmd("2026-10-14T15:59:00.000Z"), "2026-10-14");
  // 08:00 触发时刻(UTC 00:00):今天就是北京日期
  assert.equal(aggregate.shanghaiYmd("2026-10-14T00:00:00.000Z"), "2026-10-14");
  // 月/日补零与跨年
  assert.equal(aggregate.shanghaiYmd("2026-12-31T16:01:00.000Z"), "2027-01-01");
  assert.equal(aggregate.shanghaiYmd("2027-03-01T03:05:00.000Z"), "2027-03-01");
});

test("RN-AGG-2:addDaysYmd 纯日期算术(跨月/跨年/闰日自然进位)", function () {
  assert.equal(aggregate.addDaysYmd("2026-10-14", 1), "2026-10-15");
  assert.equal(aggregate.addDaysYmd("2026-10-31", 1), "2026-11-01");
  assert.equal(aggregate.addDaysYmd("2027-12-31", 1), "2028-01-01");
  assert.equal(aggregate.addDaysYmd("2028-02-28", 1), "2028-02-29", "闰年二月");
  assert.equal(aggregate.addDaysYmd("2026-10-14", -1), "2026-10-13");
});

test("RN-AGG-3:到期窗口=今天与明天(含端点),昨天/后天/非法形状一律不纳入", function () {
  var today = "2026-10-14";
  assert.equal(aggregate.inDueWindow("2026-10-14", today), true, "今天纳入");
  assert.equal(aggregate.inDueWindow("2026-10-15", today), true, "明天纳入");
  assert.equal(aggregate.inDueWindow("2026-10-13", today), false, "昨天不纳入");
  assert.equal(aggregate.inDueWindow("2026-10-16", today), false, "后天不纳入");
  assert.equal(aggregate.inDueWindow("", today), false, "空串不纳入");
  assert.equal(aggregate.inDueWindow("2026/10/14", today), false, "斜杠分隔不纳入");
  assert.equal(aggregate.inDueWindow(20261014, today), false, "非字符串不纳入");
});

test("RN-AGG-4:单件卡片四字段——名称/到期日/位置/温馨提醒直取主物品", function () {
  var cards = aggregate.buildHouseholdCards(
    [{ household_id: "hhA", item_id: "it_a", name: "鲜牛奶", location_text: "冰箱冷藏层", due_date: "2026-10-14" }],
    "2026-10-14"
  );
  assert.deepEqual(Object.keys(cards), ["hhA"]);
  assert.equal(cards.hhA.name, "鲜牛奶");
  assert.equal(cards.hhA.date, "2026-10-14");
  assert.equal(cards.hhA.location, "冰箱冷藏层");
  assert.equal(cards.hhA.tip, "今天到期,点开处理");
});

test("RN-AGG-5:多件同位置——「X 等 N 件」取最早到期件,位置沿用同文本", function () {
  var rows = [
    { household_id: "hhA", item_id: "it_b", name: "酸奶", location_text: "冰箱冷藏层", due_date: "2026-10-15" },
    { household_id: "hhA", item_id: "it_a", name: "鲜牛奶", location_text: "冰箱冷藏层", due_date: "2026-10-14" },
    { household_id: "hhA", item_id: "it_c", name: "奶酪", location_text: "冰箱冷藏层", due_date: "2026-10-15" }
  ];
  var cards = aggregate.buildHouseholdCards(rows, "2026-10-14");
  assert.equal(cards.hhA.name, "鲜牛奶 等 3 件", "最早到期件 + 等 N 件");
  assert.equal(cards.hhA.date, "2026-10-14", "到期日期=最早日期");
  assert.equal(cards.hhA.location, "冰箱冷藏层", "同位置沿用");
  assert.equal(cards.hhA.tip, "今天到期,点开处理", "含今天到期则说今天");
});

test("RN-AGG-6:多件位置不同——存放位置写「家中多处」", function () {
  var rows = [
    { household_id: "hhA", item_id: "it_a", name: "鲜牛奶", location_text: "冰箱冷藏层", due_date: "2026-10-14" },
    { household_id: "hhA", item_id: "it_b", name: "创可贴", location_text: "药箱", due_date: "2026-10-14" }
  ];
  var cards = aggregate.buildHouseholdCards(rows, "2026-10-14");
  assert.equal(cards.hhA.location, "家中多处");
  assert.equal(cards.hhA.name, "鲜牛奶 等 2 件", "同日并列按 item_id 稳定取主物品(it_a 在前)");
});

test("RN-AGG-7:全是明天到期——温馨提醒说「明天到期,记得看看」", function () {
  var cards = aggregate.buildHouseholdCards(
    [
      { household_id: "hhA", item_id: "it_a", name: "酸奶", location_text: "冰箱", due_date: "2026-10-15" },
      { household_id: "hhA", item_id: "it_b", name: "奶酪", location_text: "冰箱", due_date: "2026-10-15" }
    ],
    "2026-10-14"
  );
  assert.equal(cards.hhA.tip, "明天到期,记得看看");
  assert.equal(cards.hhA.date, "2026-10-15");
});

test("RN-AGG-8:thing 字段 20 码点截断——单件直取截断,多件保住「 等 N 件」尾巴", function () {
  var longName = "一二三四五六七八九十一二三四五六七八九十一二三四五"; // 25 码点
  var single = aggregate.buildHouseholdCards(
    [{ household_id: "hhA", item_id: "it_a", name: longName, location_text: "冰箱", due_date: "2026-10-14" }],
    "2026-10-14"
  );
  assert.equal(Array.from(single.hhA.name).length, 20, "单件名称截到 20 码点");
  assert.equal(single.hhA.name, longName.slice(0, 20));

  var multi = aggregate.buildHouseholdCards(
    [
      { household_id: "hhA", item_id: "it_a", name: longName, location_text: "冰箱", due_date: "2026-10-14" },
      { household_id: "hhA", item_id: "it_b", name: "酸奶", location_text: "冰箱", due_date: "2026-10-15" },
      { household_id: "hhA", item_id: "it_c", name: "奶酪", location_text: "冰箱", due_date: "2026-10-15" }
    ],
    "2026-10-14"
  );
  assert.equal(Array.from(multi.hhA.name).length, 20, "整字段不超 20 码点(微信 thing.DATA 上限)");
  assert.ok(multi.hhA.name.indexOf("等 3 件") !== -1, "多件后缀必须完整保留");
  var longLocation = "一二三四五六七八九十一二三四五六七八九十"; // 恰 20 码点
  assert.equal(
    aggregate.buildHouseholdCards(
      [{ household_id: "hhB", item_id: "it_x", name: "电池", location_text: longLocation + "再长一点", due_date: "2026-10-14" }],
      "2026-10-14"
    ).hhB.location,
    longLocation,
    "位置同样截到 20 码点"
  );
});

test("RN-AGG-9:按 household_id 分组,多家庭互不混卡;同日并列按 item_id 稳定排序", function () {
  var cards = aggregate.buildHouseholdCards(
    [
      { household_id: "hhB", item_id: "it_z", name: "酱油", location_text: "厨房", due_date: "2026-10-14" },
      { household_id: "hhA", item_id: "it_b", name: "乙物品", location_text: "书房", due_date: "2026-10-14" },
      { household_id: "hhA", item_id: "it_a", name: "甲物品", location_text: "客厅", due_date: "2026-10-14" }
    ],
    "2026-10-14"
  );
  assert.deepEqual(Object.keys(cards).sort(), ["hhA", "hhB"]);
  assert.equal(cards.hhA.name, "甲物品 等 2 件", "同日并列取 item_id 较小者(it_a=甲物品)为主物品");
  assert.equal(cards.hhB.name, "酱油");
  assert.equal(cards.hhA.location, "家中多处", "甲乙位置不同");
});

// ---------- RN-ELIG:发送前资格复核(lib/eligibility.js) ----------

test("RN-ELIG-1:共享家庭——会员行在且未解散才放行", function () {
  var sub = { household_id: "hh_f_family01", member_key: sha256hex("o-member") };
  assert.equal(eligibility.eligibleForSend(sub, sub.member_key, { dissolved: false }, true), true, "在册未解散:放行");
  assert.equal(eligibility.eligibleForSend(sub, sub.member_key, { dissolved: false }, false), false, "订阅后被移出家庭:跳过");
  assert.equal(eligibility.eligibleForSend(sub, sub.member_key, { dissolved: true }, true), false, "家庭已解散:跳过");
  assert.equal(
    eligibility.eligibleForSend(sub, sub.member_key, { display_name: "x" }, true),
    false,
    "dissolved 字段非法(缺省):失败关闭跳过"
  );
});

test("RN-ELIG-2:个人家庭(无 households 元数据行)——按确定性派生判定,不查成员表", function () {
  var key = sha256hex("o-single");
  var personalId = "hh_" + key.slice(0, 32);
  assert.equal(eligibility.personalHouseholdIdOf(key), personalId, "个人家庭 id=hh_+sha256 前 32 位(存量算法)");
  assert.equal(
    eligibility.eligibleForSend({ household_id: personalId, member_key: key }, key, null, false),
    true,
    "个人家庭 id 与派生一致:放行(自身即全部成员,无从被移出)"
  );
  assert.equal(
    eligibility.eligibleForSend({ household_id: "hh_" + "f".repeat(32), member_key: key }, key, null, false),
    false,
    "家庭 id 与派生不一致(挂错家庭):跳过"
  );
});

test("RN-ELIG-3:openid 重算的 member_key 与订阅记录不一致(损坏/篡改)一律跳过", function () {
  var sub = { household_id: "hh_f_family01", member_key: sha256hex("o-member") };
  assert.equal(eligibility.eligibleForSend(sub, sha256hex("o-other"), { dissolved: false }, true), false);
});

test("RN-IDEM-1:alreadySentToday——今天已发跳过,昨天/缺省不算", function () {
  assert.equal(eligibility.alreadySentToday({ last_sent_date: "2026-10-14" }, "2026-10-14"), true);
  assert.equal(eligibility.alreadySentToday({ last_sent_date: "2026-10-13" }, "2026-10-14"), false);
  assert.equal(eligibility.alreadySentToday({}, "2026-10-14"), false);
  assert.equal(eligibility.alreadySentToday({ last_sent_date: "" }, "2026-10-14"), false);
});

// ---------- RN-SUB:recordSubscription(订阅授权落库) ----------

test("RN-SUB-1:个人用户订阅——落 remind_subscriptions,键=household_id+member_key,重复调用幂等不双写", async function () {
  var db = makeDb();
  var deps = await recordDeps(db, "o-single-user");
  var first = await handler({ action: "recordSubscription" }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  var rows = await rawDocs(db, "remind_subscriptions");
  assert.equal(rows.length, 1, "恰好一条订阅文档");
  var personalId = householdLib.personalHouseholdId("o-single-user");
  assert.equal(rows[0]._id, "rsub_" + personalId + "_" + sha256hex("o-single-user"));
  assert.equal(rows[0].household_id, personalId);
  assert.equal(rows[0].member_key, sha256hex("o-single-user"));
  assert.equal(rows[0].openid, "o-single-user");
  assert.equal(rows[0].template_id, TEMPLATE_ID);
  assert.equal(rows[0].last_sent_date, "", "新订阅未发过");
  assert.ok(typeof rows[0].updated_at === "string" && rows[0].updated_at.length > 0);

  // 重复订阅(upsert):仍一条,updated_at 刷新,last_sent_date 不被重置
  var deps2 = await recordDeps(db, "o-single-user", { now: Date.parse("2026-10-15T00:00:00.000Z") });
  var again = await handler({ action: "recordSubscription" }, deps2);
  assert.equal(again.ok, true);
  var rows2 = await rawDocs(db, "remind_subscriptions");
  assert.equal(rows2.length, 1, "同键 upsert,绝不双写");
  assert.equal(rows2[0].updated_at, "2026-10-15T00:00:00.000Z", "updated_at 刷新");
});

test("RN-SUB-2:共享家庭成员订阅——家庭解析三向验证通过后落该共享家庭", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner", "o-wife"]);
  await db.collection("active_household").add({
    data: { member_key: sha256hex("o-wife"), household_id: hid, updated_at: "2026-10-01T00:00:00.000Z" }
  });
  var deps = await recordDeps(db, "o-wife");
  var res = await handler({ action: "recordSubscription" }, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  var rows = await rawDocs(db, "remind_subscriptions");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].household_id, hid, "订阅落在当前活跃共享家庭");
});

test("RN-SUB-3:家庭解析失败(fail-closed)——HOUSEHOLD_UNAVAILABLE 且零写入", async function () {
  var db = makeDb();
  var deps = await recordDeps(db, "o-ghost", { resolved: { ok: false, error: "HOUSEHOLD_UNAVAILABLE" } });
  var res = await handler({ action: "recordSubscription" }, deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "HOUSEHOLD_UNAVAILABLE");
  assert.equal((await rawDocs(db, "remind_subscriptions")).length, 0, "绝不落库");
});

// ---------- RN-SCAN:timer 每日扫描全链(handler 注入替身) ----------

test("RN-SCAN-1:窗口过滤——今天/明天纳入,昨天/后天不纳入;卡片按聚合纯函数口径", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner"]);
  await seedItem(db, hid, "it_milk", "鲜牛奶", "冰箱冷藏层");
  await seedItem(db, hid, "it_yogurt", "酸奶", "冰箱冷藏层");
  await seedItem(db, hid, "it_old", "昨天的药", "药箱");
  await seedItem(db, hid, "it_far", "后天的酱", "厨房");
  await seedReminder(db, hid, "it_milk", "2026-10-14"); // 今天
  await seedReminder(db, hid, "it_yogurt", "2026-10-15"); // 明天
  await seedReminder(db, hid, "it_old", "2026-10-13"); // 昨天:不推
  await seedReminder(db, hid, "it_far", "2026-10-16"); // 后天:不推
  await seedSubscription(db, hid, "o-owner");

  var deps = scanDeps(db);
  var res = await handler({}, deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.due, 2, "只有今天+明天两件进入推送");
  assert.equal(deps.sent.length, 1, "该家庭一位订阅者,发一条");
  var payload = deps.sent[0];
  assert.equal(payload.touser, "o-owner");
  assert.equal(payload.templateId, TEMPLATE_ID);
  assert.equal(payload.page, TEMPLATE_PAGE);
  assert.equal(payload.data.thing1.value, "鲜牛奶 等 2 件");
  assert.equal(payload.data.time2.value, "2026年10月14日 08:00");
  assert.equal(payload.data.thing4.value, "冰箱冷藏层");
  assert.equal(payload.data.thing5.value, "今天到期,点开处理");
});

test("RN-SCAN-2:资格复核——被移出家庭的订阅跳过、家庭解散跳过、个人家庭订阅照发", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_alive01", ["o-owner", "o-wife"]);
  await seedItem(db, hid, "it_a", "鲜牛奶", "冰箱");
  await seedReminder(db, hid, "it_a", "2026-10-14");
  await seedSubscription(db, hid, "o-owner"); // 在册:发
  await seedSubscription(db, hid, "o-removed"); // 无会员行(已被移出):跳过

  var dissolved = await seedSharedHousehold(db, "hh_f_dead01", ["o-gone"], { dissolved: true });
  await seedItem(db, dissolved, "it_d", "过期药", "药箱");
  await seedReminder(db, dissolved, "it_d", "2026-10-14");
  await seedSubscription(db, dissolved, "o-gone"); // 家庭已解散:跳过

  var single = householdLib.personalHouseholdId("o-single");
  await seedItem(db, single, "it_s", "酱油", "厨房");
  await seedReminder(db, single, "it_s", "2026-10-14");
  await seedSubscription(db, single, "o-single"); // 个人家庭:发

  var deps = scanDeps(db);
  var res = await handler({}, deps);
  assert.equal(res.ok, true);
  assert.equal(deps.sent.length, 2, "只有 owner 与个人用户收到");
  var tousers = deps.sent.map(function (p) {
    return p.touser;
  }).sort();
  assert.deepEqual(tousers, ["o-owner", "o-single"]);
  // 资格不通过的订阅:不发送也不盖章(他们没收到消息)
  var subs = await rawDocs(db, "remind_subscriptions");
  var removed = subs.find(function (s) {
    return s.openid === "o-removed";
  });
  assert.equal(removed.last_sent_date, "", "被移出家庭:不盖章");
});

test("RN-SCAN-3:幂等——同日第二次扫描(触发器重试)不再发送;已盖章 last_sent_date", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner"]);
  await seedItem(db, hid, "it_a", "鲜牛奶", "冰箱");
  await seedReminder(db, hid, "it_a", "2026-10-14");
  await seedSubscription(db, hid, "o-owner");

  var deps = scanDeps(db);
  var first = await handler({}, deps);
  assert.equal(first.sent, 1);
  var subs = await rawDocs(db, "remind_subscriptions");
  assert.equal(subs[0].last_sent_date, "2026-10-14", "发送后盖章今天");

  var deps2 = scanDeps(db);
  var second = await handler({}, deps2);
  assert.equal(second.sent, 0, "今天已发过:幂等跳过");
  assert.equal(deps2.sent.length, 0);
});

test("RN-SCAN-4:send 失败(43101 未订阅/额度不足等)——同样盖章今天、继续下一条、绝不抛错", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner", "o-wife"]);
  await seedItem(db, hid, "it_a", "鲜牛奶", "冰箱");
  await seedReminder(db, hid, "it_a", "2026-10-14");
  await seedSubscription(db, hid, "o-owner");
  await seedSubscription(db, hid, "o-wife");

  var failedOnce = false;
  var deps = scanDeps(db, {
    send: function (payload) {
      if (!failedOnce && payload.touser === "o-owner") {
        failedOnce = true;
        return Promise.reject(new Error("43101 user refused to subscribe"));
      }
      return Promise.resolve({ errCode: 0 });
    }
  });
  var res = await handler({}, deps);
  assert.equal(res.ok, true, "发送失败绝不把异常抛出扫描");
  assert.equal(res.sent, 1, "成功一条(妻子)");
  assert.equal(res.failed, 1, "失败一条(owner)");
  var subs = await rawDocs(db, "remind_subscriptions");
  for (var i = 0; i < subs.length; i++) {
    assert.equal(subs[i].last_sent_date, "2026-10-14", "成败都盖章:当天不再重复打扰");
  }
});

test("RN-SCAN-5:悬挂提醒行(物品已删/跨家庭)读侧容忍跳过,不进聚合计数", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner"]);
  await seedItem(db, hid, "it_alive", "鲜牛奶", "冰箱");
  await seedItem(db, hid, "it_gone", "已删的药", "药箱", { deleted: true });
  await seedItem(db, "hh_f_other99", "it_foreign", "别人家的", "别处");
  await seedReminder(db, hid, "it_alive", "2026-10-14");
  await seedReminder(db, hid, "it_gone", "2026-10-14"); // 物品已删:悬挂
  await seedReminder(db, hid, "it_foreign", "2026-10-14"); // 物品属别的家庭:悬挂
  await seedSubscription(db, hid, "o-owner");

  var deps = scanDeps(db);
  var res = await handler({}, deps);
  assert.equal(res.ok, true);
  assert.equal(res.due, 1, "只有活物品进入聚合");
  assert.equal(deps.sent[0].data.thing1.value, "鲜牛奶", "单件:不带「等 N 件」");
});

test("RN-SCAN-6:无订阅/无到期提醒——空转成功,零发送", async function () {
  var db = makeDb();
  var deps = scanDeps(db);
  var res = await handler({}, deps);
  assert.equal(res.ok, true);
  assert.equal(res.sent, 0);

  var hid = await seedSharedHousehold(db, "hh_f_shared01", ["o-owner"]);
  await seedItem(db, hid, "it_far", "后天的酱", "厨房");
  await seedReminder(db, hid, "it_far", "2026-10-16");
  await seedSubscription(db, hid, "o-owner");
  var deps2 = scanDeps(db);
  var res2 = await handler({}, deps2);
  assert.equal(res2.ok, true);
  assert.equal(res2.due, 0, "窗口外不算到期");
  assert.equal(res2.sent, 0);
});

// ---------- RN-LOG:日志纪律(只落计数与布尔) ----------

test("RN-LOG-1:扫描日志绝不落 openid/member_key/物品名/位置/家庭名/日期明细", async function () {
  var db = makeDb();
  var hid = await seedSharedHousehold(db, "hh_f_logcase1", ["o-secret-owner"], { display_name: "敏感家庭名" });
  await seedItem(db, hid, "it_milk", "机密物品名", "机密位置文本");
  await seedReminder(db, hid, "it_milk", "2026-10-14");
  await seedSubscription(db, hid, "o-secret-owner");

  var entries = [];
  var deps = scanDeps(db, {
    logger: {
      log: function (entry) {
        entries.push(entry);
      }
    }
  });
  await handler({}, deps);
  assert.ok(entries.length >= 1, "扫描记一条日志");
  var dump = JSON.stringify(entries);
  assert.equal(dump.indexOf("o-secret-owner"), -1, "绝不落 openid");
  assert.equal(dump.indexOf(sha256hex("o-secret-owner")), -1, "绝不落 member_key");
  assert.equal(dump.indexOf("机密物品名"), -1, "绝不落物品名");
  assert.equal(dump.indexOf("机密位置文本"), -1, "绝不落位置");
  assert.equal(dump.indexOf("敏感家庭名"), -1, "绝不落家庭名");
  assert.equal(dump.indexOf(hid), -1, "绝不落 household_id");
  assert.equal(dump.indexOf("2026-10-14"), -1, "绝不落提醒日期明细");
  // 只允许计数/布尔/白名单动作名与错误码形态的字段值
  var stringWhitelist = { dailyScan: true, recordSubscription: true };
  for (var i = 0; i < entries.length; i++) {
    var keys = Object.keys(entries[i]);
    for (var k = 0; k < keys.length; k++) {
      var v = entries[i][keys[k]];
      if (typeof v === "string") {
        assert.ok(
          stringWhitelist[v] === true || /^[A-Z_]+$/.test(v),
          "字符串值只能是白名单动作名或错误码,实际:" + v
        );
      } else {
        assert.ok(typeof v === "number" || typeof v === "boolean" || v === null, "其余字段只能是计数/布尔/null");
      }
    }
    assert.equal(typeof entries[i].sent, "number", "sent 为计数");
  }
});

// ---------- RN-GLUE:index.js 胶水层真实加载(stub wx-server-sdk) ----------

/** 临时把 wx-server-sdk 替换为 stub 并(重新)加载云函数入口(照 tests/households.test.js 手法) */
function loadCloudFunction(entryPath, stubSdk) {
  var origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") {
      return stubSdk;
    }
    return origLoad.apply(this, arguments);
  };
  for (var key of Object.keys(require.cache)) {
    if (key.indexOf(path.join(ROOT, "cloudfunctions")) === 0) {
      delete require.cache[key];
    }
  }
  try {
    return require(entryPath);
  } finally {
    Module._load = origLoad;
  }
}

function makeStub(openid, db, sent) {
  return {
    DYNAMIC_CURRENT_ENV: "env-dynamic",
    init: function () {},
    getWXContext: function () {
      return openid ? { OPENID: openid } : {};
    },
    database: function () {
      return db;
    },
    openapi: {
      subscribeMessage: {
        send: function (payload) {
          sent.push(payload);
          return Promise.resolve({ errCode: 0 });
        }
      }
    }
  };
}

test("RN-GLUE-1:recordSubscription 真实入口——缺 OPENID 拒绝;有 OPENID 落库", async function () {
  var db = makeDb();
  var anon = loadCloudFunction(path.join(ROOT, "cloudfunctions", "remindNotify", "index.js"), makeStub(null, db, []));
  var unauthed = await anon.main({ action: "recordSubscription" });
  assert.equal(unauthed.ok, false);
  assert.equal(unauthed.error, "UNAUTHORIZED");
  assert.equal((await rawDocs(db, "remind_subscriptions")).length, 0, "缺身份零写入");

  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "remindNotify", "index.js"), makeStub("o-glue-user", db, []));
  var ok = await entry.main({ action: "recordSubscription" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  var rows = await rawDocs(db, "remind_subscriptions");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openid, "o-glue-user");

  var bad = await entry.main({ action: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "INVALID_INPUT");
});

test("RN-GLUE-2:timer 入口(无 action / Type:Timer)——扫描并经 cloud.openapi 发送,miniprogramState=formal", async function () {
  var db = makeDb();
  // index.js 用真实时钟组 deps:窗口日期按运行时刻的上海自然日动态构造,测试与时区/日期无关
  var pad = function (n) {
    return n < 10 ? "0" + n : String(n);
  };
  var sh = new Date(Date.now() + 8 * 60 * 60 * 1000);
  var today = sh.getUTCFullYear() + "-" + pad(sh.getUTCMonth() + 1) + "-" + pad(sh.getUTCDate());
  var single = householdLib.personalHouseholdId("o-glue-single");
  await seedItem(db, single, "it_soy", "酱油", "厨房调味篮");
  await seedReminder(db, single, "it_soy", today); // 今天到期
  await seedSubscription(db, single, "o-glue-single");

  var sent = [];
  var entry = loadCloudFunction(path.join(ROOT, "cloudfunctions", "remindNotify", "index.js"), makeStub("irrelevant", db, sent));
  var res = await entry.main({ Type: "Timer", TriggerName: "dailyExpiryNotify" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(sent.length, 1);
  var payload = sent[0];
  assert.equal(payload.touser, "o-glue-single");
  assert.equal(payload.templateId, TEMPLATE_ID);
  assert.equal(payload.page, TEMPLATE_PAGE);
  assert.equal(payload.miniprogramState, "formal", "正式版状态(订阅消息默认跳开发版)");
  assert.equal(payload.data.time2.value, today.slice(0, 4) + "年" + Number(today.slice(5, 7)) + "月" + Number(today.slice(8, 10)) + "日 08:00");
  assert.equal(payload.data.thing5.value, "今天到期,点开处理");

  // 控制台「手动触发」(空事件体)同走扫描;同日幂等不再发送
  var sent2 = [];
  var entry2 = loadCloudFunction(path.join(ROOT, "cloudfunctions", "remindNotify", "index.js"), makeStub("irrelevant", db, sent2));
  var res2 = await entry2.main({});
  assert.equal(res2.ok, true);
  assert.equal(sent2.length, 0, "同日幂等:第二次不再发送");
});

// ---------- 副本纪律:remindNotify 持有 household.js 同源副本 ----------

test("RN-SRC:remindNotify/lib/household.js 与 itemsApi 源逐字节一致(HH-SRC 同款纪律)", function () {
  var fs = require("node:fs");
  var source = fs.readFileSync(path.join(ROOT, "cloudfunctions", "itemsApi", "lib", "household.js"), "utf8");
  var copy = fs.readFileSync(path.join(ROOT, "cloudfunctions", "remindNotify", "lib", "household.js"), "utf8");
  var marker = "---- 副本正文(与源文件逐字节一致)----";
  var idx = copy.indexOf(marker);
  assert.notStrictEqual(idx, -1, "remindNotify 副本应含同源声明分界标记");
  var commentEnd = copy.indexOf("*/", idx);
  assert.notStrictEqual(commentEnd, -1, "声明头应闭合");
  var body = copy.slice(copy.indexOf("\n", commentEnd) + 1);
  assert.strictEqual(body, source, "副本正文应与源文件逐字节一致(防漂移)");
});
